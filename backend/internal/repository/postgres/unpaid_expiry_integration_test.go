package postgres_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations applied.
//
// The sweep is global, so the test runs on a fake clock in January 2000: every cutoff it passes is
// far older than any real row, and only the rows seeded here can match.
func TestPostgres_ExpireOverdueUnpaidHonoursBothCutoffs(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "561", "f1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)

	now := time.Date(2000, 1, 20, 12, 0, 0, 0, time.UTC)
	createdCutoff := now.Add(-120 * time.Hour)
	graceCutoff := now.Add(-24 * time.Hour)
	old := now.Add(-130 * time.Hour)

	type tc struct {
		name       string
		status     domain.ApplicationStatus
		created    time.Time
		updated    time.Time
		slip       domain.PaymentStatus
		slipAt     time.Time
		wantExpire bool
	}
	cases := []tc{
		{name: "created at createdCutoff", status: domain.StatusPassed, created: createdCutoff, updated: createdCutoff, wantExpire: true},
		{name: "created 1m after createdCutoff", status: domain.StatusPassed, created: createdCutoff.Add(time.Minute), updated: createdCutoff.Add(time.Minute), wantExpire: false},
		{name: "updated 1h after graceCutoff", status: domain.StatusPassed, created: old, updated: graceCutoff.Add(time.Hour), wantExpire: false},
		{name: "updated 1h before graceCutoff", status: domain.StatusPassed, created: old, updated: graceCutoff.Add(-time.Hour), wantExpire: true},
		{name: "slip rejected after graceCutoff", status: domain.StatusPassed, created: old, updated: old, slip: domain.PaymentRejected, slipAt: graceCutoff.Add(time.Hour), wantExpire: false},
		{name: "slip rejected before graceCutoff", status: domain.StatusPassed, created: old, updated: old, slip: domain.PaymentRejected, slipAt: graceCutoff.Add(-time.Hour), wantExpire: true},
		{name: "PENDING slip", status: domain.StatusPassed, created: old, updated: old, slip: domain.PaymentPending, slipAt: old.Add(time.Hour), wantExpire: false},
		{name: "APPROVED slip", status: domain.StatusPassed, created: old, updated: old, slip: domain.PaymentApproved, slipAt: old.Add(time.Hour), wantExpire: false},
		{name: "CONFIRMED", status: domain.StatusConfirmed, created: old, updated: old, wantExpire: false},
	}

	byNo := map[string]tc{}
	for i, c := range cases {
		a := newApplicant(i+1, tag)
		a.Status = c.status
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
		if c.slip != "" {
			h := hashOf(ht, i+1)
			p := &domain.Payment{ID: uuid.New(), ApplicantID: a.ID, SlipURL: fmt.Sprintf("slips/%s.jpg", h), Amount: decimal.NewFromInt(1000), Status: c.slip, SlipHash: &h}
			if err := pay.Create(ctx, p); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE payments SET uploaded_at = $2, verified_at = $3 WHERE id = $1`, p.ID, c.slipAt.Add(-time.Hour), c.slipAt); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(ctx, `UPDATE applicants SET created_at = $2, updated_at = $3 WHERE id = $1`, a.ID, c.created, c.updated); err != nil {
			t.Fatal(err)
		}
		byNo[a.ApplicationNo] = c
	}

	expired, err := repo.ExpireOverdueUnpaid(ctx, createdCutoff, graceCutoff, "integration test")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, no := range expired {
		if _, ours := byNo[no]; !ours {
			t.Errorf("the fake-clock sweep expired a row it did not seed: %s", no)
		}
		got[no] = true
	}
	for no, c := range byNo {
		if got[no] != c.wantExpire {
			t.Errorf("%s: expired=%v, want %v", c.name, got[no], c.wantExpire)
		}
	}
}
