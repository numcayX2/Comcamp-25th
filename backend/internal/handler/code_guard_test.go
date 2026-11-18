package handler_test

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// Since migration 000011 the application code (CC25-XXXXXX) is the applicant's only proof on the
// public endpoints. These tests drive service.CodeGuard through the real router: unknown codes
// count per client (IP) and globally across the status lookup, confirm, slip upload and withdraw,
// and a refusal is 429 RATE_LIMITED with Retry-After, answered before any lookup.

func (a *testApp) confirmWith(t *testing.T, appID string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPost, "/api/applications/"+appID+"/confirm", bytes.NewBufferString(`{"confirmed":true}`), nil)
}

// doAs sends a request from the given client address (no trusted proxy, so it is the client IP).
func (a *testApp) doAs(t *testing.T, ip, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, bytes.NewBufferString(body))
		r.Header.Set("Content-Type", "application/json")
	}
	r.RemoteAddr = ip + ":40000"
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, r)
	return rec
}

func wantErrCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("expected %d, got %d (%s)", status, rec.Code, rec.Body.String())
	}
	if e := decodeErr(t, rec.Body.Bytes()); code != "" && e.Code != code {
		t.Fatalf("expected code %s, got %q (%s)", code, e.Code, rec.Body.String())
	}
}

// wantLimited checks a refusal: 429 RATE_LIMITED with a Retry-After between 1 second and max.
func wantLimited(t *testing.T, rec *httptest.ResponseRecorder, max time.Duration) int {
	t.Helper()
	wantErrCode(t, rec, http.StatusTooManyRequests, response.CodeRateLimited)
	secs, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || secs < 1 || secs > int(max/time.Second) {
		t.Fatalf("Retry-After must be 1..%d seconds, got %q", int(max/time.Second), rec.Header().Get("Retry-After"))
	}
	return secs
}

func (a *testApp) auditOf(action domain.AuditAction) []domain.AuditEntry {
	var out []domain.AuditEntry
	for _, e := range a.appRepo.Audit().Entries() {
		if e.Action == action {
			out = append(out, e)
		}
	}
	return out
}

// guessAt names an unknown, well-formed code on one of the four code-keyed endpoints.
func (a *testApp) guessAt(t *testing.T, ip, endpoint string, n int) *httptest.ResponseRecorder {
	t.Helper()
	code := fmt.Sprintf("CC25-%06X", 0xF00000+n)
	switch endpoint {
	case "status":
		return a.doAs(t, ip, http.MethodGet, "/api/applications/status?q="+code, "")
	case "confirm":
		return a.doAs(t, ip, http.MethodPost, "/api/applications/"+code+"/confirm", `{"confirmed":true}`)
	case "withdraw":
		return a.doAs(t, ip, http.MethodPost, "/api/applications/"+code+"/withdraw", `{}`)
	default:
		body, headers := slipForm(t, "slip.jpg", jpegBytes)
		r := httptest.NewRequest(http.MethodPost, "/api/applications/"+code+"/slip", body)
		r.Header.Set("Content-Type", headers["Content-Type"])
		r.RemoteAddr = ip + ":40000"
		rec := httptest.NewRecorder()
		a.ServeHTTP(rec, r)
		return rec
	}
}

// One client naming unknown codes on any mix of endpoints is locked out after CodeClientMaxMisses,
// even for a code that exists, with escalating lockouts; other clients carry on.
func TestCodeGuard_UnknownCodesLockTheClientAcrossEndpoints(t *testing.T) {
	app := setupRelaxedApp(t)
	mine := app.submit(t, "0810000501", "guard1@example.com")
	const attacker, student = "198.51.100.66", "203.0.113.10"

	endpoints := []string{"status", "confirm", "slip", "withdraw", "status"}
	for i, ep := range endpoints[:service.CodeClientMaxMisses] {
		wantErrCode(t, app.guessAt(t, attacker, ep, i), http.StatusNotFound, response.CodeNotFound)
	}
	secs := wantLimited(t, app.doAs(t, attacker, http.MethodGet, "/api/applications/status?q="+mine.ID, ""), service.CodeBaseLockout)
	if secs != int(service.CodeBaseLockout/time.Second) {
		t.Fatalf("first lockout should report the full %v, got %ds", service.CodeBaseLockout, secs)
	}
	wantLimited(t, app.doAs(t, attacker, http.MethodPost, "/api/applications/"+mine.ID+"/withdraw", `{}`), service.CodeBaseLockout)
	if _, err := app.applicant(t, mine.ID); err != nil {
		t.Fatalf("a refused withdraw must not remove the application: %v", err)
	}

	// The phone lookup shares the client's record (ruling R25): a locked client is refused it too.
	wantLimited(t, app.doAs(t, attacker, http.MethodGet, "/api/applications/status?q=0810000501", ""), service.CodeBaseLockout)
	// Another client is not affected.
	if rec := app.doAs(t, student, http.MethodGet, "/api/applications/status?q="+mine.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("another client: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	lockouts := app.auditOf(domain.AuditCodeGuessLockout)
	if len(lockouts) != 1 || lockouts[0].IPAddress != attacker || lockouts[0].AdminID != nil ||
		lockouts[0].Details["endpoint"] != service.CodeActionStatus {
		t.Fatalf("expected one lockout audit row for the attacker, got %+v", lockouts)
	}

	// The lockout runs out; the next round locks for twice as long.
	app.clock.Advance(service.CodeBaseLockout)
	if rec := app.doAs(t, attacker, http.MethodGet, "/api/applications/status?q="+mine.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("after the lockout: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	app.clock.Advance(service.CodeGlobalWindow) // a fresh global window, so only the client budget applies
	for i := 0; i < service.CodeClientMaxMisses; i++ {
		app.guessAt(t, attacker, "confirm", 100+i)
	}
	second := app.doAs(t, attacker, http.MethodPost, "/api/applications/"+mine.ID+"/confirm", `{"confirmed":true}`)
	if secs := wantLimited(t, second, 2*service.CodeBaseLockout); secs != int(2*service.CodeBaseLockout/time.Second) {
		t.Fatalf("second lockout should be %v, got %ds", 2*service.CodeBaseLockout, secs)
	}
}

// The global ceilings hold against guesses spread over many addresses. Once the soft ceiling is
// reached, clients with a miss on record are refused; at the hard ceiling everyone is, but only
// until the (short) window ends, so a student typing their own code waits at most that long.
func TestCodeGuard_GlobalCeilingSpansClients(t *testing.T) {
	app := setupRelaxedApp(t)
	mine := app.submit(t, "0810000502", "guard2@example.com")
	ip := func(i int) string { return fmt.Sprintf("192.0.2.%d", 100+i) }

	for i := 0; i < service.CodeGlobalSoftCeiling; i++ {
		wantErrCode(t, app.guessAt(t, ip(i), "status", i), http.StatusNotFound, response.CodeNotFound)
	}
	// Soft: an address that already missed is refused, a clean one is served.
	wantLimited(t, app.doAs(t, ip(0), http.MethodGet, "/api/applications/status?q="+mine.ID, ""), service.CodeGlobalWindow)
	if rec := app.doAs(t, "203.0.113.20", http.MethodGet, "/api/applications/status?q="+mine.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("a clean client below the hard ceiling: expected 200, got %d", rec.Code)
	}
	// Fresh addresses keep guessing until the hard ceiling.
	for i := service.CodeGlobalSoftCeiling; i < service.CodeGlobalHardCeiling; i++ {
		wantErrCode(t, app.guessAt(t, ip(i), "confirm", i), http.StatusNotFound, response.CodeNotFound)
	}
	secs := wantLimited(t, app.doAs(t, "203.0.113.21", http.MethodGet, "/api/applications/status?q="+mine.ID, ""), service.CodeGlobalWindow)
	wantLimited(t, app.guessAt(t, "203.0.113.22", "withdraw", 99), service.CodeGlobalWindow)

	ceilings := app.auditOf(domain.AuditCodeGuessCeiling)
	if len(ceilings) != 2 || ceilings[0].Details["level"] != "soft" || ceilings[1].Details["level"] != "hard" {
		t.Fatalf("expected a soft and a hard ceiling audit row, got %+v", ceilings)
	}

	// The student is served again as soon as the window ends.
	app.clock.Advance(time.Duration(secs) * time.Second)
	if rec := app.doAs(t, "203.0.113.21", http.MethodGet, "/api/applications/status?q="+mine.ID, ""); rec.Code != http.StatusOK {
		t.Fatalf("after the window: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// Only well-formed unknown codes (and phones that match nobody, see
// TestCodeGuard_PhoneMissesLockTheClient) count. Malformed codes, codes and phones that exist and
// the disabled self-edit route never do.
func TestCodeGuard_OnlyUnknownWellFormedCodesCount(t *testing.T) {
	app := setupRelaxedApp(t)
	mine := app.submit(t, "0810000503", "guard3@example.com")
	const client = "198.51.100.77"

	for i := 0; i < 20; i++ {
		wantErrCode(t, app.doAs(t, client, http.MethodPost, "/api/applications/CC25-NOTHEX/confirm", `{"confirmed":true}`), http.StatusNotFound, response.CodeNotFound)
		wantErrCode(t, app.doAs(t, client, http.MethodPost, "/api/applications/0810000503/withdraw", `{}`), http.StatusNotFound, response.CodeNotFound)
		if rec := app.doAs(t, client, http.MethodGet, "/api/applications/status?q=0810000503", ""); rec.Code != http.StatusOK {
			t.Fatalf("round %d: the real phone must keep working, got %d (%s)", i, rec.Code, rec.Body.String())
		}
		wantErrCode(t, app.doAs(t, client, http.MethodGet, "/api/applications/status?q=CC25-1234", ""), http.StatusBadRequest, response.CodeValidation)
		wantErrCode(t, app.doAs(t, client, http.MethodPatch, "/api/applications/"+mine.ID+"/profile", `{}`), http.StatusForbidden, response.CodeForbidden)
		if rec := app.doAs(t, client, http.MethodGet, "/api/applications/status?q="+mine.ID, ""); rec.Code != http.StatusOK {
			t.Fatalf("round %d: the real code must keep working, got %d (%s)", i, rec.Code, rec.Body.String())
		}
	}
	if n := len(app.auditOf(domain.AuditCodeGuessLockout)) + len(app.auditOf(domain.AuditCodeGuessCeiling)); n != 0 {
		t.Fatalf("nothing here is a code guess, got %d guard audit rows", n)
	}
}

// The audit rows of the guard never contain a code someone typed.
func TestCodeGuard_AuditRowsCarryNoCodes(t *testing.T) {
	app := setupRelaxedApp(t)
	for i := 0; i < service.CodeClientMaxMisses; i++ {
		app.guessAt(t, "198.51.100.88", "slip", i)
	}
	for _, e := range append(app.auditOf(domain.AuditCodeGuessLockout), app.auditOf(domain.AuditCodeGuessCeiling)...) {
		if strings.Contains(fmt.Sprint(e.Details), "CC25-") {
			t.Fatalf("a guard audit row must not contain the typed code: %+v", e)
		}
	}
}

// Ruling R25: a phone that matches nobody is a miss for the client, so enumerating phone numbers
// (e.g. to find the withdraw's second factor) hits the same escalating lockout: 429 RATE_LIMITED with
// Retry-After, even for a phone that exists. Phone misses never reach the global ceilings.
func TestCodeGuard_PhoneMissesLockTheClient(t *testing.T) {
	app := setupRelaxedApp(t)
	mine := app.submit(t, "0810000504", "guard4@example.com")
	const enumerator, student = "198.51.100.99", "203.0.113.30"

	for i := 0; i < service.CodeClientMaxMisses; i++ {
		rec := app.doAs(t, enumerator, http.MethodGet, fmt.Sprintf("/api/applications/status?q=08999%05d", i), "")
		wantErrCode(t, rec, http.StatusNotFound, response.CodeNotFound)
	}
	secs := wantLimited(t, app.doAs(t, enumerator, http.MethodGet, "/api/applications/status?q=0810000504", ""), service.CodeBaseLockout)
	if secs != int(service.CodeBaseLockout/time.Second) {
		t.Fatalf("first lockout should report the full %v, got %ds", service.CodeBaseLockout, secs)
	}
	// Locked for code lookups as well.
	wantLimited(t, app.doAs(t, enumerator, http.MethodGet, "/api/applications/status?q="+mine.ID, ""), service.CodeBaseLockout)
	// Another client is not affected.
	if rec := app.doAs(t, student, http.MethodGet, "/api/applications/status?q=0810000504", ""); rec.Code != http.StatusOK {
		t.Fatalf("another client: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rows := app.auditOf(domain.AuditCodeGuessLockout); len(rows) != 1 || rows[0].Details["endpoint"] != service.CodeActionStatusPhone {
		t.Fatalf("expected one lockout row for the phone lookup, got %+v", rows)
	}
	if n := len(app.auditOf(domain.AuditCodeGuessCeiling)); n != 0 {
		t.Fatalf("phone misses must not reach the global ceilings, got %d ceiling rows", n)
	}
	if body := app.doAs(t, student, http.MethodGet, "/api/applications/status?q=0810000504", "").Body.String(); strings.Contains(body, mine.ID) {
		t.Fatalf("a phone hit must not reveal the code: %s", body)
	}
}
