package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

func decodeErr(t *testing.T, body []byte) response.ErrorResponse {
	t.Helper()
	var e response.ErrorResponse
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("expected JSON error body, got %q", body)
	}
	return e
}

// C1 — the 5 MB limit must stop the request while it streams, not after reading it into RAM.
func TestSecurity_OversizedSlipRejectedWith413(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(1), "0810000001", "a1@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)

	big := make([]byte, 6<<20)
	copy(big, jpegBytes)
	rec := app.uploadSlip(t, created.ID, "big.jpg", big)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Same for an unknown application: the size check happens before any lookup.
	rec = app.uploadSlip(t, "CC25-NOPE00", "big.jpg", big)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for unknown id too, got %d", rec.Code)
	}
}

func TestSecurity_OversizedJSONRejectedWith413(t *testing.T) {
	app := setupTestApp(t)
	huge := `{"fullName":"` + strings.Repeat("ก", 100_000) + `"}`
	rec := app.do(t, http.MethodPost, "/api/applications", bytes.NewBufferString(huge), nil)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", rec.Code)
	}
}

// §13.4 strict file validation: only JPEG/PNG/WebP by magic bytes.
func TestSecurity_SlipTypeAllowlist(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(2), "0810000002", "a2@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)

	for name, data := range map[string][]byte{"gif": gifBytes, "pdf": pdfBytes, "octet-stream": binBytes} {
		t.Run(name, func(t *testing.T) {
			rec := app.uploadSlip(t, created.ID, "renamed.jpg", data)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 for %s disguised as .jpg, got %d", name, rec.Code)
			}
		})
	}

	t.Run("png accepted", func(t *testing.T) {
		if rec := app.uploadSlip(t, created.ID, "slip.png", pngBytes); rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for png, got %d (%s)", rec.Code, rec.Body.String())
		}
	})
}

// C4 — slips are not public static files; only an authenticated admin can fetch them.
func TestSecurity_SlipsNotPubliclyServed(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(3), "0810000003", "a3@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)
	if rec := app.uploadSlip(t, created.ID, "slip.jpg", jpegBytes); rec.Code != http.StatusOK {
		t.Fatalf("upload failed: %d", rec.Code)
	}

	for _, path := range []string{"/uploads/slips/", "/uploads/"} {
		if rec := app.do(t, http.MethodGet, path, nil, nil); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s: expected 404, got %d", path, rec.Code)
		}
	}
	if rec := app.do(t, http.MethodGet, service.AdminSlipPath(created.ID), nil, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("slip without token: expected 401, got %d", rec.Code)
	}

	// The public status response must not expose any slip location.
	rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil)
	if strings.Contains(rec.Body.String(), "slipUrl") || strings.Contains(rec.Body.String(), "uploads") {
		t.Errorf("public status leaks slip location: %s", rec.Body.String())
	}

	// Viewing a slip is audited.
	if rec := app.do(t, http.MethodGet, service.AdminSlipPath(created.ID), nil, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("admin slip fetch: %d", rec.Code)
	}
	if !hasAudit(app, domain.AuditSlipViewed, created.ID) {
		t.Error("expected a payment.slip.view audit entry")
	}
}

// C5 — the public status API masks identifiers server-side and omits free text.
func TestSecurity_PublicStatusIsMasked(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, e2eNationalID, "0819876543", "somkiat@school.ac.th")

	for _, q := range []string{e2eNationalID, "0819876543", created.ID} {
		rec := app.do(t, http.MethodGet, "/api/applications/status?q="+q, nil, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("q=%s: expected 200, got %d", q, rec.Code)
		}
		body := rec.Body.String()
		for _, secret := range []string{e2eNationalID, "0819876543", "somkiat@school.ac.th", "ESP8266"} {
			if strings.Contains(body, secret) {
				t.Errorf("q=%s: public response contains %q: %s", q, secret, body)
			}
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if res.NationalID != "1-5099-XXXXX-XX-X" || res.Phone != "XXX-XXX-6543" || res.Email != "s***@school.ac.th" {
			t.Errorf("unexpected masking: %+v", res)
		}
	}

	// The submit response is masked too.
	if created.NationalID != "1-5099-XXXXX-XX-X" {
		t.Errorf("submit response not masked: %q", created.NationalID)
	}
}

// §13.2 — a deactivated admin loses access immediately, not when the token expires.
func TestSecurity_DeactivatedAdminTokenRejected(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	if rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 before deactivation, got %d", rec.Code)
	}
	_ = app.adminRepo.SetActive(app.adminID, false)
	if rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 after deactivation, got %d", rec.Code)
	}
}

// §13.2 — login failures look identical whether the user is unknown, inactive or mistyped.
func TestSecurity_LoginDoesNotRevealAccountState(t *testing.T) {
	app := setupTestApp(t)
	_ = app.adminRepo.SetActive(app.adminID, false)

	attempts := map[string]string{
		"inactive account, right password": fmt.Sprintf(`{"username":%q,"password":%q}`, testAdminUser, testAdminPass),
		"wrong password":                   fmt.Sprintf(`{"username":%q,"password":"nope"}`, testAdminUser),
		"unknown user":                     `{"username":"ghost","password":"nope"}`,
	}
	var bodies []string
	for name, body := range attempts {
		rec := app.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(body), nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d", name, rec.Code)
		}
		bodies = append(bodies, rec.Body.String())
	}
	for _, b := range bodies[1:] {
		if b != bodies[0] {
			t.Errorf("login error bodies differ: %q vs %q", bodies[0], b)
		}
	}
	if !hasAudit(app, domain.AuditLoginFailure, "ghost") {
		t.Error("expected failed logins to be audited")
	}
}

// §13.4 anti-brute-force.
func TestSecurity_LoginRateLimited(t *testing.T) {
	app := setupTestApp(t)
	var last int
	for i := 0; i < 11; i++ {
		rec := app.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"guess"}`), nil)
		last = rec.Code
		if i < 10 && rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, rec.Code)
		}
		if rec.Code == http.StatusTooManyRequests && rec.Header().Get("Retry-After") == "" {
			t.Error("429 without Retry-After")
		}
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("11th attempt: expected 429, got %d", last)
	}
}

// X-Forwarded-For from an untrusted client must not change the IP used for limits and audits.
func TestSecurity_SpoofedForwardedForIgnored(t *testing.T) {
	app := setupTestApp(t)
	for i := 0; i < 10; i++ {
		app.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"guess"}`), nil)
	}
	rec := app.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"guess"}`),
		map[string]string{"X-Forwarded-For": "203.0.113.99"})
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("spoofed X-Forwarded-For bypassed the rate limit: got %d", rec.Code)
	}
	for _, e := range app.appRepo.Audit().Entries() {
		if e.IPAddress == "203.0.113.99" {
			t.Fatal("audit log recorded a spoofed IP")
		}
	}
}

// §9.2.4 / §13.4 idempotent submit.
func TestSecurity_IdempotentSubmit(t *testing.T) {
	app := setupTestApp(t)
	key := map[string]string{"X-Idempotency-Key": "4f1c2b8e-6a0d-4f7e-9a51-0c2d6b1e7a90"}

	first := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(10), "0810000010", "k1@example.com"), key)
	if first.Code != http.StatusCreated {
		t.Fatalf("first submit: expected 201, got %d (%s)", first.Code, first.Body.String())
	}
	retry := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(10), "0810000010", "k1@example.com"), key)
	if retry.Code != http.StatusOK || retry.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("retry: expected 200 + Idempotent-Replayed, got %d %v (%s)", retry.Code, retry.Header(), retry.Body.String())
	}
	var a, b service.ApplicationResponse
	_ = json.Unmarshal(first.Body.Bytes(), &a)
	_ = json.Unmarshal(retry.Body.Bytes(), &b)
	if a.ID != b.ID {
		t.Fatalf("retry returned a different application: %s vs %s", a.ID, b.ID)
	}

	reuse := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(11), "0810000011", "k2@example.com"), key)
	if reuse.Code != http.StatusUnprocessableEntity {
		t.Fatalf("key reused for another person: expected 422, got %d", reuse.Code)
	}

	bad := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(12), "0810000012", "k3@example.com"),
		map[string]string{"X-Idempotency-Key": "not-a-uuid"})
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("invalid key: expected 400, got %d", bad.Code)
	}
}

func TestSecurity_DuplicateApplicantIsCleanConflict(t *testing.T) {
	app := setupTestApp(t)
	app.submit(t, validTestNationalID(20), "0810000020", "d1@example.com")

	rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(20), "0810000021", "d2@example.com"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", rec.Code)
	}
	if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeDuplicateApp {
		t.Fatalf("expected code %s, got %+v", response.CodeDuplicateApp, e)
	}

	// Email is optional: two applicants without one must both be accepted.
	app.submit(t, validTestNationalID(22), "0810000022", "")
	app.submit(t, validTestNationalID(23), "0810000023", "")
}

// §13.4 quota lock — concurrent submits cannot exceed capacity.
func TestSecurity_QuotaHoldsUnderConcurrentSubmits(t *testing.T) {
	app := setupTestApp(t)
	const capacity = 5
	settings, _ := app.setRepo.Get(t.Context())
	settings.MaxCapacity = capacity
	_ = app.setRepo.Update(t.Context(), settings)

	var wg sync.WaitGroup
	codes := make(chan int, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Distinct client IPs so the per-IP submit limit does not interfere.
			req := applicationJSON(validTestNationalID(i), fmt.Sprintf("08%08d", i), fmt.Sprintf("q%d@example.com", i))
			codes <- app.doFrom(t, fmt.Sprintf("198.51.100.%d:1000", i+1), http.MethodPost, "/api/applications", req)
		}(i)
	}
	wg.Wait()
	close(codes)

	created, full := 0, 0
	for c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			full++
		default:
			t.Errorf("unexpected status %d", c)
		}
	}
	if created != capacity || full != 40-capacity {
		t.Fatalf("expected %d created / %d full, got %d / %d", capacity, 40-capacity, created, full)
	}
}

// §13.6 — status changes and slip verification are audited with admin and IP; a slip cannot be
// verified twice.
func TestSecurity_AuditTrailAndSingleVerification(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(30), "0810000030", "au@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)
	if rec := app.uploadSlip(t, created.ID, "slip.jpg", jpegBytes); rec.Code != http.StatusOK {
		t.Fatalf("upload failed: %d", rec.Code)
	}

	verify := func() int {
		body := bytes.NewBufferString(`{"approved":true,"note":"ok"}`)
		return app.do(t, http.MethodPatch, "/api/admin/applications/"+created.ID+"/verify-slip", body, bearer(token)).Code
	}
	if c := verify(); c != http.StatusOK {
		t.Fatalf("first verify: expected 200, got %d", c)
	}
	if c := verify(); c != http.StatusConflict {
		t.Fatalf("second verify: expected 409, got %d", c)
	}

	for _, action := range []domain.AuditAction{domain.AuditStatusUpdate, domain.AuditSlipVerify, domain.AuditLoginSuccess} {
		target := created.ID
		if action == domain.AuditLoginSuccess {
			target = testAdminUser
		}
		found := false
		for _, e := range app.appRepo.Audit().Entries() {
			if e.Action == action && e.TargetID == target {
				found = true
				if e.IPAddress == "" {
					t.Errorf("%s: missing ip_address", action)
				}
				if e.AdminID == nil || *e.AdminID != app.adminID {
					t.Errorf("%s: missing admin_id", action)
				}
			}
		}
		if !found {
			t.Errorf("no audit entry for %s", action)
		}
	}

	// Confirmed applicants cannot replace an approved slip.
	if rec := app.uploadSlip(t, created.ID, "again.png", pngBytes); rec.Code != http.StatusConflict {
		t.Errorf("upload after approval: expected 409, got %d", rec.Code)
	}
}

func TestSecurity_APIResponsesNotCacheable(t *testing.T) {
	app := setupTestApp(t)
	rec := app.do(t, http.MethodGet, "/api/settings/public", nil, nil)
	for header, want := range map[string]string{
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
	} {
		if got := rec.Header().Get(header); got != want {
			t.Errorf("%s: want %q, got %q", header, want, got)
		}
	}
}

func hasAudit(app *testApp, action domain.AuditAction, target string) bool {
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == action && e.TargetID == target {
			return true
		}
	}
	return false
}

func (a *testApp) doFrom(t *testing.T, remoteAddr, method, target string, body *bytes.Buffer) int {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	req.RemoteAddr = remoteAddr
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec.Code
}
