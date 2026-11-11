package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

const (
	realSecret   = "0x4AAAAAAAreal-secret-from-dashboard"
	dummyPass    = "1x0000000000000000000000000000000AA"
	dummyFail    = "2x0000000000000000000000000000000AA"
	dummySpent   = "3x0000000000000000000000000000000AA"
	testIdemKey  = "4f1c2b8e-6a0d-4f7e-9a51-0c2d6b1e7a90"
	someToken    = "XXXX.DUMMY.TOKEN.XXXX"
	siteHostname = "comcamp.example"
)

// fakeSiteverify is a stand-in for Cloudflare's endpoint that records what it was sent.
type fakeSiteverify struct {
	*httptest.Server
	mu     sync.Mutex
	calls  int
	last   url.Values
	status int
	body   map[string]any
	delay  time.Duration
}

func newFakeSiteverify(t *testing.T, status int, body map[string]any) *fakeSiteverify {
	t.Helper()
	f := &fakeSiteverify{status: status, body: body}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		f.calls++
		f.last = r.PostForm
		delay, status, body := f.delay, f.status, f.body
		f.mu.Unlock()
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("siteverify must be a form POST, got %s %q", r.Method, r.Header.Get("Content-Type"))
		}
		time.Sleep(delay)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeSiteverify) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func verifierFor(f *fakeSiteverify, secret string, hosts ...string) service.TurnstileVerifier {
	return service.NewTurnstileVerifierWith(secret, hosts, f.URL, &http.Client{Timeout: 300 * time.Millisecond})
}

func TestTurnstile_MissingTokenFailsWithoutCallingCloudflare(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": siteHostname})
	v := verifierFor(f, realSecret, siteHostname)
	for _, tok := range []string{"", "   ", string(make([]byte, 2049))} {
		if err := v.Verify(context.Background(), tok, "203.0.113.7", ""); !errors.Is(err, service.ErrCaptchaFailed) {
			t.Fatalf("token %q: expected ErrCaptchaFailed, got %v", tok[:min(len(tok), 5)], err)
		}
	}
	if f.callCount() != 0 {
		t.Fatalf("an empty or oversized token must not reach Cloudflare, got %d calls", f.callCount())
	}
}

func TestTurnstile_ValidTokenSendsSecretTokenIPAndKey(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": siteHostname})
	v := verifierFor(f, realSecret, siteHostname)
	if err := v.Verify(context.Background(), someToken, "203.0.113.7", testIdemKey); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if got := f.last; got.Get("secret") != realSecret || got.Get("response") != someToken ||
		got.Get("remoteip") != "203.0.113.7" || got.Get("idempotency_key") != testIdemKey {
		t.Fatalf("unexpected siteverify form: %v", got)
	}
}

func TestTurnstile_InvalidIdempotencyKeyIsNotForwarded(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": siteHostname})
	v := verifierFor(f, realSecret, siteHostname)
	if err := v.Verify(context.Background(), someToken, "", "not-a-uuid"); err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if _, ok := f.last["idempotency_key"]; ok {
		t.Error("a non-UUID idempotency key must not be sent to Cloudflare")
	}
	if _, ok := f.last["remoteip"]; ok {
		t.Error("an empty remote IP must not be sent to Cloudflare")
	}
}

func TestTurnstile_RejectedTokenIsCaptchaFailed(t *testing.T) {
	for _, code := range []string{"invalid-input-response", "timeout-or-duplicate", "bad-request"} {
		f := newFakeSiteverify(t, 200, map[string]any{"success": false, "error-codes": []string{code}})
		err := verifierFor(f, realSecret, siteHostname).Verify(context.Background(), someToken, "", "")
		if !errors.Is(err, service.ErrCaptchaFailed) {
			t.Errorf("%s: expected ErrCaptchaFailed, got %v", code, err)
		}
	}
}

func TestTurnstile_CloudflareAndConfigProblemsFailClosedAsUnavailable(t *testing.T) {
	cases := map[string]struct {
		status int
		body   map[string]any
	}{
		"http 500":              {500, map[string]any{}},
		"http 429":              {429, map[string]any{}},
		"internal-error":        {200, map[string]any{"success": false, "error-codes": []string{"internal-error"}}},
		"invalid-input-secret":  {200, map[string]any{"success": false, "error-codes": []string{"invalid-input-secret"}}},
		"missing-input-secret":  {200, map[string]any{"success": false, "error-codes": []string{"missing-input-secret"}}},
		"success without proof": {200, nil}, // body "null": decodes to an empty (success=false) answer
	}
	for name, tc := range cases {
		f := newFakeSiteverify(t, tc.status, tc.body)
		err := verifierFor(f, realSecret, siteHostname).Verify(context.Background(), someToken, "", "")
		if name == "success without proof" {
			if err == nil {
				t.Errorf("%s: an empty answer must never verify", name)
			}
			continue
		}
		if !errors.Is(err, service.ErrCaptchaUnavailable) {
			t.Errorf("%s: expected ErrCaptchaUnavailable, got %v", name, err)
		}
	}
}

func TestTurnstile_NetworkErrorAndTimeoutFailClosed(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": siteHostname})
	f.delay = 800 * time.Millisecond // longer than the 300 ms client timeout
	if err := verifierFor(f, realSecret, siteHostname).Verify(context.Background(), someToken, "", ""); !errors.Is(err, service.ErrCaptchaUnavailable) {
		t.Errorf("timeout: expected ErrCaptchaUnavailable, got %v", err)
	}

	dead := newFakeSiteverify(t, 200, map[string]any{"success": true})
	dead.Close()
	err := verifierFor(dead, realSecret, siteHostname).Verify(context.Background(), someToken, "", "")
	if !errors.Is(err, service.ErrCaptchaUnavailable) {
		t.Errorf("connection refused: expected ErrCaptchaUnavailable, got %v", err)
	}
	if err != nil && (strings.Contains(err.Error(), realSecret) || strings.Contains(err.Error(), someToken)) {
		t.Errorf("the error must not leak the secret or token: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := verifierFor(f, realSecret, siteHostname).Verify(ctx, someToken, "", ""); !errors.Is(err, service.ErrCaptchaUnavailable) {
		t.Errorf("cancelled context: expected ErrCaptchaUnavailable, got %v", err)
	}
}

func TestTurnstile_HostnameMustMatchWithARealSecret(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": "evil.example"})
	if err := verifierFor(f, realSecret, siteHostname, "localhost").Verify(context.Background(), someToken, "", ""); !errors.Is(err, service.ErrCaptchaFailed) {
		t.Fatalf("hostname mismatch: expected ErrCaptchaFailed, got %v", err)
	}

	f.mu.Lock()
	f.body = map[string]any{"success": true, "hostname": "COMCAMP.example"}
	f.mu.Unlock()
	if err := verifierFor(f, realSecret, siteHostname).Verify(context.Background(), someToken, "", ""); err != nil {
		t.Fatalf("hostnames compare case-insensitively, got %v", err)
	}

	f.mu.Lock()
	f.body = map[string]any{"success": true} // no hostname at all
	f.mu.Unlock()
	if err := verifierFor(f, realSecret, siteHostname).Verify(context.Background(), someToken, "", ""); !errors.Is(err, service.ErrCaptchaFailed) {
		t.Fatalf("a missing hostname must not pass with a real secret, got %v", err)
	}
}

func TestTurnstile_DummySecretsSkipTheHostnameCheck(t *testing.T) {
	f := newFakeSiteverify(t, 200, map[string]any{"success": true, "hostname": "example.com"})
	if err := verifierFor(f, dummyPass, siteHostname).Verify(context.Background(), someToken, "", ""); err != nil {
		t.Fatalf("dummy secret + example.com hostname should pass, got %v", err)
	}
	for _, s := range []string{dummyPass, dummyFail, dummySpent} {
		if !service.IsTurnstileTestSecret(s) {
			t.Errorf("%s should be recognised as a dummy secret", s)
		}
	}
	for _, s := range []string{realSecret, "", "4x0000000000000000000000000000000AA", "1x0000000000000000000000000000000AB"} {
		if service.IsTurnstileTestSecret(s) {
			t.Errorf("%q must not be treated as a dummy secret", s)
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Registration flow: ordering of replay, captcha and storage.
// ---------------------------------------------------------------------------------------------

// onceVerifier behaves like Cloudflare: a token verifies once, a second use is rejected.
type onceVerifier struct {
	mu    sync.Mutex
	used  map[string]bool
	calls int
	err   error // when set, returned instead (simulates an outage)
}

func (o *onceVerifier) Verify(_ context.Context, token, _ string, _ string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.calls++
	if o.err != nil {
		return o.err
	}
	if token == "" || o.used[token] || token == "bad" {
		return service.ErrCaptchaFailed
	}
	if o.used == nil {
		o.used = map[string]bool{}
	}
	o.used[token] = true
	return nil
}

func captchaTestRequest(nid, token string) service.ApplicationCreateRequest {
	return service.ApplicationCreateRequest{
		FullName: "สมชาย ใจดี", Nickname: "ชาย", NationalID: nid, Phone: "0812345678",
		Email: "somchai@example.com", School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "L",
		Motivation: "อยากเรียนรู้ IoT", TurnstileToken: token,
	}
}

func TestSubmit_CaptchaRunsBeforeAnythingIsStored(t *testing.T) {
	svc, appRepo, _ := setupTestServices()
	v := &onceVerifier{}
	svc.WithTurnstile(v)
	nid := validTestNationalID(41)

	if _, err := svc.Submit(context.Background(), captchaTestRequest(nid, "")); !errors.Is(err, service.ErrCaptchaFailed) {
		t.Fatalf("missing token: expected ErrCaptchaFailed, got %v", err)
	}
	if _, err := svc.Submit(context.Background(), captchaTestRequest(nid, "bad")); !errors.Is(err, service.ErrCaptchaFailed) {
		t.Fatalf("rejected token: expected ErrCaptchaFailed, got %v", err)
	}
	v.err = service.ErrCaptchaUnavailable
	if _, err := svc.Submit(context.Background(), captchaTestRequest(nid, "t-1")); !errors.Is(err, service.ErrCaptchaUnavailable) {
		t.Fatalf("upstream outage: expected ErrCaptchaUnavailable, got %v", err)
	}
	if n, _ := appRepo.CountActive(context.Background()); n != 0 {
		t.Fatalf("nothing may be stored while the captcha is failing, found %d rows", n)
	}

	v.err = nil
	if res, err := svc.Submit(context.Background(), captchaTestRequest(nid, "t-2")); err != nil || res.Status != domain.StatusPassed {
		t.Fatalf("valid token: expected a PASSED application, got %v / %v", res, err)
	}
}

func TestSubmit_InvalidFormIsRejectedBeforeSpendingTheToken(t *testing.T) {
	svc, _, _ := setupTestServices()
	v := &onceVerifier{}
	svc.WithTurnstile(v)
	req := captchaTestRequest("1234567890123", "t-1") // wrong check digit
	var ve *service.ValidationError
	if _, err := svc.Submit(context.Background(), req); !errors.As(err, &ve) {
		t.Fatalf("expected a validation error, got %v", err)
	}
	if v.calls != 0 {
		t.Fatalf("a malformed request must not call Turnstile, got %d calls", v.calls)
	}
}

func TestSubmit_IdempotentRetryWorksAfterTheTokenIsSpent(t *testing.T) {
	svc, _, _ := setupTestServices()
	v := &onceVerifier{}
	svc.WithTurnstile(v)
	nid := validTestNationalID(42)
	req := captchaTestRequest(nid, "token-A")

	first, replayed, err := svc.SubmitWithKey(context.Background(), req, testIdemKey)
	if err != nil || replayed {
		t.Fatalf("first submit: %v replayed=%v", err, replayed)
	}
	if v.calls != 1 {
		t.Fatalf("first submit should verify once, got %d", v.calls)
	}

	// The 201 never reached the phone; it retries with the same key AND the same, now spent, token.
	again, replayed, err := svc.SubmitWithKey(context.Background(), req, testIdemKey)
	if err != nil || !replayed || again.ID != first.ID {
		t.Fatalf("retry: expected the stored application replayed, got %v replayed=%v err=%v", again, replayed, err)
	}
	if v.calls != 1 {
		t.Fatalf("a replay must not consume or verify a token, got %d verifier calls", v.calls)
	}

	// The same key for a different national ID is still refused, still without touching Turnstile.
	other := captchaTestRequest(validTestNationalID(43), "token-B")
	if _, _, err := svc.SubmitWithKey(context.Background(), other, testIdemKey); !errors.Is(err, service.ErrIdempotencyKeyReused) {
		t.Fatalf("key reuse: expected ErrIdempotencyKeyReused, got %v", err)
	}
	if v.calls != 1 {
		t.Fatalf("key reuse must not call Turnstile, got %d calls", v.calls)
	}
}

func TestSubmit_SpentTokenWithoutAStoredRowIsRejected(t *testing.T) {
	svc, _, _ := setupTestServices()
	v := &onceVerifier{}
	svc.WithTurnstile(v)
	if _, _, err := svc.SubmitWithKey(context.Background(), captchaTestRequest(validTestNationalID(44), "token-A"), testIdemKey); err != nil {
		t.Fatal(err)
	}
	// Reusing the spent token for a NEW applicant (new key) must fail: no free replays for bots.
	_, _, err := svc.SubmitWithKey(context.Background(), captchaTestRequest(validTestNationalID(45), "token-A"), "9b2e7c14-3d5a-4e86-8f10-7a6c1d2e3f40")
	if !errors.Is(err, service.ErrCaptchaFailed) {
		t.Fatalf("expected ErrCaptchaFailed for a spent token, got %v", err)
	}
}
