package postgres_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001-000006 applied.

func TestPostgres_VerifyRefusesDeletedApplicant(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "511", "b1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	for i, approved := range []bool{true, false} {
		a := seedApplicant(t, pool, repo, i, tag)
		p := slipFor(a.ID, hashOf(ht, i))
		if _, err := pay.CreateReplacingPending(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := repo.SoftDelete(ctx, a.ID, &admin.ID, "duplicate", nil); err != nil {
			t.Fatal(err)
		}
		if err := pay.Verify(ctx, p.ID, approved, admin.ID, "x", nil); !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("approved=%v: want ErrStateConflict, got %v", approved, err)
		}
		if got := payStatuses(t, pool, a.ID); got[domain.PaymentPending] != 1 || len(got) != 1 {
			t.Fatalf("approved=%v: the slip must stay PENDING, got %v", approved, got)
		}
	}
}

func TestPostgres_SelfWithdrawRechecksUnderTheLock(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "512", "b2"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	pending := seedApplicant(t, pool, repo, 1, tag)
	if _, err := pay.CreateReplacingPending(ctx, slipFor(pending.ID, hashOf(ht, 1))); err != nil {
		t.Fatal(err)
	}
	approved := seedApplicant(t, pool, repo, 2, tag)
	ap := slipFor(approved.ID, hashOf(ht, 2))
	if _, err := pay.CreateReplacingPending(ctx, ap); err != nil {
		t.Fatal(err)
	}
	if err := pay.Verify(ctx, ap.ID, true, admin.ID, "ok", nil); err != nil {
		t.Fatal(err)
	}
	confirmed := seedApplicant(t, pool, repo, 3, tag)
	if err := repo.UpdateStatus(ctx, confirmed.ID, domain.StatusConfirmed, &admin.ID, "cash", nil); err != nil {
		t.Fatal(err)
	}
	rejected := seedApplicant(t, pool, repo, 4, tag)
	if err := repo.UpdateStatus(ctx, rejected.ID, domain.StatusRejected, &admin.ID, "x", nil); err != nil {
		t.Fatal(err)
	}
	for name, a := range map[string]*domain.Applicant{"pending slip": pending, "approved slip": approved, "confirmed": confirmed, "rejected": rejected} {
		if err := repo.SoftDelete(ctx, a.ID, nil, "เปลี่ยนใจ", nil); !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("%s: want ErrStateConflict, got %v", name, err)
		}
		if _, err := repo.GetByApplicationNo(ctx, a.ApplicationNo); err != nil {
			t.Fatalf("%s: the application must survive: %v", name, err)
		}
	}

	rs := seedApplicant(t, pool, repo, 5, tag)
	rp := slipFor(rs.ID, hashOf(ht, 5))
	if _, err := pay.CreateReplacingPending(ctx, rp); err != nil {
		t.Fatal(err)
	}
	if err := pay.Verify(ctx, rp.ID, false, admin.ID, "no", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, rs.ID, nil, "เปลี่ยนใจ", nil); err != nil {
		t.Fatalf("only a rejected slip: withdrawal goes through, got %v", err)
	}
	if err := repo.SoftDelete(ctx, pending.ID, &admin.ID, "duplicate", nil); err != nil {
		t.Fatalf("a staff delete is not a self-service withdrawal: %v", err)
	}
}

// Withdrawal and slip upload of the same applicant at the same moment: one of them wins, cleanly.
func TestPostgres_WithdrawRacesWithUpload(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "513", "b3"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)

	wins := map[string]int{}
	for round := 0; round < 40; round++ {
		a := seedApplicant(t, pool, repo, round, tag)
		var wg sync.WaitGroup
		var wErr, uErr error
		wg.Add(2)
		go func() { defer wg.Done(); wErr = repo.SoftDelete(ctx, a.ID, nil, "x", nil) }()
		go func() { defer wg.Done(); _, uErr = pay.CreateReplacingPending(ctx, slipFor(a.ID, hashOf(ht, round))) }()
		wg.Wait()
		switch {
		case wErr == nil && errors.Is(uErr, domain.ErrNotFound):
			wins["withdraw"]++
			if got := payStatuses(t, pool, a.ID); len(got) != 0 {
				t.Fatalf("round %d: no slip may land on a withdrawn application, got %v", round, got)
			}
		case errors.Is(wErr, domain.ErrStateConflict) && uErr == nil:
			wins["upload"]++
			if _, err := repo.GetByApplicationNo(ctx, a.ApplicationNo); err != nil {
				t.Fatalf("round %d: the application with a fresh slip must survive: %v", round, err)
			}
		default:
			t.Fatalf("round %d: withdraw=%v upload=%v", round, wErr, uErr)
		}
	}
	t.Logf("winners over 40 rounds: %v", wins)
}

func TestPostgres_PlainUpdateStatusRefusesToRetakeASeat(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "514"
	cleanupApplicants(t, pool, tag)
	admin := seedAdmin(t, pool)

	a := seedApplicant(t, pool, repo, 1, tag)
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusRejected, &admin.ID, "admin 2", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusConfirmed, &admin.ID, "admin 1", nil); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("REJECTED -> CONFIRMED without the quota lock must be refused, got %v", err)
	}
	got, _ := repo.GetByApplicationNo(ctx, a.ApplicationNo)
	if got.Status != domain.StatusRejected {
		t.Fatalf("the refused change must leave REJECTED, got %s", got.Status)
	}
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusRefunded, &admin.ID, "x", nil); err != nil {
		t.Fatalf("seatless -> seatless needs no quota lock: %v", err)
	}
	if err := repo.UpdateStatusWithinCapacity(ctx, a.ID, domain.StatusPassed, &admin.ID, "x", nil, 100_000); err != nil {
		t.Fatalf("the quota-checked path may take the seat back: %v", err)
	}
}

// Migration 000005: the unique index ignores REJECTED rows, and the pre-check agrees with it.
func TestPostgres_SlipHashIsFreedByRejectionOnly(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "515", "b5"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)
	h := hashOf(ht, 1)
	dup := func() bool {
		t.Helper()
		d, err := pay.CheckDuplicateSlipHash(ctx, h)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}

	mine := seedApplicant(t, pool, repo, 1, tag)
	other := seedApplicant(t, pool, repo, 2, tag)
	first := slipFor(mine.ID, h)
	if _, err := pay.CreateReplacingPending(ctx, first); err != nil {
		t.Fatal(err)
	}
	if !dup() {
		t.Fatal("PENDING holds the hash")
	}
	// CreateReplacingPending has no pre-check of its own: this is the unique index refusing.
	if _, err := pay.CreateReplacingPending(ctx, slipFor(other.ID, h)); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("a PENDING slip's image must be refused by the index, got %v", err)
	}

	if err := pay.Verify(ctx, first.ID, false, admin.ID, "blurry", nil); err != nil {
		t.Fatal(err)
	}
	if dup() {
		t.Fatal("REJECTED must not hold the hash")
	}
	again := slipFor(mine.ID, h)
	if _, err := pay.CreateReplacingPending(ctx, again); err != nil {
		t.Fatalf("the same image after a rejection must be accepted, got %v", err)
	}
	if _, err := pay.CreateReplacingPending(ctx, slipFor(other.ID, h)); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("the re-sent PENDING slip blocks the image again, got %v", err)
	}
	if err := pay.Verify(ctx, again.ID, true, admin.ID, "ok", nil); err != nil {
		t.Fatal(err)
	}
	if !dup() {
		t.Fatal("APPROVED holds the hash")
	}
	if _, err := pay.CreateReplacingPending(ctx, slipFor(other.ID, h)); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("an approved slip's image must be refused, got %v", err)
	}
	if got := payStatuses(t, pool, mine.ID); got[domain.PaymentRejected] != 1 || got[domain.PaymentApproved] != 1 {
		t.Fatalf("want 1 REJECTED + 1 APPROVED with the same hash, got %v", got)
	}
}
