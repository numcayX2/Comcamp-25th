package handler_test

import (
	"bytes"
	"net/http"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
)

// LOW-04 through the HTTP API: the answer is audited with the caller's IP, and an application that
// is no longer PASSED / CONFIRMED gets 409.
func TestConfirmAttendance_AuditsAndGuardsStatus(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(9149), "0812349149", "att49@example.com")
	code := app.verifyCodes[created.ID]

	rec := app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/confirm",
		bytes.NewBufferString(`{"confirmed":false,"verifyCode":"`+code+`"}`), nil)
	wantCode(t, rec, http.StatusOK, "")
	rec = app.confirmWith(t, created.ID, code)
	wantCode(t, rec, http.StatusOK, "")

	var got []domain.AuditEntry
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == domain.AuditAttendanceConfirm {
			got = append(got, e)
		}
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 attendance audit entries, got %d", len(got))
	}
	for i, want := range []bool{false, true} {
		e := got[i]
		// httptest requests come from 192.0.2.1 (no trusted proxy in front).
		if e.TargetID != created.ID || e.IPAddress != "192.0.2.1" || e.Details["confirmed"] != want || e.AdminID != nil {
			t.Fatalf("entry %d: unexpected %+v", i, e)
		}
	}

	app.setStatus(t, token, created.ID, domain.StatusRejected)
	rec = app.confirmWith(t, created.ID, code)
	wantCode(t, rec, http.StatusConflict, response.CodeForbidden)
}

// LOW-03 through the HTTP API: a password reset ends an admin's earlier session at once.
func TestAdminTokenRejectedAfterAccountUpdate(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	wantCode(t, rec, http.StatusOK, "")

	if err := app.adminRepo.SetUpdatedAt(app.adminID, time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	rec = app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	wantCode(t, rec, http.StatusUnauthorized, response.CodeUnauthorized)
}
