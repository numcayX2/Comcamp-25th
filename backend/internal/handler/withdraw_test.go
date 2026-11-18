package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// withdraw posts /withdraw for the application code appID with the applicant's own registered phone
// (R24: code in the path + full phone in the body). For an unknown code a placeholder phone is sent.
func (a *testApp) withdraw(t *testing.T, appID string) *http.Response {
	t.Helper()
	return a.withdrawRec(t, appID).Result()
}

func (a *testApp) withdrawRec(t *testing.T, appID string) *httptest.ResponseRecorder {
	t.Helper()
	phone := "0800000000"
	if ap, err := a.appRepo.GetByApplicationNo(context.Background(), strings.ToUpper(appID)); err == nil {
		phone = ap.Phone
	}
	return a.withdrawWith(t, appID, fmt.Sprintf(`{"phone":%q,"reason":"เปลี่ยนใจ"}`, phone))
}

func (a *testApp) withdrawWith(t *testing.T, appID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPost, "/api/applications/"+appID+"/withdraw", bytes.NewBufferString(body), nil)
}

func (a *testApp) publicCount(t *testing.T) int {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/settings/public", nil, nil)
	var s struct {
		CurrentCount int `json:"currentCount"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("settings/public: %v (%s)", err, rec.Body.String())
	}
	return s.CurrentCount
}

// Self-service withdrawal: the application code is the proof, the seat is freed, and the same
// person can register again with the same phone and email.
func TestWithdraw_SelfServiceLifecycle(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, "0810000031", "w1@example.com")
	before := app.publicCount(t)

	t.Run("unknown or malformed code is 404", func(t *testing.T) {
		for _, id := range []string{"CC25-000000", "CC25-NOPE00", "0810000031"} {
			if res := app.withdraw(t, id); res.StatusCode != http.StatusNotFound {
				t.Fatalf("%s: expected 404, got %d", id, res.StatusCode)
			}
		}
		if after := app.publicCount(t); after != before {
			t.Fatalf("nothing may be withdrawn, currentCount %d -> %d", before, after)
		}
	})

	t.Run("the code withdraws and frees the seat", func(t *testing.T) {
		res := app.withdraw(t, strings.ToLower(created.ID))
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", res.StatusCode)
		}
		if after := app.publicCount(t); after != before-1 {
			t.Fatalf("expected currentCount %d after withdraw, got %d", before-1, after)
		}
		if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil); rec.Code != http.StatusNotFound {
			t.Fatalf("withdrawn application should not be found, got %d", rec.Code)
		}
		if res := app.withdraw(t, created.ID); res.StatusCode != http.StatusNotFound {
			t.Fatalf("second withdraw should be 404, got %d", res.StatusCode)
		}
	})

	t.Run("audit entry has no admin and the self action", func(t *testing.T) {
		var found *domain.AuditEntry
		for _, e := range app.appRepo.Audit().Entries() {
			if e.Action == domain.AuditApplicantWithdrawSelf && e.TargetID == created.ID {
				found = &e
			}
		}
		if found == nil {
			t.Fatal("expected an application.withdraw.self audit entry")
		}
		if found.AdminID != nil {
			t.Fatalf("self withdrawal must not carry an admin id, got %d", *found.AdminID)
		}
	})

	t.Run("same person can register again", func(t *testing.T) {
		again := app.submit(t, "0810000031", "w1@example.com")
		if again.ID == created.ID {
			t.Fatalf("expected a new application ID, got the old one %s", again.ID)
		}
		if after := app.publicCount(t); after != before {
			t.Fatalf("expected currentCount %d after re-registering, got %d", before, after)
		}
	})
}

// A body from an outdated page that still sends nationalId is accepted: the field is never read or
// echoed. Here it is malformed on purpose and the request still reaches the state checks.
func TestWithdraw_IgnoresLegacyNationalIDField(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	other := app.submit(t, "0810000033", "w3@example.com")
	app.setStatus(t, token, other.ID, domain.StatusConfirmed)
	rec := app.withdrawWith(t, other.ID, `{"nationalId":"123","phone":"0810000033","reason":"x"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for a confirmed place, got %d (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "123") {
		t.Fatalf("the ignored field must not be echoed: %s", rec.Body.String())
	}
}

// R24: self-withdraw needs the code AND the full registered phone. A missing, malformed or wrong
// phone gets exactly the answer of an unknown code (no oracle) and counts towards the code guard;
// a phone typed with Thai digits, dashes or spaces is accepted. The reason stays optional.
func TestWithdraw_PhoneIsTheSecondFactor(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, "0810000034", "w4@example.com")
	// One client per attempt, so the code guard's per-client budget does not mix into the comparison.
	unknown := app.doAs(t, "198.51.100.10", http.MethodPost, "/api/applications/CC25-0BADC0/withdraw", `{"phone":"0810000034"}`)
	wantErrCode(t, unknown, http.StatusNotFound, response.CodeNotFound)

	n := 10
	for name, body := range map[string]string{
		"wrong phone":     `{"phone":"0810000035","reason":"x"}`,
		"missing phone":   `{"reason":"x"}`,
		"empty body":      ``,
		"malformed phone": `{"phone":"08-1"}`,
		"other field":     `{"parentPhone":"0810000034"}`,
	} {
		n++
		rec := app.doAs(t, fmt.Sprintf("198.51.100.%d", n), http.MethodPost, "/api/applications/"+created.ID+"/withdraw", body)
		if rec.Code != unknown.Code || rec.Body.String() != unknown.Body.String() {
			t.Fatalf("%s: got %d %s, want exactly the unknown-code answer %d %s", name, rec.Code, rec.Body.String(), unknown.Code, unknown.Body.String())
		}
		// Headers too: same Content-Type, no Retry-After on either, and nothing else that differs
		// (apart from the per-request id).
		if got, want := comparableHeaders(rec.Header()), comparableHeaders(unknown.Header()); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: headers differ from the unknown-code answer: got %v, want %v", name, got, want)
		}
		if rec.Header().Get("Retry-After") != "" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s: expected a JSON answer without Retry-After, got headers %v", name, rec.Header())
		}
		if strings.Contains(rec.Body.String(), "0810000034") {
			t.Fatalf("%s: the phone must not be echoed", name)
		}
	}
	if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("the application must survive failed withdrawals, got %d", rec.Code)
	}

	// Thai digits, dashes and spaces in the phone: accepted, like at registration.
	rec := app.withdrawWith(t, created.ID, `{"phone":" ๐๘๑-๐๐๐ ๐๐๓๔ "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with a Thai-digit phone, got %d (%s)", rec.Code, rec.Body.String())
	}
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == domain.AuditApplicantWithdrawSelf && e.TargetID == created.ID {
			if strings.Contains(fmt.Sprint(e.Details), "0810000034") || strings.Contains(fmt.Sprint(e.Details), "๐๘๑") {
				t.Fatalf("the typed phone must not be audited: %v", e.Details)
			}
		}
	}
}

// R24: wrong phones for a real code are misses for the code guard, so they cannot be used to guess
// a phone (or a code) beyond the guard's budget.
func TestWithdraw_WrongPhoneCountsTowardsTheCodeGuard(t *testing.T) {
	app := setupRelaxedApp(t)
	created := app.submit(t, "0810000036", "w6@example.com")
	const ip = "198.51.100.66"
	for i := 0; i < service.CodeClientMaxMisses; i++ {
		body := fmt.Sprintf(`{"phone":"08100001%02d"}`, i)
		wantErrCode(t, app.doAs(t, ip, http.MethodPost, "/api/applications/"+created.ID+"/withdraw", body), http.StatusNotFound, response.CodeNotFound)
	}
	// Even the right phone is now refused for this client, before any lookup.
	wantLimited(t, app.doAs(t, ip, http.MethodPost, "/api/applications/"+created.ID+"/withdraw", `{"phone":"0810000036"}`), service.CodeBaseLockout)
	if n := len(app.auditOf(domain.AuditCodeGuessLockout)); n != 1 {
		t.Fatalf("expected one lockout audit row, got %d", n)
	}
	// Another client with the right phone still withdraws.
	if rec := app.doAs(t, "203.0.113.66", http.MethodPost, "/api/applications/"+created.ID+"/withdraw", `{"phone":"081-000-0036"}`); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for another client with the right phone, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// A confirmed place (money already verified) can only be removed by staff.
func TestWithdraw_ConfirmedIsRejectedWith409(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, "0810000032", "w2@example.com")
	app.setStatus(t, token, created.ID, domain.StatusConfirmed)

	if res := app.withdraw(t, created.ID); res.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409, got %d", res.StatusCode)
	}
	if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("confirmed application must still exist, got %d", rec.Code)
	}
}

// comparableHeaders drops the headers that legitimately differ per request.
func comparableHeaders(h http.Header) http.Header {
	out := h.Clone()
	for _, k := range []string{"X-Request-Id", "Date"} {
		out.Del(k)
	}
	return out
}
