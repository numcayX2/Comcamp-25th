package service_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

// Regression tests for the pre-launch audit (fable_report.md, "Important" 1, 3 and 4). They run on
// the in-memory repositories; the PostgreSQL twins are covered by the integration suite.

func auditApplicant(t *testing.T, apps *memory.MemoryApplicantRepo, idx int, status domain.ApplicationStatus) *domain.Applicant {
	t.Helper()
	a := &domain.Applicant{
		ID:            uuid.New(),
		ApplicationNo: fmt.Sprintf("CC25-AD%04X", idx),
		NationalID:    validTestNationalID(900 + idx),
		FirstName:     "ทดสอบ",
		LastName:      "ระบบ",
		Nickname:      "ทด",
		Phone:         fmt.Sprintf("08200%05d", idx),
		Email:         fmt.Sprintf("audit%d@example.com", idx),
		School:        "โรงเรียนทดสอบ",
		Grade:         "ม.5",
		Province:      "เชียงใหม่",
		ShirtSize:     "M",
		Status:        status,
	}
	if err := apps.CreateWithinCapacity(context.Background(), a, 30); err != nil {
		t.Fatal(err)
	}
	return a
}

// Answering "will you attend" or editing one's own profile is not a payment: it must not extend the
// 24h grace that keeps an unpaid seat from being released.
func TestUnpaidExpiry_NotExtendedBySelfServiceActivity(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	svc := service.NewApplicantService(apps, memory.NewMemorySettingRepo(), pays).WithAudit(apps.Audit())

	control := auditApplicant(t, apps, 1, domain.StatusPassed)
	confirmer := auditApplicant(t, apps, 2, domain.StatusPassed)
	editor := auditApplicant(t, apps, 3, domain.StatusPassed)
	old := time.Now().UTC().Add(-100 * time.Hour)
	for _, a := range []*domain.Applicant{control, confirmer, editor} {
		if err := apps.SetTimestampsForTest(a.ID, old, old); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := svc.ConfirmAttendance(ctx, confirmer.ApplicationNo, confirmer.NationalID[9:], true); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if _, err := svc.UpdateOwnProfile(ctx, editor.ApplicationNo, service.SelfProfileRequest{
		VerifyCode: editor.NationalID[9:], Nickname: "ชื่อใหม่", School: editor.School,
		Province: editor.Province, Grade: editor.Grade, ShirtSize: editor.ShirtSize,
	}, "127.0.0.1"); err != nil {
		t.Fatalf("self profile edit: %v", err)
	}

	expired, err := svc.ExpireOverdueUnpaid(ctx, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, id := range expired {
		got[id] = true
	}
	for _, a := range []*domain.Applicant{control, confirmer, editor} {
		if !got[a.ApplicationNo] {
			t.Errorf("%s was not expired: self-service activity must not grant the 24h grace (expired=%v)", a.ApplicationNo, expired)
		}
	}
}

// Staff actions do count: a seat restored or edited by staff keeps its 24h grace.
func TestUnpaidExpiry_StaffEditKeepsGrace(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	svc := service.NewApplicantService(apps, memory.NewMemorySettingRepo(), pays).WithAudit(apps.Audit())

	a := auditApplicant(t, apps, 4, domain.StatusPassed)
	old := time.Now().UTC().Add(-100 * time.Hour)
	if err := apps.SetTimestampsForTest(a.ID, old, old); err != nil {
		t.Fatal(err)
	}
	nick := "แก้โดยพี่ค่าย"
	adminID := int64(1)
	if _, err := svc.AdminUpdateProfile(ctx, a.ApplicationNo, service.AdminProfileRequest{Nickname: &nick}, &adminID, "127.0.0.1"); err != nil {
		t.Fatalf("admin edit: %v", err)
	}
	expired, err := svc.ExpireOverdueUnpaid(ctx, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(expired) != 0 {
		t.Errorf("a seat edited by staff just now must keep its grace, got expired=%v", expired)
	}
}

// Rejecting the first slip of a seat that staff confirmed by hand (for example cash) keeps it
// confirmed; taking back an approved slip still demotes it, because that slip confirmed the seat.
func TestVerifySlip_RejectKeepsHandConfirmedSeat(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	psvc := service.NewPaymentService(pays, apps, memory.NewMemorySettingRepo(), apps.Audit(), t.TempDir())

	a := auditApplicant(t, apps, 5, domain.StatusConfirmed)
	p := &domain.Payment{ID: uuid.New(), ApplicantID: a.ID, SlipURL: "slips/a.jpg", Amount: decimal.NewFromInt(1200), Status: domain.PaymentPending}
	if _, err := pays.CreateReplacingPending(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), false, 1, "รูปไม่ชัด", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	got, _ := apps.GetByID(ctx, a.ID)
	if got.Status != domain.StatusConfirmed {
		t.Errorf("hand-confirmed seat must stay CONFIRMED after its first slip is rejected, got %s", got.Status)
	}

	// An approved slip that is later taken back demotes the seat it had confirmed.
	b := auditApplicant(t, apps, 6, domain.StatusPassed)
	q := &domain.Payment{ID: uuid.New(), ApplicantID: b.ID, SlipURL: "slips/b.jpg", Amount: decimal.NewFromInt(1200), Status: domain.PaymentPending}
	if _, err := pays.CreateReplacingPending(ctx, q); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, b.ApplicationNo, q.ID.String(), true, 1, "ยอดถูกต้อง", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, b.ApplicationNo, q.ID.String(), false, 1, "พบว่าสลิปปลอม", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	gotB, _ := apps.GetByID(ctx, b.ID)
	if gotB.Status != domain.StatusPassed {
		t.Errorf("taking back an approved slip must return the seat to PASSED, got %s", gotB.Status)
	}
}

// A slip is only stored for an application that still holds a seat to pay for.
func TestCreateReplacingPending_RefusesClosedApplication(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)

	for i, st := range []domain.ApplicationStatus{domain.StatusRejected, domain.StatusRefundPending, domain.StatusRefunded} {
		a := auditApplicant(t, apps, 10+i, st)
		p := &domain.Payment{ID: uuid.New(), ApplicantID: a.ID, SlipURL: "slips/c.jpg", Amount: decimal.NewFromInt(1200), Status: domain.PaymentPending}
		if _, err := pays.CreateReplacingPending(ctx, p); err == nil {
			t.Errorf("status %s: a slip must not be stored for an application that left the camp", st)
		}
	}
	live := auditApplicant(t, apps, 20, domain.StatusPassed)
	p := &domain.Payment{ID: uuid.New(), ApplicantID: live.ID, SlipURL: "slips/d.jpg", Amount: decimal.NewFromInt(1200), Status: domain.PaymentPending}
	if _, err := pays.CreateReplacingPending(ctx, p); err != nil {
		t.Errorf("a PASSED application must still accept its slip: %v", err)
	}
}
