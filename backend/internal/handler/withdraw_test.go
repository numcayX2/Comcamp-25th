package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
)

// withdraw posts /withdraw with the given full national ID (AGENTS.md §13.5: 4 digits are not
// enough to give a seat away).
func (a *testApp) withdraw(t *testing.T, appID, nationalID string) *http.Response {
	t.Helper()
	return a.withdrawRec(t, appID, nationalID).Result()
}

func (a *testApp) withdrawRec(t *testing.T, appID, nationalID string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"nationalId":%q,"reason":"เปลี่ยนใจ"}`, nationalID)
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

// Self-service withdrawal: needs the full 13-digit national ID, frees the seat, and lets the same
// person register again with the same national ID, phone and email.
func TestWithdraw_SelfServiceLifecycle(t *testing.T) {
	app := setupTestApp(t)
	nid := validTestNationalID(31)
	created := app.submit(t, nid, "0810000031", "w1@example.com")
	before := app.publicCount(t)

	t.Run("missing national ID is 400", func(t *testing.T) {
		if res := app.withdraw(t, created.ID, ""); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d", res.StatusCode)
		}
	})

	t.Run("wrong national ID is 403 INVALID_VERIFY_CODE", func(t *testing.T) {
		rec := app.withdrawRec(t, created.ID, validTestNationalID(9031))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403, got %d (%s)", rec.Code, rec.Body.String())
		}
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeInvalidVerifyCode {
			t.Fatalf("expected code %s, got %s", response.CodeInvalidVerifyCode, e.Code)
		}
	})

	t.Run("unknown application is 404", func(t *testing.T) {
		if res := app.withdraw(t, "CC25-NOPE00", validTestNationalID(9032)); res.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", res.StatusCode)
		}
	})

	t.Run("correct national ID withdraws and frees the seat", func(t *testing.T) {
		res := app.withdraw(t, created.ID, nid)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", res.StatusCode)
		}
		if after := app.publicCount(t); after != before-1 {
			t.Fatalf("expected currentCount %d after withdraw, got %d", before-1, after)
		}
		if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil); rec.Code != http.StatusNotFound {
			t.Fatalf("withdrawn application should not be found, got %d", rec.Code)
		}
		if res := app.withdraw(t, created.ID, nid); res.StatusCode != http.StatusNotFound {
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
		again := app.submit(t, nid, "0810000031", "w1@example.com")
		if again.ID == created.ID {
			t.Fatalf("expected a new application ID, got the old one %s", again.ID)
		}
		if after := app.publicCount(t); after != before {
			t.Fatalf("expected currentCount %d after re-registering, got %d", before, after)
		}
	})
}

// A confirmed place (money already verified) can only be removed by staff.
func TestWithdraw_ConfirmedIsRejectedWith409(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(32), "0810000032", "w2@example.com")
	app.setStatus(t, token, created.ID, domain.StatusConfirmed)

	if res := app.withdraw(t, created.ID, app.nationalIDs[created.ID]); res.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409, got %d", res.StatusCode)
	}
	if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("confirmed application must still exist, got %d", rec.Code)
	}
}
