package handler_test

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// wrongCode returns a 4-digit code that is not the applicant's.
func (a *testApp) wrongCode(appID string) string {
	if a.verifyCodes[appID] == "0000" {
		return "1111"
	}
	return "0000"
}

func (a *testApp) confirmWith(t *testing.T, appID, code string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"confirmed":true,"verifyCode":%q}`, code)
	return a.do(t, http.MethodPost, "/api/applications/"+appID+"/confirm", bytes.NewBufferString(body), nil)
}

func (a *testApp) profileWith(t *testing.T, appID, code string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"verifyCode":%q,"nickname":"เกียรติ","school":"โรงเรียนแม่โจ้วิทยาคม","grade":"ม.5","shirtSize":"XL"}`, code)
	return a.do(t, http.MethodPatch, "/api/applications/"+appID+"/profile", bytes.NewBufferString(body), nil)
}

func wantErrCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("expected %d, got %d (%s)", status, rec.Code, rec.Body.String())
	}
	if e := decodeErr(t, rec.Body.Bytes()); code != "" && e.Code != code {
		t.Fatalf("expected code %s, got %q (%s)", code, e.Code, rec.Body.String())
	}
}

// wantLocked checks a lockout answer: 429 RATE_LIMITED with a Retry-After of at most 15 minutes.
func wantLocked(t *testing.T, rec *httptest.ResponseRecorder) int {
	t.Helper()
	wantErrCode(t, rec, http.StatusTooManyRequests, response.CodeRateLimited)
	secs, err := strconv.Atoi(rec.Header().Get("Retry-After"))
	if err != nil || secs < 1 || secs > int(service.VerifyLockoutDuration/time.Second) {
		t.Fatalf("Retry-After must be 1..900 seconds, got %q", rec.Header().Get("Retry-After"))
	}
	return secs
}

func (a *testApp) auditFor(appID string, action domain.AuditAction) []domain.AuditEntry {
	var out []domain.AuditEntry
	for _, e := range a.appRepo.Audit().Entries() {
		if e.TargetID == appID && e.Action == action {
			out = append(out, e)
		}
	}
	return out
}

// Five wrong codes lock the application for 15 minutes on every public endpoint, even for the
// right code; other applications are not affected; the lock expires on its own and a success
// resets the counter.
func TestVerifyLockout_FiveWrongCodesLockTheApplication(t *testing.T) {
	app := setupRelaxedApp(t)
	victim := app.submit(t, validTestNationalID(81), "0810000081", "lock1@example.com")
	other := app.submit(t, validTestNationalID(82), "0810000082", "lock2@example.com")
	wrong := app.wrongCode(victim.ID)

	for i := 1; i <= service.MaxVerifyFailures-1; i++ {
		wantErrCode(t, app.confirmWith(t, victim.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
	}
	if secs := wantLocked(t, app.confirmWith(t, victim.ID, wrong)); secs != int(service.VerifyLockoutDuration/time.Second) {
		t.Fatalf("the answer that locks should report the full 15 minutes, got %ds", secs)
	}

	t.Run("locked for the right code on every endpoint", func(t *testing.T) {
		wantLocked(t, app.confirmWith(t, victim.ID, app.verifyCodes[victim.ID]))
		wantLocked(t, app.uploadSlip(t, victim.ID, "slip.jpg", uniqueSlip(81)))
		wantLocked(t, app.profileWith(t, victim.ID, app.verifyCodes[victim.ID]))
		wantLocked(t, app.withdrawRec(t, victim.ID, app.nationalIDs[victim.ID]))
		if _, err := app.applicant(t, victim.ID); err != nil {
			t.Fatalf("a locked withdraw must not remove the application: %v", err)
		}
	})

	t.Run("other applications are not affected", func(t *testing.T) {
		wantErrCode(t, app.confirmWith(t, other.ID, app.verifyCodes[other.ID]), http.StatusOK, "")
	})

	t.Run("audit rows for repeated failures and the lockout, without an admin", func(t *testing.T) {
		failures := app.auditFor(victim.ID, domain.AuditVerifyFailure)
		if len(failures) != service.MaxVerifyFailures-2 { // the 2nd, 3rd and 4th wrong answer
			t.Fatalf("expected %d failure rows, got %d", service.MaxVerifyFailures-2, len(failures))
		}
		lockouts := app.auditFor(victim.ID, domain.AuditVerifyLockout)
		if len(lockouts) != 1 {
			t.Fatalf("expected 1 lockout row, got %d", len(lockouts))
		}
		l := lockouts[0]
		if l.AdminID != nil || l.TargetType != domain.AuditTargetApplicant || l.IPAddress == "" {
			t.Fatalf("unexpected lockout row: %+v", l)
		}
		if l.Details["endpoint"] != service.VerifyActionConfirm || fmt.Sprint(l.Details["failures"]) != strconv.Itoa(service.MaxVerifyFailures) {
			t.Fatalf("unexpected lockout details: %+v", l.Details)
		}
		for _, e := range app.appRepo.Audit().Entries() {
			if strings.Contains(fmt.Sprint(e.Details), app.verifyCodes[victim.ID]) {
				t.Fatalf("an audit row must not contain the verify code: %+v", e)
			}
		}
	})

	t.Run("the lock expires after 15 minutes", func(t *testing.T) {
		app.clock.Advance(service.VerifyLockoutDuration - time.Minute)
		wantLocked(t, app.confirmWith(t, victim.ID, app.verifyCodes[victim.ID]))
		app.clock.Advance(time.Minute + time.Second)
		wantErrCode(t, app.confirmWith(t, victim.ID, app.verifyCodes[victim.ID]), http.StatusOK, "")
	})

	t.Run("after the lock the counter starts from zero", func(t *testing.T) {
		for i := 1; i <= service.MaxVerifyFailures-1; i++ {
			wantErrCode(t, app.confirmWith(t, victim.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
		}
	})
}

// The counter is per application and shared by confirm, slip upload, profile edit and withdraw,
// so spreading guesses over endpoints does not buy more of them.
func TestVerifyLockout_SharedAcrossEndpoints(t *testing.T) {
	app := setupRelaxedApp(t)
	a := app.submit(t, validTestNationalID(83), "0810000083", "lock3@example.com")
	wrong := app.wrongCode(a.ID)

	wantErrCode(t, app.confirmWith(t, a.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
	wantErrCode(t, app.uploadSlipWithCode(t, a.ID, wrong, "slip.jpg", uniqueSlip(83)), http.StatusForbidden, response.CodeInvalidVerifyCode)
	wantErrCode(t, app.profileWith(t, a.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
	wantErrCode(t, app.withdrawRec(t, a.ID, validTestNationalID(9083)), http.StatusForbidden, response.CodeInvalidVerifyCode)
	wantLocked(t, app.uploadSlipWithCode(t, a.ID, wrong, "slip.jpg", uniqueSlip(84)))

	lockouts := app.auditFor(a.ID, domain.AuditVerifyLockout)
	if len(lockouts) != 1 || lockouts[0].Details["endpoint"] != service.VerifyActionSlip {
		t.Fatalf("expected one lockout row from the slip endpoint, got %+v", lockouts)
	}
}

// A correct answer resets the counter, so a student who mistypes now and then is never locked.
func TestVerifyLockout_SuccessResetsTheCounter(t *testing.T) {
	app := setupRelaxedApp(t)
	a := app.submit(t, validTestNationalID(85), "0810000085", "lock5@example.com")
	wrong := app.wrongCode(a.ID)

	for round := 0; round < 3; round++ {
		for i := 1; i <= service.MaxVerifyFailures-1; i++ {
			wantErrCode(t, app.confirmWith(t, a.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
		}
		wantErrCode(t, app.confirmWith(t, a.ID, app.verifyCodes[a.ID]), http.StatusOK, "")
	}
	if n := len(app.auditFor(a.ID, domain.AuditVerifyLockout)); n != 0 {
		t.Fatalf("no lockout expected, got %d", n)
	}
}

// Failures older than the 15-minute window are forgotten.
func TestVerifyLockout_FailuresOutsideTheWindowDoNotAdd(t *testing.T) {
	app := setupRelaxedApp(t)
	a := app.submit(t, validTestNationalID(86), "0810000086", "lock6@example.com")
	wrong := app.wrongCode(a.ID)

	for i := 1; i <= service.MaxVerifyFailures-1; i++ {
		wantErrCode(t, app.confirmWith(t, a.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
	}
	app.clock.Advance(service.VerifyFailureWindow + time.Second)
	for i := 1; i <= service.MaxVerifyFailures-1; i++ {
		wantErrCode(t, app.confirmWith(t, a.ID, wrong), http.StatusForbidden, response.CodeInvalidVerifyCode)
	}
	wantLocked(t, app.confirmWith(t, a.ID, wrong))
}

// A missing or malformed code is a 400 and does not count: it cannot be a correct guess.
func TestVerifyLockout_MalformedCodesDoNotCount(t *testing.T) {
	app := setupRelaxedApp(t)
	a := app.submit(t, validTestNationalID(87), "0810000087", "lock7@example.com")
	for _, code := range []string{"", "12", "abcd", "123456", "12", "", "1", "99", "x", "0"} {
		wantErrCode(t, app.confirmWith(t, a.ID, code), http.StatusBadRequest, response.CodeValidation)
	}
	wantErrCode(t, app.confirmWith(t, a.ID, app.verifyCodes[a.ID]), http.StatusOK, "")
}

// Parallel guesses cannot get past the limit: the lock check, the compare and the count happen
// under one lock, so exactly MaxVerifyFailures answers are evaluated.
func TestVerifyLockout_ConcurrentGuessesStopAtTheLimit(t *testing.T) {
	app := setupRelaxedApp(t)
	a := app.submit(t, validTestNationalID(88), "0810000088", "lock8@example.com")
	wrong := app.wrongCode(a.ID)

	const n = 40
	var wg sync.WaitGroup
	codes := make(chan int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body := fmt.Sprintf(`{"confirmed":true,"verifyCode":%q}`, wrong)
			req := httptest.NewRequest(http.MethodPost, "/api/applications/"+a.ID+"/confirm", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			app.ServeHTTP(rec, req)
			codes <- rec.Code
		}()
	}
	wg.Wait()
	close(codes)
	count := map[int]int{}
	for c := range codes {
		count[c]++
	}
	if count[http.StatusForbidden] != service.MaxVerifyFailures-1 || count[http.StatusTooManyRequests] != n-(service.MaxVerifyFailures-1) {
		t.Fatalf("expected %d×403 and %d×429, got %v", service.MaxVerifyFailures-1, n-(service.MaxVerifyFailures-1), count)
	}
	if got := len(app.auditFor(a.ID, domain.AuditVerifyLockout)); got != 1 {
		t.Fatalf("expected exactly one lockout row, got %d", got)
	}
}

// /withdraw needs the full 13-digit national ID: 4 digits (the old verifyCode) are refused, a
// malformed ID is a 400 that does not count, formatting from a LINE paste is accepted, and wrong
// IDs lock the application like wrong verify codes do.
func TestWithdraw_RequiresTheFullNationalID(t *testing.T) {
	app := setupRelaxedApp(t)
	nid := validTestNationalID(89)
	a := app.submit(t, nid, "0810000089", "wd1@example.com")
	path := "/api/applications/" + a.ID + "/withdraw"

	t.Run("the old 4-digit verifyCode body is refused", func(t *testing.T) {
		rec := app.do(t, http.MethodPost, path, bytes.NewBufferString(fmt.Sprintf(`{"verifyCode":%q}`, app.verifyCodes[a.ID])), nil)
		wantErrCode(t, rec, http.StatusBadRequest, response.CodeValidation)
	})

	t.Run("malformed IDs are 400 and do not count", func(t *testing.T) {
		badChecksum := nid[:12] + string(rune('0'+(int(nid[12]-'0')+1)%10))
		for _, bad := range []string{app.verifyCodes[a.ID], nid[:12], nid + "0", badChecksum, "15099abc00890", ""} {
			wantErrCode(t, app.withdrawRec(t, a.ID, bad), http.StatusBadRequest, response.CodeValidation)
		}
		if n := len(app.auditFor(a.ID, domain.AuditVerifyFailure)) + len(app.auditFor(a.ID, domain.AuditVerifyLockout)); n != 0 {
			t.Fatalf("malformed IDs must not be counted, got %d audit rows", n)
		}
	})

	t.Run("five wrong IDs lock withdraw and the other endpoints", func(t *testing.T) {
		for i := 1; i <= service.MaxVerifyFailures-1; i++ {
			wantErrCode(t, app.withdrawRec(t, a.ID, validTestNationalID(9100+i)), http.StatusForbidden, response.CodeInvalidVerifyCode)
		}
		wantLocked(t, app.withdrawRec(t, a.ID, validTestNationalID(9100)))
		wantLocked(t, app.withdrawRec(t, a.ID, nid))
		wantLocked(t, app.confirmWith(t, a.ID, app.verifyCodes[a.ID]))
		if _, err := app.applicant(t, a.ID); err != nil {
			t.Fatalf("the application must still exist while locked: %v", err)
		}
		lockouts := app.auditFor(a.ID, domain.AuditVerifyLockout)
		if len(lockouts) != 1 || lockouts[0].Details["endpoint"] != service.VerifyActionWithdraw {
			t.Fatalf("expected one withdraw lockout row, got %+v", lockouts)
		}
		for _, e := range app.appRepo.Audit().Entries() {
			if strings.Contains(fmt.Sprint(e.Details), nid) {
				t.Fatalf("an audit row must not contain the national ID: %+v", e)
			}
		}
	})

	t.Run("after the lock, the right ID with dashes and zero-width characters withdraws", func(t *testing.T) {
		app.clock.Advance(service.VerifyLockoutDuration + time.Second)
		pasted := "\u200b" + nid[:1] + "-" + nid[1:5] + "-" + nid[5:10] + " " + nid[10:12] + "-" + nid[12:] + "\ufeff"
		wantErrCode(t, app.withdrawRec(t, a.ID, pasted), http.StatusOK, "")
		if _, err := app.applicant(t, a.ID); err == nil {
			t.Fatal("the application should be withdrawn")
		}
	})
}
