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

func (r *recordingAudit) byAction(action domain.AuditAction) []domain.AuditEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []domain.AuditEntry
	for _, e := range r.entries {
		if e.Action == action {
			out = append(out, e)
		}
	}
	return out
}

func newTestCodeGuard(cfg CodeGuardConfig) (*CodeGuard, *fakeClock, *recordingAudit) {
	clock := &fakeClock{now: time.Date(2026, 11, 19, 9, 0, 0, 0, time.UTC)}
	audit := &recordingAudit{}
	cfg.Now = clock.Now
	return NewCodeGuardWith(audit, cfg), clock, audit
}

func clientCtx(key string) context.Context {
	return WithClientKey(WithRemoteIP(context.Background(), key), key)
}

var (
	codeMiss = func() error { return domain.ErrNotFound }
	codeHit  = func() error { return nil }
)

func lookup(g *CodeGuard, client string, find func() error) error {
	return g.Do(clientCtx(client), CodeActionStatus, find)
}

func retryOf(t *testing.T, err error) time.Duration {
	t.Helper()
	var limited *CodeGuessLimitedError
	if !errors.As(err, &limited) {
		t.Fatalf("expected *CodeGuessLimitedError, got %v", err)
	}
	return limited.RetryAfter
}

func TestCodeGuard_DefaultsAreTheProductionLimits(t *testing.T) {
	g := NewCodeGuard(nil)
	c := g.cfg
	if c.ClientMaxMisses != 5 || c.ClientWindow != 15*time.Minute || c.BaseLockout != 15*time.Minute ||
		c.MaxLockout != time.Hour || c.StrikeMemory != time.Hour || c.GlobalWindow != 5*time.Minute ||
		c.GlobalSoftCeiling != 5 || c.GlobalHardCeiling != 10 || c.MaxClients != 50_000 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

func TestCodeGuard_LocksClientAfterMaxMissesBeforeTheLookup(t *testing.T) {
	// Global ceilings out of the way: this is about one client.
	g, clock, audit := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000})
	for i := 1; i <= CodeClientMaxMisses; i++ {
		if err := lookup(g, "198.51.100.7", codeMiss); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("miss %d: expected the lookup's own ErrNotFound, got %v", i, err)
		}
	}
	var ran atomic.Int32
	err := lookup(g, "198.51.100.7", func() error { ran.Add(1); return nil })
	if retry := retryOf(t, err); retry != 15*time.Minute {
		t.Fatalf("first lockout: Retry-After = %v, want 15m", retry)
	}
	if ran.Load() != 0 {
		t.Fatal("a locked client must be refused before the database lookup runs")
	}
	// Other clients are not affected by one client's lockout.
	if err := lookup(g, "203.0.113.9", codeHit); err != nil {
		t.Fatalf("another client must not be locked: %v", err)
	}
	lockouts := audit.byAction(domain.AuditCodeGuessLockout)
	if len(lockouts) != 1 || lockouts[0].IPAddress != "198.51.100.7" || lockouts[0].Details["strike"] != 1 ||
		lockouts[0].Details["lockedForSeconds"] != 900 || lockouts[0].Details["endpoint"] != CodeActionStatus {
		t.Fatalf("expected one lockout audit row, got %+v", lockouts)
	}

	// The lock runs out; a second round of misses locks for twice as long.
	clock.Advance(15 * time.Minute)
	if err := lookup(g, "198.51.100.7", codeHit); err != nil {
		t.Fatalf("after the lockout the client is served again: %v", err)
	}
	for i := 0; i < CodeClientMaxMisses; i++ {
		_ = lookup(g, "198.51.100.7", codeMiss)
	}
	if retry := retryOf(t, lookup(g, "198.51.100.7", codeHit)); retry != 30*time.Minute {
		t.Fatalf("second lockout: Retry-After = %v, want 30m (escalation)", retry)
	}
}

func TestCodeGuard_EscalationIsCappedAndForgotten(t *testing.T) {
	g, clock, _ := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000})
	// Capped at 1h (shared IPs: CGNAT, school Wi-Fi). Steady state: 5 guesses per hour, ~120 a day.
	want := []time.Duration{15 * time.Minute, 30 * time.Minute, time.Hour, time.Hour, time.Hour}
	for round, w := range want {
		for i := 0; i < CodeClientMaxMisses; i++ {
			_ = lookup(g, "c", codeMiss)
		}
		if got := retryOf(t, lookup(g, "c", codeHit)); got != w {
			t.Fatalf("round %d: lockout %v, want %v", round, got, w)
		}
		clock.Advance(w)
	}
	// An hour after the last lockout ended the strikes are forgotten: back to the base lockout.
	clock.Advance(CodeStrikeMemory)
	for i := 0; i < CodeClientMaxMisses; i++ {
		_ = lookup(g, "c", codeMiss)
	}
	if got := retryOf(t, lookup(g, "c", codeHit)); got != 15*time.Minute {
		t.Fatalf("after the strike memory: lockout %v, want 15m", got)
	}
}

// Someone holding one valid code (their own) must not reset their miss count by mixing it in.
func TestCodeGuard_HitsDoNotResetMisses(t *testing.T) {
	g, _, _ := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000})
	for i := 0; i < CodeClientMaxMisses-1; i++ {
		_ = lookup(g, "c", codeMiss)
		if err := lookup(g, "c", codeHit); err != nil {
			t.Fatalf("hit %d: %v", i, err)
		}
	}
	_ = lookup(g, "c", codeMiss)
	retryOf(t, lookup(g, "c", codeHit))
}

func TestCodeGuard_MissWindowForgetsOldMisses(t *testing.T) {
	g, clock, _ := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000})
	for i := 0; i < CodeClientMaxMisses-1; i++ {
		_ = lookup(g, "c", codeMiss)
	}
	clock.Advance(CodeClientWindow)
	for i := 0; i < CodeClientMaxMisses-1; i++ {
		if err := lookup(g, "c", codeMiss); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("a fresh window allows %d misses again, got %v", CodeClientMaxMisses-1, err)
		}
	}
}

func TestCodeGuard_OnlyNotFoundCounts(t *testing.T) {
	g, _, _ := newTestCodeGuard(CodeGuardConfig{})
	dbDown := errors.New("connection refused")
	for i := 0; i < 50; i++ {
		if err := lookup(g, "c", func() error { return dbDown }); !errors.Is(err, dbDown) {
			t.Fatalf("expected the lookup's own error, got %v", err)
		}
		if err := lookup(g, "c", codeHit); err != nil {
			t.Fatalf("hits never count: %v", err)
		}
	}
	if n := g.tracked(); n != 0 {
		t.Fatalf("a client without misses must not stay in the table, %d tracked", n)
	}
}

// The global ceilings: soft stops clients with a record, hard stops everyone, and both end with
// the window. A clean client (an applicant typing their own code) is only held up by the hard one.
func TestCodeGuard_GlobalCeilings(t *testing.T) {
	g, clock, audit := newTestCodeGuard(CodeGuardConfig{})
	// Five clients, one miss each: the soft ceiling is reached.
	for i := 0; i < CodeGlobalSoftCeiling; i++ {
		_ = lookup(g, fmt.Sprintf("10.0.0.%d", i), codeMiss)
	}
	retry := retryOf(t, lookup(g, "10.0.0.0", codeHit)) // has a miss on record
	if retry <= 0 || retry > CodeGlobalWindow {
		t.Fatalf("soft ceiling Retry-After = %v, want (0, %v]", retry, CodeGlobalWindow)
	}
	if err := lookup(g, "192.0.2.1", codeHit); err != nil {
		t.Fatalf("a clean client passes the soft ceiling: %v", err)
	}
	// Fresh clients keep guessing until the hard ceiling: now nobody gets through.
	for i := CodeGlobalSoftCeiling; i < CodeGlobalHardCeiling; i++ {
		if err := lookup(g, fmt.Sprintf("10.0.1.%d", i), codeMiss); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("fresh client %d below the hard ceiling: %v", i, err)
		}
	}
	var ran atomic.Int32
	retry = retryOf(t, lookup(g, "192.0.2.2", func() error { ran.Add(1); return nil }))
	if retry <= 0 || retry > CodeGlobalWindow || ran.Load() != 0 {
		t.Fatalf("hard ceiling: Retry-After = %v (want (0, %v]), lookups run %d (want 0)", retry, CodeGlobalWindow, ran.Load())
	}
	ceilings := audit.byAction(domain.AuditCodeGuessCeiling)
	if len(ceilings) != 2 || ceilings[0].Details["level"] != "soft" || ceilings[1].Details["level"] != "hard" {
		t.Fatalf("expected one soft and one hard ceiling audit row, got %+v", ceilings)
	}
	// The legitimate applicant is held up for at most the window.
	clock.Advance(retry)
	if err := lookup(g, "192.0.2.2", codeHit); err != nil {
		t.Fatalf("after the window a clean client is served: %v", err)
	}
	if err := lookup(g, "10.0.0.0", codeHit); err != nil {
		t.Fatalf("after the window a client with one old miss is served again: %v", err)
	}
}

// Parallel requests reserve their slot before the lookup, so a burst cannot run more lookups than
// the budget allows, from one client or from many.
func TestCodeGuard_BurstsCannotExceedTheBudgets(t *testing.T) {
	for _, tc := range []struct {
		name    string
		clients int
		cfg     CodeGuardConfig
		max     int32
	}{
		{"one client", 1, CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000}, CodeClientMaxMisses},
		{"many clients", 200, CodeGuardConfig{}, CodeGlobalHardCeiling},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g, _, _ := newTestCodeGuard(tc.cfg)
			release := make(chan struct{})
			var ran, refused atomic.Int32
			var wg sync.WaitGroup
			for i := 0; i < 200; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					err := lookup(g, fmt.Sprintf("c%d", i%tc.clients), func() error {
						ran.Add(1)
						<-release
						return domain.ErrNotFound
					})
					var limited *CodeGuessLimitedError
					if errors.As(err, &limited) {
						refused.Add(1)
					}
				}(i)
			}
			// Every goroutine has either reserved a slot (and is waiting in find) or been refused.
			deadline := time.Now().Add(5 * time.Second)
			for ran.Load()+refused.Load() < 200 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			close(release)
			wg.Wait()
			if ran.Load() > tc.max {
				t.Fatalf("%d lookups ran in a burst, the budget is %d", ran.Load(), tc.max)
			}
			if ran.Load()+refused.Load() != 200 {
				t.Fatalf("ran %d + refused %d != 200", ran.Load(), refused.Load())
			}
		})
	}
}

func TestCodeGuard_TableStaysBounded(t *testing.T) {
	g, _, _ := newTestCodeGuard(CodeGuardConfig{MaxClients: 64, GlobalSoftCeiling: 1 << 20, GlobalHardCeiling: 1 << 20})
	for i := 0; i < 1000; i++ {
		_ = lookup(g, fmt.Sprintf("client-%d", i), codeMiss)
		if n := g.tracked(); n > 64 {
			t.Fatalf("table grew to %d entries, cap 64", n)
		}
	}
}

func TestCodeGuard_EvictionKeepsRunningLockouts(t *testing.T) {
	g, _, _ := newTestCodeGuard(CodeGuardConfig{MaxClients: 16, GlobalSoftCeiling: 1 << 20, GlobalHardCeiling: 1 << 20})
	for i := 0; i < CodeClientMaxMisses; i++ {
		_ = lookup(g, "attacker", codeMiss)
	}
	for i := 0; i < 500; i++ {
		_ = lookup(g, fmt.Sprintf("noise-%d", i), codeMiss)
	}
	retryOf(t, lookup(g, "attacker", codeHit))
}

// A malformed code never reaches the guard or the database and is never counted.
func TestFindByCode_MalformedCodesAreNotCounted(t *testing.T) {
	g, _, _ := newTestCodeGuard(CodeGuardConfig{GlobalSoftCeiling: 1000, GlobalHardCeiling: 1000})
	for _, raw := range []string{"", "CC25", "CC25-12345", "CC25-1234567", "CC26-ABCDEF", "0812345678", "CC25-GHIJKL"} {
		for i := 0; i < 10; i++ {
			if _, err := findByCode(clientCtx("c"), g, nil, raw, CodeActionSlip, nil); !errors.Is(err, ErrApplicantNotFound) {
				t.Fatalf("%q: expected ErrApplicantNotFound, got %v", raw, err)
			}
		}
	}
	if n := g.tracked(); n != 0 {
		t.Fatalf("malformed codes must not be tracked, %d clients", n)
	}
}

func TestNormalizeAppNo_AcceptsWhatStudentsPaste(t *testing.T) {
	for _, raw := range []string{"CC25-E85B53", "cc25-e85b53", "\u200bCC25E85B53\ufeff", "CC๒๕-E85B53", "CC25 E85B53", "CC25\u2013E85B53", " cc25-e85b53 "} {
		if got := normalizeAppNo(raw); got != "CC25-E85B53" {
			t.Errorf("normalizeAppNo(%q) = %q", raw, got)
		}
	}
}

// Ruling R25: phone lookups are guarded per client only. Their misses lock the client on the same
// ladder as unknown codes (and a client locked for either is refused both), but they never reach the
// global window: no ceiling, no ceiling audit row, no LastHardCeilingAt (the unpaid-expiry pause), and
// the global ceilings never refuse a phone lookup.
func TestCodeGuard_PerClientLookupsNeverFeedTheGlobalWindow(t *testing.T) {
	g, _, audit := newTestCodeGuard(CodeGuardConfig{})
	phone := func(client string, find func() error) error {
		return g.DoPerClient(clientCtx(client), CodeActionStatusPhone, find)
	}

	// Many clients, each just below its own budget: far more misses than the hard ceiling.
	clients := CodeGlobalHardCeiling
	for i := 0; i < clients; i++ {
		for j := 0; j < CodeClientMaxMisses-1; j++ {
			if err := phone(fmt.Sprintf("10.0.0.%d", i), codeMiss); !errors.Is(err, domain.ErrNotFound) {
				t.Fatalf("client %d miss %d: %v", i, j, err)
			}
		}
	}
	if g.globalMisses != 0 || g.globalPending != 0 || !g.LastHardCeilingAt().IsZero() {
		t.Fatalf("phone misses must not reach the global window: misses=%d pending=%d lastHard=%v",
			g.globalMisses, g.globalPending, g.LastHardCeilingAt())
	}
	if n := len(audit.byAction(domain.AuditCodeGuessCeiling)); n != 0 {
		t.Fatalf("phone misses must not write ceiling rows, got %d", n)
	}
	// A clean client's code lookup is not held up by them, and a found phone still works.
	if err := lookup(g, "10.9.9.9", codeHit); err != nil {
		t.Fatalf("clean code lookup: %v", err)
	}
	if err := phone("10.0.0.0", codeHit); err != nil {
		t.Fatalf("found phone below the client budget: %v", err)
	}

	// The next miss locks that client, for phone and code lookups alike.
	if err := phone("10.0.0.0", codeMiss); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("last allowed miss: %v", err)
	}
	if d := retryOf(t, phone("10.0.0.0", codeHit)); d != CodeBaseLockout {
		t.Fatalf("phone lookup while locked: retry %v, want %v", d, CodeBaseLockout)
	}
	if d := retryOf(t, lookup(g, "10.0.0.0", codeHit)); d != CodeBaseLockout {
		t.Fatalf("code lookup while locked by phone misses: retry %v, want %v", d, CodeBaseLockout)
	}
	if rows := audit.byAction(domain.AuditCodeGuessLockout); len(rows) != 1 || rows[0].Details["endpoint"] != CodeActionStatusPhone {
		t.Fatalf("expected one lockout row for the phone lookup, got %+v", rows)
	}

	// Code misses fill the global window up to the hard ceiling: phone lookups are still served.
	for i := 0; i < CodeGlobalHardCeiling; i++ {
		_ = lookup(g, fmt.Sprintf("10.1.0.%d", i), codeMiss)
	}
	if g.LastHardCeilingAt().IsZero() {
		t.Fatal("code misses should have reached the hard ceiling")
	}
	retryOf(t, lookup(g, "10.9.9.8", codeHit))
	if err := phone("10.9.9.8", codeHit); err != nil {
		t.Fatalf("a phone lookup must not be refused by the global ceiling: %v", err)
	}
}
