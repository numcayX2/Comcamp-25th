package memory_test

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
)

func newTestApplicant(appNo, nationalID, phone, email string) *domain.Applicant {
	return &domain.Applicant{
		ID:               uuid.New(),
		ApplicationNo:    appNo,
		NationalID:       nationalID,
		FirstName:        "ทดสอบ",
		LastName:         "ระบบ",
		Nickname:         "เทส",
		BirthDate:        time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC),
		Gender:           "unspecified",
		School:           "โรงเรียนทดสอบ",
		Grade:            "ม.5",
		Phone:            phone,
		Email:            email,
		Province:         "เชียงใหม่",
		EmergencyContact: "ผู้ปกครอง",
		EmergencyPhone:   phone,
		ShirtSize:        "M",
		Status:           domain.StatusPending,
	}
}

func TestMemoryApplicantRepo_ParityAndConstraints(t *testing.T) {
	ctx := context.Background()
	setRepo := memory.NewMemorySettingRepo()
	appRepo := memory.NewMemoryApplicantRepo()
	appRepo.SetSettingRepo(setRepo)

	// Allow multiple applicants with empty email
	a1 := newTestApplicant("CC25-AAA001", "1111111111111", "0811111111", "")
	a2 := newTestApplicant("CC25-AAA002", "2222222222222", "0822222222", "")
	if err := appRepo.Create(ctx, a1); err != nil {
		t.Fatalf("failed to create a1 with blank email: %v", err)
	}
	if err := appRepo.Create(ctx, a2); err != nil {
		t.Fatalf("failed to create a2 with blank email: %v", err)
	}

	// Duplicate ApplicationNo (case-insensitive)
	dupAppNo := newTestApplicant("cc25-aaa001", "3333333333333", "0833333333", "a3@example.com")
	if err := appRepo.Create(ctx, dupAppNo); !errors.Is(err, domain.ErrDuplicateApplicationNo) {
		t.Errorf("expected ErrDuplicateApplicationNo, got %v", err)
	}

	// Duplicate NationalID / Phone / Email
	dupNID := newTestApplicant("CC25-AAA003", "1111111111111", "0833333333", "a3@example.com")
	if err := appRepo.Create(ctx, dupNID); !errors.Is(err, domain.ErrDuplicateApplicant) {
		t.Errorf("expected ErrDuplicateApplicant for nationalID, got %v", err)
	}
	dupPhone := newTestApplicant("CC25-AAA004", "4444444444444", "0822222222", "a4@example.com")
	if err := appRepo.Create(ctx, dupPhone); !errors.Is(err, domain.ErrDuplicateApplicant) {
		t.Errorf("expected ErrDuplicateApplicant for phone, got %v", err)
	}
	a3 := newTestApplicant("CC25-AAA005", "5555555555555", "0855555555", "Same@Example.com")
	if err := appRepo.Create(ctx, a3); err != nil {
		t.Fatalf("failed to create a3: %v", err)
	}
	dupEmail := newTestApplicant("CC25-AAA006", "6666666666666", "0866666666", "same@example.com")
	if err := appRepo.Create(ctx, dupEmail); !errors.Is(err, domain.ErrDuplicateApplicant) {
		t.Errorf("expected ErrDuplicateApplicant for case-insensitive email, got %v", err)
	}

	// FindByIDOrAppNo matches UUID & case-insensitive appNo, NOT nationalId or phone
	if got, err := appRepo.FindByIDOrAppNo(ctx, a1.ID.String()); err != nil || got.ID != a1.ID {
		t.Errorf("expected UUID lookup to succeed, got %v, %v", got, err)
	}
	if got, err := appRepo.FindByIDOrAppNo(ctx, strings.ToLower(a1.ApplicationNo)); err != nil || got.ID != a1.ID {
		t.Errorf("expected case-insensitive appNo lookup to succeed, got %v, %v", got, err)
	}
	if _, err := appRepo.FindByIDOrAppNo(ctx, a1.NationalID); !errors.Is(err, domain.ErrApplicantNotFound) {
		t.Errorf("expected FindByIDOrAppNo to reject nationalId, got %v", err)
	}
	if _, err := appRepo.FindByIDOrAppNo(ctx, a1.Phone); !errors.Is(err, domain.ErrApplicantNotFound) {
		t.Errorf("expected FindByIDOrAppNo to reject phone, got %v", err)
	}

	// FindByQuery matches appNo (case-insensitive), nationalId, phone
	if got, err := appRepo.FindByQuery(ctx, "cc25-aaa002"); err != nil || got.ID != a2.ID {
		t.Errorf("expected FindByQuery by lowercase appNo to succeed, got %v, %v", got, err)
	}
	if got, err := appRepo.FindByQuery(ctx, a2.Phone); err != nil || got.ID != a2.ID {
		t.Errorf("expected FindByQuery by phone to succeed, got %v, %v", got, err)
	}

	// UpdateStatus to CONFIRMED enforces capacity and sets AttendanceConfirmed=true
	_ = setRepo.Update(ctx, &domain.Settings{
		ID:                  1,
		CampName:            "ComCamp 25th",
		RegistrationOpenAt:  time.Now().Add(-time.Hour),
		RegistrationCloseAt: time.Now().Add(time.Hour),
		MaxCapacity:         1,
		CampFee:             decimal.NewFromInt(300),
	})
	if err := appRepo.UpdateStatus(ctx, a1.ID, domain.StatusConfirmed, nil, "confirmed 1"); err != nil {
		t.Fatalf("expected first confirm to succeed, got %v", err)
	}
	updatedA1, _ := appRepo.GetByID(ctx, a1.ID)
	if !updatedA1.AttendanceConfirmed {
		t.Errorf("expected AttendanceConfirmed=true on CONFIRMED status")
	}
	if err := appRepo.UpdateStatus(ctx, a2.ID, domain.StatusConfirmed, nil, "exceeds cap"); !errors.Is(err, domain.ErrQuotaExceeded) {
		t.Errorf("expected ErrQuotaExceeded on second CONFIRMED with maxCapacity=1, got %v", err)
	}

	// CountConfirmed & CountActive & ListAll
	if c, err := appRepo.CountConfirmed(ctx); err != nil || c != 1 {
		t.Errorf("expected CountConfirmed=1, got %d (%v)", c, err)
	}
	_ = appRepo.UpdateStatus(ctx, a3.ID, domain.StatusRejected, nil, "rejected")
	if c, err := appRepo.CountActive(ctx); err != nil || c != 2 {
		t.Errorf("expected CountActive=2 (excluding REJECTED), got %d (%v)", c, err)
	}
	confirmedStatus := domain.StatusConfirmed
	listConfirmed, err := appRepo.ListAll(ctx, &confirmedStatus)
	if err != nil || len(listConfirmed) != 1 || listConfirmed[0].ID != a1.ID {
		t.Errorf("expected 1 CONFIRMED applicant in ListAll, got %d (%v)", len(listConfirmed), err)
	}
}

func TestMemoryPaymentRepo_VerifyAtomicAndBatch(t *testing.T) {
	ctx := context.Background()
	setRepo := memory.NewMemorySettingRepo()
	appRepo := memory.NewMemoryApplicantRepo()
	appRepo.SetSettingRepo(setRepo)
	payRepo := memory.NewMemoryPaymentRepoWithSettings(appRepo, setRepo)

	_ = setRepo.Update(ctx, &domain.Settings{
		ID:                  1,
		CampName:            "ComCamp 25th",
		RegistrationOpenAt:  time.Now().Add(-time.Hour),
		RegistrationCloseAt: time.Now().Add(time.Hour),
		MaxCapacity:         1,
		CampFee:             decimal.NewFromInt(300),
	})

	a1 := newTestApplicant("CC25-PAY001", "7777777777771", "0877777771", "p1@example.com")
	a1.Status = domain.StatusPassed
	a2 := newTestApplicant("CC25-PAY002", "7777777777772", "0877777772", "p2@example.com")
	a2.Status = domain.StatusPassed
	_ = appRepo.Create(ctx, a1)
	_ = appRepo.Create(ctx, a2)

	h1 := "hash-1"
	p1 := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a1.ID,
		SlipURL:     "/uploads/slips/s1.jpg",
		Amount:      decimal.NewFromInt(300),
		Status:      domain.PaymentPending,
		SlipHash:    &h1,
	}
	if err := payRepo.Create(ctx, p1); err != nil {
		t.Fatalf("failed to create p1: %v", err)
	}

	// Duplicate slip hash
	pDup := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a2.ID,
		SlipURL:     "/uploads/slips/sdup.jpg",
		Amount:      decimal.NewFromInt(300),
		Status:      domain.PaymentPending,
		SlipHash:    &h1,
	}
	if err := payRepo.Create(ctx, pDup); !errors.Is(err, domain.ErrDuplicateSlip) {
		t.Errorf("expected ErrDuplicateSlip, got %v", err)
	}

	// Verify p1 with approved=false -> PaymentRejected, applicant stays PASSED
	if err := payRepo.Verify(ctx, p1.ID, false, 1, "blurry image"); err != nil {
		t.Fatalf("expected reject verify to succeed, got %v", err)
	}
	gotP1, _ := payRepo.GetByID(ctx, p1.ID)
	if gotP1.Status != domain.PaymentRejected || gotP1.RejectionReason == nil || *gotP1.RejectionReason != "blurry image" {
		t.Errorf("expected REJECTED payment with rejection reason, got %+v", gotP1)
	}
	gotA1, _ := appRepo.GetByID(ctx, a1.ID)
	if gotA1.Status != domain.StatusPassed {
		t.Errorf("expected applicant to remain PASSED on slip rejection, got %s", gotA1.Status)
	}

	// Re-verifying p1 must return ErrPaymentAlreadyVerified
	if err := payRepo.Verify(ctx, p1.ID, true, 1, "retry"); !errors.Is(err, domain.ErrPaymentAlreadyVerified) {
		t.Errorf("expected ErrPaymentAlreadyVerified, got %v", err)
	}

	// Upload new slip for a1 & a2 and test capacity enforcement
	h2 := "hash-2"
	p1Retry := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a1.ID,
		SlipURL:     "/uploads/slips/s1b.jpg",
		Amount:      decimal.NewFromInt(300),
		Status:      domain.PaymentPending,
		SlipHash:    &h2,
	}
	time.Sleep(2 * time.Millisecond) // Ensure newer UploadedAt
	_ = payRepo.Create(ctx, p1Retry)

	h3 := "hash-3"
	p2 := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: a2.ID,
		SlipURL:     "/uploads/slips/s2.jpg",
		Amount:      decimal.NewFromInt(300),
		Status:      domain.PaymentPending,
		SlipHash:    &h3,
	}
	_ = payRepo.Create(ctx, p2)

	// Approve a1 -> CONFIRMED
	if err := payRepo.Verify(ctx, p1Retry.ID, true, 1, "ok"); err != nil {
		t.Fatalf("expected p1Retry approval to succeed, got %v", err)
	}
	gotA1After, _ := appRepo.GetByID(ctx, a1.ID)
	if gotA1After.Status != domain.StatusConfirmed || !gotA1After.AttendanceConfirmed {
		t.Errorf("expected a1 CONFIRMED + attendanceConfirmed=true, got %s, %v", gotA1After.Status, gotA1After.AttendanceConfirmed)
	}

	// Approve a2 -> ErrQuotaExceeded because MaxCapacity=1
	if err := payRepo.Verify(ctx, p2.ID, true, 1, "over cap"); !errors.Is(err, domain.ErrQuotaExceeded) {
		t.Errorf("expected ErrQuotaExceeded when capacity full, got %v", err)
	}

	// Batch GetLatestByApplicantIDs
	latestMap, err := payRepo.GetLatestByApplicantIDs(ctx, []uuid.UUID{a1.ID, a2.ID})
	if err != nil {
		t.Fatalf("GetLatestByApplicantIDs failed: %v", err)
	}
	if latestMap[a1.ID] == nil || latestMap[a1.ID].ID != p1Retry.ID {
		t.Errorf("expected latest payment for a1 to be p1Retry")
	}
	if latestMap[a2.ID] == nil || latestMap[a2.ID].ID != p2.ID {
		t.Errorf("expected latest payment for a2 to be p2")
	}
}

func TestMemoryAdminRepo(t *testing.T) {
	ctx := context.Background()
	admRepo := memory.NewMemoryAdminRepo()

	if c, err := admRepo.Count(ctx); err != nil || c != 0 {
		t.Fatalf("expected count 0, got %d (%v)", c, err)
	}
	a := &domain.Admin{
		Username:     "admin",
		PasswordHash: "hash",
		FullName:     "Admin",
		IsActive:     true,
	}
	if err := admRepo.Create(ctx, a); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if a.Role != domain.RoleAdmin {
		t.Errorf("expected default RoleAdmin, got %q", a.Role)
	}
	if err := admRepo.Create(ctx, &domain.Admin{Username: "admin"}); !errors.Is(err, domain.ErrDuplicateAdmin) {
		t.Errorf("expected ErrDuplicateAdmin, got %v", err)
	}
	if c, err := admRepo.Count(ctx); err != nil || c != 1 {
		t.Errorf("expected count 1, got %d (%v)", c, err)
	}
	if err := admRepo.UpdateLastLogin(ctx, a.ID); err != nil {
		t.Errorf("UpdateLastLogin failed: %v", err)
	}
	fetched, err := admRepo.GetByID(ctx, a.ID)
	if err != nil || fetched.LastLoginAt == nil {
		t.Errorf("expected LastLoginAt to be populated, got %v (%v)", fetched, err)
	}
}
