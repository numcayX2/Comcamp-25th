// Command create-admin creates (or re-activates with a new password) a staff account in
// PostgreSQL with a bcrypt-hashed password (AGENTS.md §13.2). There are no default admin accounts.
//
//	cd backend
//	go run ./cmd/create-admin -username pee_somchai -name "พี่สมชาย" -role staff
//
// The password is read from the ADMIN_PASSWORD environment variable, or from the first line of
// stdin, so it never appears in shell history or the process list.
//
// The account row and an audit_logs entry (admin.cli.upsert, ip 127.0.0.1) are written in one
// transaction, so every account created or reset from the command line leaves a trace.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"comcamp25-backend/internal/config"
	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/service"
)

const (
	minPasswordLen = 12
	// cliIP is recorded as the audit row's ip_address: the command runs on the server itself.
	cliIP = "127.0.0.1"
)

func main() {
	username := flag.String("username", "", "login name (required)")
	fullName := flag.String("name", "", "display name (required)")
	role := flag.String("role", string(domain.RoleStaff), "superadmin | staff | finance | reviewer")
	flag.Parse()

	if *username == "" || *fullName == "" {
		flag.Usage()
		os.Exit(2)
	}
	switch domain.AdminRole(*role) {
	case domain.RoleSuperadmin, domain.RoleStaff, domain.RoleFinance, domain.RoleReviewer:
	default:
		log.Fatalf("invalid role %q", *role)
	}

	password := os.Getenv("ADMIN_PASSWORD")
	if password == "" {
		fmt.Fprint(os.Stderr, "Password (min 12 chars): ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		password = strings.TrimRight(line, "\r\n")
	}
	if len(password) < minPasswordLen || len(password) > 72 {
		log.Fatalf("password must be %d–72 characters", minPasswordLen)
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := repository.NewPool(ctx, repository.DefaultPoolConfig(cfg.DSN()))
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	hash, err := service.HashPassword(password)
	if err != nil {
		log.Fatal(err)
	}

	id, err := saveAdmin(ctx, pool, *username, hash, *fullName, *role)
	if err != nil {
		log.Fatalf("save admin: %v", err)
	}
	log.Printf("Admin %q saved (id %d) with role %s; audit entry %s written", *username, id, *role, domain.AuditAdminCLIUpsert)
}

// txBeginner is satisfied by *pgxpool.Pool (and by pgx.Tx, for tests that run inside one).
type txBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// saveAdmin creates the account, or re-activates it with the new password, name and role, and
// writes the matching audit_logs row in the same transaction. Bumping updated_at also invalidates
// every token issued to the account before now (AuthService.Authenticate).
func saveAdmin(ctx context.Context, db txBeginner, username, passwordHash, fullName, role string) (int64, error) {
	details, err := json.Marshal(map[string]any{"role": role, "fullName": fullName})
	if err != nil {
		return 0, fmt.Errorf("marshal audit details: %w", err)
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO admins (username, password_hash, full_name, role, is_active)
		VALUES ($1, $2, $3, $4, true)
		ON CONFLICT (username) DO UPDATE
		SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name,
		    role = EXCLUDED.role, is_active = true, updated_at = now()
		RETURNING id
	`, username, passwordHash, fullName, role).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert admin: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, id, string(domain.AuditAdminCLIUpsert), domain.AuditTargetAdmin, username, details, cliIP); err != nil {
		return 0, fmt.Errorf("insert audit log: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return id, nil
}
