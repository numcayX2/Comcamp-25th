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
	"comcamp25-backend/internal/service"
)

// ---------------------------------------------------------------------------------------------
// Cross-endpoint PII: finance and reviewer must not read raw national IDs
// ---------------------------------------------------------------------------------------------

// adminListIDs returns application ID -> nationalId as the given token sees it.
func (a *testApp) adminListIDs(t *testing.T, token, query string) (map[string]string, string) {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/admin/applications"+query, nil, bearer(token))
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var list []struct {
		ID         string `json:"id"`
		NationalID string `json:"nationalId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	out := map[string]string{}
	for _, x := range list {
		out[x.ID] = x.NationalID
	}
	return out, rec.Body.String()
}

func TestAdminList_NationalIDIsMaskedForFinanceAndReviewerOnly(t *testing.T) {
	app := setupUnlimitedApp(t)
	nid := validTestNationalID(80_001)
	created := app.submit(t, nid, "0880000001", "pii1@example.com")

	cases := []struct {
		role domain.AdminRole
		raw  bool
	}{
		{domain.RoleSuperadmin, true},
		{domain.RoleStaff, true},
		{domain.RoleFinance, false},
		{domain.RoleReviewer, false},
	}
	for _, tc := range cases {
		t.Run(string(tc.role), func(t *testing.T) {
			token, _ := app.loginAs(t, "pii-"+string(tc.role), tc.role)
			// Plain list and a status-filtered list share the path; check both.
			for _, q := range []string{"", "?status=PASSED"} {
				ids, body := app.adminListIDs(t, token, q)
				got, ok := ids[created.ID]
				if !ok {
					t.Fatalf("%s: application missing from list%s", tc.role, q)
				}
				if tc.raw {
					if got != nid {
						t.Fatalf("%s must get the raw national ID, got %q", tc.role, got)
					}
					continue
				}
				if want := service.MaskNationalID(nid); got != want {
					t.Fatalf("%s%s: nationalId = %q, want masked %q", tc.role, q, got, want)
				}
				if strings.Contains(body, nid) || strings.Contains(body, nid[9:]) {
					t.Fatalf("%s%s: the raw ID (or its last digits) leaks elsewhere in the response", tc.role, q)
				}
			}
		})
	}
}

// The attack the masking closes: public /withdraw needs only the national ID, so a role that may
// not DELETE must not be able to read it and withdraw the application instead.
func TestAdminList_ReviewerAndFinanceCannotWithdrawWithWhatTheySee(t *testing.T) {
	app := setupUnlimitedApp(t)
	nid := validTestNationalID(80_002)
	created := app.submit(t, nid, "0880000002", "pii2@example.com")
	app.nationalIDs[created.ID] = nid

	for _, role := range []domain.AdminRole{domain.RoleReviewer, domain.RoleFinance} {
		token, _ := app.loginAs(t, "attacker-"+string(role), role)
		ids, _ := app.adminListIDs(t, token, "")
		seen := ids[created.ID]

		// What the account can see is useless as a credential: format check fails (400), no lock.
		body := fmt.Sprintf(`{"nationalId":%q}`, seen)
		rec := app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/withdraw", bytes.NewBufferString(body), nil)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: withdraw with the visible (masked) value should be 400, got %d (%s)", role, rec.Code, rec.Body.String())
		}
		// And the DELETE route itself stays superadmin-only.
		del := app.do(t, http.MethodDelete, "/api/admin/applications/"+created.ID, nil, bearer(token))
		if del.Code != http.StatusForbidden {
			t.Fatalf("%s: DELETE should be 403, got %d", role, del.Code)
		}
	}
	if a, err := app.applicant(t, created.ID); err != nil || a.Status == domain.StatusRejected {
		t.Fatalf("the application must be untouched, got %v / %v", a, err)
	}
	// The applicant themselves (who knows the ID) can still withdraw.
	rec := app.withdrawRec(t, created.ID, nid)
	if rec.Code != http.StatusOK {
		t.Fatalf("the real applicant must still be able to withdraw, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestAdminList_RoleChangeToReviewerMasksImmediately(t *testing.T) {
	app := setupUnlimitedApp(t)
	nid := validTestNationalID(80_003)
	created := app.submit(t, nid, "0880000003", "pii3@example.com")
	token, adminID := app.loginAs(t, "pii-demoted", domain.RoleStaff)

	if ids, _ := app.adminListIDs(t, token, ""); ids[created.ID] != nid {
		t.Fatalf("staff should see the raw ID, got %q", ids[created.ID])
	}
	app.adminRepo.SetRole(adminID, domain.RoleReviewer) // role is re-read from the DB on every request
	if ids, _ := app.adminListIDs(t, token, ""); ids[created.ID] != service.MaskNationalID(nid) {
		t.Fatalf("after the demotion the same token must get the masked ID, got %q", ids[created.ID])
	}
}

func TestCanSeeFullNationalID_FailsClosed(t *testing.T) {
	for role, want := range map[domain.AdminRole]bool{
		domain.RoleSuperadmin: true, domain.RoleStaff: true,
		domain.RoleFinance: false, domain.RoleReviewer: false,
		"": false, "auditor": false, "SUPERADMIN": false,
	} {
		if got := service.CanSeeFullNationalID(role); got != want {
			t.Errorf("CanSeeFullNationalID(%q) = %v, want %v", role, got, want)
		}
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
	created := app.submit(t, validTestNationalID(81_001), "0881000001", "slip1@example.com")

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
	a1 := app.submit(t, validTestNationalID(81_002), "0881000002", "slip2a@example.com")
	a2 := app.submit(t, validTestNationalID(81_003), "0881000003", "slip2b@example.com")
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
	created := app.submit(t, validTestNationalID(81_004), "0881000004", "slip3@example.com")
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
	created := app.submit(t, validTestNationalID(81_005), "0881000005", "slip4@example.com")
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
	created := app.submit(t, validTestNationalID(81_006), "0881000006", "slip5@example.com")

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
	created := app.submit(t, validTestNationalID(82_001), "0882000001", "swap0@example.com")

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
	created := app.submit(t, validTestNationalID(82_002), "0882000002", "swap1@example.com")

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
	created := app.submit(t, validTestNationalID(82_003), "0882000003", "swap2@example.com")
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
	other := app.submit(t, validTestNationalID(82_004), "0882000004", "swap3@example.com")
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
	// Omitting paymentId keeps the old behaviour.
	if rec := app.verifySlip(t, token, created.ID, true); rec.Code != http.StatusOK {
		t.Fatalf("no paymentId: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}
