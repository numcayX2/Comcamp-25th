package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

// ---------------------------------------------------------------------------------------------
// Cross-endpoint PII: only RoleAdmin may access admin endpoints (and the full phone and email)
// ---------------------------------------------------------------------------------------------

// adminListPhones returns application ID -> phone as the given token sees it.
func (a *testApp) adminListPhones(t *testing.T, token, query string) (map[string]string, string) {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/admin/applications"+query, nil, bearer(token))
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var list []struct {
		ID    string `json:"id"`
		Phone string `json:"phone"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	out := map[string]string{}
	for _, x := range list {
		out[x.ID] = x.Phone
	}
	return out, rec.Body.String()
}

func TestAdminList_FullContactIsVisibleToAdminAndPublicStatusRemainsMasked(t *testing.T) {
	app := setupUnlimitedApp(t)
	created := app.submit(t, "0880000001", "pii1@example.com")

	token, _ := app.loginAs(t, "pii-admin", domain.RoleAdmin)
	for _, q := range []string{"", "?status=PASSED"} {
		phones, body := app.adminListPhones(t, token, q)
		got, ok := phones[created.ID]
		if !ok {
			t.Fatalf("admin: application missing from list%s", q)
		}
		if got != "0880000001" {
			t.Fatalf("admin%s must get the full phone number, got %q", q, got)
		}
		if strings.Contains(body, "nationalId") {
			t.Fatalf("admin%s: there is no national ID any more: %s", q, body)
		}
	}

	// Public status endpoint remains masked.
	pub := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil)
	if pub.Code != http.StatusOK {
		t.Fatalf("public status: expected 200, got %d", pub.Code)
	}
	if body := pub.Body.String(); !strings.Contains(body, "XXX-XXX-0001") || strings.Contains(body, "0880000001") || strings.Contains(body, "pii1@example.com") {
		t.Fatalf("public status must mask the phone and email, got %s", body)
	}
}

func TestAdminList_NonAdminCannotReadOrDelete(t *testing.T) {
	app := setupUnlimitedApp(t)
	created := app.submit(t, "0880000002", "pii2@example.com")

	for _, role := range []domain.AdminRole{domain.AdminRole("auditor"), domain.AdminRole("")} {
		token, _ := app.loginAs(t, "nonadmin-"+string(role), role)
		listRec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
		if listRec.Code != http.StatusForbidden {
			t.Fatalf("role %q: GET /api/admin/applications should be 403, got %d", role, listRec.Code)
		}
		delRec := app.do(t, http.MethodDelete, "/api/admin/applications/"+created.ID, nil, bearer(token))
		if delRec.Code != http.StatusForbidden {
			t.Fatalf("role %q: DELETE should be 403, got %d", role, delRec.Code)
		}
	}
	if a, err := app.applicant(t, created.ID); err != nil || a.Status == domain.StatusRejected {
		t.Fatalf("the application must be untouched, got %v / %v", a, err)
	}
	// The applicant themselves (who holds the code) can still withdraw.
	rec := app.withdrawRec(t, created.ID)
	if rec.Code != http.StatusOK {
		t.Fatalf("the real applicant must still be able to withdraw, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestAdminList_RoleDemotionRevokesAccessImmediately(t *testing.T) {
	app := setupUnlimitedApp(t)
	created := app.submit(t, "0880000003", "pii3@example.com")
	token, adminID := app.loginAs(t, "pii-demoted", domain.RoleAdmin)

	if phones, _ := app.adminListPhones(t, token, ""); phones[created.ID] != "0880000003" {
		t.Fatalf("admin should see the full phone, got %q", phones[created.ID])
	}
	app.adminRepo.SetRole(adminID, domain.AdminRole("auditor")) // role is re-read from the DB on every request
	if rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token)); rec.Code != http.StatusForbidden {
		t.Fatalf("after demotion to non-admin role the same token must get 403, got %d", rec.Code)
	}
}

// ---------------------------------------------------------------------------------------------
// HIGH-02: one pending slip per applicant, and the slip-swap race
// ---------------------------------------------------------------------------------------------

func (a *testApp) slipFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(a.slipDir)
	if err != nil {
		t.Fatalf("read slip dir: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func (a *testApp) paymentsOf(t *testing.T, appID string) []*domain.Payment {
	t.Helper()
	ap, err := a.applicant(t, appID)
	if err != nil {
		t.Fatal(err)
	}
	list, err := a.payRepo.GetByApplicantID(context.Background(), ap.ID)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func (a *testApp) slipPaymentID(t *testing.T, token, appID string) string {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	var list []struct {
		ID            string  `json:"id"`
		SlipPaymentID *string `json:"slipPaymentId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	for _, x := range list {
		if x.ID == appID {
			if x.SlipPaymentID == nil {
				t.Fatalf("%s has no slipPaymentId in the admin list", appID)
			}
			return *x.SlipPaymentID
		}
	}
	t.Fatalf("%s not in the admin list", appID)
	return ""
}

func (a *testApp) verifyWithPaymentID(t *testing.T, token, appID, paymentID string, approved bool) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"approved":%t,"note":"ok","paymentId":%q}`, approved, paymentID)
	return a.do(t, http.MethodPatch, "/api/admin/applications/"+appID+"/verify-slip", bytes.NewBufferString(body), bearer(token))
}

func TestSlipReupload_ReplacesThePendingSlipAndItsFile(t *testing.T) {
	app := setupUnlimitedApp(t)
	created := app.submit(t, "0881000001", "slip1@example.com")

	for i := 1; i <= 12; i++ {
		if rec := app.uploadSlip(t, created.ID, "slip.jpg", uniqueSlip(100+i)); rec.Code != http.StatusOK {
			t.Fatalf("upload %d: expected 200, got %d (%s)", i, rec.Code, rec.Body.String())
		}
		if n := len(app.slipFiles(t)); n != 1 {
			t.Fatalf("after upload %d the disk holds %d slip files, want exactly 1", i, n)
		}
		pays := app.paymentsOf(t, created.ID)
		if len(pays) != 1 || pays[0].Status != domain.PaymentPending {
			t.Fatalf("after upload %d: want one PENDING payment, got %d rows", i, len(pays))
		}
	}

	// The remaining file is the newest slip's.
	pays := app.paymentsOf(t, created.ID)
	if want := strings.TrimPrefix(pays[0].SlipURL, "slips/"); app.slipFiles(t)[0] != want {
		t.Fatalf("the file on disk is %q, the row points at %q", app.slipFiles(t)[0], want)
	}

	// A replaced slip's hash is free again (it was never approved), so it can be sent once more.
	if rec := app.uploadSlip(t, created.ID, "slip.jpg", uniqueSlip(101)); rec.Code != http.StatusOK {
		t.Fatalf("re-sending an earlier, replaced slip: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	// But the slip that is currently pending is still a duplicate of itself.
	if rec := app.uploadSlip(t, created.ID, "slip.jpg", uniqueSlip(101)); rec.Code != http.StatusConflict {
		t.Fatalf("the identical pending slip: expected 409, got %d", rec.Code)
	}
	if n := len(app.slipFiles(t)); n != 1 {
		t.Fatalf("a refused duplicate must leave no file behind, disk holds %d", n)
	}

	var superseded int
	for _, e := range app.appRepo.Audit().Entries() {
		if e.Action == domain.AuditSlipSuperseded && e.TargetID == created.ID {
			superseded++
		}
	}
	if superseded != 12 { // uploads 2..12 and the re-send of 101
		t.Fatalf("expected 12 slip.superseded audit rows, got %d", superseded)
	}
}

func TestSlipReupload_OtherApplicantsAreUntouched(t *testing.T) {
	app := setupUnlimitedApp(t)
	a1 := app.submit(t, "0881000002", "slip2a@example.com")
	a2 := app.submit(t, "0881000003", "slip2b@example.com")
	if rec := app.uploadSlip(t, a1.ID, "s.jpg", uniqueSlip(201)); rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if rec := app.uploadSlip(t, a2.ID, "s.jpg", uniqueSlip(202)); rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if rec := app.uploadSlip(t, a1.ID, "s.jpg", uniqueSlip(203)); rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if n := len(app.slipFiles(t)); n != 2 {
		t.Fatalf("one slip per applicant: want 2 files, got %d", n)
	}
	if p := app.paymentsOf(t, a2.ID); len(p) != 1 || p[0].Status != domain.PaymentPending {
		t.Fatalf("applicant 2 must keep their pending slip, got %v", p)
	}
	// Another applicant sending the identical image is still refused as fraud.
	if rec := app.uploadSlip(t, a1.ID, "s.jpg", uniqueSlip(202)); rec.Code != http.StatusConflict {
		t.Fatalf("a slip pending under someone else: expected 409, got %d", rec.Code)
	}
	if n := len(app.slipFiles(t)); n != 2 {
		t.Fatalf("a refused duplicate must leave no file, got %d files", n)
	}
}

func TestSlipReupload_ApprovedSlipIsNeverReplaced(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	created := app.submit(t, "0881000004", "slip3@example.com")
	if rec := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(301)); rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if rec := app.verifySlip(t, token, created.ID, true); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	if rec := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(302)); rec.Code != http.StatusConflict {
		t.Fatalf("upload after approval: expected 409, got %d", rec.Code)
	}
	if n := len(app.slipFiles(t)); n != 1 {
		t.Fatalf("the refused upload must not leave a file, disk holds %d", n)
	}
	if p := app.paymentsOf(t, created.ID); len(p) != 1 || p[0].Status != domain.PaymentApproved {
		t.Fatalf("the approved slip must stay as it was, got %v", p)
	}
}

func TestSlipReupload_RejectedSlipIsKeptAsHistory(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	created := app.submit(t, "0881000005", "slip4@example.com")
	if rec := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(401)); rec.Code != http.StatusOK {
		t.Fatal(rec.Body.String())
	}
	if rec := app.verifySlip(t, token, created.ID, false); rec.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", rec.Code, rec.Body.String())
	}
	if rec := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(402)); rec.Code != http.StatusOK {
		t.Fatalf("re-upload after a rejection: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	pays := app.paymentsOf(t, created.ID)
	var rejected, pending int
	for _, p := range pays {
		switch p.Status {
		case domain.PaymentRejected:
			rejected++
		case domain.PaymentPending:
			pending++
		}
	}
	if rejected != 1 || pending != 1 || len(app.slipFiles(t)) != 2 {
		t.Fatalf("want 1 REJECTED (history) + 1 PENDING and 2 files, got rejected=%d pending=%d files=%d", rejected, pending, len(app.slipFiles(t)))
	}
}

// Parallel uploads for one applicant still end with exactly one pending slip and one file.
func TestSlipReupload_ConcurrentUploadsLeaveOnePendingSlip(t *testing.T) {
	app := setupUnlimitedApp(t)
	created := app.submit(t, "0881000006", "slip5@example.com")

	const n = 24
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(500+i)).Code
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("upload %d: expected 200, got %d", i, c)
		}
	}
	pays := app.paymentsOf(t, created.ID)
	if len(pays) != 1 || pays[0].Status != domain.PaymentPending {
		t.Fatalf("want exactly one PENDING payment after %d parallel uploads, got %d rows", n, len(pays))
	}
	if files := app.slipFiles(t); len(files) != 1 || files[0] != strings.TrimPrefix(pays[0].SlipURL, "slips/") {
		t.Fatalf("want exactly the surviving slip on disk, got %v (row %s)", files, pays[0].SlipURL)
	}
}

func TestVerifySlip_AdminListAndSlipHeaderExposeThePaymentID(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	created := app.submit(t, "0882000001", "swap0@example.com")

	// No slip: no slipPaymentId.
	rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
	if strings.Contains(rec.Body.String(), "slipPaymentId") {
		t.Fatalf("an application without a slip must not carry slipPaymentId: %s", rec.Body.String())
	}

	if r := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(601)); r.Code != http.StatusOK {
		t.Fatal(r.Body.String())
	}
	pid := app.slipPaymentID(t, token, created.ID)
	if _, err := uuid.Parse(pid); err != nil {
		t.Fatalf("slipPaymentId %q is not a UUID", pid)
	}
	slip := app.do(t, http.MethodGet, "/api/admin/applications/"+created.ID+"/slip", nil, bearer(token))
	if slip.Code != http.StatusOK || slip.Header().Get("X-Slip-Payment-Id") != pid {
		t.Fatalf("GET slip: want 200 with X-Slip-Payment-Id=%s, got %d %q", pid, slip.Code, slip.Header().Get("X-Slip-Payment-Id"))
	}
	// Not for the public: the id appears only behind admin auth.
	pub := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil)
	if strings.Contains(pub.Body.String(), pid) || strings.Contains(pub.Body.String(), "slipPaymentId") {
		t.Fatalf("the public status response must not expose the payment id: %s", pub.Body.String())
	}
}

func TestVerifySlip_StalePaymentIDIsRefusedAndNothingChanges(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	created := app.submit(t, "0882000002", "swap1@example.com")

	if r := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(701)); r.Code != http.StatusOK {
		t.Fatal(r.Body.String())
	}
	inspected := app.slipPaymentID(t, token, created.ID) // the admin opens slip #1 ...

	if r := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(702)); r.Code != http.StatusOK { // ... the applicant swaps it
		t.Fatal(r.Body.String())
	}
	current := app.slipPaymentID(t, token, created.ID)
	if current == inspected {
		t.Fatal("the new upload must have a new payment id")
	}

	rec := app.verifyWithPaymentID(t, token, created.ID, inspected, true)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"SLIP_CHANGED"`) {
		t.Fatalf("approving the stale slip: expected 409 SLIP_CHANGED, got %d (%s)", rec.Code, rec.Body.String())
	}
	if a, _ := app.applicant(t, created.ID); a.Status != domain.StatusPassed {
		t.Fatalf("a refused verdict must not confirm the seat, status = %s", a.Status)
	}
	if p := app.paymentsOf(t, created.ID); len(p) != 1 || p[0].Status != domain.PaymentPending || p[0].ID.String() != current {
		t.Fatalf("the new slip must still be PENDING and untouched, got %v", p)
	}

	// The admin reviews what is current and approves it.
	if rec := app.verifyWithPaymentID(t, token, created.ID, current, true); rec.Code != http.StatusOK {
		t.Fatalf("approving the current slip: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if a, _ := app.applicant(t, created.ID); a.Status != domain.StatusConfirmed {
		t.Fatalf("status = %s, want CONFIRMED", a.Status)
	}
}

func TestVerifySlip_PaymentIDValidation(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	created := app.submit(t, "0882000003", "swap2@example.com")
	if r := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(801)); r.Code != http.StatusOK {
		t.Fatal(r.Body.String())
	}

	if rec := app.verifyWithPaymentID(t, token, created.ID, "not-a-uuid", true); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed paymentId: expected 400, got %d", rec.Code)
	}
	if rec := app.verifyWithPaymentID(t, token, created.ID, uuid.NewString(), true); rec.Code != http.StatusConflict {
		t.Fatalf("someone else's / unknown paymentId: expected 409, got %d", rec.Code)
	}
	// paymentId from ANOTHER applicant's slip must not settle this applicant's slip either.
	other := app.submit(t, "0882000004", "swap3@example.com")
	if r := app.uploadSlip(t, other.ID, "s.jpg", uniqueSlip(802)); r.Code != http.StatusOK {
		t.Fatal(r.Body.String())
	}
	otherPID := app.slipPaymentID(t, token, other.ID)
	if rec := app.verifyWithPaymentID(t, token, created.ID, otherPID, true); rec.Code != http.StatusConflict {
		t.Fatalf("another applicant's paymentId: expected 409, got %d", rec.Code)
	}
	if a, _ := app.applicant(t, created.ID); a.Status != domain.StatusPassed {
		t.Fatalf("nothing may have been approved, status = %s", a.Status)
	}
	// Missing, empty, whitespace-only, or malformed paymentId must be rejected with 400 VALIDATION_ERROR
	// for both approve and reject decisions.
	for _, approved := range []bool{true, false} {
		for name, rawBody := range map[string]string{
			"missing":    fmt.Sprintf(`{"approved":%t,"note":"ok"}`, approved),
			"empty":      fmt.Sprintf(`{"approved":%t,"note":"ok","paymentId":""}`, approved),
			"whitespace": fmt.Sprintf(`{"approved":%t,"note":"ok","paymentId":"   "}`, approved),
			"non-uuid":   fmt.Sprintf(`{"approved":%t,"note":"ok","paymentId":"not-a-uuid"}`, approved),
		} {
			rec := app.do(t, http.MethodPatch, "/api/admin/applications/"+created.ID+"/verify-slip", bytes.NewBufferString(rawBody), bearer(token))
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"VALIDATION_ERROR"`) {
				t.Fatalf("approved=%t %s paymentId: expected 400 VALIDATION_ERROR, got %d (%s)", approved, name, rec.Code, rec.Body.String())
			}
		}
	}

	// Historical REJECTED slip ID must be rejected as 409 SLIP_CHANGED after re-upload.
	firstPID := app.slipPaymentID(t, token, created.ID)
	if rec := app.verifyWithPaymentID(t, token, created.ID, firstPID, false); rec.Code != http.StatusOK {
		t.Fatalf("reject current slip: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if r := app.uploadSlip(t, created.ID, "s.jpg", uniqueSlip(803)); r.Code != http.StatusOK {
		t.Fatal(r.Body.String())
	}
	if rec := app.verifyWithPaymentID(t, token, created.ID, firstPID, true); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"SLIP_CHANGED"`) {
		t.Fatalf("stale historical paymentId: expected 409 SLIP_CHANGED, got %d (%s)", rec.Code, rec.Body.String())
	}

	// Approving with the latest paymentId succeeds.
	latestPID := app.slipPaymentID(t, token, created.ID)
	if rec := app.verifyWithPaymentID(t, token, created.ID, latestPID, true); rec.Code != http.StatusOK {
		t.Fatalf("latest paymentId: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}
