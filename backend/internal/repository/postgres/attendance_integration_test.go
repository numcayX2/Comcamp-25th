package postgres_test

// Run against a database with migrations 000001-000006 applied, for example:
//   TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=... dbname=comcamp_db sslmode=disable" go test ./internal/repository/postgres/

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// LOW-04: the status guard is part of the UPDATE, and the audit row commits with the answer.
func TestPostgres_UpdateAttendanceGuardAndAudit(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "541"
	cleanupApplicants(t, pool, tag)

	a := seedApplicant(t, pool, repo, 1, tag) // PASSED
	audit := func(confirmed bool) *domain.AuditEntry {
		return &domain.AuditEntry{
			Action: domain.AuditAttendanceConfirm, TargetType: domain.AuditTargetApplicant, TargetID: a.ApplicationNo,
			Details: map[string]any{"confirmed": confirmed}, IPAddress: "203.0.113.9",
		}
	}
	type row struct {
		confirmed bool
		status    string
		ip        string
	}
	readAudits := func() []row {
		t.Helper()
		rows, err := pool.Query(ctx, `SELECT details, ip_address FROM audit_logs WHERE action = $1 AND target_id = $2 ORDER BY id`,
			string(domain.AuditAttendanceConfirm), a.ApplicationNo)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []row
		for rows.Next() {
			var raw []byte
			var ip string
			if err := rows.Scan(&raw, &ip); err != nil {
				t.Fatal(err)
			}
			var d struct {
				Confirmed bool   `json:"confirmed"`
				Status    string `json:"status"`
			}
			if err := json.Unmarshal(raw, &d); err != nil {
				t.Fatal(err)
			}
			out = append(out, row{d.Confirmed, d.Status, ip})
		}
		return out
	}

	if err := repo.UpdateAttendance(ctx, a.ID, true, audit(true)); err != nil {
		t.Fatalf("PASSED: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE applicants SET status = 'CONFIRMED' WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateAttendance(ctx, a.ID, false, audit(false)); err != nil {
		t.Fatalf("CONFIRMED: %v", err)
	}
	got := readAudits()
	want := []row{{true, "PASSED", "203.0.113.9"}, {false, "CONFIRMED", "203.0.113.9"}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("audit rows = %+v, want %+v", got, want)
	}

	// Staff rejected it after the service's read: refused, nothing written.
	if _, err := pool.Exec(ctx, `UPDATE applicants SET status = 'REJECTED' WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateAttendance(ctx, a.ID, true, audit(true)); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("REJECTED: expected ErrStateConflict, got %v", err)
	}
	var confirmed bool
	if err := pool.QueryRow(ctx, `SELECT attendance_confirmed FROM applicants WHERE id = $1`, a.ID).Scan(&confirmed); err != nil {
		t.Fatal(err)
	}
	if confirmed {
		t.Fatal("refused write changed attendance_confirmed")
	}
	if n := len(readAudits()); n != 2 {
		t.Fatalf("refused write left an audit row (%d rows)", n)
	}

	// Deleted: not found.
	if _, err := pool.Exec(ctx, `UPDATE applicants SET deleted_at = now() WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateAttendance(ctx, a.ID, true, audit(true)); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted: expected ErrNotFound, got %v", err)
	}
}
