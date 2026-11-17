package service_test

import (
	"context"
	"errors"
	"strings"
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

func TestVerifySlip_ReverifyApprovedAndRejected(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	psvc := service.NewPaymentService(pays, apps, memory.NewMemorySettingRepo(), apps.Audit(), t.TempDir())

	a := &domain.Applicant{
		ID:            uuid.New(),
		ApplicationNo: "CC25-BB2233",
		FirstName:     "ทดสอบ",
		LastName:      "ตรวจซ้ำ",
		Nickname:      "ซ้ำ",
		Phone:         "0812345679",
		Email:         "reverify@example.com",
		School:        "โรงเรียนทดสอบ",
		Grade:         "ม.5",
		Province:      "เชียงใหม่",
		ShirtSize:     "M",
		Status:        domain.StatusPassed,
	}
	other := &domain.Applicant{
		ID:            uuid.New(),
		ApplicationNo: "CC25-BB2234",
		FirstName:     "ทดสอบ",
		LastName:      "อีกคน",
		Nickname:      "อีก",
		Phone:         "0812345680",
		Email:         "other-reverify@example.com",
		School:        "โรงเรียนทดสอบ",
		Grade:         "ม.5",
		Province:      "เชียงใหม่",
		ShirtSize:     "L",
		Status:        domain.StatusPassed,
	}
	for _, app := range []*domain.Applicant{a, other} {
		if err := apps.CreateWithinCapacity(ctx, app, 30); err != nil {
			t.Fatal(err)
		}
	}

	slipHash := strings.Repeat("a", 64)
	p := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a.ID,
		SlipURL:     "slips/reverify-1.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		SlipHash:    &slipHash,
	}
	if _, err := pays.CreateReplacingPending(ctx, p); err != nil {
		t.Fatal(err)
	}

	// 1. PENDING -> APPROVED (applicant: PASSED -> CONFIRMED, hash held).
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 1, "ok", "127.0.0.1"); err != nil {
		t.Fatalf("initial approve failed: %v", err)
	}
	gotApp, _ := apps.GetByID(ctx, a.ID)
	gotPay, _ := pays.GetByID(ctx, p.ID)
	if gotApp.Status != domain.StatusConfirmed || !gotApp.AttendanceConfirmed || gotPay.Status != domain.PaymentApproved {
		t.Fatalf("after approve: status=%s attendance=%v payment=%s, want CONFIRMED/true/APPROVED", gotApp.Status, gotApp.AttendanceConfirmed, gotPay.Status)
	}
	if dup, _ := pays.CheckDuplicateSlipHash(ctx, slipHash); !dup {
		t.Fatal("approved slip must hold its hash")
	}

	// Exact no-op re-submission must still be rejected as ErrSlipAlreadyVerified.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 1, "ok", "127.0.0.1"); !errors.Is(err, service.ErrSlipAlreadyVerified) {
		t.Fatalf("no-op re-verify: expected ErrSlipAlreadyVerified, got %v", err)
	}

	// Updating note only on APPROVED slip succeeds without emitting a redundant status log.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 2, "verified ref 123", "127.0.0.1"); err != nil {
		t.Fatalf("update note on approved slip failed: %v", err)
	}
	gotPay, _ = pays.GetByID(ctx, p.ID)
	if gotPay.AdminNote == nil || *gotPay.AdminNote != "verified ref 123" || gotPay.RejectionReason != nil {
		t.Fatalf("after note update: note=%v reason=%v", gotPay.AdminNote, gotPay.RejectionReason)
	}

	// 2. APPROVED -> REJECTED (applicant: CONFIRMED -> PASSED, hash released).
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), false, 2, "blurry slip", "127.0.0.1"); err != nil {
		t.Fatalf("reverify APPROVED -> REJECTED failed: %v", err)
	}
	gotApp, _ = apps.GetByID(ctx, a.ID)
	gotPay, _ = pays.GetByID(ctx, p.ID)
	if gotApp.Status != domain.StatusPassed || gotPay.Status != domain.PaymentRejected {
		t.Fatalf("after reject: status=%s payment=%s, want PASSED/REJECTED", gotApp.Status, gotPay.Status)
	}
	if gotPay.RejectionReason == nil || *gotPay.RejectionReason != "blurry slip" {
		t.Fatalf("expected rejection reason to be set, got %v", gotPay.RejectionReason)
	}
	if dup, _ := pays.CheckDuplicateSlipHash(ctx, slipHash); dup {
		t.Fatal("rejected slip must release its hash")
	}

	// Updating rejection note on REJECTED slip succeeds and does not disturb status or hash release.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), false, 2, "wrong amount", "127.0.0.1"); err != nil {
		t.Fatalf("update note on rejected slip failed: %v", err)
	}
	gotPay, _ = pays.GetByID(ctx, p.ID)
	if gotPay.AdminNote == nil || *gotPay.AdminNote != "wrong amount" || gotPay.RejectionReason == nil || *gotPay.RejectionReason != "wrong amount" {
		t.Fatalf("after rejection note update: note=%v reason=%v", gotPay.AdminNote, gotPay.RejectionReason)
	}

	// While hash is released, another applicant claims it; re-approving p must fail with ErrDuplicateSlip.
	otherPay := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: other.ID,
		SlipURL:     "slips/other.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		SlipHash:    &slipHash,
	}
	if _, err := pays.CreateReplacingPending(ctx, otherPay); err != nil {
		t.Fatalf("other applicant claiming released hash failed: %v", err)
	}
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 3, "try re-approve", "127.0.0.1"); !errors.Is(err, service.ErrDuplicateSlip) {
		t.Fatalf("re-approving while hash held elsewhere: expected ErrDuplicateSlip, got %v", err)
	}
	gotApp, _ = apps.GetByID(ctx, a.ID)
	gotPay, _ = pays.GetByID(ctx, p.ID)
	if gotApp.Status != domain.StatusPassed || gotPay.Status != domain.PaymentRejected {
		t.Fatalf("failed re-approve must not mutate state: status=%s payment=%s", gotApp.Status, gotPay.Status)
	}

	// Reject other applicant's slip to release the hash again.
	if err := psvc.VerifySlip(ctx, other.ApplicationNo, otherPay.ID.String(), false, 3, "release hash", "127.0.0.1"); err != nil {
		t.Fatalf("rejecting other slip failed: %v", err)
	}

	// 3. REJECTED -> APPROVED (applicant: PASSED -> CONFIRMED, hash re-acquired).
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 3, "re-approved ok", "127.0.0.1"); err != nil {
		t.Fatalf("reverify REJECTED -> APPROVED failed: %v", err)
	}
	gotApp, _ = apps.GetByID(ctx, a.ID)
	gotPay, _ = pays.GetByID(ctx, p.ID)
	if gotApp.Status != domain.StatusConfirmed || gotPay.Status != domain.PaymentApproved {
		t.Fatalf("after re-approve: status=%s payment=%s, want CONFIRMED/APPROVED", gotApp.Status, gotPay.Status)
	}
	if gotPay.RejectionReason != nil || gotPay.AdminNote == nil || *gotPay.AdminNote != "re-approved ok" {
		t.Fatalf("after re-approve: note=%v reason=%v", gotPay.AdminNote, gotPay.RejectionReason)
	}
	if dup, _ := pays.CheckDuplicateSlipHash(ctx, slipHash); !dup {
		t.Fatal("re-approved slip must re-acquire its hash")
	}
	if _, err := pays.CreateReplacingPending(ctx, &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: other.ID,
		SlipURL:     "slips/other-2.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
		SlipHash:    &slipHash,
	}); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("expected ErrDuplicateSlipHash after re-acquisition, got %v", err)
	}

	// Verify exact applicant status transitions: PASSED -> CONFIRMED -> PASSED -> CONFIRMED.
	var transitions []string
	for _, l := range apps.StatusLogs() {
		if l.ApplicantID == a.ID {
			transitions = append(transitions, string(l.OldStatus)+"->"+string(l.NewStatus))
		}
	}
	wantTransitions := []string{"PASSED->CONFIRMED", "CONFIRMED->PASSED", "PASSED->CONFIRMED"}
	if len(transitions) != len(wantTransitions) {
		t.Fatalf("status transitions = %v, want %v", transitions, wantTransitions)
	}
	for i := range wantTransitions {
		if transitions[i] != wantTransitions[i] {
			t.Fatalf("transition %d = %s, want %s (all: %v)", i, transitions[i], wantTransitions[i], transitions)
		}
	}

	// Verify audit trail records previousSlipStatus on re-verifications.
	var reverifyAudits []domain.AuditEntry
	for _, e := range apps.Audit().Entries() {
		if e.Action == domain.AuditSlipVerify && e.TargetID == a.ApplicationNo {
			reverifyAudits = append(reverifyAudits, e)
		}
	}
	if len(reverifyAudits) != 5 {
		t.Fatalf("expected 5 verify audit entries for %s, got %d", a.ApplicationNo, len(reverifyAudits))
	}
	if reverifyAudits[1].Details["previousSlipStatus"] != domain.PaymentApproved ||
		reverifyAudits[2].Details["previousSlipStatus"] != domain.PaymentApproved ||
		reverifyAudits[3].Details["previousSlipStatus"] != domain.PaymentRejected ||
		reverifyAudits[4].Details["previousSlipStatus"] != domain.PaymentRejected {
		t.Fatalf("unexpected previousSlipStatus audit trail: %+v", reverifyAudits)
	}

	// Superseded slip cannot be re-verified once a newer slip is uploaded.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), false, 4, "reject before replace", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	newer := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a.ID,
		SlipURL:     "slips/reverify-2.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
	}
	if _, err := pays.CreateReplacingPending(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 4, "stale", "127.0.0.1"); !errors.Is(err, service.ErrSlipChanged) {
		t.Fatalf("stale slip reverify: expected ErrSlipChanged, got %v", err)
	}

	// Inactive/refunded applicant cannot have its reviewed slip re-verified.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, newer.ID.String(), true, 4, "ok", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	adminID := int64(4)
	if err := apps.UpdateStatus(ctx, a.ID, domain.StatusRefunded, &adminID, "refund", nil); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, newer.ID.String(), false, 4, "late reject", "127.0.0.1"); !errors.Is(err, service.ErrSlipLocked) {
		t.Fatalf("refunded applicant reverify: expected ErrSlipLocked, got %v", err)
	}
}

func TestGetPublicSettings_IncludesRegistrationCloseAt(t *testing.T) {
	ctx := context.Background()
	setRepo := memory.NewMemorySettingRepo()
	appRepo := memory.NewMemoryApplicantRepo()
	svc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())

	stored, err := setRepo.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := svc.GetPublicSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := stored.RegistrationCloseAt.Format(time.RFC3339)
	if pub.RegistrationCloseAt != want {
		t.Fatalf("RegistrationCloseAt = %q, want %q", pub.RegistrationCloseAt, want)
	}
}
