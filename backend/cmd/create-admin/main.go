// Command create-admin creates (or re-activates with a new password) a staff account in
// PostgreSQL with a bcrypt-hashed password (AGENTS.md §13.2). There are no default admin accounts.
//
//	cd backend
//	go run ./cmd/create-admin -username pee_somchai -name "พี่สมชาย" -role staff
//
// The password is read from the ADMIN_PASSWORD environment variable, or from the first line of
// stdin, so it never appears in shell history or the process list.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"comcamp25-backend/internal/config"
	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/service"
)

const minPasswordLen = 12

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

	tag, err := pool.Exec(ctx, `
		INSERT INTO admins (username, password_hash, full_name, role, is_active)
		VALUES ($1, $2, $3, $4, true)
		ON CONFLICT (username) DO UPDATE
		SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name,
		    role = EXCLUDED.role, is_active = true, updated_at = now()
	`, *username, hash, *fullName, *role)
	if err != nil {
		log.Fatalf("save admin: %v", err)
	}
	log.Printf("Admin %q saved (%d row) with role %s", *username, tag.RowsAffected(), *role)
}
