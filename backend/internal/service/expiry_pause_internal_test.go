package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
)

// fireHardCeiling makes distinct clean clients send unknown codes until the global hard ceiling is
// reached at the guard's current time.
func fireHardCeiling(t *testing.T, g *CodeGuard) {
	t.Helper()
	for i := 0; i < CodeGlobalHardCeiling; i++ {
		_ = lookup(g, fmt.Sprintf("198.51.100.%d", i+1), codeMiss)
	}
	if g.LastHardCeilingAt().IsZero() {
		t.Fatal("the hard ceiling should have fired")
	}
}

// R23: while the code guard's hard ceiling fired within 24h, slip uploads may have been refused for
// everyone, so the unpaid-expiry sweep must not release seats. Once 24h have passed it resumes.
func TestExpireOverdueUnpaid_PausedWhileCodeCeilingFiredRecently(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	guard, clock, audit := newTestCodeGuard(CodeGuardConfig{})
	created := clock.Now()
	svc := NewApplicantService(appRepo, memory.NewMemorySettingRepo(), payRepo).
		WithCodeGuard(guard).
		WithNow(clock.Now)

	res, err := svc.Submit(ctx, ApplicationCreateRequest{
		FullName: "สมชาย ทดสอบ", Nickname: "ชาย", Phone: "0830009001", Email: "pause@test.com",
		School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "L",
	})
	if err != nil {
		t.Fatalf("submit: %v", err)
	}

	// The flood happens on the last day of the payment window.
	clock.Advance(119 * time.Hour)
	fireHardCeiling(t, guard)
	if n := len(audit.byAction(domain.AuditCodeGuessCeiling)); n != 2 {
		t.Fatalf("expected soft + hard ceiling audit rows, got %d", n)
	}

	// +121h: overdue, but the ceiling fired 2h ago -> nothing is released.
	expired, err := svc.ExpireOverdueUnpaid(ctx, created.Add(121*time.Hour))
	if err != nil || len(expired) != 0 {
		t.Fatalf("expected the sweep to pause (0 released, nil error), got %v, %v", expired, err)
	}
	if a, _ := appRepo.GetByApplicationNo(ctx, res.ID); a.Status != domain.StatusPassed {
		t.Fatalf("the seat must be kept during the pause, status %s", a.Status)
	}

	// Just under 24h after the ceiling: still paused.
	if expired, _ := svc.ExpireOverdueUnpaid(ctx, created.Add(119*time.Hour+ExpiryPauseAfterCodeCeiling-time.Minute)); len(expired) != 0 {
		t.Fatalf("still within 24h of the ceiling: expected no release, got %v", expired)
	}

	// More than 24h after the ceiling last fired: the sweep proceeds.
	expired, err = svc.ExpireOverdueUnpaid(ctx, created.Add(119*time.Hour+ExpiryPauseAfterCodeCeiling+time.Minute))
	if err != nil || len(expired) != 1 || expired[0] != res.ID {
		t.Fatalf("expected %s to expire once the pause is over, got %v, %v", res.ID, expired, err)
	}
}

func TestCodeGuard_LastHardCeilingAt(t *testing.T) {
	var none *CodeGuard
	if !none.LastHardCeilingAt().IsZero() {
		t.Fatal("a nil guard never reports a ceiling (no pause)")
	}
	g, clock, _ := newTestCodeGuard(CodeGuardConfig{})
	if !g.LastHardCeilingAt().IsZero() {
		t.Fatal("no ceiling yet")
	}
	// The soft ceiling alone does not count.
	for i := 0; i < CodeGlobalSoftCeiling; i++ {
		_ = lookup(g, fmt.Sprintf("203.0.113.%d", i+1), codeMiss)
	}
	if !g.LastHardCeilingAt().IsZero() {
		t.Fatal("the soft ceiling must not pause the expiry sweep")
	}
	fireAt := clock.Now()
	fireHardCeiling(t, g)
	if got := g.LastHardCeilingAt(); !got.Equal(fireAt) {
		t.Fatalf("LastHardCeilingAt = %v, want %v", got, fireAt)
	}
	// A later flood moves it forward.
	clock.Advance(time.Hour)
	fireHardCeiling(t, g)
	if got := g.LastHardCeilingAt(); !got.Equal(fireAt.Add(time.Hour)) {
		t.Fatalf("LastHardCeilingAt = %v, want the later flood", got)
	}
}

// F1: with the 1h cap a single client sending unknown codes all day gets about 120 guesses.
func TestCodeGuard_SingleClientDailyGuessBudget(t *testing.T) {
	g, clock, _ := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1 << 20, GlobalHardCeiling: 1 << 20})
	misses := 0
	for minute := 0; minute < 24*60; minute++ {
		for {
			ran := false
			_ = lookup(g, "198.51.100.200", func() error { ran = true; return domain.ErrNotFound })
			if !ran {
				break
			}
			misses++
		}
		clock.Advance(time.Minute)
	}
	if misses < 100 || misses > 135 {
		t.Fatalf("single client got %d guesses in 24h, want about 120", misses)
	}
	t.Logf("single client, 24h: %d guesses", misses)
}
