package middleware_test

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
)

type stubVerifier struct {
	claims *middleware.AdminClaims
	err    error
	seen   string
}

func (s *stubVerifier) VerifyToken(_ context.Context, token string) (*middleware.AdminClaims, error) {
	s.seen = token
	if s.err != nil {
		return nil, s.err
	}
	return s.claims, nil
}

func TestRequireAuth(t *testing.T) {
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := middleware.GetAdminClaims(r.Context())
		if claims == nil {
			t.Fatal("expected admin claims in context")
		}
		w.WriteHeader(http.StatusOK)
	})

	t.Run("nil verifier returns 500", func(t *testing.T) {
		h := middleware.RequireAuth(nil)(okHandler)
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d", rec.Code)
		}
	})

	t.Run("missing or malformed Authorization headers return 401", func(t *testing.T) {
		v := &stubVerifier{claims: &middleware.AdminClaims{AdminID: 1, Role: domain.RoleAdmin}}
		h := middleware.RequireAuth(v)(okHandler)

		headers := []string{
			"",
			"   ",
			"Basic dXNlcjpwYXNz",
			"Bearer",
			"Bearer   ",
			"Token abc.def.ghi",
		}
		for _, hdr := range headers {
			req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
			if hdr != "" {
				req.Header.Set("Authorization", hdr)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("header %q: expected 401, got %d", hdr, rec.Code)
			}
		}
	})

	t.Run("verifier error returns 401", func(t *testing.T) {
		v := &stubVerifier{err: errors.New("revoked")}
		h := middleware.RequireAuth(v)(okHandler)
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		req.Header.Set("Authorization", "Bearer bad-token")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", rec.Code)
		}
	})

	t.Run("non-admin role returns 403", func(t *testing.T) {
		v := &stubVerifier{
			claims: &middleware.AdminClaims{
				AdminID:  2,
				Username: "other",
				Role:     domain.AdminRole("staff"),
			},
		}
		h := middleware.RequireAuth(v)(okHandler)
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		req.Header.Set("Authorization", "Bearer valid-non-admin")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("valid admin token succeeds and populates claims", func(t *testing.T) {
		v := &stubVerifier{
			claims: &middleware.AdminClaims{
				AdminID:  1,
				Username: "admin",
				Role:     domain.RoleAdmin,
				TokenID:  "jti-123",
			},
		}
		h := middleware.RequireAuth(v)(okHandler)
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		req.Header.Set("Authorization", "bearer my-jwt-token")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		if v.seen != "my-jwt-token" {
			t.Errorf("expected verifier to receive trimmed token, got %q", v.seen)
		}
	})
}

func TestNewCORS(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("explicit origin allows credentials", func(t *testing.T) {
		h := middleware.NewCORS([]string{"https://comcamp.csmju.com"})(next)
		req := httptest.NewRequest(http.MethodOptions, "/api/health", nil)
		req.Header.Set("Origin", "https://comcamp.csmju.com")
		req.Header.Set("Access-Control-Request-Method", "GET")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://comcamp.csmju.com" {
			t.Errorf("expected Allow-Origin https://comcamp.csmju.com, got %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Errorf("expected Allow-Credentials true, got %q", got)
		}
	})

	t.Run("disallowed origin does not receive Allow-Origin", func(t *testing.T) {
		h := middleware.NewCORS([]string{"https://comcamp.csmju.com"})(next)
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("expected empty Allow-Origin for disallowed origin, got %q", got)
		}
	})

	t.Run("wildcard disables Allow-Credentials", func(t *testing.T) {
		h := middleware.NewCORS([]string{"*"})(next)
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Origin", "https://any.example.com")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("expected Allow-Origin *, got %q", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
			t.Errorf("expected Allow-Credentials to be omitted for wildcard, got %q", got)
		}
	})
}

func TestRateLimiter(t *testing.T) {
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("throttles after limit with 429 and Retry-After then resets", func(t *testing.T) {
		rl := middleware.NewRateLimiter(2, 60*time.Millisecond, nil)
		h := rl.Middleware(okHandler)

		for i := 0; i < 2; i++ {
			req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
			req.RemoteAddr = "203.0.113.10:12345"
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("request %d: expected 200, got %d", i+1, rec.Code)
			}
		}

		// 3rd request from same IP -> 429
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		req.RemoteAddr = "203.0.113.10:54321"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("expected 429 Too Many Requests, got %d", rec.Code)
		}
		if rec.Header().Get("Retry-After") == "" {
			t.Errorf("expected Retry-After header on 429 response")
		}

		// Different IP is still allowed
		otherReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		otherReq.RemoteAddr = "203.0.113.11:1111"
		otherRec := httptest.NewRecorder()
		h.ServeHTTP(otherRec, otherReq)
		if otherRec.Code != http.StatusOK {
			t.Fatalf("expected 200 for separate IP, got %d", otherRec.Code)
		}

		// Wait for window to elapse
		time.Sleep(80 * time.Millisecond)
		resetReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
		resetReq.RemoteAddr = "203.0.113.10:9999"
		resetRec := httptest.NewRecorder()
		h.ServeHTTP(resetRec, resetReq)
		if resetRec.Code != http.StatusOK {
			t.Fatalf("expected 200 after rate limit window reset, got %d", resetRec.Code)
		}
	})

	t.Run("trusted proxy IP extraction prevents XFF spoofing", func(t *testing.T) {
		trusted := middleware.ParseTrustedProxies([]string{"10.0.0.0/8", "127.0.0.1"})

		// Untrusted peer spoofing X-Forwarded-For -> ignored
		reqSpoof := httptest.NewRequest(http.MethodGet, "/", nil)
		reqSpoof.RemoteAddr = "198.51.100.5:4000"
		reqSpoof.Header.Set("X-Forwarded-For", "1.2.3.4")
		if got := middleware.ClientIP(reqSpoof, trusted); got != "198.51.100.5" {
			t.Errorf("expected untrusted peer IP 198.51.100.5, got %q", got)
		}

		// Trusted proxy forwarding chain -> picks rightmost untrusted IP
		reqProxy := httptest.NewRequest(http.MethodGet, "/", nil)
		reqProxy.RemoteAddr = "127.0.0.1:4000"
		reqProxy.Header.Set("X-Forwarded-For", "1.1.1.1, 203.0.113.77, 10.1.2.3")
		if got := middleware.ClientIP(reqProxy, trusted); got != "203.0.113.77" {
			t.Errorf("expected 203.0.113.77 from XFF right-to-left, got %q", got)
		}

		// Trusted proxy with X-Real-IP fallback
		reqXRI := httptest.NewRequest(http.MethodGet, "/", nil)
		reqXRI.RemoteAddr = "10.0.0.5:4000"
		reqXRI.Header.Set("X-Real-IP", "192.0.2.44")
		if got := middleware.ClientIP(reqXRI, trusted); got != "192.0.2.44" {
			t.Errorf("expected 192.0.2.44 from X-Real-IP, got %q", got)
		}
	})

	t.Run("StartCleanup exits cleanly on context cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		rl := middleware.NewRateLimiter(5, time.Second, nil)
		rl.StartCleanup(ctx)
		cancel()
	})
}

func TestSecurityHeadersAndSafeLogger(t *testing.T) {
	t.Run("SecurityHeaders sets baseline headers", func(t *testing.T) {
		h := middleware.SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		expected := map[string]string{
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options":        "DENY",
			"Referrer-Policy":        "strict-origin-when-cross-origin",
			"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
		}
		for k, v := range expected {
			if got := rec.Header().Get(k); got != v {
				t.Errorf("header %s: expected %q, got %q", k, v, got)
			}
		}
	})

	t.Run("SafeLogger redacts ?q= on status endpoint and sensitive query params", func(t *testing.T) {
		var buf bytes.Buffer
		prevOut := log.Writer()
		log.SetOutput(&buf)
		t.Cleanup(func() {
			log.SetOutput(prevOut)
		})

		h := middleware.SafeLogger(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))

		req1 := httptest.NewRequest(http.MethodGet, "/api/applications/status?q=1509900112233", nil)
		req1.RemoteAddr = "127.0.0.1:5000"
		h.ServeHTTP(httptest.NewRecorder(), req1)

		req2 := httptest.NewRequest(http.MethodGet, "/api/admin/applications?status=PASSED&token=secretjwt&password=pw123&secret=s3cr3t", nil)
		req2.RemoteAddr = "127.0.0.1:5000"
		h.ServeHTTP(httptest.NewRecorder(), req2)

		logged := buf.String()
		if strings.Contains(logged, "1509900112233") {
			t.Fatalf("national ID leaked in SafeLogger output: %s", logged)
		}
		if !strings.Contains(logged, "q=REDACTED") {
			t.Errorf("expected q=REDACTED in SafeLogger output: %s", logged)
		}
		for _, secretVal := range []string{"secretjwt", "pw123", "s3cr3t"} {
			if strings.Contains(logged, secretVal) {
				t.Errorf("sensitive query value %q leaked in log: %s", secretVal, logged)
			}
		}
		if !strings.Contains(logged, "status=PASSED") {
			t.Errorf("expected non-sensitive query param status=PASSED preserved in log: %s", logged)
		}
	})
}
