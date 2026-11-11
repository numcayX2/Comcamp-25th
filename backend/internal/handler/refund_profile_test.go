package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

// ── helpers ────────────────────────────────────────────────────────────────

// setupRelaxedApp raises the public mutation limit: these tests make many PATCH/POST calls from
// one test IP, which the production limit (20 per minute) would answer with 429.
func setupRelaxedApp(t *testing.T) *testApp {
	t.Helper()
	limits := server.DefaultRateLimits()
	limits.Mutations = middleware.NewRateLimiter(10_000, time.Minute)
	return setupTestAppWith(t, limits)
}

// uniqueSlip returns a distinct tiny JPEG per n: the upload path rejects a slip whose SHA-256 was
// already uploaded by anyone (AGENTS.md section 13.4).
func uniqueSlip(n int) []byte { return encodeJPEG(n%40+1, n/40+1) }

func (a *testApp) patchStatus(t *testing.T, token, id string, status domain.ApplicationStatus) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"status":%q,"reason":"test"}`, status)
	return a.do(t, http.MethodPatch, "/api/admin/applications/"+id, bytes.NewBufferString(body), bearer(token))
}

func (a *testApp) verifySlip(t *testing.T, token, id string, approved bool) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"approved":%t,"note":"test"}`, approved)
	return a.do(t, http.MethodPatch, "/api/admin/applications/"+id+"/verify-slip", bytes.NewBufferString(body), bearer(token))
}

func (a *testApp) setCapacity(t *testing.T, n int) {
	t.Helper()
	s, err := a.setRepo.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	s.MaxCapacity = n
	if err := a.setRepo.Update(context.Background(), s); err != nil {
		t.Fatal(err)
	}
}

// selfEdit sends the applicant's own profile edit; body is the JSON object.
func (a *testApp) selfEdit(t *testing.T, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPatch, "/api/applications/"+id+"/profile", bytes.NewBufferString(body), nil)
}

func (a *testApp) adminEdit(t *testing.T, token, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPatch, "/api/admin/applications/"+id+"/profile", bytes.NewBufferString(body), bearer(token))
}

// adminView returns the full (unmasked) record from the admin list.
func (a *testApp) adminView(t *testing.T, token, id string) service.ApplicationResponse {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	var list []service.ApplicationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("admin list: %v (%s)", err, rec.Body.String())
	}
	for _, r := range list {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("application %s not in the admin list", id)
	return service.ApplicationResponse{}
}

func auditEntries(app *testApp, action domain.AuditAction, target string) []domain.AuditEntry {
	var out []domain.AuditEntry
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == action && e.TargetID == target {
			out = append(out, e)
		}
	}
	return out
}

// wantStatus checks the status of a plain *http.Response (the withdraw helper returns one).
func wantStatus(t *testing.T, res *http.Response, status int) {
	t.Helper()
	if res.StatusCode != status {
		t.Fatalf("expected %d, got %d", status, res.StatusCode)
	}
}

func wantCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("expected %d, got %d (%s)", status, rec.Code, rec.Body.String())
	}
	if code != "" {
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != code {
			t.Fatalf("expected error code %s, got %s (%s)", code, e.Code, e.Error)
		}
	}
}

// ── first come, first served ───────────────────────────────────────────────

// A registration that fits the quota is PASSED at once, so the applicant can send a slip without
// waiting for a staff status change.
func TestFCFS_SlipUploadRightAfterSubmit(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, validTestNationalID(101), "0810000101", "fcfs@example.com")
	if created.Status != domain.StatusPassed {
		t.Fatalf("new application should be PASSED, got %s", created.Status)
	}

	rec := app.uploadSlip(t, created.ID, "slip.jpg", jpegBytes)
	if rec.Code != http.StatusOK {
		t.Fatalf("slip upload straight after submit: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	got := app.status(t, created.ID)
	if !got.HasSlip || got.SlipStatus == nil || *got.SlipStatus != domain.PaymentPending {
		t.Fatalf("expected a PENDING slip, got %+v", got)
	}
	if got.Status != domain.StatusPassed {
		t.Fatalf("uploading a slip must not change the status, got %s", got.Status)
	}
}

// ── refund statuses and the quota ──────────────────────────────────────────

func TestRefundStatuses_ReleaseSeatAndGuardReactivation(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	app.setCapacity(t, 1)

	a := app.submit(t, validTestNationalID(111), "0810000111", "ra@example.com")
	// The camp is full: the next student is refused.
	rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(112), "0810000112", "rb@example.com"), nil)
	wantCode(t, rec, http.StatusConflict, response.CodeQuotaFull)
	if got := app.publicCount(t); got != 1 {
		t.Fatalf("count should be 1, got %d", got)
	}

	// REFUND_PENDING releases the seat at once, yet the row stays for the ledger.
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRefundPending), http.StatusOK, "")
	if got := app.publicCount(t); got != 0 {
		t.Fatalf("REFUND_PENDING must free the seat, count = %d", got)
	}
	list := app.do(t, http.MethodGet, "/api/admin/applications?status=REFUND_PENDING", nil, bearer(token))
	var refunds []service.ApplicationResponse
	_ = json.Unmarshal(list.Body.Bytes(), &refunds)
	if list.Code != http.StatusOK || len(refunds) != 1 || refunds[0].ID != a.ID {
		t.Fatalf("the refund case must stay visible to staff, got %d %+v", list.Code, refunds)
	}

	// Someone else takes the freed seat.
	b := app.submit(t, validTestNationalID(112), "0810000112", "rb@example.com")
	if got := app.publicCount(t); got != 1 {
		t.Fatalf("count should be 1 again, got %d", got)
	}

	// Restoring A would exceed the quota: refused, and A stays where it was.
	for _, target := range []domain.ApplicationStatus{domain.StatusPassed, domain.StatusPending, domain.StatusReserve, domain.StatusConfirmed} {
		wantCode(t, app.patchStatus(t, token, a.ID, target), http.StatusConflict, response.CodeQuotaFull)
	}
	if got := app.adminView(t, token, a.ID).Status; got != domain.StatusRefundPending {
		t.Fatalf("a refused restore must not change the status, got %s", got)
	}

	// Moving between non-counting statuses never needs a seat.
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRefunded), http.StatusOK, "")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRejected), http.StatusOK, "")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusPassed), http.StatusConflict, response.CodeQuotaFull) // REJECTED -> active is guarded too
	if got := app.publicCount(t); got != 1 {
		t.Fatalf("count should still be 1, got %d", got)
	}

	// Once B leaves, there is room again.
	wantStatus(t, app.withdraw(t, b.ID, app.nationalIDs[b.ID]), http.StatusOK)
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusPassed), http.StatusOK, "")
	if got := app.publicCount(t); got != 1 {
		t.Fatalf("count should be 1 after the restore, got %d", got)
	}
}

// Two restores racing for the last seat: exactly one wins, the camp never exceeds its quota.
func TestRefundStatuses_ConcurrentRestoresRespectQuota(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	app.setCapacity(t, 2)

	a := app.submit(t, validTestNationalID(121), "0810000121", "c1@example.com")
	b := app.submit(t, validTestNationalID(122), "0810000122", "c2@example.com")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRefunded), http.StatusOK, "")
	wantCode(t, app.patchStatus(t, token, b.ID, domain.StatusRefunded), http.StatusOK, "")
	app.submit(t, validTestNationalID(123), "0810000123", "c3@example.com") // takes one of the two freed seats

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, id := range []string{a.ID, b.ID} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			codes[i] = app.patchStatus(t, token, id, domain.StatusPassed).Code
		}(i, id)
	}
	wg.Wait()

	ok, full := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict:
			full++
		}
	}
	if ok != 1 || full != 1 {
		t.Fatalf("expected one restore to win and one to get 409, got %v", codes)
	}
	if got := app.publicCount(t); got != 2 {
		t.Fatalf("count must be exactly the quota (2), got %d", got)
	}
}

// ── withdrawal and slip review guards ──────────────────────────────────────

func TestWithdraw_BlockedWhenMoneyOrRefundIsInvolved(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)

	// A slip is waiting for review: the applicant cannot make the row disappear.
	withSlip := app.submit(t, validTestNationalID(131), "0810000131", "w1@example.com")
	wantCode(t, app.uploadSlip(t, withSlip.ID, "s.jpg", uniqueSlip(1)), http.StatusOK, "")
	wantStatus(t, app.withdraw(t, withSlip.ID, app.nationalIDs[withSlip.ID]), http.StatusConflict)
	if got := app.status(t, withSlip.ID); got.Status != domain.StatusPassed || !got.HasSlip {
		t.Fatalf("a blocked withdrawal must leave the application untouched, got %+v", got)
	}

	// Closed applications cannot be withdrawn either: staff own the refund from here.
	for i, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
		n := 140 + i
		c := app.submit(t, validTestNationalID(n), fmt.Sprintf("08100001%02d", n%100), fmt.Sprintf("w%d@example.com", n))
		wantCode(t, app.patchStatus(t, token, c.ID, st), http.StatusOK, "")
		wantStatus(t, app.withdraw(t, c.ID, app.nationalIDs[c.ID]), http.StatusConflict)
		if app.status(t, c.ID).Status != st {
			t.Fatalf("%s application must survive a withdrawal attempt", st)
		}
	}

	// A slip staff already rejected is not money held: that applicant may still withdraw.
	rejected := app.submit(t, validTestNationalID(150), "0810000150", "w150@example.com")
	wantCode(t, app.uploadSlip(t, rejected.ID, "s.jpg", uniqueSlip(2)), http.StatusOK, "")
	wantCode(t, app.verifySlip(t, token, rejected.ID, false), http.StatusOK, "")
	wantStatus(t, app.withdraw(t, rejected.ID, app.nationalIDs[rejected.ID]), http.StatusOK)
}

func TestVerifySlip_BlockedForRefundedOrRejectedApplications(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)

	for i, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
		n := 160 + i
		c := app.submit(t, validTestNationalID(n), fmt.Sprintf("08100001%02d", n%100), fmt.Sprintf("v%d@example.com", n))
		wantCode(t, app.uploadSlip(t, c.ID, "s.jpg", uniqueSlip(10+i)), http.StatusOK, "")
		wantCode(t, app.patchStatus(t, token, c.ID, st), http.StatusOK, "")

		for _, approved := range []bool{true, false} {
			wantCode(t, app.verifySlip(t, token, c.ID, approved), http.StatusConflict, "")
		}
		got := app.adminView(t, token, c.ID)
		if got.Status != st {
			t.Fatalf("%s: a refused review must not change the status, got %s", st, got.Status)
		}
		if got.SlipStatus == nil || *got.SlipStatus != domain.PaymentPending {
			t.Fatalf("%s: the slip must stay PENDING, got %v", st, got.SlipStatus)
		}
		// The image stays viewable for the accountant.
		if rec := app.do(t, http.MethodGet, service.AdminSlipPath(c.ID), nil, bearer(token)); rec.Code != http.StatusOK {
			t.Fatalf("%s: the slip must stay viewable, got %d", st, rec.Code)
		}
	}
}

// ── applicant's own profile edit ───────────────────────────────────────────

func TestSelfProfileEdit(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(171), "0810000171", "p1@example.com")
	code := app.verifyCodes[created.ID]
	orig := app.adminView(t, token, created.ID) // unmasked original, including the motivation
	valid := func(extra string) string {
		return fmt.Sprintf(`{"verifyCode":%q,"nickname":"ชาย","school":"โรงเรียนใหม่","province":"ลำปาง","grade":"ม.6","shirtSize":"M"%s}`, code, extra)
	}

	t.Run("verify code is required and checked", func(t *testing.T) {
		wantCode(t, app.selfEdit(t, created.ID, `{"nickname":"ชาย","school":"ร","province":"ล","grade":"ม.6","shirtSize":"M"}`), http.StatusBadRequest, response.CodeValidation)
		wrong := "0000"
		if code == wrong {
			wrong = "1111"
		}
		wantCode(t, app.selfEdit(t, created.ID, strings.Replace(valid(""), code, wrong, 1)), http.StatusForbidden, response.CodeInvalidVerifyCode)
		wantCode(t, app.selfEdit(t, "CC25-NOPE00", valid("")), http.StatusNotFound, "")
		if got := app.adminView(t, token, created.ID); got.School == "โรงเรียนใหม่" {
			t.Fatal("a rejected request must not change anything")
		}
	})

	t.Run("allowed fields change, normalised, with a masked response and an audit row", func(t *testing.T) {
		body := fmt.Sprintf(`{"verifyCode":%q,"nickname":"  ชาย​  ใหม่ ","school":"โรงเรียน   ใหม่","province":"ลำปาง","grade":"ปวส.1","shirtSize":"xl"}`, code)
		rec := app.selfEdit(t, created.ID, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if res.Nickname != "ชาย ใหม่" || res.School != "โรงเรียน ใหม่" || res.Province != "ลำปาง" || res.Grade != "ปวส.1" || res.ShirtSize != "XL" {
			t.Fatalf("unexpected normalised result: %+v", res)
		}
		if !strings.Contains(res.NationalID, "X") || !strings.Contains(res.Phone, "X") {
			t.Fatalf("the response must stay masked, got %q / %q", res.NationalID, res.Phone)
		}
		for _, leaked := range []string{"adminNote", "admin_note", "motivation", "slipUrl"} {
			if strings.Contains(rec.Body.String(), leaked) {
				t.Fatalf("public response must not contain %q: %s", leaked, rec.Body.String())
			}
		}

		// Identity is untouched; updatedAt moved.
		full := app.adminView(t, token, created.ID)
		if full.FullName != orig.FullName || full.NationalID != orig.NationalID || full.Phone != orig.Phone || full.Email != orig.Email {
			t.Fatalf("identity fields changed: %+v", full)
		}

		entries := auditEntries(app, domain.AuditProfileUpdateSelf, created.ID)
		if len(entries) != 1 {
			t.Fatalf("expected one self-edit audit entry, got %d", len(entries))
		}
		if entries[0].AdminID != nil {
			t.Fatalf("a self edit must not carry an admin id, got %d", *entries[0].AdminID)
		}
		if entries[0].IPAddress == "" {
			t.Fatal("the audit entry must record the IP address")
		}
		changes, _ := entries[0].Details["changes"].(map[string]map[string]string)
		if changes["nickname"]["new"] != "ชาย ใหม่" || changes["nickname"]["old"] == "" || changes["grade"]["new"] != "ปวส.1" || changes["grade"]["old"] != "ม.5" {
			t.Fatalf("audit changes should list old -> new, got %+v", entries[0].Details["changes"])
		}
		if _, same := changes["shirtSize"]; same {
			t.Fatal("an unchanged field must not appear in the diff")
		}
		if _, touchedIdentity := changes["nationalId"]; touchedIdentity {
			t.Fatal("identity must not appear in a self-edit diff")
		}
	})

	t.Run("saving the same values changes nothing and writes no audit row", func(t *testing.T) {
		before := len(auditEntries(app, domain.AuditProfileUpdateSelf, created.ID))
		body := fmt.Sprintf(`{"verifyCode":%q,"nickname":"ชาย ใหม่","school":"โรงเรียน ใหม่","province":"ลำปาง","grade":"ปวส.1","shirtSize":"XL"}`, code)
		wantCode(t, app.selfEdit(t, created.ID, body), http.StatusOK, "")
		if after := len(auditEntries(app, domain.AuditProfileUpdateSelf, created.ID)); after != before {
			t.Fatalf("a no-op edit wrote %d audit rows", after-before)
		}
	})

	t.Run("identity fields and motivation are refused", func(t *testing.T) {
		for _, extra := range []string{
			`,"fullName":"คนอื่น ที่ต่าง"`,
			`,"nationalId":"` + validTestNationalID(999) + `"`,
			`,"phone":"0899999999"`,
			`,"email":"other@example.com"`,
			`,"motivation":"changed"`,
		} {
			wantCode(t, app.selfEdit(t, created.ID, valid(extra)), http.StatusBadRequest, response.CodeValidation)
		}
		full := app.adminView(t, token, created.ID)
		if full.FullName != orig.FullName || full.NationalID != orig.NationalID || full.Phone != orig.Phone || full.Email != orig.Email || full.Motivation != orig.Motivation {
			t.Fatalf("a refused request changed the record: %+v", full)
		}
	})

	t.Run("bad values are rejected", func(t *testing.T) {
		for _, body := range []string{
			fmt.Sprintf(`{"verifyCode":%q,"nickname":"","school":"ร","province":"ล","grade":"ม.6","shirtSize":"M"}`, code),
			fmt.Sprintf(`{"verifyCode":%q,"nickname":"ก","school":"ร","province":"","grade":"ม.6","shirtSize":"M"}`, code),
			fmt.Sprintf(`{"verifyCode":%q,"nickname":"ก","school":"ร","province":"ล","grade":"ม.6","shirtSize":"4XL"}`, code),
			fmt.Sprintf(`{"verifyCode":%q,"nickname":"ก","school":"ร","province":"ล","grade":"อื่นๆ","shirtSize":"M"}`, code),
			fmt.Sprintf(`{"verifyCode":%q,"nickname":%q,"school":"ร","province":"ล","grade":"ม.6","shirtSize":"M"}`, code, strings.Repeat("ก", 51)),
		} {
			wantCode(t, app.selfEdit(t, created.ID, body), http.StatusBadRequest, response.CodeValidation)
		}
	})

	t.Run("closed applications cannot be edited, and the code is checked first", func(t *testing.T) {
		for _, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
			wantCode(t, app.patchStatus(t, token, created.ID, st), http.StatusOK, "")
			wantCode(t, app.selfEdit(t, created.ID, valid("")), http.StatusConflict, response.CodeForbidden)
			// A wrong code learns nothing about the state.
			wrong := "0000"
			if code == wrong {
				wrong = "1111"
			}
			wantCode(t, app.selfEdit(t, created.ID, strings.Replace(valid(""), code, wrong, 1)), http.StatusForbidden, response.CodeInvalidVerifyCode)
		}
	})

	t.Run("a confirmed applicant can still fix a shirt size", func(t *testing.T) {
		wantCode(t, app.patchStatus(t, token, created.ID, domain.StatusConfirmed), http.StatusOK, "")
		wantCode(t, app.selfEdit(t, created.ID, valid("")), http.StatusOK, "")
		if got := app.adminView(t, token, created.ID).ShirtSize; got != "M" {
			t.Fatalf("expected shirt size M, got %s", got)
		}
	})
}

// ── staff profile edit ─────────────────────────────────────────────────────

func TestAdminProfileEdit(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	a := app.submit(t, validTestNationalID(181), "0810000181", "a@example.com")
	b := app.submit(t, validTestNationalID(182), "0810000182", "b@example.com")

	t.Run("requires staff authentication", func(t *testing.T) {
		wantCode(t, app.do(t, http.MethodPatch, "/api/admin/applications/"+a.ID+"/profile", bytes.NewBufferString(`{"nickname":"x"}`), nil), http.StatusUnauthorized, "")
		wantCode(t, app.adminEdit(t, token, "CC25-NOPE00", `{"nickname":"x"}`), http.StatusNotFound, "")
		wantCode(t, app.adminEdit(t, token, a.ID, `{not json`), http.StatusBadRequest, response.CodeValidation)
	})

	t.Run("full validation", func(t *testing.T) {
		for name, body := range map[string]string{
			"bad national id":   `{"nationalId":"1234567890123"}`,
			"short national":    `{"nationalId":"150990000"}`,
			"bad phone":         `{"phone":"0912"}`,
			"phone not zero":    `{"phone":"1234567890"}`,
			"bad email":         `{"email":"not-an-email"}`,
			"bad shirt size":    `{"shirtSize":"5XL"}`,
			"bad grade":         `{"grade":"อื่นๆ"}`,
			"blank full name":   `{"fullName":"   "}`,
			"blank nickname":    `{"nickname":""}`,
			"blank school":      `{"school":"  "}`,
			"blank province":    `{"province":""}`,
			"nickname too long": `{"nickname":"` + strings.Repeat("ก", 51) + `"}`,
			"name too long":     `{"fullName":"` + strings.Repeat("ก", 101) + `"}`,
			"reason too long":   `{"nickname":"x","reason":"` + strings.Repeat("ก", 501) + `"}`,
		} {
			t.Run(name, func(t *testing.T) {
				wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusBadRequest, response.CodeValidation)
			})
		}
		if got := app.adminView(t, token, a.ID); got.NationalID != validTestNationalID(181) || got.Phone != "0810000181" {
			t.Fatalf("rejected edits must not change anything: %+v", got)
		}
	})

	t.Run("duplicates with another live applicant are a clean 409", func(t *testing.T) {
		for name, body := range map[string]string{
			"national id": fmt.Sprintf(`{"nationalId":%q}`, validTestNationalID(182)),
			"phone":       `{"phone":"0810000182"}`,
			"email":       `{"email":"b@example.com"}`,
			"formatted":   `{"phone":"081-000-0182"}`,
		} {
			t.Run(name, func(t *testing.T) {
				wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusConflict, response.CodeDuplicateApp)
			})
		}
	})

	t.Run("keeping the applicant's own identifiers is fine", func(t *testing.T) {
		body := fmt.Sprintf(`{"nationalId":%q,"phone":"0810000181","email":"a@example.com","nickname":"เปลี่ยนชื่อเล่น"}`, validTestNationalID(181))
		wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusOK, "")
		if got := app.adminView(t, token, a.ID).Nickname; got != "เปลี่ยนชื่อเล่น" {
			t.Fatalf("nickname not saved: %s", got)
		}
	})

	t.Run("full edit is saved, unmasked and audited", func(t *testing.T) {
		newID := validTestNationalID(191)
		body := fmt.Sprintf(`{"fullName":"สมศักดิ์ ใจดี","nickname":"ศักดิ์","nationalId":%q,"phone":"0810000191","email":"New@Example.com","school":"โรงเรียนใหม่","province":"ลำพูน","grade":"ปวช.2","shirtSize":"3XL","motivation":"แก้ไขโดยพี่ค่าย","reason":"ผู้ปกครองแจ้งแก้ไขเลขบัตร"}`, newID)
		rec := app.adminEdit(t, token, a.ID, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if res.FullName != "สมศักดิ์ ใจดี" || res.NationalID != newID || res.Phone != "0810000191" || res.Email != "new@example.com" ||
			res.Grade != "ปวช.2" || res.ShirtSize != "3XL" || res.Motivation != "แก้ไขโดยพี่ค่าย" || res.Province != "ลำพูน" {
			t.Fatalf("unexpected admin response (must be unmasked): %+v", res)
		}
		// The public lookup follows the new identifiers.
		if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+newID, nil, nil); rec.Code != http.StatusOK {
			t.Fatalf("lookup by the new national ID should work, got %d", rec.Code)
		}
		if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+validTestNationalID(181), nil, nil); rec.Code != http.StatusNotFound {
			t.Fatalf("the old national ID should no longer match, got %d", rec.Code)
		}

		entries := auditEntries(app, domain.AuditProfileUpdate, a.ID)
		if len(entries) == 0 {
			t.Fatal("expected an application.profile.update audit entry")
		}
		last := entries[len(entries)-1]
		if last.AdminID == nil || *last.AdminID != app.adminID {
			t.Fatalf("audit entry must carry the admin id, got %v", last.AdminID)
		}
		if last.IPAddress == "" || last.Details["reason"] != "ผู้ปกครองแจ้งแก้ไขเลขบัตร" {
			t.Fatalf("audit entry needs the IP and reason, got %+v", last)
		}
		changes, _ := last.Details["changes"].(map[string]map[string]string)
		if changes["nationalId"]["old"] != validTestNationalID(181) || changes["nationalId"]["new"] != newID || changes["grade"]["new"] != "ปวช.2" {
			t.Fatalf("audit changes should list old -> new, got %+v", last.Details["changes"])
		}
	})

	t.Run("a partial edit keeps everything else", func(t *testing.T) {
		before := app.adminView(t, token, a.ID)
		wantCode(t, app.adminEdit(t, token, a.ID, `{"school":"เฉพาะโรงเรียน"}`), http.StatusOK, "")
		after := app.adminView(t, token, a.ID)
		if after.School != "เฉพาะโรงเรียน" || after.FullName != before.FullName || after.NationalID != before.NationalID || after.Motivation != before.Motivation {
			t.Fatalf("partial edit changed other fields: before %+v after %+v", before, after)
		}
	})

	t.Run("a deleted applicant's identifiers are free again", func(t *testing.T) {
		wantCode(t, app.do(t, http.MethodDelete, "/api/admin/applications/"+b.ID, nil, bearer(token)), http.StatusOK, "")
		body := fmt.Sprintf(`{"nationalId":%q,"phone":"0810000182","email":"b@example.com"}`, validTestNationalID(182))
		wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusOK, "")
	})

	t.Run("staff can edit a refunded application", func(t *testing.T) {
		wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRefunded), http.StatusOK, "")
		wantCode(t, app.adminEdit(t, token, a.ID, `{"nickname":"บัญชีคืนเงิน"}`), http.StatusOK, "")
	})
}

// The new endpoints sit behind the same body cap as the rest of the JSON API.
func TestProfileEndpoints_BodyCap(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(201), "0810000201", "cap@example.com")
	huge := `{"nickname":"` + strings.Repeat("ก", 200_000) + `"}`
	wantCode(t, app.selfEdit(t, created.ID, huge), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge)
	wantCode(t, app.adminEdit(t, token, created.ID, huge), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge)
}

// The applicant's own edit shares the public mutation limiter (verifyCode guessing is the attack).
func TestSelfProfileEdit_IsRateLimited(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, validTestNationalID(211), "0810000211", "rl@example.com")
	wrong := "0000"
	if app.verifyCodes[created.ID] == wrong {
		wrong = "1111"
	}
	body := fmt.Sprintf(`{"verifyCode":%q,"nickname":"a","school":"b","province":"c","grade":"ม.6","shirtSize":"M"}`, wrong)
	limited := 0
	for i := 0; i < 30; i++ {
		rec := app.selfEdit(t, created.ID, body)
		switch rec.Code {
		case http.StatusForbidden:
		case http.StatusTooManyRequests:
			limited++
		default:
			t.Fatalf("unexpected status %d", rec.Code)
		}
	}
	if limited == 0 {
		t.Fatal("30 wrong-code attempts in a row must hit the rate limiter")
	}
}
