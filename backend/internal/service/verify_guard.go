package service

import (
	"context"
	"errors"
	"log"
	"slices"
	"sync"
	"time"

	"comcamp25-backend/internal/domain"
)

// Per-application lockout for the public identity checks (AGENTS.md §13.5).
//
// verifyCode has only 10 000 values, and the per-IP rate limit alone does not stop someone who
// spreads guesses over many addresses (or sits behind a school NAT). So wrong answers are also
// counted per application, across every endpoint that checks one: confirm, slip upload, profile
// edit and withdraw share one counter. After MaxVerifyFailures wrong answers for an application
// within VerifyFailureWindow, every identity check for that application is refused with 429 for
// VerifyLockoutDuration, even with the right answer. A correct answer resets the counter.
//
// The state lives in process memory, so the In-Memory and PostgreSQL deployments behave the same.
// It is per backend process: several API replicas behind one load balancer would need a shared
// store. Entries exist only for real applications (the application is looked up first), and
// expired ones are swept, so memory stays bounded by the number of applications.

const (
	MaxVerifyFailures     = 5
	VerifyFailureWindow   = 15 * time.Minute
	VerifyLockoutDuration = 15 * time.Minute
	// MaxVerifyEntries is a hard cap on tracked applications. Normally the map holds at most the
	// applications that failed in the last window (a few dozen); the cap is a backstop so a bot
	// flood can never grow it without limit.
	MaxVerifyEntries = 50_000
)

// Endpoint names recorded in the audit details.
const (
	VerifyActionConfirm  = "confirm"
	VerifyActionSlip     = "slip"
	VerifyActionProfile  = "profile"
	VerifyActionWithdraw = "withdraw"
)

// VerifyLockedError means the application is locked after too many wrong answers.
type VerifyLockedError struct {
	RetryAfter time.Duration
}

func (e *VerifyLockedError) Error() string {
	return "too many wrong verification attempts for this application, please try again later"
}

// VerifyGuardConfig tunes a VerifyGuard. Zero values take the package defaults; Now is for tests.
type VerifyGuardConfig struct {
	MaxFailures int
	Window      time.Duration
	Lockout     time.Duration
	MaxEntries  int
	Now         func() time.Time
}

type verifyState struct {
	failures     int
	firstFailure time.Time
	lockedUntil  time.Time
}

// VerifyGuard counts wrong identity answers per application and locks the application out.
// It is safe for concurrent use. One guard must be shared by every service that checks
// verifyCode / nationalId, so the limit holds across endpoints.
type VerifyGuard struct {
	mu        sync.Mutex
	cfg       VerifyGuardConfig
	audit     domain.AuditRepository
	entries   map[string]*verifyState
	lastSweep time.Time
}

// NewVerifyGuard uses the production limits. audit may be nil (no audit rows, tests only).
func NewVerifyGuard(audit domain.AuditRepository) *VerifyGuard {
	return NewVerifyGuardWith(audit, VerifyGuardConfig{})
}

// NewVerifyGuardWith is NewVerifyGuard with explicit limits or clock.
func NewVerifyGuardWith(audit domain.AuditRepository, cfg VerifyGuardConfig) *VerifyGuard {
	if cfg.MaxFailures <= 0 {
		cfg.MaxFailures = MaxVerifyFailures
	}
	if cfg.Window <= 0 {
		cfg.Window = VerifyFailureWindow
	}
	if cfg.Lockout <= 0 {
		cfg.Lockout = VerifyLockoutDuration
	}
	if cfg.MaxEntries <= 0 {
		cfg.MaxEntries = MaxVerifyEntries
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &VerifyGuard{cfg: cfg, audit: audit, entries: map[string]*verifyState{}}
}

// isWrongAnswer reports the errors that count as a guess. A missing or malformed code is a 400
// and does not count: it cannot be a correct guess.
func isWrongAnswer(err error) bool {
	return errors.Is(err, ErrInvalidVerifyCode) || errors.Is(err, ErrNationalIDMismatch)
}

// Check runs verify for applicationNo unless the application is locked, and records the result.
// The lock check, the comparison and the bookkeeping happen under one mutex, so parallel requests
// cannot squeeze in more than MaxFailures guesses. verify must therefore be cheap and must not
// block (it is a constant-time string compare).
//
// It returns nil on a correct answer, *VerifyLockedError while locked (including the answer that
// triggers the lock), and verify's own error otherwise.
func (g *VerifyGuard) Check(ctx context.Context, applicationNo, action, ip string, verify func() error) error {
	g.mu.Lock()
	now := g.cfg.Now()
	g.sweepLocked(now)

	st := g.entries[applicationNo]
	if st != nil {
		switch {
		case now.Before(st.lockedUntil):
			retry := st.lockedUntil.Sub(now)
			g.mu.Unlock()
			return &VerifyLockedError{RetryAfter: retry}
		case !st.lockedUntil.IsZero(), now.Sub(st.firstFailure) >= g.cfg.Window:
			// The lock ran out, or the failures are older than the window: start over.
			delete(g.entries, applicationNo)
			st = nil
		}
	}

	err := verify()
	if err == nil {
		delete(g.entries, applicationNo)
		g.mu.Unlock()
		return nil
	}
	if !isWrongAnswer(err) {
		g.mu.Unlock()
		return err
	}

	if st == nil {
		g.makeRoomLocked(now)
		st = &verifyState{firstFailure: now}
		g.entries[applicationNo] = st
	}
	st.failures++
	failures := st.failures
	locked := failures >= g.cfg.MaxFailures
	if locked {
		st.lockedUntil = now.Add(g.cfg.Lockout)
	}
	g.mu.Unlock()

	g.record(ctx, applicationNo, action, ip, failures, locked)
	if locked {
		return &VerifyLockedError{RetryAfter: g.cfg.Lockout}
	}
	return err
}

// sweepLocked drops expired entries at most once per window. Callers hold g.mu.
func (g *VerifyGuard) sweepLocked(now time.Time) {
	if now.Sub(g.lastSweep) < g.cfg.Window {
		return
	}
	g.dropExpiredLocked(now)
}

// dropExpiredLocked removes every entry whose window or lock has run out. Callers hold g.mu.
func (g *VerifyGuard) dropExpiredLocked(now time.Time) {
	g.lastSweep = now
	for k, st := range g.entries {
		if st.lockedUntil.IsZero() {
			if now.Sub(st.firstFailure) >= g.cfg.Window {
				delete(g.entries, k)
			}
		} else if !now.Before(st.lockedUntil) {
			delete(g.entries, k)
		}
	}
}

// makeRoomLocked keeps len(entries) below MaxEntries before a new entry is added. It first sweeps
// expired entries right away (whatever lastSweep says); if the table is still full of live ones it
// evicts the oldest. Callers hold g.mu.
//
// Eviction prefers entries that are only counting failures over entries that hold a lock (a
// lock is the thing the guard exists to keep), oldest first within each group, and removes a
// batch (1/16 of the cap) so a sustained flood pays the sort once per many inserts, not on every
// request.
func (g *VerifyGuard) makeRoomLocked(now time.Time) {
	if len(g.entries) < g.cfg.MaxEntries {
		return
	}
	g.dropExpiredLocked(now)
	if len(g.entries) < g.cfg.MaxEntries {
		return
	}

	type cand struct {
		key    string
		locked bool
		since  time.Time
	}
	cands := make([]cand, 0, len(g.entries))
	for k, st := range g.entries {
		c := cand{key: k, locked: !st.lockedUntil.IsZero(), since: st.firstFailure}
		if c.locked {
			c.since = st.lockedUntil
		}
		cands = append(cands, c)
	}
	slices.SortFunc(cands, func(a, b cand) int {
		if a.locked != b.locked {
			if !a.locked {
				return -1
			}
			return 1
		}
		return a.since.Compare(b.since)
	})
	n := max(len(g.entries)-g.cfg.MaxEntries+1, g.cfg.MaxEntries/16)
	for _, c := range cands[:min(n, len(cands))] {
		delete(g.entries, c.key)
	}
}

// tracked reports how many applications currently have failures or a lock (tests).
func (g *VerifyGuard) tracked() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.entries)
}

// record writes repeated failures (the 2nd onwards) and the lockout to audit_logs. A single typo
// is not worth a row. The write is detached from the request context so a client that hangs up
// cannot drop it.
func (g *VerifyGuard) record(ctx context.Context, applicationNo, action, ip string, failures int, locked bool) {
	if g.audit == nil || (failures < 2 && !locked) {
		return
	}
	details := map[string]any{
		"endpoint":    action,
		"failures":    failures,
		"maxFailures": g.cfg.MaxFailures,
		"selfService": true,
	}
	entry := &domain.AuditEntry{
		Action:     domain.AuditVerifyFailure,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicationNo,
		Details:    details,
		IPAddress:  ip,
	}
	if locked {
		entry.Action = domain.AuditVerifyLockout
		details["lockedForSeconds"] = int(g.cfg.Lockout / time.Second)
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := g.audit.Log(wctx, entry); err != nil {
		log.Printf("audit log write failed (%s %s): %v", entry.Action, applicationNo, err)
	}
}
