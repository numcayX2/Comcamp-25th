package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type recordingAudit struct {
	mu      sync.Mutex
	entries []domain.AuditEntry
}

func (r *recordingAudit) Log(_ context.Context, e *domain.AuditEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, *e)
	return nil
}

func (r *recordingAudit) count(action domain.AuditAction) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.entries {
		if e.Action == action {
			n++
		}
	}
	return n
}

func newTestGuard() (*VerifyGuard, *fakeClock, *recordingAudit) {
	clock := &fakeClock{now: time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)}
	audit := &recordingAudit{}
	return NewVerifyGuardWith(audit, VerifyGuardConfig{Now: clock.Now}), clock, audit
}

var (
	wrong = func() error { return ErrInvalidVerifyCode }
	right = func() error { return nil }
)

func check(g *VerifyGuard, app string, verify func() error) error {
	return g.Check(context.Background(), app, VerifyActionConfirm, "198.51.100.7", verify)
}

func TestVerifyGuard_LocksAfterMaxFailuresAndExpires(t *testing.T) {
	g, clock, audit := newTestGuard()

	for i := 1; i < MaxVerifyFailures; i++ {
		if err := check(g, "CC25-AAAAAA", wrong); err != ErrInvalidVerifyCode {
			t.Fatalf("failure %d: expected ErrInvalidVerifyCode unchanged, got %v", i, err)
		}
	}
	var locked *VerifyLockedError
	if err := check(g, "CC25-AAAAAA", wrong); !errors.As(err, &locked) || locked.RetryAfter != VerifyLockoutDuration {
		t.Fatalf("failure %d: expected a 15 minute lock, got %v", MaxVerifyFailures, err)
	}

	// While locked the answer is not even looked at.
	called := false
	clock.Advance(5 * time.Minute)
	err := check(g, "CC25-AAAAAA", func() error { called = true; return nil })
	if !errors.As(err, &locked) || called {
		t.Fatalf("expected the lock without calling verify, got %v (called=%v)", err, called)
	}
	if locked.RetryAfter != VerifyLockoutDuration-5*time.Minute {
		t.Fatalf("Retry-After should count down, got %v", locked.RetryAfter)
	}

	// Other applications are unaffected.
	if err := check(g, "CC25-BBBBBB", right); err != nil {
		t.Fatalf("another application must not be locked: %v", err)
	}

	clock.Advance(VerifyLockoutDuration)
	if err := check(g, "CC25-AAAAAA", right); err != nil {
		t.Fatalf("after the lock the right answer must pass: %v", err)
	}
	if n := g.tracked(); n != 0 {
		t.Fatalf("a success must clear the state, %d entries left", n)
	}

	if audit.count(domain.AuditVerifyFailure) != MaxVerifyFailures-2 || audit.count(domain.AuditVerifyLockout) != 1 {
		t.Fatalf("expected %d failure rows and 1 lockout row, got %+v", MaxVerifyFailures-2, audit.entries)
	}
	for _, e := range audit.entries {
		if e.AdminID != nil || e.TargetID != "CC25-AAAAAA" || e.IPAddress != "198.51.100.7" || e.TargetType != domain.AuditTargetApplicant {
			t.Fatalf("unexpected audit row %+v", e)
		}
	}
}

func TestVerifyGuard_SuccessResetsAndWindowForgets(t *testing.T) {
	g, clock, _ := newTestGuard()

	for i := 1; i < MaxVerifyFailures; i++ {
		_ = check(g, "CC25-AAAAAA", wrong)
	}
	if err := check(g, "CC25-AAAAAA", right); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < MaxVerifyFailures; i++ {
		if err := check(g, "CC25-AAAAAA", wrong); err != ErrInvalidVerifyCode {
			t.Fatalf("after a success the counter restarts, failure %d got %v", i, err)
		}
	}

	clock.Advance(VerifyFailureWindow)
	if err := check(g, "CC25-AAAAAA", wrong); err != ErrInvalidVerifyCode {
		t.Fatalf("failures older than the window must not add up, got %v", err)
	}
}

func TestVerifyGuard_OnlyWrongAnswersCount(t *testing.T) {
	g, _, audit := newTestGuard()
	other := errors.New("database is down")
	for i := 0; i < 3*MaxVerifyFailures; i++ {
		if err := check(g, "CC25-AAAAAA", func() error { return ErrVerifyCodeRequired }); err != ErrVerifyCodeRequired {
			t.Fatalf("a malformed code must pass through, got %v", err)
		}
		if err := check(g, "CC25-AAAAAA", func() error { return other }); err != other {
			t.Fatalf("other errors must pass through, got %v", err)
		}
	}
	if g.tracked() != 0 || len(audit.entries) != 0 {
		t.Fatalf("nothing should be counted, got %d entries and %d audit rows", g.tracked(), len(audit.entries))
	}

	// A wrong national ID counts like a wrong verify code.
	for i := 1; i < MaxVerifyFailures; i++ {
		_ = check(g, "CC25-AAAAAA", func() error { return ErrNationalIDMismatch })
	}
	var locked *VerifyLockedError
	if err := check(g, "CC25-AAAAAA", wrong); !errors.As(err, &locked) {
		t.Fatalf("mixed wrong answers must lock, got %v", err)
	}
}

func TestVerifyGuard_ConcurrentGuessesAreCountedExactly(t *testing.T) {
	g, _, audit := newTestGuard()
	var evaluated, wrongAnswers, lockedAnswers atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := check(g, "CC25-AAAAAA", func() error { evaluated.Add(1); return ErrInvalidVerifyCode })
			var locked *VerifyLockedError
			switch {
			case errors.As(err, &locked):
				lockedAnswers.Add(1)
			case errors.Is(err, ErrInvalidVerifyCode):
				wrongAnswers.Add(1)
			}
		}()
	}
	wg.Wait()
	if evaluated.Load() != MaxVerifyFailures || wrongAnswers.Load() != MaxVerifyFailures-1 || lockedAnswers.Load() != 200-(MaxVerifyFailures-1) {
		t.Fatalf("evaluated=%d wrong=%d locked=%d", evaluated.Load(), wrongAnswers.Load(), lockedAnswers.Load())
	}
	if audit.count(domain.AuditVerifyLockout) != 1 {
		t.Fatalf("expected one lockout row, got %d", audit.count(domain.AuditVerifyLockout))
	}
}

// Expired entries are swept, so memory does not grow with old failures.
func TestVerifyGuard_SweepsExpiredEntries(t *testing.T) {
	g, clock, _ := newTestGuard()
	for i := 0; i < 500; i++ {
		app := fmt.Sprintf("CC25-%06X", i)
		n := 1
		if i%2 == 0 {
			n = MaxVerifyFailures // half of them locked
		}
		for j := 0; j < n; j++ {
			_ = check(g, app, wrong)
		}
	}
	if g.tracked() != 500 {
		t.Fatalf("expected 500 tracked applications, got %d", g.tracked())
	}
	clock.Advance(VerifyFailureWindow + VerifyLockoutDuration)
	_ = check(g, "CC25-FFFFFF", right)
	if n := g.tracked(); n != 0 {
		t.Fatalf("expired entries should be swept, %d left", n)
	}
}

// The default guard every service gets is never "off".
func TestVerifyGuard_DefaultsAreTheProductionLimits(t *testing.T) {
	g := NewVerifyGuard(nil)
	if g.cfg.MaxFailures != 5 || g.cfg.Window != 15*time.Minute || g.cfg.Lockout != 15*time.Minute {
		t.Fatalf("unexpected defaults %+v", g.cfg)
	}
	for i := 1; i < MaxVerifyFailures; i++ {
		_ = g.Check(context.Background(), "CC25-AAAAAA", VerifyActionSlip, "", wrong)
	}
	var locked *VerifyLockedError
	if err := g.Check(context.Background(), "CC25-AAAAAA", VerifyActionSlip, "", wrong); !errors.As(err, &locked) {
		t.Fatalf("expected a lock without an audit repository too, got %v", err)
	}
}

func TestCheckNationalID(t *testing.T) {
	a := &domain.Applicant{NationalID: "1509900000017"}
	if !isValidThaiNationalID(a.NationalID) {
		t.Fatal("fixture ID must pass the Mod-11 check")
	}
	if err := CheckNationalID(a, "1509900000017"); err != nil {
		t.Fatalf("same ID: %v", err)
	}
	if err := CheckNationalID(a, "1509900000025"); err != ErrNationalIDMismatch {
		t.Fatalf("different ID: expected ErrNationalIDMismatch, got %v", err)
	}
	if id, err := ParseWithdrawNationalID("\u200b1-5099-00000-01-7\ufeff"); err != nil || id != "1509900000017" {
		t.Fatalf("pasted ID should be cleaned, got %q %v", id, err)
	}
	for _, bad := range []string{"", "0010", "150990000001", "15099000000170", "1509900000018", "15099OOOOOO17"} {
		if _, err := ParseWithdrawNationalID(bad); err != ErrWithdrawNationalIDRequired {
			t.Fatalf("%q: expected ErrWithdrawNationalIDRequired, got %v", bad, err)
		}
	}
}
