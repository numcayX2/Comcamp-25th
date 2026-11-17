package handler_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
)

// withdraw posts /withdraw for the application code appID: the code in the path is the proof.
func (a *testApp) withdraw(t *testing.T, appID string) *http.Response {
	t.Helper()
	return a.withdrawRec(t, appID).Result()
}

func (a *testApp) withdrawRec(t *testing.T, appID string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPost, "/api/applications/"+appID+"/withdraw", bytes.NewBufferString(`{"reason":"เปลี่ยนใจ"}`), nil)
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
	rec := app.do(t, http.MethodPost, "/api/applications/"+other.ID+"/withdraw", bytes.NewBufferString(`{"nationalId":"123","reason":"x"}`), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for a confirmed place, got %d (%s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "123") {
		t.Fatalf("the ignored field must not be echoed: %s", rec.Body.String())
	}
}

// A withdrawal with no body at all (the reason is optional) is accepted.
func TestWithdraw_EmptyBody(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, "0810000034", "w4@example.com")
	if rec := app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/withdraw", nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
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
