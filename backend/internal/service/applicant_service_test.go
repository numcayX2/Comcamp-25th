package service_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func setupTestServices() (*service.ApplicantService, *memory.MemoryApplicantRepo, *memory.MemorySettingRepo) {
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	svc := service.NewApplicantService(appRepo, setRepo, payRepo)
	return svc, appRepo, setRepo
}

func TestApplicantService_Submit_Success(t *testing.T) {
	svc, _, _ := setupTestServices()

	req := service.ApplicationCreateRequest{
		FullName:   "สมชาย ใจดี",
		Nickname:   "ชาย",
		NationalID: validTestNationalID(1),
		Phone:      "0812345678",
		Email:      "somchai@example.com",
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "L",
		Motivation: "อยากเรียนรู้ IoT และเขียนโปรแกรม Arduino",
	}

	res, err := svc.Submit(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.ID == "" {
		t.Errorf("expected non-empty application ID")
	}
	if res.Status != domain.StatusPassed {
		t.Errorf("expected status %s (first come, first served), got %s", domain.StatusPassed, res.Status)
	}
	if res.FullName != "สมชาย ใจดี" {
		t.Errorf("expected full name 'สมชาย ใจดี', got '%s'", res.FullName)
	}
}

// badCheckDigit returns id with its last digit changed, so the Mod-11 check fails.
func badCheckDigit(id string) string {
	last := id[12] - '0'
	return id[:12] + string(rune('0'+(last+1)%10))
}

func TestApplicantService_Submit_ValidationErrors(t *testing.T) {
	svc, _, _ := setupTestServices()

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
			name: "National ID with a wrong check digit",
			req: service.ApplicationCreateRequest{
				FullName:   "สมหญิง จริงใจ",
				Nickname:   "หญิง",
				NationalID: badCheckDigit(validTestNationalID(4)),
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
				NationalID: validTestNationalID(2),
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
				NationalID: validTestNationalID(3),
				Phone:      "0898765432",
				Email:      "ying2@test.com",
				School:     "โรงเรียนเทศบาล",
				Grade:      "ม.4",
				ShirtSize:  "XXXXL",
			},
			expectedErr: service.ErrInvalidShirtSize,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Submit(context.Background(), tc.req)
			if err != tc.expectedErr {
				t.Fatalf("expected error %v, got %v", tc.expectedErr, err)
			}
		})
	}
}

func TestApplicantService_Submit_ClosedSchedule(t *testing.T) {
	svc, _, setRepo := setupTestServices()

	// Set schedule in the future (registration not opened yet)
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
		NationalID: validTestNationalID(1),
		Phone:      "0812345678",
		Email:      "somchai@example.com",
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "L",
	}

	_, err := svc.Submit(context.Background(), req)
	if err != service.ErrRegistrationClosed {
		t.Fatalf("expected ErrRegistrationClosed, got %v", err)
	}
}

// The seat quota is maxCapacity from settings (default 30, adjustable by admins through
// PATCH /api/admin/settings): a full camp rejects new applications, and raising the quota
// lets them in again without a deploy.
func TestApplicantService_Submit_AdjustableCapacity(t *testing.T) {
	svc, appRepo, setRepo := setupTestServices()

	_ = setRepo.Update(context.Background(), &domain.Settings{
		ID:                  1,
		RegistrationOpenAt:  time.Now().Add(-1 * time.Hour),
		RegistrationCloseAt: time.Now().Add(24 * time.Hour),
		MaxCapacity:         1,
		CampFee:             decimal.NewFromFloat(300),
	})

	req1 := service.ApplicationCreateRequest{
		FullName:   "คนที่หนึ่ง",
		Nickname:   "หนึ่ง",
		NationalID: validTestNationalID(11),
		Phone:      "0811111111",
		Email:      "one@example.com",
		School:     "โรงเรียน 1",
		Grade:      "ม.4",
		ShirtSize:  "M",
	}
	_, err := svc.Submit(context.Background(), req1)
	if err != nil {
		t.Fatalf("expected person 1 to succeed, got %v", err)
	}

	req2 := service.ApplicationCreateRequest{
		FullName:   "คนที่สอง",
		Nickname:   "สอง",
		NationalID: validTestNationalID(22),
		Phone:      "0822222222",
		Email:      "two@example.com",
		School:     "โรงเรียน 2",
		Grade:      "ม.5",
		ShirtSize:  "L",
	}
	if _, err := svc.Submit(context.Background(), req2); err != service.ErrQuotaExceeded {
		t.Fatalf("capacity 1 is full: expected ErrQuotaExceeded for person 2, got %v", err)
	}

	// An admin raises the quota to 2; person 2 can now apply.
	settingSvc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())
	two := 2
	if _, err := settingSvc.UpdateSettings(context.Background(), service.UpdateSettingsRequest{MaxCapacity: &two}, 1, "127.0.0.1"); err != nil {
		t.Fatalf("raise capacity: %v", err)
	}
	res2, err := svc.Submit(context.Background(), req2)
	if err != nil {
		t.Fatalf("after raising capacity: expected person 2 to be accepted, got %v", err)
	}
	if res2.Status != domain.StatusPassed {
		t.Errorf("expected person 2 status PASSED, got %s", res2.Status)
	}

	// Two seats are taken: the quota cannot drop below that, but may equal it.
	one := 1
	_, err = settingSvc.UpdateSettings(context.Background(), service.UpdateSettingsRequest{MaxCapacity: &one}, 1, "127.0.0.1")
	if err == nil || !strings.Contains(err.Error(), "cannot be lower than the current applicant count") {
		t.Fatalf("lowering capacity below the applicant count: expected a validation error, got %v", err)
	}
	if got, _ := setRepo.Get(context.Background()); got.MaxCapacity != 2 {
		t.Errorf("rejected update must not change the quota, got %d", got.MaxCapacity)
	}
	if _, err := settingSvc.UpdateSettings(context.Background(), service.UpdateSettingsRequest{MaxCapacity: &two}, 1, "127.0.0.1"); err != nil {
		t.Errorf("capacity equal to the applicant count should be allowed, got %v", err)
	}
}

func TestApplicantService_QueryStatus_And_ConfirmAttendance(t *testing.T) {
	svc, _, _ := setupTestServices()
	nid := validTestNationalID(8888888)
	verify := nid[9:] // verifyCode = last 4 digits of the national ID

	req := service.ApplicationCreateRequest{
		FullName:   "น้องทดสอบ สดใส",
		Nickname:   "สด",
		NationalID: nid,
		Phone:      "0899999999",
		Email:      "test@example.com",
		School:     "โรงเรียนเทศบาล",
		Grade:      "ม.6",
		ShirtSize:  "S",
	}
	created, err := svc.Submit(context.Background(), req)
	if err != nil {
		t.Fatalf("failed to submit: %v", err)
	}

	// 1. Query by National ID
	byNational, err := svc.QueryStatus(context.Background(), nid)
	if err != nil {
		t.Fatalf("failed to query by national id: %v", err)
	}
	if byNational.ID != created.ID {
		t.Errorf("expected ID %s, got %s", created.ID, byNational.ID)
	}

	// 2. Query by Phone
	byPhone, err := svc.QueryStatus(context.Background(), "0899999999")
	if err != nil {
		t.Fatalf("failed to query by phone: %v", err)
	}
	if byPhone.ID != created.ID {
		t.Errorf("expected ID %s, got %s", created.ID, byPhone.ID)
	}

	// 3. Confirm attendance while PENDING should fail (staff can still park an application there)
	if _, err := svc.UpdateStatus(context.Background(), created.ID, domain.StatusPending, nil, "hold", "127.0.0.1"); err != nil {
		t.Fatalf("failed to set PENDING: %v", err)
	}
	_, err = svc.ConfirmAttendance(context.Background(), created.ID, verify, true)
	if err != service.ErrCannotConfirm {
		t.Fatalf("expected ErrCannotConfirm while PENDING, got %v", err)
	}

	// 4. Update status to PASSED then confirm should succeed
	_, err = svc.UpdateStatus(context.Background(), created.ID, domain.StatusPassed, nil, "Passed screening", "127.0.0.1")
	if err != nil {
		t.Fatalf("failed to update status: %v", err)
	}

	// 5. verifyCode (AGENTS.md §13.5): last 4 digits of the national ID only. A missing code is a
	//    validation error; a wrong one, or the phone's last 4 digits, is rejected.
	if _, err := svc.ConfirmAttendance(context.Background(), created.ID, "", true); err != service.ErrVerifyCodeRequired {
		t.Fatalf("missing verifyCode: expected ErrVerifyCodeRequired, got %v", err)
	}
	for _, code := range []string{"1234", "9999"} { // 9999 = the phone's last 4 digits
		if _, err := svc.ConfirmAttendance(context.Background(), created.ID, code, true); err != service.ErrInvalidVerifyCode {
			t.Fatalf("verifyCode %s: expected ErrInvalidVerifyCode, got %v", code, err)
		}
	}

	confirmed, err := svc.ConfirmAttendance(context.Background(), created.ID, verify, true)
	if err != nil {
		t.Fatalf("failed to confirm attendance: %v", err)
	}
	if !confirmed.AttendanceConfirmed {
		t.Errorf("expected attendanceConfirmed to be true")
	}
}
