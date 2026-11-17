package service_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

type capturedMail struct {
	addr string
	from string
	to   string
	raw  string
}

func TestAsyncMailer_RegistrationStageAndReplay(t *testing.T) {
	ctx := context.Background()
	svc, appRepo, _ := setupTestServices()

	var mu sync.Mutex
	var sent []capturedMail

	mailer := service.NewAsyncSMTPMailer(service.SMTPConfig{
		From:        "ComCamp #25 <noreply@comcamp.csmju.com>",
		FrontendURL: "https://comcamp.csmju.com/",
		Pace:        -1,
		SendTimeout: 2 * time.Second,
		SendFn: func(_ context.Context, addr, from, to string, raw []byte) error {
			mu.Lock()
			sent = append(sent, capturedMail{addr: addr, from: from, to: to, raw: string(raw)})
			mu.Unlock()
			return nil
		},
	}, appRepo.Audit())
	svc.WithMailer(mailer)

	req := service.ApplicationCreateRequest{
		FullName:   "สมชาย ใจดี",
		Nickname:   "ชาย",
		NationalID: validTestNationalID(901),
		Phone:      "0812345678",
		Email:      "somchai@example.com",
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "XL",
		Motivation: "อยากทดลองทำโปรเจกต์ IoT",
	}
	idemKey := uuid.NewString()

	res, replayed, err := svc.SubmitWithKey(ctx, req, idemKey)
	if err != nil || replayed {
		t.Fatalf("first SubmitWithKey = (%v, %v), want fresh success", replayed, err)
	}

	resReplay, replayed2, err := svc.SubmitWithKey(ctx, req, idemKey)
	if err != nil || !replayed2 || resReplay.ID != res.ID {
		t.Fatalf("replay SubmitWithKey = (%v, %v, %v), want replayed=%s", resReplay, replayed2, err, res.ID)
	}

	if err := mailer.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("expected exactly 1 email across initial submit + idempotent replay, got %d", len(sent))
	}
	m := sent[0]
	if m.from != "noreply@comcamp.csmju.com" || m.to != "somchai@example.com" {
		t.Fatalf("unexpected envelope from=%q to=%q", m.from, m.to)
	}
	for _, want := range []string{
		res.ID,
		"1,200",
		"587-0-84106-0",
		"https://comcamp.csmju.com/status?q=" + res.ID,
		"เรือนพักสมาคมศิษย์เก่าแม่โจ้",
		"080-993-8214",
		"063-784-4515",
	} {
		if !strings.Contains(m.raw, want) {
			t.Errorf("registration email missing %q", want)
		}
	}

	entries := appRepo.Audit().Entries()
	found := false
	for _, e := range entries {
		if e.Action == domain.AuditEmailRegistrationSent && e.TargetID == res.ID {
			found = true
			if got := e.Details["maskedEmail"]; got != service.MaskEmail("somchai@example.com") {
				t.Fatalf("maskedEmail = %v, want %q", got, service.MaskEmail("somchai@example.com"))
			}
			if strings.Contains(strings.ToLower(e.Details["maskedEmail"].(string)), "somchai@") {
				t.Fatalf("raw email leaked into audit details: %+v", e.Details)
			}
		}
	}
	if !found {
		t.Fatalf("expected %s audit entry for %s", domain.AuditEmailRegistrationSent, res.ID)
	}
}

func TestAsyncMailer_ConfirmedStageAndSkipOnRejectOrDuplicateNoteEdit(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	pays := memory.NewMemoryPaymentRepo(apps)
	psvc := service.NewPaymentService(pays, apps, memory.NewMemorySettingRepo(), apps.Audit(), t.TempDir())

	var mu sync.Mutex
	var sent []capturedMail
	mailer := service.NewAsyncSMTPMailer(service.SMTPConfig{
		From:        "noreply@comcamp.csmju.com",
		FrontendURL: "https://comcamp.csmju.com",
		Pace:        -1,
		SendTimeout: 2 * time.Second,
		SendFn: func(_ context.Context, addr, from, to string, raw []byte) error {
			mu.Lock()
			sent = append(sent, capturedMail{addr: addr, from: from, to: to, raw: string(raw)})
			mu.Unlock()
			return nil
		},
	}, apps.Audit())
	psvc.WithMailer(mailer)

	a := &domain.Applicant{
		ID:            uuid.New(),
		ApplicationNo: "CC25-900902",
		NationalID:    validTestNationalID(902),
		FirstName:     "มานี",
		LastName:      "มีใจ",
		Nickname:      "นี",
		Phone:         "0898765432",
		Email:         "manee@example.com",
		School:        "โรงเรียนยุพราช",
		Grade:         "ม.6",
		Province:      "เชียงใหม่",
		ShirtSize:     "2XL",
		Status:        domain.StatusPassed,
	}
	if err := apps.CreateWithinCapacity(ctx, a, 30); err != nil {
		t.Fatal(err)
	}
	p := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a.ID,
		SlipURL:     "slips/confirm-test.jpg",
		Amount:      decimal.NewFromInt(1200),
		Status:      domain.PaymentPending,
		UploadedAt:  time.Now().UTC(),
	}
	if _, err := pays.CreateReplacingPending(ctx, p); err != nil {
		t.Fatal(err)
	}

	// Rejecting a slip must NOT send a CONFIRMED email.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), false, 1, "ภาพไม่ชัด", "127.0.0.1"); err != nil {
		t.Fatalf("reject VerifySlip: %v", err)
	}
	// Approving the previously rejected slip transitions into CONFIRMED -> sends email once.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 1, "ตรวจสอบผ่าน", "127.0.0.1"); err != nil {
		t.Fatalf("approve VerifySlip: %v", err)
	}
	// Updating note on an already-approved slip must NOT send a duplicate CONFIRMED email.
	if err := psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 1, "บันทึกเพิ่มเติม", "127.0.0.1"); err != nil {
		t.Fatalf("note-update VerifySlip: %v", err)
	}

	if err := mailer.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 {
		t.Fatalf("expected exactly 1 CONFIRMED email, got %d", len(sent))
	}
	body := sent[0].raw
	for _, want := range []string{
		a.ApplicationNo,
		"เรือนพักสมาคมศิษย์เก่าแม่โจ้",
		"https://maps.app.goo.gl/oKP6J7gn3VXLXn7z7",
		"https://line.me/ti/g2/",
		"2XL",
		"080-993-8214",
		"063-784-4515",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("confirmed email missing %q", want)
		}
	}

	entries := apps.Audit().Entries()
	found := false
	for _, e := range entries {
		if e.Action == domain.AuditEmailConfirmedSent && e.TargetID == a.ApplicationNo {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected %s audit entry for %s", domain.AuditEmailConfirmedSent, a.ApplicationNo)
	}
}

func TestAsyncMailer_FailureAuditAndPanicRecovery(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()

	attempts := 0
	mailer := service.NewAsyncSMTPMailer(service.SMTPConfig{
		From:        "noreply@comcamp.csmju.com",
		FrontendURL: "https://comcamp.csmju.com",
		Pace:        -1,
		SendTimeout: 2 * time.Second,
		SendFn: func(_ context.Context, _, _, _ string, _ []byte) error {
			attempts++
			if attempts == 1 {
				panic("simulated SMTP driver panic")
			}
			return errors.New("smtp 550 relay access denied")
		},
	}, apps.Audit())

	// First job panics inside SendFn; worker must recover and continue to the second job.
	mailer.EnqueueRegistration(service.RegistrationEmailData{
		ApplicationNo: "CC25-PANIC1",
		FullName:      "ทดสอบ แพนิก",
		Nickname:      "แพน",
		Email:         "panic@example.com",
		CampFee:       "1,200",
	})
	mailer.EnqueueConfirmed(service.ConfirmedEmailData{
		ApplicationNo: "CC25-FAIL02",
		FullName:      "ทดสอบ ล้มเหลว",
		Nickname:      "เฟล",
		Email:         "fail@example.com",
		ShirtSize:     "L",
	})

	if err := mailer.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("expected worker to recover after panic and deliver second job (attempts=%d)", attempts)
	}

	entries := apps.Audit().Entries()
	foundFail := false
	for _, e := range entries {
		if e.Action == domain.AuditEmailConfirmedFailed && e.TargetID == "CC25-FAIL02" {
			foundFail = true
			if got := e.Details["error"]; got == nil || !strings.Contains(got.(string), "relay access denied") {
				t.Fatalf("expected failure reason in audit details, got %+v", e.Details)
			}
		}
	}
	if !foundFail {
		t.Fatalf("expected %s audit entry after failed send", domain.AuditEmailConfirmedFailed)
	}
}

func TestAsyncMailer_DisabledWhenHostEmpty(t *testing.T) {
	apps := memory.NewMemoryApplicantRepo()
	mailer := service.NewAsyncSMTPMailer(service.SMTPConfig{Host: ""}, apps.Audit())
	mailer.EnqueueRegistration(service.RegistrationEmailData{
		ApplicationNo: "CC25-NOOP01",
		FullName:      "ทดสอบ ปิดส่ง",
		Nickname:      "โน",
		Email:         "noop@example.com",
		CampFee:       "1,200",
	})
	mailer.EnqueueConfirmed(service.ConfirmedEmailData{
		ApplicationNo: "CC25-NOOP01",
		FullName:      "ทดสอบ ปิดส่ง",
		Nickname:      "โน",
		Email:         "noop@example.com",
		ShirtSize:     "M",
	})
	if err := mailer.Shutdown(context.Background()); err != nil {
		t.Fatalf("disabled mailer Shutdown returned error: %v", err)
	}
	if len(apps.Audit().Entries()) != 0 {
		t.Fatalf("disabled mailer should not write audit entries")
	}
}
