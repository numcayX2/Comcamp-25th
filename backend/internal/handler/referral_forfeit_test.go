package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

func referralJSON(t *testing.T, phone, email string, sources []string, other string) *bytes.Buffer {
	t.Helper()
	var req service.ApplicationCreateRequest
	if err := json.Unmarshal(applicationJSON(phone, email).Bytes(), &req); err != nil {
		t.Fatal(err)
	}
	req.ReferralSources, req.ReferralOther = sources, other
	body, _ := json.Marshal(req)
	return bytes.NewBuffer(body)
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &e)
	return e.Code
}

// Referral answers are stored normalised (allowlist, form order, no repeats), are returned to staff
// only, and bad answers are refused before anything is stored. Old clients that do not send the
// question still register.
func TestReferral_SubmitValidateAndAdminOnly(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	rec := app.do(t, http.MethodPost, "/api/applications",
		referralJSON(t, "0810000101", "r1@example.com", []string{" OTHER ", "google", "social_tiktok", "google"}, "  ป้ายหน้าโรงเรียน "), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit with referral: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var pub map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	if _, leaked := pub["referralSources"]; leaked {
		t.Fatal("the public receipt must not echo referral answers")
	}
	id, _ := pub["id"].(string)

	rec = app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	var list []service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	var found *service.ApplicationResponse
	for i := range list {
		if list[i].ID == id {
			found = &list[i]
		}
	}
	if found == nil {
		t.Fatalf("admin list misses %s", id)
	}
	if want := []string{"social_tiktok", "google", "other"}; !reflect.DeepEqual(found.ReferralSources, want) || found.ReferralOther != "ป้ายหน้าโรงเรียน" {
		t.Fatalf("stored referral = %v %q, want %v %q", found.ReferralSources, found.ReferralOther, want, "ป้ายหน้าโรงเรียน")
	}

	for name, c := range map[string]struct {
		sources []string
		other   string
	}{
		"unknown code":        {[]string{"tv"}, ""},
		"other without text":  {[]string{"other"}, ""},
		"other text too long": {[]string{"other"}, "1234567890123456789012345678901234567890123456789012"},
	} {
		rec := app.do(t, http.MethodPost, "/api/applications", referralJSON(t, "0810000102", "r2@example.com", c.sources, c.other), nil)
		if rec.Code != http.StatusBadRequest || errorCode(t, rec.Body.Bytes()) != response.CodeValidation {
			t.Fatalf("%s: expected 400 %s, got %d (%s)", name, response.CodeValidation, rec.Code, rec.Body.String())
		}
	}

	// Text without "other" is dropped, not refused.
	rec = app.do(t, http.MethodPost, "/api/applications", referralJSON(t, "0810000103", "r3@example.com", []string{"parent"}, "ignored"), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("text without other: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	if a, _ := app.appRepo.GetByApplicationNo(context.Background(), pub["id"].(string)); a.ReferralOther != "" {
		t.Fatalf("referralOther must be dropped without the other code, got %q", a.ReferralOther)
	}

	// Old payload (no referral fields) still registers.
	app.submit(t, "0810000104", "r4@example.com")
}

// An application whose seat was released for non-payment is FORFEITED: it no longer counts, it
// leaves the public list, and registering again with its phone or email answers
// 409 FORFEITED_APPLICATION. Staff can restore it within capacity.
func TestForfeited_ReRegisterBlockedAndRestorable(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	ctx := context.Background()

	created := app.submit(t, "0810000201", "f1@example.com")
	a, _ := app.appRepo.GetByApplicationNo(ctx, created.ID)
	old := time.Now().UTC().Add(-service.UnpaidExpiryWindow - service.UnpaidGraceWindow - time.Hour)
	if err := app.appRepo.SetTimestampsForTest(a.ID, old, old); err != nil {
		t.Fatal(err)
	}
	before := app.publicCount(t)

	// The admin list read runs the expiry sweep.
	app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	if a, _ = app.appRepo.GetByApplicationNo(ctx, created.ID); a.Status != domain.StatusForfeited {
		t.Fatalf("expected FORFEITED after the sweep, got %s", a.Status)
	}
	if after := app.publicCount(t); after != before-1 {
		t.Fatalf("a forfeited seat must be released: currentCount %d -> %d", before, after)
	}
	rec := app.do(t, http.MethodGet, "/api/applications/public", nil, nil)
	if bytes.Contains(rec.Body.Bytes(), []byte(a.FirstName)) {
		t.Fatalf("a forfeited applicant must leave the public list: %s", rec.Body.String())
	}

	for _, id := range [][2]string{{"0810000201", "f1-new@example.com"}, {"0810000299", "f1@example.com"}} {
		rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON(id[0], id[1]), nil)
		if rec.Code != http.StatusConflict || errorCode(t, rec.Body.Bytes()) != response.CodeForfeitedApp {
			t.Fatalf("re-register %v: expected 409 %s, got %d (%s)", id, response.CodeForfeitedApp, rec.Code, rec.Body.String())
		}
	}

	// Staff restore takes the seat back.
	app.setStatus(t, token, created.ID, domain.StatusPassed)
	if after := app.publicCount(t); after != before {
		t.Fatalf("restoring must take the seat back: currentCount %d, want %d", after, before)
	}
}

// GET /api/admin/applications/withdrawn lists self-withdrawals only (not staff deletes), with the
// typed reason, newest first; it is admin-only.
func TestWithdrawn_AdminList(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	if rec := app.do(t, http.MethodGet, "/api/admin/applications/withdrawn", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous: expected 401, got %d", rec.Code)
	}

	self := app.submit(t, "0810000301", "w1@example.com")
	deleted := app.submit(t, "0810000302", "w2@example.com")
	if res := app.withdraw(t, self.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("withdraw: %d", res.StatusCode)
	}
	if rec := app.do(t, http.MethodDelete, "/api/admin/applications/"+deleted.ID, nil, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("admin delete: %d (%s)", rec.Code, rec.Body.String())
	}

	rec := app.do(t, http.MethodGet, "/api/admin/applications/withdrawn", nil, bearer(token))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var list []service.WithdrawnEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ApplicationNo != self.ID || list[0].Reason != "เปลี่ยนใจ" || list[0].Phone != "0810000301" {
		t.Fatalf("expected only the self-withdrawal with its reason, got %+v", list)
	}
	if list[0].Status != domain.StatusPassed || list[0].WithdrawnAt == "" {
		t.Fatalf("expected status at withdrawal and a timestamp, got %+v", list[0])
	}
}

// DELETE /api/admin/applications/withdrawn/{id} erases a self-withdrawal for good; live and
// staff-deleted applications are refused with 404 and stay as they are.
func TestWithdrawn_AdminPurge(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	self := app.submit(t, "0810000311", "p1@example.com")
	live := app.submit(t, "0810000312", "p2@example.com")
	deleted := app.submit(t, "0810000313", "p3@example.com")
	if res := app.withdraw(t, self.ID); res.StatusCode != http.StatusOK {
		t.Fatalf("withdraw: %d", res.StatusCode)
	}
	if rec := app.do(t, http.MethodDelete, "/api/admin/applications/"+deleted.ID, nil, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("admin delete: %d (%s)", rec.Code, rec.Body.String())
	}

	if rec := app.do(t, http.MethodDelete, "/api/admin/applications/withdrawn/"+self.ID, nil, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous purge: expected 401, got %d", rec.Code)
	}
	for _, id := range []string{live.ID, deleted.ID} {
		if rec := app.do(t, http.MethodDelete, "/api/admin/applications/withdrawn/"+id, nil, bearer(token)); rec.Code != http.StatusNotFound {
			t.Fatalf("purge %s: expected 404, got %d (%s)", id, rec.Code, rec.Body.String())
		}
	}
	if rec := app.do(t, http.MethodDelete, "/api/admin/applications/withdrawn/"+self.ID, nil, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("purge: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if rec := app.do(t, http.MethodDelete, "/api/admin/applications/withdrawn/"+self.ID, nil, bearer(token)); rec.Code != http.StatusNotFound {
		t.Fatalf("second purge: expected 404, got %d", rec.Code)
	}

	rec := app.do(t, http.MethodGet, "/api/admin/applications/withdrawn", nil, bearer(token))
	var list []service.WithdrawnEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("expected the withdrawn list to be empty after the purge, got %+v", list)
	}
	rec = app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	var apps []service.ApplicationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &apps); err != nil {
		t.Fatal(err)
	}
	if len(apps) != 1 || apps[0].ID != live.ID {
		t.Fatalf("expected only the live application to remain, got %d rows", len(apps))
	}
}
