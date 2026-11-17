package memory_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

// The repository applies exactly the two cutoffs the service hands it: created_at against
// createdCutoff and updated_at / the latest REJECTED slip against graceCutoff. It must not derive
// one from the other (a hard-coded offset is what let the grace drift when the window changed).
func TestMemoryExpireOverdueUnpaid_HonoursBothCutoffs(t *testing.T) {
	ctx := context.Background()
	apps, pays := newRepos()
	now := time.Now().UTC().Truncate(time.Second)
	createdCutoff := now.Add(-120 * time.Hour)
	graceCutoff := now.Add(-24 * time.Hour)

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
		{name: "updated 1h after graceCutoff", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: graceCutoff.Add(time.Hour), wantExpire: false},
		{name: "updated 1h before graceCutoff", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: graceCutoff.Add(-time.Hour), wantExpire: true},
		{name: "slip rejected after graceCutoff", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: now.Add(-130 * time.Hour), slip: domain.PaymentRejected, slipAt: graceCutoff.Add(time.Hour), wantExpire: false},
		{name: "slip rejected before graceCutoff", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: now.Add(-130 * time.Hour), slip: domain.PaymentRejected, slipAt: graceCutoff.Add(-time.Hour), wantExpire: true},
		{name: "PENDING slip", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: now.Add(-130 * time.Hour), slip: domain.PaymentPending, slipAt: now.Add(-129 * time.Hour), wantExpire: false},
		{name: "APPROVED slip", status: domain.StatusPassed, created: now.Add(-130 * time.Hour), updated: now.Add(-130 * time.Hour), slip: domain.PaymentApproved, slipAt: now.Add(-129 * time.Hour), wantExpire: false},
		{name: "CONFIRMED", status: domain.StatusConfirmed, created: now.Add(-130 * time.Hour), updated: now.Add(-130 * time.Hour), wantExpire: false},
	}

	byNo := map[string]tc{}
	for i, c := range cases {
		a := addApplicant(t, apps, 700+i, c.status)
		if c.slip != "" {
			p := &domain.Payment{ID: uuid.New(), ApplicantID: a.ID, SlipURL: "slips/x.jpg", Amount: decimal.NewFromInt(1000), Status: c.slip}
			if err := pays.Create(ctx, p); err != nil {
				t.Fatal(err)
			}
			at := c.slipAt
			if err := pays.SetPaymentTimestampsForTest(p.ID, at.Add(-time.Hour), &at); err != nil {
				t.Fatal(err)
			}
		}
		if err := apps.SetTimestampsForTest(a.ID, c.created, c.updated); err != nil {
			t.Fatal(err)
		}
		byNo[a.ApplicationNo] = c
	}

	expired, err := apps.ExpireOverdueUnpaid(ctx, createdCutoff, graceCutoff, "test")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, no := range expired {
		got[no] = true
	}
	for no, c := range byNo {
		if got[no] != c.wantExpire {
			t.Errorf("%s: expired=%v, want %v", c.name, got[no], c.wantExpire)
		}
	}
}
