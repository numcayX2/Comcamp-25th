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

func setupTestServices() (*service.ApplicantService, *memory.MemoryApplicantRepo, *memory.MemorySettingRepo, *memory.MemoryPaymentRepo) {
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	appRepo.SetSettingRepo(setRepo)
	payRepo := memory.NewMemoryPaymentRepoWithSettings(appRepo, setRepo)
	svc := service.NewApplicantService(appRepo, setRepo, payRepo)
	return svc, appRepo, setRepo, payRepo
}

func TestApplicantService_Submit_SuccessAndOptionalBlankEmail(t *testing.T) {
	svc, _, _, _ := setupTestServices()
	ctx := context.Background()

	// Two applicants with blank email should both succeed
	req1 := service.ApplicationCreateRequest{
		FullName:   "สมชาย ใจดี",
		Nickname:   "ชาย",
		NationalID: "1509900000000",
		Phone:      "0812345678",
		Email:      "",
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "L",
		Motivation: "อยากเรียนรู้ IoT และเขียนโปรแกรม Arduino",
	}
	res1, err := svc.Submit(ctx, req1)
	if err != nil {
		t.Fatalf("unexpected error for first blank email: %v", err)
	}
	if res1.ID == "" || res1.Status != domain.StatusPending {
		t.Fatalf("unexpected res1: %+v", res1)
	}
	if res1.Province != "เชียงใหม่" {
		t.Errorf("expected default province 'เชียงใหม่', got %q", res1.Province)
	}

	req2 := service.ApplicationCreateRequest{
		FullName:   "สมหญิง จริงใจ",
		Nickname:   "หญิง",
		NationalID: "1509900000001",
		Phone:      "0812345679",
		Email:      "   ",
		School:     "โรงเรียนสันทรายวิทยาคม",
		Grade:      "ปวช.2",
		ShirtSize:  "m",
		Province:   "ลำพูน",
	}
	res2, err := svc.Submit(ctx, req2)
	if err != nil {
		t.Fatalf("unexpected error for second blank email: %v", err)
	}
	if res2.ShirtSize != "M" || res2.Province != "ลำพูน" {
		t.Errorf("unexpected normalized fields on res2: %+v", res2)
	}
}

func TestApplicantService_Submit_ValidationAndDuplicateErrors(t *testing.T) {
	svc, _, _, _ := setupTestServices()
	ctx := context.Background()

	_, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:   "ต้นแบบ ทดสอบ",
		Nickname:   "ต้น",
		NationalID: "1509900000010",
		Phone:      "0811111110",
		Email:      "seed@example.com",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.4",
		ShirtSize:  "M",
	})
	if err != nil {
		t.Fatalf("seed submit failed: %v", err)
	}

	tests := []struct {
		name        string
		req         service.ApplicationCreateRequest
		expectedErr error
	}{
		{
			name: "National ID too short",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: "12345",
				Phone:      "0812345678",
				Email:      "ying@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidNationalID,
		},
		{
			name: "Invalid phone format",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: "1509900000001",
				Phone:      "999999",
				Email:      "ying@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidPhone,
		},
		{
			name: "Invalid shirt size",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: "1509900000002",
				Phone:      "0898765432",
				Email:      "ying2@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "XXXXL",
			},
			expectedErr: service.ErrInvalidShirtSize,
		},
		{
			name: "Invalid email format",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: "1509900000003",
				Phone:      "0898765433",
				Email:      "not-an-email",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidEmail,
		},
		{
			name: "Invalid grade",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: "1509900000004",
				Phone:      "0898765434",
				Email:      "ying4@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ป.6",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidGrade,
		},
		{
			name: "Blank required fields",
			req: service.ApplicationCreateRequest{
				FullName:   "   ",
				Nickname:   "หญิง",
				NationalID: "1509900000005",
				Phone:      "0898765435",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.6",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidInput,
		},
		{
			name: "Exceeds max length",
			req: service.ApplicationCreateRequest{
				FullName:   strings.Repeat("ก", 201),
				Nickname:   "หญิง",
				NationalID: "1509900000006",
				Phone:      "0898765436",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.6",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrInvalidInput,
		},
		{
			name: "Duplicate national ID",
			req: service.ApplicationCreateRequest{
				FullName:   "ซ้ำ บัตร",
				Nickname:   "ซ้ำ",
				NationalID: "1509900000010",
				Phone:      "0898765437",
				Email:      "unique1@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrDuplicateApplicant,
		},
		{
			name: "Duplicate email",
			req: service.ApplicationCreateRequest{
				FullName:   "ซ้ำ เมล",
				Nickname:   "ซ้ำ",
				NationalID: "1509900000011",
				Phone:      "0898765438",
				Email:      "SEED@example.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "M",
			},
			expectedErr: service.ErrDuplicateApplicant,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Submit(ctx, tc.req)
			if !errors.Is(err, tc.expectedErr) {
				t.Fatalf("expected error %v, got %v", tc.expectedErr, err)
			}
		})
	}
}

func TestApplicantService_Submit_ClosedSchedule(t *testing.T) {
	svc, _, setRepo, _ := setupTestServices()

	now := time.Now().UTC()
	_ = setRepo.Update(context.Background(), &domain.Settings{
		ID:                  1,
		RegistrationOpenAt:  now.Add(24 * time.Hour),
		RegistrationCloseAt: now.Add(48 * time.Hour),
		MaxCapacity:         30,
	})

	req := service.ApplicationCreateRequest{
		FullName:   "สมชาย ใจดี",
		Nickname:   "ชาย",
		NationalID: "1509900000000",
		Phone:      "0812345678",
		Email:      "somchai@example.com",
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "L",
	}

	_, err := svc.Submit(context.Background(), req)
	if !errors.Is(err, service.ErrRegistrationClosed) {
		t.Fatalf("expected ErrRegistrationClosed, got %v", err)
	}
}

func TestApplicantService_QueryStatus_MasksPII_And_Identifiers(t *testing.T) {
	svc, appRepo, _, payRepo := setupTestServices()
	ctx := context.Background()

	created, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:   "น้องทดสอบ สดใส",
		Nickname:   "สด",
		NationalID: "1509988881234",
		Phone:      "0899991234",
		Email:      "somkiat@school.ac.th",
		School:     "โรงเรียนเทศบาล",
		Grade:      "ม.6",
		ShirtSize:  "S",
	})
	if err != nil {
		t.Fatalf("failed to submit: %v", err)
	}

	appRecord, _ := appRepo.GetByApplicationNo(ctx, created.ID)
	reason := "สลิปไม่ชัด"
	adminID := int64(7)
	now := time.Now().UTC()
	_ = payRepo.Create(ctx, &domain.Payment{
		ID:                uuid.New(),
		ApplicantID:       appRecord.ID,
		SlipURL:           "/uploads/slips/test.jpg",
		Amount:            decimal.NewFromInt(300),
		Status:            domain.PaymentRejected,
		VerifiedByAdminID: &adminID,
		RejectionReason:   &reason,
		VerifiedAt:        &now,
	})

	// Query by National ID, Phone, and lowercase ApplicationNo
	for _, q := range []string{"1509988881234", "0899991234", strings.ToLower(created.ID)} {
		got, err := svc.QueryStatus(ctx, q)
		if err != nil {
			t.Fatalf("QueryStatus(%q) failed: %v", q, err)
		}
		if got.ID != created.ID {
			t.Errorf("QueryStatus(%q): expected ID %s, got %s", q, created.ID, got.ID)
		}
		if got.NationalID != "15099******34" {
			t.Errorf("expected masked nationalId 15099******34, got %q", got.NationalID)
		}
		if got.Phone != "089****234" {
			t.Errorf("expected masked phone 089****234, got %q", got.Phone)
		}
		if got.Email != "s***@school.ac.th" {
			t.Errorf("expected masked email s***@school.ac.th, got %q", got.Email)
		}
		if got.RejectionReason == nil || *got.RejectionReason != reason {
			t.Errorf("expected rejectionReason %q, got %v", reason, got.RejectionReason)
		}
		if got.SlipVerifiedBy == nil || *got.SlipVerifiedBy != "7" {
			t.Errorf("expected slipVerifiedBy '7', got %v", got.SlipVerifiedBy)
		}
	}

	// Confirm attendance while PENDING fails
	if _, err := svc.ConfirmAttendance(ctx, created.ID, true); !errors.Is(err, service.ErrCannotConfirm) {
		t.Fatalf("expected ErrCannotConfirm while PENDING, got %v", err)
	}

	// Update status to PASSED then confirm via UUID and decline via lowercase appNo
	if _, err := svc.UpdateStatus(ctx, appRecord.ID.String(), domain.StatusPassed, &adminID, "Passed"); err != nil {
		t.Fatalf("UpdateStatus failed: %v", err)
	}
	confirmed, err := svc.ConfirmAttendance(ctx, appRecord.ID.String(), true)
	if err != nil || !confirmed.AttendanceConfirmed {
		t.Fatalf("expected attendanceConfirmed=true, got %+v (%v)", confirmed, err)
	}
	declined, err := svc.ConfirmAttendance(ctx, strings.ToLower(created.ID), false)
	if err != nil || declined.AttendanceConfirmed {
		t.Fatalf("expected attendanceConfirmed=false, got %+v (%v)", declined, err)
	}
}

func TestApplicantService_UpdateStatus_TransitionsAndCapacity(t *testing.T) {
	svc, appRepo, setRepo, _ := setupTestServices()
	ctx := context.Background()

	_ = setRepo.Update(ctx, &domain.Settings{
		ID:                  1,
		CampName:            "ComCamp 25th",
		RegistrationOpenAt:  time.Now().Add(-time.Hour),
		RegistrationCloseAt: time.Now().Add(time.Hour),
		MaxCapacity:         1,
		CampFee:             decimal.NewFromInt(300),
	})

	a1, _ := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:   "คนที่หนึ่ง",
		Nickname:   "หนึ่ง",
		NationalID: "1111111111111",
		Phone:      "0811111111",
		School:     "โรงเรียน 1",
		Grade:      "ม.4",
		ShirtSize:  "M",
	})
	a2, _ := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:   "คนที่สอง",
		Nickname:   "สอง",
		NationalID: "2222222222222",
		Phone:      "0822222222",
		School:     "โรงเรียน 2",
		Grade:      "ม.5",
		ShirtSize:  "L",
	})

	adminID := int64(1)
	// Invalid status
	if _, err := svc.UpdateStatus(ctx, a1.ID, domain.ApplicationStatus("UNKNOWN"), &adminID, ""); !errors.Is(err, service.ErrInvalidStatus) {
		t.Errorf("expected ErrInvalidStatus, got %v", err)
	}
	// Disallowed direct PENDING -> CONFIRMED
	if _, err := svc.UpdateStatus(ctx, a1.ID, domain.StatusConfirmed, &adminID, ""); !errors.Is(err, service.ErrInvalidStatusTransition) {
		t.Errorf("expected ErrInvalidStatusTransition for PENDING->CONFIRMED, got %v", err)
	}

	// Valid PENDING -> PASSED -> CONFIRMED syncs attendanceConfirmed=true
	if _, err := svc.UpdateStatus(ctx, a1.ID, domain.StatusPassed, &adminID, "pass"); err != nil {
		t.Fatalf("PENDING->PASSED failed: %v", err)
	}
	res1, err := svc.UpdateStatus(ctx, a1.ID, domain.StatusConfirmed, &adminID, "confirm")
	if err != nil {
		t.Fatalf("PASSED->CONFIRMED failed: %v", err)
	}
	if !res1.AttendanceConfirmed {
		t.Errorf("expected attendanceConfirmed=true when updated to CONFIRMED")
	}

	// Disallowed CONFIRMED -> PENDING
	if _, err := svc.UpdateStatus(ctx, a1.ID, domain.StatusPending, &adminID, "back"); !errors.Is(err, service.ErrInvalidStatusTransition) {
		t.Errorf("expected ErrInvalidStatusTransition for CONFIRMED->PENDING, got %v", err)
	}

	// Capacity full: a2 PASSED -> CONFIRMED must fail with ErrQuotaExceeded
	_, _ = svc.UpdateStatus(ctx, a2.ID, domain.StatusPassed, &adminID, "pass")
	if _, err := svc.UpdateStatus(ctx, a2.ID, domain.StatusConfirmed, &adminID, "over"); !errors.Is(err, service.ErrQuotaExceeded) {
		t.Errorf("expected ErrQuotaExceeded when maxCapacity=1 is reached, got %v", err)
	}

	// ListFiltered checks
	badStatus := domain.ApplicationStatus("BOGUS")
	if _, err := svc.ListFiltered(ctx, service.AdminListFilter{Status: &badStatus}); !errors.Is(err, service.ErrInvalidStatus) {
		t.Errorf("expected ErrInvalidStatus on ListFiltered, got %v", err)
	}
	confirmedFilter := domain.StatusConfirmed
	list, err := svc.ListFiltered(ctx, service.AdminListFilter{Status: &confirmedFilter, Query: "หนึ่ง"})
	if err != nil || len(list) != 1 || list[0].ID != a1.ID {
		t.Errorf("expected 1 filtered applicant, got %v (%v)", list, err)
	}
	// Ensure admin list is unmasked
	if len(list) == 1 && list[0].NationalID != "1111111111111" {
		t.Errorf("expected unmasked nationalId in admin list, got %q", list[0].NationalID)
	}
	_ = appRepo
}
