package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
	"comcamp25-backend/internal/service"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001-000006 applied.

func slipFor(applicantID uuid.UUID, hash string) *domain.Payment {
	h := hash
	return &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: applicantID,
		SlipURL:     "slips/" + hash + ".jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		SlipHash:    &h,
	}
}

func hashOf(tag string, n int) string { return fmt.Sprintf("%s%0*d", tag, 64-len(tag), n) }

func payStatuses(t *testing.T, pool *pgxpool.Pool, applicantID uuid.UUID) map[domain.PaymentStatus]int {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT status, count(*) FROM payments WHERE applicant_id = $1 GROUP BY status`, applicantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[domain.PaymentStatus]int{}
	for rows.Next() {
		var st domain.PaymentStatus
		var n int
		if err := rows.Scan(&st, &n); err != nil {
			t.Fatal(err)
		}
		out[st] = n
	}
	return out
}

func seedApplicant(t *testing.T, pool *pgxpool.Pool, repo *postgres.ApplicantPostgresRepo, i int, tag string) *domain.Applicant {
	t.Helper()
	a := newApplicant(i, tag)
	a.Status = domain.StatusPassed
	if err := repo.Create(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	return a
}

func seedAdmin(t *testing.T, pool *pgxpool.Pool) *domain.Admin {
	t.Helper()
	hash, err := service.HashPassword("integration-test-only")
	if err != nil {
		t.Fatal(err)
	}
	admin := &domain.Admin{Username: "slip-" + uuid.NewString()[:8], PasswordHash: hash, FullName: "slip test", Role: domain.RoleAdmin, IsActive: true}
	if err := postgres.NewAdminPostgresRepo(pool).Create(context.Background(), admin); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE payments SET verified_by_admin_id = NULL WHERE verified_by_admin_id = $1`, admin.ID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM admins WHERE id = $1`, admin.ID)
	})
	return admin
}

func cleanupSlips(t *testing.T, pool *pgxpool.Pool, hashTag string) {
	t.Helper()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM payments WHERE slip_hash LIKE $1`, hashTag+"%")
	})
}

func TestPostgres_CreateReplacingPendingKeepsOnePendingSlip(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "491", "a1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	a := seedApplicant(t, pool, repo, 1, tag)

	var prev *domain.Payment
	for i := 1; i <= 5; i++ {
		p := slipFor(a.ID, hashOf(ht, i))
		old, err := pay.CreateReplacingPending(ctx, p)
		if err != nil {
			t.Fatalf("upload %d: %v", i, err)
		}
		if i == 1 && len(old) != 0 {
			t.Fatalf("first upload supersedes nothing, got %d", len(old))
		}
		if i > 1 && (len(old) != 1 || old[0].ID != prev.ID || old[0].SlipURL != prev.SlipURL) {
			t.Fatalf("upload %d should return the previous slip %s, got %v", i, prev.ID, old)
		}
		prev = p
		if got := payStatuses(t, pool, a.ID); got[domain.PaymentPending] != 1 || len(got) != 1 {
			t.Fatalf("after upload %d: want a single PENDING row, got %v", i, got)
		}
	}
	if latest, _ := pay.GetLatestByApplicantID(ctx, a.ID); latest.ID != prev.ID {
		t.Fatal("the newest upload must be the latest slip")
	}
	// A replaced slip's hash is free (the unique index no longer holds it).
	if dup, _ := pay.CheckDuplicateSlipHash(ctx, hashOf(ht, 1)); dup {
		t.Fatal("the hash of a deleted pending slip must be free again")
	}
	if _, err := pay.CreateReplacingPending(ctx, slipFor(a.ID, hashOf(ht, 1))); err != nil {
		t.Fatalf("re-sending a replaced slip: %v", err)
	}
}

func TestPostgres_CreateReplacingPendingRefusesAfterApprovalAndKeepsRejected(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "492", "a2"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	a := seedApplicant(t, pool, repo, 1, tag)

	first := slipFor(a.ID, hashOf(ht, 1))
	if _, err := pay.CreateReplacingPending(ctx, first); err != nil {
		t.Fatal(err)
	}
	// Rejected slips stay as history; the next upload adds a PENDING row next to them.
	admin := seedAdmin(t, pool)
	if err := pay.Verify(ctx, first.ID, false, admin.ID, "blurry", nil); err != nil {
		t.Fatal(err)
	}
	second := slipFor(a.ID, hashOf(ht, 2))
	if _, err := pay.CreateReplacingPending(ctx, second); err != nil {
		t.Fatal(err)
	}
	if got := payStatuses(t, pool, a.ID); got[domain.PaymentRejected] != 1 || got[domain.PaymentPending] != 1 {
		t.Fatalf("want 1 REJECTED + 1 PENDING, got %v", got)
	}

	// Once a slip is approved nothing replaces it, and the refused upload changes nothing.
	if err := pay.Verify(ctx, second.ID, true, admin.ID, "ok", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := pay.CreateReplacingPending(ctx, slipFor(a.ID, hashOf(ht, 3))); !errors.Is(err, domain.ErrPaymentAlreadyVerified) {
		t.Fatalf("upload after approval: expected ErrPaymentAlreadyVerified, got %v", err)
	}
	if got := payStatuses(t, pool, a.ID); got[domain.PaymentRejected] != 1 || got[domain.PaymentApproved] != 1 || len(got) != 2 {
		t.Fatalf("a refused upload must leave the rows as they were, got %v", got)
	}
}

// A refused upload must roll back completely: the delete of the old pending slip is undone.
func TestPostgres_CreateReplacingPendingRollsBackOnDuplicateHash(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "493", "a3"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	a1 := seedApplicant(t, pool, repo, 1, tag)
	a2 := seedApplicant(t, pool, repo, 2, tag)

	mine := slipFor(a1.ID, hashOf(ht, 1))
	theirs := slipFor(a2.ID, hashOf(ht, 2))
	for _, p := range []*domain.Payment{mine, theirs} {
		if _, err := pay.CreateReplacingPending(ctx, p); err != nil {
			t.Fatal(err)
		}
	}

	// a1 uploads the image that a2 already has pending: refused, and a1's own pending slip survives.
	_, err := pay.CreateReplacingPending(ctx, slipFor(a1.ID, hashOf(ht, 2)))
	if !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("expected ErrDuplicateSlipHash, got %v", err)
	}
	got, err := pay.GetLatestByApplicantID(ctx, a1.ID)
	if err != nil || got.ID != mine.ID || got.Status != domain.PaymentPending {
		t.Fatalf("the refused upload must not delete the existing pending slip, got %v / %v", got, err)
	}
}

func TestPostgres_CreateReplacingPendingConcurrentUploadsLeaveOne(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "494", "a4"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	a := seedApplicant(t, pool, repo, 1, tag)

	const n = 16
	var wg sync.WaitGroup
	errs := make([]error, n)
	removed := make([][]*domain.Payment, n)
	created := make([]*domain.Payment, n)
	for i := 0; i < n; i++ {
		created[i] = slipFor(a.ID, hashOf(ht, i+1))
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			removed[i], errs[i] = pay.CreateReplacingPending(ctx, created[i])
		}(i)
	}
	wg.Wait()
	totalRemoved := 0
	for i := range errs {
		if errs[i] != nil {
			t.Fatalf("upload %d: %v", i, errs[i])
		}
		totalRemoved += len(removed[i])
	}
	if got := payStatuses(t, pool, a.ID); got[domain.PaymentPending] != 1 || len(got) != 1 {
		t.Fatalf("%d racing uploads must leave exactly one PENDING row, got %v", n, got)
	}
	if totalRemoved != n-1 {
		t.Fatalf("every upload but the survivor must be reported superseded exactly once: %d of %d", totalRemoved, n-1)
	}
}

// Admin approval and an applicant re-upload at the same moment: either the approval wins and the
// upload is refused, or the upload wins and the approval finds its slip gone. Never both.
func TestPostgres_ApproveRacesWithReupload(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "495", "a5"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)

	admin := seedAdmin(t, pool)

	for round := 0; round < 25; round++ {
		a := seedApplicant(t, pool, repo, 100+round, tag)
		first := slipFor(a.ID, hashOf(ht, round*10+1))
		if _, err := pay.CreateReplacingPending(ctx, first); err != nil {
			t.Fatal(err)
		}
		second := slipFor(a.ID, hashOf(ht, round*10+2))

		var wg sync.WaitGroup
		var verifyErr, uploadErr error
		wg.Add(2)
		go func() { defer wg.Done(); verifyErr = pay.Verify(ctx, first.ID, true, admin.ID, "ok", nil) }()
		go func() { defer wg.Done(); _, uploadErr = pay.CreateReplacingPending(ctx, second) }()
		wg.Wait()

		got := payStatuses(t, pool, a.ID)
		switch {
		case verifyErr == nil && errors.Is(uploadErr, domain.ErrPaymentAlreadyVerified):
			if got[domain.PaymentApproved] != 1 || got[domain.PaymentPending] != 0 {
				t.Fatalf("round %d: approval won, want 1 APPROVED and no PENDING, got %v", round, got)
			}
		case errors.Is(verifyErr, domain.ErrNotFound) && uploadErr == nil:
			if got[domain.PaymentApproved] != 0 || got[domain.PaymentPending] != 1 {
				t.Fatalf("round %d: upload won, want 1 PENDING and no APPROVED, got %v", round, got)
			}
		case verifyErr == nil && uploadErr == nil:
			// Verify committed first, then the upload saw APPROVED... that is the first case; the only
			// other way both succeed is an approved row next to a new pending one.
			t.Fatalf("round %d: both succeeded, rows %v: an approved slip must never be followed by a pending one", round, got)
		default:
			t.Fatalf("round %d: unexpected outcome verify=%v upload=%v rows=%v", round, verifyErr, uploadErr, got)
		}
	}
}

func TestPostgres_GetLatestByApplicantIDs(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "495", "a5"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	a1 := seedApplicant(t, pool, repo, 1, tag)
	a2 := seedApplicant(t, pool, repo, 2, tag)

	empty, err := pay.GetLatestByApplicantIDs(ctx, nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("expected empty map for nil slice, got %v / %v", empty, err)
	}

	first := slipFor(a1.ID, hashOf(ht, 1))
	if err := pay.Create(ctx, first); err != nil {
		t.Fatal(err)
	}
	second := slipFor(a1.ID, hashOf(ht, 2))
	if err := pay.Create(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE payments SET uploaded_at = uploaded_at + interval '5 seconds' WHERE id = $1`, second.ID); err != nil {
		t.Fatal(err)
	}

	got, err := pay.GetLatestByApplicantIDs(ctx, []uuid.UUID{a1.ID, a2.ID})
	if err != nil {
		t.Fatalf("GetLatestByApplicantIDs failed: %v", err)
	}
	if p := got[a1.ID]; p == nil || p.ID != second.ID {
		t.Fatalf("expected latest payment %s for a1, got %+v", second.ID, p)
	}
	if p, ok := got[a2.ID]; ok {
		t.Fatalf("expected no payment entry for a2, got %+v", p)
	}
}
