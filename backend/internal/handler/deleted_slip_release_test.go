package handler_test

import (
	"context"
	"net/http"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
)

// MEDIUM-04 case B: staff delete an application whose slip is PENDING, and another whose slip is
// APPROVED. Both students register again (same national ID, phone, email) and send the same bank
// slips: accepted, because a deleted application nobody can see in /admin no longer holds them.
func TestAdminDelete_ReleasesSlipImagesForReRegistration(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)
	ctx := context.Background()

	type student struct{ nid, phone, email string }
	pendingStudent := student{validTestNationalID(86_001), "0886000001", "del1@example.com"}
	approvedStudent := student{validTestNationalID(86_002), "0886000002", "del2@example.com"}
	pendingImg, approvedImg := uniqueSlip(881), uniqueSlip(882)

	first := app.submit(t, pendingStudent.nid, pendingStudent.phone, pendingStudent.email)
	second := app.submit(t, approvedStudent.nid, approvedStudent.phone, approvedStudent.email)
	if rec := app.uploadSlip(t, first.ID, "s.jpg", pendingImg); rec.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if rec := app.uploadSlip(t, second.ID, "s.jpg", approvedImg); rec.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if rec := app.verifyWithPaymentID(t, token, second.ID, app.slipPaymentID(t, token, second.ID), true); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d %s", rec.Code, rec.Body.String())
	}
	firstPays, secondPays := app.paymentsOf(t, first.ID), app.paymentsOf(t, second.ID)

	for _, id := range []string{first.ID, second.ID} {
		if rec := app.do(t, http.MethodDelete, "/api/admin/applications/"+id, nil, bearer(token)); rec.Code != http.StatusOK {
			t.Fatalf("delete %s: %d %s", id, rec.Code, rec.Body.String())
		}
	}

	// The ledger keeps both slips as they were.
	for _, c := range []struct {
		before []*domain.Payment
		want   domain.PaymentStatus
	}{{firstPays, domain.PaymentPending}, {secondPays, domain.PaymentApproved}} {
		if len(c.before) != 1 {
			t.Fatalf("want one slip before the delete, got %d", len(c.before))
		}
		got, err := app.payRepo.GetByID(ctx, c.before[0].ID)
		if err != nil || got.Status != c.want || got.SlipHash == nil || *got.SlipHash != *c.before[0].SlipHash {
			t.Fatalf("a deleted application's slip must keep status %s and its hash, got %+v (%v)", c.want, got, err)
		}
	}
	// Settling the deleted application is not possible (it is gone from /admin).
	wantCode(t, app.verifyWithPaymentID(t, token, first.ID, firstPays[0].ID.String(), true), http.StatusNotFound, "")

	again1 := app.submit(t, pendingStudent.nid, pendingStudent.phone, pendingStudent.email)
	again2 := app.submit(t, approvedStudent.nid, approvedStudent.phone, approvedStudent.email)
	if rec := app.uploadSlip(t, again1.ID, "s.jpg", pendingImg); rec.Code != http.StatusOK {
		t.Fatalf("re-registered student sending the slip of a deleted PENDING application: %d %s", rec.Code, rec.Body.String())
	}
	if rec := app.uploadSlip(t, again2.ID, "s.jpg", approvedImg); rec.Code != http.StatusOK {
		t.Fatalf("re-registered student sending the slip of a deleted APPROVED application: %d %s", rec.Code, rec.Body.String())
	}
	// The live slips hold the images again.
	wantErrCode(t, app.uploadSlip(t, again2.ID, "s.jpg", pendingImg), http.StatusConflict, response.CodeDuplicateSlip)
}
