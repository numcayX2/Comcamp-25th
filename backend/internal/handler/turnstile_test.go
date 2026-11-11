package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

const captchaKey = "4f1c2b8e-6a0d-4f7e-9a51-0c2d6b1e7a90"

// cloudflareLike accepts every token exactly once, like the real siteverify. fail makes it behave
// like an outage (returns the configured error).
type cloudflareLike struct {
	mu    sync.Mutex
	used  map[string]bool
	calls int
	err   error
	ip    string
}

func (c *cloudflareLike) Verify(_ context.Context, token, remoteIP, _ string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	c.ip = remoteIP
	if c.err != nil {
		return c.err
	}
	if token == "" || token == "bad" || c.used[token] {
		return service.ErrCaptchaFailed
	}
	if c.used == nil {
		c.used = map[string]bool{}
	}
	c.used[token] = true
	return nil
}

func submitBody(nationalID, token string) *bytes.Buffer {
	body, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName: "สมเกียรติ สุขสมบูรณ์", Nickname: "เกียรติ", NationalID: nationalID, Phone: "0840012345",
		Email: "hl@example.com", School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "XL",
		Motivation: "อยากเรียนรู้การต่อวงจร", TurnstileToken: token,
	})
	return bytes.NewBuffer(body)
}

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	return e.Code
}

func TestTurnstile_MissingAndInvalidTokenAre403CaptchaFailed(t *testing.T) {
	v := &cloudflareLike{}
	app := setupTestAppFull(t, server.DefaultRateLimits(), v)
	for name, tok := range map[string]string{"missing": "", "invalid": "bad"} {
		rec := app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(51), tok), nil)
		if rec.Code != http.StatusForbidden || errCode(t, rec) != "CAPTCHA_FAILED" {
			t.Fatalf("%s token: expected 403 CAPTCHA_FAILED, got %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if n, _ := app.appRepo.CountActive(context.Background()); n != 0 {
		t.Fatalf("a failed captcha must store nothing, found %d", n)
	}
}

func TestTurnstile_CloudflareOutageFailsClosedWith503(t *testing.T) {
	v := &cloudflareLike{err: service.ErrCaptchaUnavailable}
	app := setupTestAppFull(t, server.DefaultRateLimits(), v)
	rec := app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(52), "token-1"), map[string]string{"X-Idempotency-Key": captchaKey})
	if rec.Code != http.StatusServiceUnavailable || errCode(t, rec) != "SERVICE_UNAVAILABLE" || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("expected 503 SERVICE_UNAVAILABLE + Retry-After, got %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}
	if n, _ := app.appRepo.CountActive(context.Background()); n != 0 {
		t.Fatalf("an outage must not let anyone through, found %d rows", n)
	}

	// Cloudflare is back: the same key and form succeed, so the applicant lost nothing.
	v.mu.Lock()
	v.err = nil
	v.mu.Unlock()
	rec = app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(52), "token-2"), map[string]string{"X-Idempotency-Key": captchaKey})
	if rec.Code != http.StatusCreated {
		t.Fatalf("retry after the outage: expected 201, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestTurnstile_ValidTokenCreatesApplicationAndIsNeverEchoed(t *testing.T) {
	v := &cloudflareLike{}
	app := setupTestAppFull(t, server.DefaultRateLimits(), v)
	rec := app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(53), "secret-looking-token"), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secret-looking-token") || strings.Contains(strings.ToLower(rec.Body.String()), "turnstile") {
		t.Fatalf("the token must not appear in the response: %s", rec.Body.String())
	}
	if v.ip == "" {
		t.Error("the client IP must be forwarded to the verifier")
	}
}

func TestTurnstile_IdempotentRetryWithSpentTokenReplays(t *testing.T) {
	v := &cloudflareLike{}
	app := setupTestAppFull(t, server.DefaultRateLimits(), v)
	nid := validTestNationalID(54)
	key := map[string]string{"X-Idempotency-Key": captchaKey}

	first := app.do(t, http.MethodPost, "/api/applications", submitBody(nid, "one-shot"), key)
	if first.Code != http.StatusCreated {
		t.Fatalf("first submit: expected 201, got %d %s", first.Code, first.Body.String())
	}
	// Mobile network dropped the 201; the phone retries with the same key and the same spent token.
	retry := app.do(t, http.MethodPost, "/api/applications", submitBody(nid, "one-shot"), key)
	if retry.Code != http.StatusOK || retry.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("retry: expected 200 + Idempotent-Replayed, got %d %v %s", retry.Code, retry.Header(), retry.Body.String())
	}
	var a, b service.ApplicationResponse
	_ = json.Unmarshal(first.Body.Bytes(), &a)
	_ = json.Unmarshal(retry.Body.Bytes(), &b)
	if a.ID == "" || a.ID != b.ID {
		t.Fatalf("the retry must return the original application, got %q vs %q", a.ID, b.ID)
	}
	if v.calls != 1 {
		t.Fatalf("the replay must not touch Turnstile, got %d verifier calls", v.calls)
	}

	// Same key, different national ID: refused, and still no Turnstile call.
	other := app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(55), "another"), key)
	if other.Code != http.StatusUnprocessableEntity || errCode(t, other) != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatalf("key reuse: expected 422 IDEMPOTENCY_KEY_REUSED, got %d %s", other.Code, other.Body.String())
	}
	if v.calls != 1 {
		t.Fatalf("key reuse must not touch Turnstile, got %d calls", v.calls)
	}
}

// End to end through the real HTTP verifier against a fake Cloudflare: hostname enforcement.
func TestTurnstile_RealVerifierRejectsAForeignHostname(t *testing.T) {
	host := "evil.example"
	cf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "hostname": host})
	}))
	defer cf.Close()
	v := service.NewTurnstileVerifierWith("0x4AAAAAAAreal-secret-from-dashboard", []string{"comcamp.example"}, cf.URL, &http.Client{Timeout: time.Second})
	app := setupTestAppFull(t, server.DefaultRateLimits(), v)

	rec := app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(56), "tok"), nil)
	if rec.Code != http.StatusForbidden || errCode(t, rec) != "CAPTCHA_FAILED" {
		t.Fatalf("foreign hostname: expected 403 CAPTCHA_FAILED, got %d %s", rec.Code, rec.Body.String())
	}
	host = "comcamp.example"
	rec = app.do(t, http.MethodPost, "/api/applications", submitBody(validTestNationalID(56), "tok"), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("matching hostname: expected 201, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubmitRateLimitIsEightPerMinute(t *testing.T) {
	app := setupTestApp(t) // default limits, captcha off
	var lastCode int
	for i := 0; i < 9; i++ {
		// invalid national ID: cheap 400s that still count against the limiter
		rec := app.do(t, http.MethodPost, "/api/applications", submitBody("1234567890123", ""), nil)
		lastCode = rec.Code
		if i < 8 && rec.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d was limited too early", i+1)
		}
	}
	if lastCode != http.StatusTooManyRequests {
		t.Fatalf("the 9th submit within a minute should be 429, got %d", lastCode)
	}
}
