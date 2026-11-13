package main

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
)

// Needs a database with migrations 000001-000007 applied (TEST_DATABASE_DSN, as for
// internal/repository/postgres); skipped otherwise.
func TestSaveAdmin_WritesAccountAndAuditInOneTransaction(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_DSN")
	if dsn == "" {
		t.Skip("Skipping: TEST_DATABASE_DSN is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := repository.NewPool(ctx, repository.DefaultPoolConfig(dsn))
	if err != nil {
		t.Skipf("Skipping: PostgreSQL not available (%v)", err)
	}
	// Registered first so it runs last: the row cleanup below still needs the pool.
	t.Cleanup(pool.Close)

	username := "cli-" + uuid.NewString()[:8]
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM audit_logs WHERE target_type = 'admin' AND target_id = $1`, username)
		_, _ = pool.Exec(context.Background(), `DELETE FROM admins WHERE username = $1`, username)
	})

	id, err := saveAdmin(ctx, pool, username, "$2a$12$hash-one", "พี่ทดสอบ", string(domain.RoleAdmin))
	if err != nil {
		t.Fatal(err)
	}
	var firstUpdated time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM admins WHERE id = $1`, id).Scan(&firstUpdated); err != nil {
		t.Fatal(err)
	}

	// Running it again resets the same account and writes a second audit row.
	id2, err := saveAdmin(ctx, pool, username, "$2a$12$hash-two", "พี่ทดสอบ ใหม่", string(domain.RoleAdmin))
	if err != nil {
		t.Fatal(err)
	}
	if id2 != id {
		t.Fatalf("upsert returned id %d, want %d", id2, id)
	}
	var hash, role string
	var updated time.Time
	if err := pool.QueryRow(ctx, `SELECT password_hash, role, updated_at FROM admins WHERE id = $1`, id).Scan(&hash, &role, &updated); err != nil {
		t.Fatal(err)
	}
	if hash != "$2a$12$hash-two" || role != string(domain.RoleAdmin) || updated.Before(firstUpdated) {
		t.Fatalf("account not reset: hash=%q role=%q updated=%v (was %v)", hash, role, updated, firstUpdated)
	}

	rows, err := pool.Query(ctx, `SELECT admin_id, action, details, ip_address FROM audit_logs WHERE target_type = 'admin' AND target_id = $1 ORDER BY id`, username)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type detail struct {
		Role     string `json:"role"`
		FullName string `json:"fullName"`
	}
	want := []detail{{string(domain.RoleAdmin), "พี่ทดสอบ"}, {string(domain.RoleAdmin), "พี่ทดสอบ ใหม่"}}
	n := 0
	for rows.Next() {
		var adminID *int64
		var action, ip string
		var raw []byte
		if err := rows.Scan(&adminID, &action, &raw, &ip); err != nil {
			t.Fatal(err)
		}
		var d detail
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		if n >= len(want) || adminID == nil || *adminID != id || action != string(domain.AuditAdminCLIUpsert) || ip != cliIP || d != want[n] {
			t.Fatalf("audit row %d: admin_id=%v action=%q ip=%q details=%+v", n, adminID, action, ip, d)
		}
		n++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected 2 audit rows, got %d", n)
	}
}
