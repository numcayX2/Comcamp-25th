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

// setupRelaxedApp raises the public mutation and status lookup limits: these tests make many
// PATCH/POST/lookup calls from one test IP, which the production per-minute limits answer with 429.
func setupRelaxedApp(t *testing.T) *testApp {
	t.Helper()
	limits := server.DefaultRateLimits()
	limits.Slip = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Confirm = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Withdraw = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Profile = middleware.NewRateLimiter(10_000, time.Minute)
	limits.StatusQuery = middleware.NewRateLimiter(10_000, time.Minute)
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
	return a.verifyWithPaymentID(t, token, id, a.slipPaymentID(t, token, id), approved)
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
	created := app.submit(t, "0810000101", "fcfs@example.com")
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

	a := app.submit(t, "0810000111", "ra@example.com")
	// The camp is full: the next student is refused.
	rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON("0810000112", "rb@example.com"), nil)
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
	b := app.submit(t, "0810000112", "rb@example.com")
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
	wantStatus(t, app.withdraw(t, b.ID), http.StatusOK)
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

	a := app.submit(t, "0810000121", "c1@example.com")
	b := app.submit(t, "0810000122", "c2@example.com")
	wantCode(t, app.patchStatus(t, token, a.ID, domain.StatusRefunded), http.StatusOK, "")
	wantCode(t, app.patchStatus(t, token, b.ID, domain.StatusRefunded), http.StatusOK, "")
	app.submit(t, "0810000123", "c3@example.com") // takes one of the two freed seats

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
	withSlip := app.submit(t, "0810000131", "w1@example.com")
	wantCode(t, app.uploadSlip(t, withSlip.ID, "s.jpg", uniqueSlip(1)), http.StatusOK, "")
	wantStatus(t, app.withdraw(t, withSlip.ID), http.StatusConflict)
	if got := app.status(t, withSlip.ID); got.Status != domain.StatusPassed || !got.HasSlip {
		t.Fatalf("a blocked withdrawal must leave the application untouched, got %+v", got)
	}

	// Closed applications cannot be withdrawn either: staff own the refund from here.
	for i, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
		n := 140 + i
		c := app.submit(t, fmt.Sprintf("08100001%02d", n%100), fmt.Sprintf("w%d@example.com", n))
		wantCode(t, app.patchStatus(t, token, c.ID, st), http.StatusOK, "")
		wantStatus(t, app.withdraw(t, c.ID), http.StatusConflict)
		if app.status(t, c.ID).Status != st {
			t.Fatalf("%s application must survive a withdrawal attempt", st)
		}
	}

	// A slip staff already rejected is not money held: that applicant may still withdraw.
	rejected := app.submit(t, "0810000150", "w150@example.com")
	wantCode(t, app.uploadSlip(t, rejected.ID, "s.jpg", uniqueSlip(2)), http.StatusOK, "")
	wantCode(t, app.verifySlip(t, token, rejected.ID, false), http.StatusOK, "")
	wantStatus(t, app.withdraw(t, rejected.ID), http.StatusOK)
}

func TestVerifySlip_BlockedForRefundedOrRejectedApplications(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)

	for i, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
		n := 160 + i
		c := app.submit(t, fmt.Sprintf("08100001%02d", n%100), fmt.Sprintf("v%d@example.com", n))
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

// ── applicant's own profile edit (disabled, staff-only since Phase 2.3) ────

// The public PATCH /api/applications/{id}/profile route stays registered behind its rate limiter
// but refuses every request with 403 FORBIDDEN: it never reads the body into the DB, never counts
// towards the application-code guard and never writes an audit row. Corrections go through staff.
func TestSelfProfileEdit_IsDisabled(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	created := app.submit(t, "0810000171", "p1@example.com")
	orig := app.adminView(t, token, created.ID)
	valid := `{"nickname":"ชาย","school":"โรงเรียนใหม่","province":"ลำปาง","grade":"ม.6","shirtSize":"M"}`

	t.Run("every request is refused with 403 FORBIDDEN and a Thai message", func(t *testing.T) {
		bodies := []string{
			valid,
			`{}`,
			`not json at all`,
			`{"verifyCode":"0000","nickname":"x"}`,
			`{"fullName":"คนอื่น ที่ต่าง"}`,
		}
		for _, body := range bodies {
			rec := app.selfEdit(t, created.ID, body)
			wantCode(t, rec, http.StatusForbidden, response.CodeForbidden)
			if e := decodeErr(t, rec.Body.Bytes()); !strings.Contains(e.Error, "ปิดการแก้ไขข้อมูลด้วยตนเองแล้ว") {
				t.Fatalf("expected the Thai notice, got %q", e.Error)
			}
		}
		// An unknown application is no longer distinguishable from a known one.
		wantCode(t, app.selfEdit(t, "CC25-NOPE00", valid), http.StatusForbidden, response.CodeForbidden)
		wantCode(t, app.selfEdit(t, "CC25-000000", valid), http.StatusForbidden, response.CodeForbidden)
	})

	t.Run("nothing changes and nothing is audited", func(t *testing.T) {
		got := app.adminView(t, token, created.ID)
		if got.Nickname != orig.Nickname || got.School != orig.School || got.Province != orig.Province ||
			got.Grade != orig.Grade || got.ShirtSize != orig.ShirtSize || got.FullName != orig.FullName {
			t.Fatalf("a refused request changed the record: %+v", got)
		}
		if n := len(auditEntries(app, domain.AuditProfileUpdateSelf, created.ID)); n != 0 {
			t.Fatalf("expected no self-edit audit rows, got %d", n)
		}
		if n := len(app.auditOf(domain.AuditCodeGuessLockout)) + len(app.auditOf(domain.AuditCodeGuessCeiling)); n != 0 {
			t.Fatalf("a refused edit must not write code-guard audit rows, got %d", n)
		}
	})

	t.Run("unknown codes on the disabled route do not count towards the code guard", func(t *testing.T) {
		for i := 0; i < service.CodeClientMaxMisses+2; i++ {
			wantCode(t, app.selfEdit(t, fmt.Sprintf("CC25-%06X", 0xA00000+i), valid), http.StatusForbidden, response.CodeForbidden)
		}
		// The applicant is not locked out of the other self-service endpoints.
		wantCode(t, app.confirmWith(t, created.ID), http.StatusOK, "")
	})

	t.Run("closed and confirmed applications get the same answer", func(t *testing.T) {
		for _, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRejected, domain.StatusConfirmed} {
			wantCode(t, app.patchStatus(t, token, created.ID, st), http.StatusOK, "")
			wantCode(t, app.selfEdit(t, created.ID, valid), http.StatusForbidden, response.CodeForbidden)
		}
		if got := app.adminView(t, token, created.ID); got.School != orig.School || got.ShirtSize != orig.ShirtSize {
			t.Fatalf("a refused request changed the record: %+v", got)
		}
	})

	t.Run("staff can still edit the same application", func(t *testing.T) {
		body := `{"nickname":"พี่แก้ให้","school":"โรงเรียนใหม่","province":"ลำปาง","grade":"ม.6","shirtSize":"M","reason":"ผู้สมัครแจ้งแก้ไข"}`
		wantCode(t, app.adminEdit(t, token, created.ID, body), http.StatusOK, "")
		got := app.adminView(t, token, created.ID)
		if got.Nickname != "พี่แก้ให้" || got.School != "โรงเรียนใหม่" || got.Province != "ลำปาง" || got.Grade != "ม.6" || got.ShirtSize != "M" {
			t.Fatalf("admin edit did not apply: %+v", got)
		}
	})
}

// ── staff profile edit ─────────────────────────────────────────────────────

func TestAdminProfileEdit(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)
	a := app.submit(t, "0810000181", "a@example.com")
	b := app.submit(t, "0810000182", "b@example.com")

	t.Run("requires staff authentication", func(t *testing.T) {
		wantCode(t, app.do(t, http.MethodPatch, "/api/admin/applications/"+a.ID+"/profile", bytes.NewBufferString(`{"nickname":"x"}`), nil), http.StatusUnauthorized, "")
		wantCode(t, app.adminEdit(t, token, "CC25-NOPE00", `{"nickname":"x"}`), http.StatusNotFound, "")
		wantCode(t, app.adminEdit(t, token, a.ID, `{not json`), http.StatusBadRequest, response.CodeValidation)
	})

	t.Run("full validation", func(t *testing.T) {
		for name, body := range map[string]string{
			"bad phone":         `{"phone":"0912"}`,
			"phone not zero":    `{"phone":"1234567890"}`,
			"bad email":         `{"email":"not-an-email"}`,
			"blank email":       `{"email":"   "}`,
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
		if got := app.adminView(t, token, a.ID); got.Phone != "0810000181" || got.Email != "a@example.com" {
			t.Fatalf("rejected edits must not change anything: %+v", got)
		}
	})

	t.Run("duplicates with another live applicant are a clean 409", func(t *testing.T) {
		for name, body := range map[string]string{
			"phone":          `{"phone":"0810000182"}`,
			"email":          `{"email":"b@example.com"}`,
			"email any case": `{"email":"B@Example.COM"}`,
			"formatted":      `{"phone":"081-000-0182"}`,
		} {
			t.Run(name, func(t *testing.T) {
				wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusConflict, response.CodeDuplicateApp)
			})
		}
	})

	t.Run("keeping the applicant's own identifiers is fine", func(t *testing.T) {
		body := `{"phone":"0810000181","email":"a@example.com","nickname":"เปลี่ยนชื่อเล่น"}`
		wantCode(t, app.adminEdit(t, token, a.ID, body), http.StatusOK, "")
		if got := app.adminView(t, token, a.ID).Nickname; got != "เปลี่ยนชื่อเล่น" {
			t.Fatalf("nickname not saved: %s", got)
		}
	})

	t.Run("full edit is saved, unmasked and audited", func(t *testing.T) {
		// A nationalId field from an outdated admin page is ignored.
		body := `{"fullName":"สมศักดิ์ ใจดี","nickname":"ศักดิ์","nationalId":"1509900112233","phone":"0810000191","email":"New@Example.com","school":"โรงเรียนใหม่","province":"ลำพูน","grade":"ปวช.2","shirtSize":"3XL","motivation":"แก้ไขโดยพี่ค่าย","allergies":"แพ้อาหารทะเล","medicalConditions":"หอบหืด","reason":"ผู้ปกครองแจ้งแก้ไขเบอร์โทร"}`
		rec := app.adminEdit(t, token, a.ID, body)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d (%s)", rec.Code, rec.Body.String())
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if strings.Contains(rec.Body.String(), "1509900112233") || strings.Contains(rec.Body.String(), "nationalId") {
			t.Fatalf("the ignored national ID must not come back: %s", rec.Body.String())
		}
		if res.FullName != "สมศักดิ์ ใจดี" || res.Phone != "0810000191" || res.Email != "new@example.com" ||
			res.Grade != "ปวช.2" || res.ShirtSize != "3XL" || res.Motivation != "แก้ไขโดยพี่ค่าย" || res.Province != "ลำพูน" ||
			res.Allergies != "แพ้อาหารทะเล" || res.MedicalConditions != "หอบหืด" {
			t.Fatalf("unexpected admin response (must be unmasked): %+v", res)
		}
		// The public lookup follows the new phone without leaking health notes or motivation.
		pubRec := app.do(t, http.MethodGet, "/api/applications/status?q=0810000191", nil, nil)
		if pubRec.Code != http.StatusOK {
			t.Fatalf("lookup by the new phone should work, got %d", pubRec.Code)
		}
		for _, leaked := range []string{"allergies", "medicalConditions", "แพ้อาหารทะเล", "หอบหืด", "motivation"} {
			if strings.Contains(pubRec.Body.String(), leaked) {
				t.Fatalf("public status lookup must not leak %q: %s", leaked, pubRec.Body.String())
			}
		}
		if rec := app.do(t, http.MethodGet, "/api/applications/status?q=0810000181", nil, nil); rec.Code != http.StatusNotFound {
			t.Fatalf("the old phone should no longer match, got %d", rec.Code)
		}

		entries := auditEntries(app, domain.AuditProfileUpdate, a.ID)
		if len(entries) == 0 {
			t.Fatal("expected an application.profile.update audit entry")
		}
		last := entries[len(entries)-1]
		if last.AdminID == nil || *last.AdminID != app.adminID {
			t.Fatalf("audit entry must carry the admin id, got %v", last.AdminID)
		}
		if last.IPAddress == "" || last.Details["reason"] != "ผู้ปกครองแจ้งแก้ไขเบอร์โทร" {
			t.Fatalf("audit entry needs the IP and reason, got %+v", last)
		}
		changes, _ := last.Details["changes"].(map[string]map[string]string)
		if _, ok := changes["nationalId"]; ok {
			t.Fatalf("there is no national ID to change any more: %+v", changes)
		}
		if changes["phone"]["old"] != "0810000181" || changes["phone"]["new"] != "0810000191" || changes["grade"]["new"] != "ปวช.2" {
			t.Fatalf("audit changes should list old -> new, got %+v", last.Details["changes"])
		}
	})

	t.Run("a partial edit keeps everything else", func(t *testing.T) {
		before := app.adminView(t, token, a.ID)
		wantCode(t, app.adminEdit(t, token, a.ID, `{"school":"เฉพาะโรงเรียน"}`), http.StatusOK, "")
		after := app.adminView(t, token, a.ID)
		if after.School != "เฉพาะโรงเรียน" || after.FullName != before.FullName || after.Phone != before.Phone || after.Motivation != before.Motivation {
			t.Fatalf("partial edit changed other fields: before %+v after %+v", before, after)
		}
	})

	t.Run("a deleted applicant's identifiers are free again", func(t *testing.T) {
		wantCode(t, app.do(t, http.MethodDelete, "/api/admin/applications/"+b.ID, nil, bearer(token)), http.StatusOK, "")
		body := `{"phone":"0810000182","email":"b@example.com"}`
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
	created := app.submit(t, "0810000201", "cap@example.com")
	huge := `{"nickname":"` + strings.Repeat("ก", 200_000) + `"}`
	wantCode(t, app.selfEdit(t, created.ID, huge), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge)
	wantCode(t, app.adminEdit(t, token, created.ID, huge), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge)
}

// The disabled public edit route stays behind its rate limiter, so it cannot be hammered.
func TestSelfProfileEdit_IsRateLimited(t *testing.T) {
	app := setupTestApp(t)
	created := app.submit(t, "0810000211", "rl@example.com")
	body := `{"nickname":"a","school":"b","province":"c","grade":"ม.6","shirtSize":"M"}`
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
		t.Fatal("30 attempts in a row must hit the rate limiter")
	}
}

func TestHealthNotesRegistrationAndPrivacy(t *testing.T) {
	app := setupRelaxedApp(t)
	token := app.login(t)

	payload := `{"fullName":"สมหญิง ใจดี","nickname":"หญิง","phone":"0810000221","email":"ying.health@example.com","school":"โรงเรียนแม่โจ้","province":"เชียงใหม่","grade":"ม.5","shirtSize":"M","motivation":"อยากทำ IoT","allergies":"  แพ้กุ้ง\u200bและปู  ","medicalConditions":"  หอบหืด ต้องพกยาพ่น  "}`
	rec := app.do(t, http.MethodPost, "/api/applications", strings.NewReader(payload), map[string]string{
		"Idempotency-Key": "660e8400-e29b-41d4-a716-446655440221",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	for _, leaked := range []string{"allergies", "medicalConditions", "แพ้กุ้ง", "หอบหืด", "motivation"} {
		if strings.Contains(rec.Body.String(), leaked) {
			t.Fatalf("public register response must not leak %q: %s", leaked, rec.Body.String())
		}
	}

	var created service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	adminView := app.adminView(t, token, created.ID)
	if adminView.Allergies != "แพ้กุ้งและปู" || adminView.MedicalConditions != "หอบหืด ต้องพกยาพ่น" {
		t.Fatalf("admin view did not normalize/return health notes: %+v", adminView)
	}

	// Oversized allergies (>500 runes) must fail cleanly with 400.
	tooLong := fmt.Sprintf(
		`{"fullName":"สมชาย ยาว","nickname":"ยาว","phone":"0810000222","email":"long222@example.com","school":"โรงเรียนแม่โจ้","province":"เชียงใหม่","grade":"ม.5","shirtSize":"M","motivation":"","allergies":%q}`,
		strings.Repeat("ก", 501),
	)
	wantCode(t, app.do(t, http.MethodPost, "/api/applications", strings.NewReader(tooLong), map[string]string{
		"Idempotency-Key": "660e8400-e29b-41d4-a716-446655440222",
	}), http.StatusBadRequest, response.CodeValidation)
}
