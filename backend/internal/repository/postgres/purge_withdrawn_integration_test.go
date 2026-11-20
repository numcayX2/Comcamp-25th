package postgres_test

import (
	"context"
	"errors"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001-000013 applied.

// PurgeWithdrawn removes a self-withdrawn applicant with its payments and status logs, returns the
// slip URLs and writes the audit row; live and staff-deleted rows are refused and left intact.
func TestPostgres_PurgeWithdrawn(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "531", "d1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	self := seedApplicant(t, pool, repo, 1, tag)
	slip := slipFor(self.ID, hashOf(ht, 1))
	if _, err := pay.CreateReplacingPending(ctx, slip); err != nil {
		t.Fatal(err)
	}
	if err := pay.Verify(ctx, slip.ID, false, admin.ID, "blurry", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, self.ID, nil, "test", nil); err != nil {
		t.Fatal(err)
	}
	staff := seedApplicant(t, pool, repo, 2, tag)
	if err := repo.SoftDelete(ctx, staff.ID, &admin.ID, "duplicate", nil); err != nil {
		t.Fatal(err)
	}
	live := seedApplicant(t, pool, repo, 3, tag)

	audit := &domain.AuditEntry{AdminID: &admin.ID, Action: domain.AuditApplicantPurge, TargetType: domain.AuditTargetApplicant, TargetID: self.ApplicationNo}
	for _, a := range []*domain.Applicant{staff, live} {
		if _, err := repo.PurgeWithdrawn(ctx, a.ApplicationNo, audit); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("purge %s: expected ErrNotFound, got %v", a.ApplicationNo, err)
		}
	}

	urls, err := repo.PurgeWithdrawn(ctx, self.ApplicationNo, audit)
	if err != nil {
		t.Fatal(err)
	}
	if len(urls) != 1 || urls[0] != slip.SlipURL {
		t.Fatalf("expected the slip URL back, got %v", urls)
	}
	var applicants, payments, logs, audits int
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM applicants WHERE id = $1`, self.ID).Scan(&applicants)
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM payments WHERE applicant_id = $1`, self.ID).Scan(&payments)
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM applicant_status_logs WHERE applicant_id = $1`, self.ID).Scan(&logs)
	_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM audit_logs WHERE action = 'application.purge' AND target_id = $1`, self.ApplicationNo).Scan(&audits)
	if applicants != 0 || payments != 0 || logs != 0 || audits != 1 {
		t.Fatalf("expected the row, payments and logs gone and one audit row; got %d/%d/%d/%d", applicants, payments, logs, audits)
	}
	if _, err := repo.PurgeWithdrawn(ctx, self.ApplicationNo, audit); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second purge: expected ErrNotFound, got %v", err)
	}
	for _, a := range []*domain.Applicant{staff, live} {
		var n int
		_ = pool.QueryRow(ctx, `SELECT COUNT(*) FROM applicants WHERE id = $1`, a.ID).Scan(&n)
		if n != 1 {
			t.Fatalf("%s must be untouched", a.ApplicationNo)
		}
	}
}
