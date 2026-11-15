package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func TestVerifySlip_RequiresValidPaymentID(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	psvc := service.NewPaymentService(pays, apps, memory.NewMemorySettingRepo(), apps.Audit(), t.TempDir())

	a := &domain.Applicant{
		ID:            uuid.New(),
		ApplicationNo: "CC25-AA1122",
		NationalID:    "1100500000018",
		FirstName:     "ทดสอบ",
		LastName:      "ระบบ",
		Nickname:      "สอบ",
		Phone:         "0812345678",
		Email:         "vslip@example.com",
		School:        "โรงเรียนทดสอบ",
		Grade:         "ม.5",
		Province:      "เชียงใหม่",
		ShirtSize:     "L",
		Status:        domain.StatusPassed,
	}
	if err := apps.CreateWithinCapacity(ctx, a, 30); err != nil {
		t.Fatal(err)
	}
	p1 := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a.ID,
		SlipURL:     "slips/test-1.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		UploadedAt:  time.Now().UTC().Add(-1 * time.Minute),
	}
	if _, err := pays.CreateReplacingPending(ctx, p1); err != nil {
		t.Fatal(err)
	}

	for _, approved := range []bool{true, false} {
		for _, bad := range []string{"", "   ", "not-a-uuid"} {
			var verr *service.ValidationError
			if err := psvc.VerifySlip(ctx, a.ApplicationNo, bad, approved, 1, "note", "127.0.0.1"); !errors.As(err, &verr) {
				t.Fatalf("approved=%v paymentID=%q: expected ValidationError, got %v", approved, bad, err)
			}
		}
	}

	if err := psvc.VerifySlip(ctx, a.ApplicationNo, uuid.NewString(), true, 1, "ok", "127.0.0.1"); !errors.Is(err, service.ErrSlipChanged) {
		t.Fatalf("unknown paymentID: expected ErrSlipChanged, got %v", err)
	}

	// Simulate applicant uploading a newer slip while reviewer still holds p1.ID.
	p2 := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a.ID,
		SlipURL:     "slips/test-2.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		UploadedAt:  time.Now().UTC(),
	}
	if _, err := pays.CreateReplacingPending(ctx, p2); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p1.ID.String(), true, 1, "ok", "127.0.0.1"); !errors.Is(err, service.ErrSlipChanged) {
		t.Fatalf("stale paymentID: expected ErrSlipChanged, got %v", err)
	}

	if err := psvc.VerifySlip(ctx, a.ApplicationNo, "  "+p2.ID.String()+"  ", true, 1, "ok", "127.0.0.1"); err != nil {
		t.Fatalf("valid paymentID: unexpected error %v", err)
	}
}
