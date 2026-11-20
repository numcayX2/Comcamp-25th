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
	"comcamp25-backend/internal/service"
)

func (a *testApp) patchStatusRaw(t *testing.T, token, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPatch, "/api/admin/applications/"+id, bytes.NewBufferString(body), bearer(token))
}

func (a *testApp) publicSettings(t *testing.T) domain.PublicSettingsResponse {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/settings/public", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/settings/public: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var pub domain.PublicSettingsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &pub); err != nil {
		t.Fatalf("decode public settings: %v (%s)", err, rec.Body.String())
	}
	return pub
}

func TestOverCapacityRestore_FullQuotaFlow(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	const quota = 2
	app.setCapacity(t, quota)

	// Fill the quota: a and b take both seats, then a is forfeited and c takes the freed seat.
	a := app.submit(t, "0810000501", "oc1@example.com")
	_ = app.submit(t, "0810000502", "oc2@example.com")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusForfeited), http.StatusOK, "")
	_ = app.submit(t, "0810000503", "oc3@example.com")

	// Camp is now full (2/2). isOpen reflects only the schedule window; the client derives FULL
	// from currentCount >= maxCapacity (main.js computeHeroState, RegisterSection gate).
	pub := app.publicSettings(t)
	if pub.CurrentCount != quota || pub.MaxCapacity != quota {
		t.Fatalf("expected full camp (count=%d cap=%d), got %+v", quota, quota, pub)
	}

	// 1. FORFEITED -> PASSED without overCapacity flag -> 409 QUOTA_FULL.
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusPassed), http.StatusConflict, response.CodeQuotaFull)
	if got := app.adminView(t, token, a.ID).Status; got != domain.StatusForfeited {
		t.Fatalf("refused restore must keep FORFEITED, got %s", got)
	}

	// 2. With overCapacity: true and empty / whitespace reason -> 400 VALIDATION_ERROR.
	beforeAudits := len(auditEntries(app, domain.AuditStatusUpdate, a.ID))
	for name, body := range map[string]string{
		"omitted reason":    `{"status":"PASSED","overCapacity":true}`,
		"empty reason":      `{"status":"PASSED","reason":"","overCapacity":true}`,
		"whitespace reason": `{"status":"PASSED","reason":"   \t  ","overCapacity":true}`,
		"zero-width reason": "{\"status\":\"PASSED\",\"reason\":\"\u200b \",\"overCapacity\":true}",
	} {
		t.Run(name, func(t *testing.T) {
			rec := app.patchStatusRaw(t, token, a.ID, body)
			wantCode(t, rec, http.StatusBadRequest, response.CodeValidation)
			if e := decodeErr(t, rec.Body.Bytes()); e.Error != "reason is required for over-capacity restore" {
				t.Fatalf("unexpected validation message: %q", e.Error)
			}
		})
	}
	if got := app.adminView(t, token, a.ID).Status; got != domain.StatusForfeited {
		t.Fatalf("validation failure must keep FORFEITED, got %s", got)
	}
	if afterAudits := len(auditEntries(app, domain.AuditStatusUpdate, a.ID)); afterAudits != beforeAudits {
		t.Fatalf("validation failures must not write audit rows: %d -> %d", beforeAudits, afterAudits)
	}

	// 3. With overCapacity: true and a reason -> 200 OK, PASSED, currentCount = quota+1, audited.
	const reason = "อนุโลมชำระล่าช้า ผู้ปกครองแจ้งล่วงหน้า"
	rec := app.patchStatusRaw(t, token, a.ID, fmt.Sprintf(`{"status":"PASSED","reason":%q,"overCapacity":true}`, reason))
	if rec.Code != http.StatusOK {
		t.Fatalf("over-capacity restore: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var restored service.ApplicationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &restored); err != nil {
		t.Fatalf("decode restore response: %v", err)
	}
	if restored.Status != domain.StatusPassed {
		t.Fatalf("expected status PASSED, got %s", restored.Status)
	}

	// Public settings: currentCount = quota+1 (the client clamps seatsLeft at 0).
	pub = app.publicSettings(t)
	if pub.CurrentCount != quota+1 || pub.MaxCapacity != quota {
		t.Fatalf("expected over-capacity public settings (count=%d cap=%d), got %+v", quota+1, quota, pub)
	}

	// Audit entry carries overCapacity: true, currentCount: quota+1, maxCapacity: quota.
	entries := auditEntries(app, domain.AuditStatusUpdate, a.ID)
	if len(entries) != beforeAudits+1 {
		t.Fatalf("expected 1 new audit entry, got %d -> %d", beforeAudits, len(entries))
	}
	last := entries[len(entries)-1]
	if last.Details["overCapacity"] != true {
		t.Fatalf("expected overCapacity=true in audit details, got %+v", last.Details)
	}
	if last.Details["currentCount"] != quota+1 || last.Details["maxCapacity"] != quota {
		t.Fatalf("expected currentCount=%d maxCapacity=%d in audit details, got %+v", quota+1, quota, last.Details)
	}
	if last.Details["oldStatus"] != domain.StatusForfeited || last.Details["newStatus"] != domain.StatusPassed || last.Details["reason"] != reason {
		t.Fatalf("unexpected audit transition details: %+v", last.Details)
	}

	// 4. A new registration while over capacity gets 409 QUOTA_FULL.
	regRec := app.do(t, http.MethodPost, "/api/applications", applicationJSON("0810000504", "oc4@example.com"), nil)
	wantCode(t, regRec, http.StatusConflict, response.CodeQuotaFull)
	if got := app.publicCount(t); got != quota+1 {
		t.Fatalf("refused registration must not change count: want %d, got %d", quota+1, got)
	}

	// 5. PATCH /api/admin/settings still refuses maxCapacity below active seats, and accepts >= active seats.
	wantCode(t, app.do(t, http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(`{"maxCapacity":2}`), bearer(token)), http.StatusBadRequest, response.CodeValidation)
	wantCode(t, app.do(t, http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(`{"maxCapacity":3}`), bearer(token)), http.StatusOK, "")
	if pub := app.publicSettings(t); pub.CurrentCount != 3 || pub.MaxCapacity != 3 {
		t.Fatalf("expected 3/3, got %+v", pub)
	}
	wantCode(t, app.do(t, http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(`{"maxCapacity":4}`), bearer(token)), http.StatusOK, "")
	if pub := app.publicSettings(t); pub.CurrentCount != 3 || pub.MaxCapacity != 4 {
		t.Fatalf("expected 3/4, got %+v", pub)
	}
}

func TestOverCapacityRestore_FreeSeatsAndNonRetaking(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	app.setCapacity(t, 3)

	a := app.submit(t, "0810000511", "oc11@example.com")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusForfeited), http.StatusOK, "")

	// With overCapacity: true while seats are free -> 200 OK and NO overCapacity in audit.
	rec := app.patchStatusRaw(t, token, a.ID, `{"status":"PASSED","reason":"ยังมีที่นั่งว่าง","overCapacity":true}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore with free seats: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	entries := auditEntries(app, domain.AuditStatusUpdate, a.ID)
	last := entries[len(entries)-1]
	for _, key := range []string{"overCapacity", "currentCount", "maxCapacity"} {
		if _, exists := last.Details[key]; exists {
			t.Fatalf("normal restore with free seats must not record %q in audit: %+v", key, last.Details)
		}
	}
	if pub := app.publicSettings(t); pub.CurrentCount != 1 {
		t.Fatalf("expected 1 seat taken, got %+v", pub)
	}

	// Non-seat-retaking transitions ignore overCapacity even when reason is empty.
	for _, st := range []domain.ApplicationStatus{domain.StatusConfirmed, domain.StatusRejected, domain.StatusRefunded} {
		rec := app.patchStatusRaw(t, token, a.ID, fmt.Sprintf(`{"status":%q,"reason":"","overCapacity":true}`, st))
		if rec.Code != http.StatusOK {
			t.Fatalf("non-retaking change to %s with overCapacity=true and empty reason: expected 200, got %d (%s)", st, rec.Code, rec.Body.String())
		}
		entries := auditEntries(app, domain.AuditStatusUpdate, a.ID)
		last := entries[len(entries)-1]
		if _, exists := last.Details["overCapacity"]; exists {
			t.Fatalf("non-retaking change to %s must not record overCapacity in audit: %+v", st, last.Details)
		}
	}
}

func TestOverCapacityRestore_AllSeatlessStatuses(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	const quota = 2
	app.setCapacity(t, quota)

	seatless := []domain.ApplicationStatus{
		domain.StatusRejected,
		domain.StatusRefundPending,
		domain.StatusRefunded,
		domain.StatusForfeited,
	}
	ids := make([]string, len(seatless))
	for i, st := range seatless {
		sub := app.submit(t, fmt.Sprintf("081000052%d", i), fmt.Sprintf("oc2%d@example.com", i))
		wantCode(t, app.patchStatus(t, token, sub.ID, st), http.StatusOK, "")
		ids[i] = sub.ID
	}
	// Fill all seats with fresh applicants (6 total submits, well below the 8/min register limit).
	for i := 0; i < quota; i++ {
		_ = app.submit(t, fmt.Sprintf("081000053%d", i), fmt.Sprintf("oc3%d@example.com", i))
	}

	// Each non-seat-holding status can be restored over capacity with a reason.
	for i, id := range ids {
		rec := app.patchStatusRaw(t, token, id, fmt.Sprintf(`{"status":"PASSED","reason":"restore %s","overCapacity":true}`, seatless[i]))
		if rec.Code != http.StatusOK {
			t.Fatalf("restore from %s: expected 200, got %d (%s)", seatless[i], rec.Code, rec.Body.String())
		}
		wantCount := quota + i + 1
		entries := auditEntries(app, domain.AuditStatusUpdate, id)
		last := entries[len(entries)-1]
		if last.Details["overCapacity"] != true || last.Details["currentCount"] != wantCount || last.Details["maxCapacity"] != quota {
			t.Fatalf("restore from %s: unexpected audit details %+v (want count=%d cap=%d)", seatless[i], last.Details, wantCount, quota)
		}
	}
	if pub := app.publicSettings(t); pub.CurrentCount != quota+len(seatless) {
		t.Fatalf("expected count=%d, got %+v", quota+len(seatless), pub)
	}
}
