package service

import (
	"context"
	"errors"
	"log"
	"regexp"
	"slices"
	"sync"
	"time"

	"comcamp25-backend/internal/domain"
)

// Brute-force guard for the application code (CC25-XXXXXX, AGENTS.md §13.5).
//
// Since migration 000011 there is no national ID: knowing the code is the applicant's proof on every
// public endpoint that names an application (the status lookup by code, slip upload, confirm and
// withdraw). The code is 6 hex digits (16,777,216 values), so with ~40 live applications a blind
// guess hits about once in 419,000 tries. The per-IP request limiters alone would still allow tens of
// thousands of guesses a day, and a per-application lockout cannot help against codes the attacker
// does not know. So unknown codes ("misses") are counted per client and globally:
//
//  1. Per client (the rate-limit key: the IP, or its /64 for IPv6). After CodeClientMaxMisses misses
//     within CodeClientWindow the client is refused every code-keyed request for a lockout that
//     doubles with each repeat (CodeBaseLockout up to CodeMaxLockout). Repeats are remembered until
//     CodeStrikeMemory after the last lockout ended.
//  2. Globally, per fixed window of CodeGlobalWindow. Once the misses of all clients together reach
//     CodeGlobalSoftCeiling, clients with a miss (or a lockout) on their record are refused until the
//     window ends. At CodeGlobalHardCeiling every client is refused until the window ends. A client
//     with a clean record, such as an applicant typing their own code, is therefore held up by other
//     people's misses only while the hard ceiling holds, and never beyond the end of that window.
//
// A refusal happens BEFORE the database lookup, so it never tells whether a code exists, and it is the
// same for every endpoint. A hit never clears a client's misses: otherwise someone could interleave
// their own valid code with guesses. Lookups in flight hold a reservation, so a burst of parallel
// requests cannot squeeze past either budget. Malformed codes are rejected before the guard and never
// counted: they cannot be a hit.
//
// The state lives in process memory (like the per-IP rate limiters), is bounded by CodeMaxClients, and
// is per backend process. The phone lookup is not code-keyed and never passes through this guard: a
// student who lost their code can always find their application by phone (which never reveals the
// code) and contact staff.
const (
	CodeClientMaxMisses   = 5
	CodeClientWindow      = 15 * time.Minute
	CodeBaseLockout       = 15 * time.Minute
	CodeMaxLockout        = 24 * time.Hour
	CodeStrikeMemory      = 24 * time.Hour
	CodeGlobalWindow      = 5 * time.Minute
	CodeGlobalSoftCeiling = 5
	CodeGlobalHardCeiling = 10
	// CodeMaxClients caps the per-client table. Normally it holds only clients with recent misses.
	CodeMaxClients = 50_000
	// codeBusyRetry is the Retry-After for a refusal caused only by lookups still in flight.
	codeBusyRetry = time.Second
)

// Endpoint names recorded in the audit details.
const (
	CodeActionStatus   = "status"
	CodeActionConfirm  = "confirm"
	CodeActionSlip     = "slip"
	CodeActionWithdraw = "withdraw"
)

// CodeGuessLimitedError refuses a code-keyed request: the client sent too many unknown codes, or all
// clients together did. Handlers answer 429 RATE_LIMITED with Retry-After.
type CodeGuessLimitedError struct {
	RetryAfter time.Duration
}

func (e *CodeGuessLimitedError) Error() string {
	return "too many lookups with unknown application codes, please try again later"
}

// CodeGuardConfig tunes a CodeGuard. Zero values take the package defaults; Now is for tests.
type CodeGuardConfig struct {
	ClientMaxMisses   int
	ClientWindow      time.Duration
	BaseLockout       time.Duration
	MaxLockout        time.Duration
	StrikeMemory      time.Duration
	GlobalWindow      time.Duration
	GlobalSoftCeiling int
	GlobalHardCeiling int
	MaxClients        int
	Now               func() time.Time
}

type codeClient struct {
	misses      int       // misses in the current window
	windowStart time.Time // first miss of the current window
	pending     int       // lookups in flight
	lockedUntil time.Time
	strikes     int       // lockouts so far; each one doubles the next
	strikeUntil time.Time // strikes are forgotten from here on
}

func (c *codeClient) clean() bool {
	return c.misses == 0 && c.pending == 0 && c.strikes == 0 && c.lockedUntil.IsZero()
}

// CodeGuard counts unknown application codes per client and globally. It is safe for concurrent use;
// one guard must be shared by every service with a code-keyed public endpoint, so the budgets hold
// across endpoints.
type CodeGuard struct {
	mu    sync.Mutex
	cfg   CodeGuardConfig
	audit domain.AuditRepository

	clients   map[string]*codeClient
	lastSweep time.Time

	globalStart   time.Time
	globalMisses  int
	globalPending int
	softLogged    bool
	hardLogged    bool
}

// NewCodeGuard uses the production limits. audit may be nil (no audit rows, tests only).
func NewCodeGuard(audit domain.AuditRepository) *CodeGuard {
	return NewCodeGuardWith(audit, CodeGuardConfig{})
}

// NewCodeGuardWith is NewCodeGuard with explicit limits or clock.
func NewCodeGuardWith(audit domain.AuditRepository, cfg CodeGuardConfig) *CodeGuard {
	if cfg.ClientMaxMisses <= 0 {
		cfg.ClientMaxMisses = CodeClientMaxMisses
	}
	if cfg.ClientWindow <= 0 {
		cfg.ClientWindow = CodeClientWindow
	}
	if cfg.BaseLockout <= 0 {
		cfg.BaseLockout = CodeBaseLockout
	}
	if cfg.MaxLockout <= 0 {
		cfg.MaxLockout = CodeMaxLockout
	}
	if cfg.StrikeMemory <= 0 {
		cfg.StrikeMemory = CodeStrikeMemory
	}
	if cfg.GlobalWindow <= 0 {
		cfg.GlobalWindow = CodeGlobalWindow
	}
	if cfg.GlobalSoftCeiling <= 0 {
		cfg.GlobalSoftCeiling = CodeGlobalSoftCeiling
	}
	if cfg.GlobalHardCeiling <= 0 {
		cfg.GlobalHardCeiling = CodeGlobalHardCeiling
	}
	if cfg.GlobalSoftCeiling > cfg.GlobalHardCeiling {
		cfg.GlobalSoftCeiling = cfg.GlobalHardCeiling
	}
	if cfg.MaxClients <= 0 {
		cfg.MaxClients = CodeMaxClients
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &CodeGuard{cfg: cfg, audit: audit, clients: map[string]*codeClient{}}
}

// Do runs find, a database lookup by application code, for the client in ctx (see WithClientKey). It
// refuses with *CodeGuessLimitedError before find runs while the client or the global budget is
// exhausted, and records find's domain.ErrNotFound as a miss. Any other result, including other
// errors, only releases the reservation.
func (g *CodeGuard) Do(ctx context.Context, action string, find func() error) (err error) {
	key := clientKeyFrom(ctx)
	c, refused := g.begin(key)
	if refused != nil {
		return refused
	}
	miss := false
	defer func() { g.finish(ctx, key, action, c, miss) }()
	err = find()
	miss = errors.Is(err, domain.ErrNotFound)
	return err
}

// begin checks the budgets and reserves one lookup for key.
func (g *CodeGuard) begin(key string) (*codeClient, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.cfg.Now()
	g.rollGlobalLocked(now)
	g.sweepLocked(now)

	c := g.clients[key]
	if c != nil {
		g.refreshLocked(c, now)
		if now.Before(c.lockedUntil) {
			return nil, &CodeGuessLimitedError{RetryAfter: c.lockedUntil.Sub(now)}
		}
		if c.misses+c.pending >= g.cfg.ClientMaxMisses {
			return nil, &CodeGuessLimitedError{RetryAfter: codeBusyRetry}
		}
	}

	clean := c == nil || c.clean()
	used := g.globalMisses + g.globalPending
	ceiling := g.cfg.GlobalHardCeiling
	if !clean {
		ceiling = g.cfg.GlobalSoftCeiling
	}
	if used >= ceiling {
		retry := codeBusyRetry
		if g.globalMisses >= ceiling {
			retry = g.globalStart.Add(g.cfg.GlobalWindow).Sub(now)
		}
		return nil, &CodeGuessLimitedError{RetryAfter: max(retry, time.Second)}
	}

	if c == nil {
		g.makeRoomLocked(now)
		c = &codeClient{}
		g.clients[key] = c
	}
	c.pending++
	g.globalPending++
	return c, nil
}

type codeEvent struct {
	action domain.AuditAction
	ip     string
	detail map[string]any
}

// finish releases the reservation of c and records a miss.
func (g *CodeGuard) finish(ctx context.Context, key, action string, c *codeClient, miss bool) {
	var events []codeEvent
	g.mu.Lock()
	now := g.cfg.Now()
	g.rollGlobalLocked(now)
	c.pending--
	g.globalPending--
	if miss {
		g.refreshLocked(c, now)
		if c.misses == 0 {
			c.windowStart = now
		}
		c.misses++
		g.globalMisses++
		if c.misses >= g.cfg.ClientMaxMisses && c.lockedUntil.IsZero() {
			c.strikes++
			lock := g.cfg.BaseLockout
			for i := 1; i < c.strikes && lock < g.cfg.MaxLockout; i++ {
				lock *= 2
			}
			lock = min(lock, g.cfg.MaxLockout)
			c.lockedUntil = now.Add(lock)
			c.strikeUntil = c.lockedUntil.Add(g.cfg.StrikeMemory)
			events = append(events, codeEvent{action: domain.AuditCodeGuessLockout, detail: map[string]any{
				"endpoint":         action,
				"client":           key,
				"misses":           c.misses,
				"maxMisses":        g.cfg.ClientMaxMisses,
				"strike":           c.strikes,
				"lockedForSeconds": int(lock / time.Second),
			}})
		}
		for _, level := range []struct {
			name    string
			ceiling int
			logged  *bool
		}{
			{"soft", g.cfg.GlobalSoftCeiling, &g.softLogged},
			{"hard", g.cfg.GlobalHardCeiling, &g.hardLogged},
		} {
			if g.globalMisses >= level.ceiling && !*level.logged {
				*level.logged = true
				events = append(events, codeEvent{action: domain.AuditCodeGuessCeiling, detail: map[string]any{
					"level":         level.name,
					"endpoint":      action,
					"misses":        g.globalMisses,
					"ceiling":       level.ceiling,
					"windowSeconds": int(g.cfg.GlobalWindow / time.Second),
				}})
			}
		}
	}
	if c.clean() && g.clients[key] == c {
		delete(g.clients, key)
	}
	g.mu.Unlock()

	for _, e := range events {
		g.record(ctx, e)
	}
}

// rollGlobalLocked starts a new global window once the current one has run out. Lookups in flight
// stay reserved across the boundary. Callers hold g.mu.
func (g *CodeGuard) rollGlobalLocked(now time.Time) {
	if now.Sub(g.globalStart) < g.cfg.GlobalWindow {
		return
	}
	g.globalStart = now
	g.globalMisses = 0
	g.softLogged = false
	g.hardLogged = false
}

// refreshLocked expires a finished lockout, a finished miss window and forgotten strikes. Callers
// hold g.mu.
func (g *CodeGuard) refreshLocked(c *codeClient, now time.Time) {
	if !c.lockedUntil.IsZero() && !now.Before(c.lockedUntil) {
		c.lockedUntil = time.Time{}
		c.misses = 0
	}
	if c.lockedUntil.IsZero() && c.misses > 0 && now.Sub(c.windowStart) >= g.cfg.ClientWindow {
		c.misses = 0
	}
	if c.strikes > 0 && c.lockedUntil.IsZero() && !now.Before(c.strikeUntil) {
		c.strikes = 0
	}
}

// sweepLocked drops idle clients at most once per client window. Callers hold g.mu.
func (g *CodeGuard) sweepLocked(now time.Time) {
	if now.Sub(g.lastSweep) < g.cfg.ClientWindow {
		return
	}
	g.dropIdleLocked(now)
}

func (g *CodeGuard) dropIdleLocked(now time.Time) {
	g.lastSweep = now
	for k, c := range g.clients {
		g.refreshLocked(c, now)
		if c.clean() {
			delete(g.clients, k)
		}
	}
}

// makeRoomLocked keeps the table below MaxClients before a new client is added: idle clients go
// first, then (oldest first) clients that are only counting misses, then clients remembered for an
// earlier lockout. Clients with a lookup in flight or a running lockout are never evicted. A batch
// (1/16 of the cap) is removed so a flood pays the sort once per many inserts. Callers hold g.mu.
func (g *CodeGuard) makeRoomLocked(now time.Time) {
	if len(g.clients) < g.cfg.MaxClients {
		return
	}
	g.dropIdleLocked(now)
	if len(g.clients) < g.cfg.MaxClients {
		return
	}
	type cand struct {
		key    string
		strike bool
		since  time.Time
	}
	cands := make([]cand, 0, len(g.clients))
	for k, c := range g.clients {
		if c.pending > 0 || !c.lockedUntil.IsZero() {
			continue
		}
		cands = append(cands, cand{key: k, strike: c.strikes > 0, since: c.windowStart})
	}
	slices.SortFunc(cands, func(a, b cand) int {
		if a.strike != b.strike {
			if !a.strike {
				return -1
			}
			return 1
		}
		return a.since.Compare(b.since)
	})
	n := max(len(g.clients)-g.cfg.MaxClients+1, g.cfg.MaxClients/16)
	for _, c := range cands[:min(n, len(cands))] {
		delete(g.clients, c.key)
	}
}

// tracked reports how many clients are in the table (tests).
func (g *CodeGuard) tracked() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.clients)
}

// record writes a lockout or a ceiling event to audit_logs. The write is detached from the request
// context so a client that hangs up cannot drop it.
func (g *CodeGuard) record(ctx context.Context, e codeEvent) {
	if g.audit == nil {
		return
	}
	e.detail["selfService"] = true
	entry := &domain.AuditEntry{Action: e.action, Details: e.detail, IPAddress: remoteIPFrom(ctx)}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := g.audit.Log(wctx, entry); err != nil {
		log.Printf("audit log write failed (%s): %v", entry.Action, err)
	}
}

type clientKeyKey struct{}

// WithClientKey attaches the key the code guard counts this client under. Handlers pass
// middleware.RateLimitKey (the IP, or its /64 for IPv6), so the guard and the per-IP rate limiters
// agree on who a client is.
func WithClientKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, clientKeyKey{}, key)
}

// clientKeyFrom falls back to the remote IP, then to one shared bucket for callers that set neither.
func clientKeyFrom(ctx context.Context) string {
	if k, _ := ctx.Value(clientKeyKey{}).(string); k != "" {
		return k
	}
	if ip := remoteIPFrom(ctx); ip != "" {
		return ip
	}
	return "unknown"
}

// appNoRe is the canonical application code written by generateAppNo.
var appNoRe = regexp.MustCompile(`^CC25-[0-9A-F]{6}$`)

// findByCode is the lookup every public code-keyed endpoint shares. The code is normalised the same
// way as the status search (normalizeAppNo); anything that is not then a canonical code cannot exist
// and is ErrApplicantNotFound without a database call and without counting as a guess. A well-formed
// code is looked up through the guard: an unknown one counts as a miss, and a refused client gets
// *CodeGuessLimitedError before any lookup.
func findByCode(ctx context.Context, guard *CodeGuard, repo domain.ApplicantRepository, raw, action string, before func()) (*domain.Applicant, error) {
	code := normalizeAppNo(raw)
	if !appNoRe.MatchString(code) {
		return nil, ErrApplicantNotFound
	}
	var a *domain.Applicant
	err := guard.Do(ctx, action, func() error {
		if before != nil {
			before()
		}
		var err error
		a, err = repo.GetByApplicationNo(ctx, code)
		return err
	})
	if err != nil {
		return nil, notFoundOr(err)
	}
	return a, nil
}
