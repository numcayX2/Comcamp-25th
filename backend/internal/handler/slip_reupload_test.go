package handler_test

import (
	"net/http"
	"testing"

	"comcamp25-backend/internal/pkg/response"
)

// Staff reject a genuine slip by mistake and ask for it again: the same image must go through.
// A slip that is PENDING or APPROVED still blocks its image for everyone else.
func TestSlipHash_RejectedSlipCanBeSentAgain(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	mine := app.submit(t, validTestNationalID(85_001), "0885000001", "re1@example.com")
	other := app.submit(t, validTestNationalID(85_002), "0885000002", "re2@example.com")
	img := uniqueSlip(777)

	if rec := app.uploadSlip(t, mine.ID, "slip.jpg", img); rec.Code != http.StatusOK {
		t.Fatalf("first upload: %d %s", rec.Code, rec.Body.String())
	}
	// PENDING holds the image.
	wantErrCode(t, app.uploadSlip(t, other.ID, "slip.jpg", img), http.StatusConflict, response.CodeDuplicateSlip)

	if rec := app.verifyWithPaymentID(t, token, mine.ID, app.slipPaymentID(t, token, mine.ID), false); rec.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", rec.Code, rec.Body.String())
	}
	// REJECTED does not: the student sends the same bank slip again.
	if rec := app.uploadSlip(t, mine.ID, "slip.jpg", img); rec.Code != http.StatusOK {
		t.Fatalf("re-sending a rejected slip must be accepted, got %d %s", rec.Code, rec.Body.String())
	}
	wantErrCode(t, app.uploadSlip(t, other.ID, "slip.jpg", img), http.StatusConflict, response.CodeDuplicateSlip)

	if rec := app.verifyWithPaymentID(t, token, mine.ID, app.slipPaymentID(t, token, mine.ID), true); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	// APPROVED holds it for good.
	wantErrCode(t, app.uploadSlip(t, other.ID, "slip.jpg", img), http.StatusConflict, response.CodeDuplicateSlip)

	if got := len(app.paymentsOf(t, mine.ID)); got != 2 {
		t.Fatalf("the rejected slip stays in the ledger next to the approved one, have %d", got)
	}
}
