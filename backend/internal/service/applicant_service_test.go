package service_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
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

func TestApplicantService_Submit_ValidationErrors(t *testing.T) {
	svc, _, _ := setupTestServices()

	tests := []struct {
		name        string
		req         service.ApplicationCreateRequest
		expectedErr error
	}{
		{
			name: "Phone with 13 digits (a national ID typed by habit)",
			req: service.ApplicationCreateRequest{
				FullName:  "สมหญิง จริงใจ",
				Nickname:  "หญิง",
				Phone:     "1509900112233",
				Email:     "ying@test.com",
				School:    "โรงเรียนเทศบาล",
				Grade:     "ม.4",
				ShirtSize: "M",
			},
			expectedErr: service.ErrInvalidPhone,
		},
		{
			name: "Invalid phone format",
			req: service.ApplicationCreateRequest{
				FullName:  "สมหญิง จริงใจ",
				Nickname:  "หญิง",
				Phone:     "999999",
				Email:     "ying@test.com",
				School:    "โรงเรียนเทศบาล",
				Grade:     "ม.4",
				ShirtSize: "M",
			},
			expectedErr: service.ErrInvalidPhone,
		},
		{
			name: "Invalid shirt size",
			req: service.ApplicationCreateRequest{
				FullName:  "สมหญิง จริงใจ",
				Nickname:  "หญิง",
				Phone:     "0898765432",
				Email:     "ying2@test.com",
				School:    "โรงเรียนเทศบาล",
				Grade:     "ม.4",
				ShirtSize: "XXXXL",
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
		FullName:  "สมชาย ใจดี",
		Nickname:  "ชาย",
		Phone:     "0812345678",
		Email:     "somchai@example.com",
		School:    "โรงเรียนแม่โจ้วิทยาคม",
		Grade:     "ม.5",
		ShirtSize: "L",
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
		FullName:  "คนที่หนึ่ง",
		Nickname:  "หนึ่ง",
		Phone:     "0811111111",
		Email:     "one@example.com",
		School:    "โรงเรียน 1",
		Grade:     "ม.4",
		ShirtSize: "M",
	}
	_, err := svc.Submit(context.Background(), req1)
	if err != nil {
		t.Fatalf("expected person 1 to succeed, got %v", err)
	}

	req2 := service.ApplicationCreateRequest{
		FullName:  "คนที่สอง",
		Nickname:  "สอง",
		Phone:     "0822222222",
		Email:     "two@example.com",
		School:    "โรงเรียน 2",
		Grade:     "ม.5",
		ShirtSize: "L",
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

	req := service.ApplicationCreateRequest{
		FullName:  "น้องทดสอบ สดใส",
		Nickname:  "สด",
		Phone:     "0899999999",
		Email:     "test@example.com",
		School:    "โรงเรียนเทศบาล",
		Grade:     "ม.6",
		ShirtSize: "S",
	}
	created, err := svc.Submit(context.Background(), req)
	if err != nil {
		t.Fatalf("failed to submit: %v", err)
	}

	// 1. Query by application code: the full masked record, with the code, marked as a code lookup.
	byCode, err := svc.QueryStatus(context.Background(), strings.ToLower(created.ID))
	if err != nil {
		t.Fatalf("failed to query by code: %v", err)
	}
	if byCode.ByPhone != nil || byCode.ByCode == nil || byCode.ByCode.ID != created.ID || byCode.ByCode.Lookup != service.LookupCode {
		t.Fatalf("code lookup: expected the record of %s, got %+v", created.ID, byCode)
	}
	if byCode.ByCode.School != "โรงเรียนเทศบาล" || byCode.ByCode.Phone != "XXX-XXX-XX99" || byCode.ByCode.Email != "t***@example.com" {
		t.Fatalf("code lookup must return the masked record, got %+v", byCode.ByCode)
	}

	// 2. Query by phone: masked display data only, never the code.
	byPhone, err := svc.QueryStatus(context.Background(), "089-999-9999")
	if err != nil {
		t.Fatalf("failed to query by phone: %v", err)
	}
	if byPhone.ByCode != nil || byPhone.ByPhone == nil {
		t.Fatalf("phone lookup must answer with PhoneLookupResponse, got %+v", byPhone)
	}
	p := byPhone.ByPhone
	if p.Lookup != service.LookupPhone || !p.CodeRequired || p.FullName != "น*** ส***" || p.Phone != "XXX-XXX-XX99" ||
		p.Email != "t***@example.com" || p.Status != domain.StatusPassed {
		t.Fatalf("unexpected phone lookup answer: %+v", p)
	}

	// 3. Anything that is neither a phone number nor a code is refused without a lookup.
	for _, q := range []string{"1509900112233", "12345", "CC25-12345", "hello"} {
		if _, err := svc.QueryStatus(context.Background(), q); err != service.ErrInvalidQuery {
			t.Fatalf("query %q: expected ErrInvalidQuery, got %v", q, err)
		}
	}

	// 4. Confirm attendance while PENDING should fail (staff can still park an application there)
	if _, err := svc.UpdateStatus(context.Background(), created.ID, domain.StatusPending, nil, "hold", "127.0.0.1"); err != nil {
		t.Fatalf("failed to set PENDING: %v", err)
	}
	if _, err = svc.ConfirmAttendance(context.Background(), created.ID, true); err != service.ErrCannotConfirm {
		t.Fatalf("expected ErrCannotConfirm while PENDING, got %v", err)
	}

	// 5. Update status to PASSED then confirm should succeed with the code alone.
	if _, err = svc.UpdateStatus(context.Background(), created.ID, domain.StatusPassed, nil, "Passed screening", "127.0.0.1"); err != nil {
		t.Fatalf("failed to update status: %v", err)
	}
	confirmed, err := svc.ConfirmAttendance(context.Background(), created.ID, true)
	if err != nil {
		t.Fatalf("failed to confirm attendance: %v", err)
	}
	if !confirmed.AttendanceConfirmed {
		t.Errorf("expected attendanceConfirmed to be true")
	}

	// 6. An unknown or malformed code is not found.
	for _, code := range []string{"CC25-000000", "CC25-XYZ", ""} {
		if _, err := svc.ConfirmAttendance(context.Background(), code, true); err != service.ErrApplicantNotFound {
			t.Fatalf("code %q: expected ErrApplicantNotFound, got %v", code, err)
		}
	}
}

type countingPaymentRepo struct {
	*memory.MemoryPaymentRepo
	singleCalls atomic.Int64
	batchCalls  atomic.Int64
}

func (r *countingPaymentRepo) GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	r.singleCalls.Add(1)
	return r.MemoryPaymentRepo.GetLatestByApplicantID(ctx, applicantID)
}

func (r *countingPaymentRepo) GetLatestByApplicantIDs(ctx context.Context, applicantIDs []uuid.UUID) (map[uuid.UUID]*domain.Payment, error) {
	r.batchCalls.Add(1)
	return r.MemoryPaymentRepo.GetLatestByApplicantIDs(ctx, applicantIDs)
}

func TestApplicantService_ListAll_UsesBatchPaymentLookup(t *testing.T) {
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := &countingPaymentRepo{MemoryPaymentRepo: memory.NewMemoryPaymentRepo(appRepo)}
	svc := service.NewApplicantService(appRepo, setRepo, payRepo)

	ctx := context.Background()
	a1, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:  "น้องหนึ่ง ทดสอบ",
		Nickname:  "หนึ่ง",
		Phone:     "0811111111",
		Email:     "one@example.com",
		School:    "โรงเรียนทดสอบ",
		Grade:     "ม.5",
		ShirtSize: "M",
	})
	if err != nil {
		t.Fatalf("submit a1: %v", err)
	}
	a2, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:  "น้องสอง ทดสอบ",
		Nickname:  "สอง",
		Phone:     "0822222222",
		Email:     "two@example.com",
		School:    "โรงเรียนทดสอบ",
		Grade:     "ม.6",
		ShirtSize: "L",
	})
	if err != nil {
		t.Fatalf("submit a2: %v", err)
	}

	domainA1, err := appRepo.GetByApplicationNo(ctx, a1.ID)
	if err != nil {
		t.Fatalf("get a1 by applicationNo: %v", err)
	}
	older := &domain.Payment{
		ApplicantID: domainA1.ID,
		SlipURL:     "slips/old.webp",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentRejected,
	}
	if err := payRepo.Create(ctx, older); err != nil {
		t.Fatalf("create older payment: %v", err)
	}
	// Sleep longer than Windows timer resolution so UploadedAt ordering is deterministic in memory.
	time.Sleep(20 * time.Millisecond)
	newer := &domain.Payment{
		ApplicantID: domainA1.ID,
		SlipURL:     "slips/new.webp",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
	}
	if err := payRepo.Create(ctx, newer); err != nil {
		t.Fatalf("create newer payment: %v", err)
	}

	payRepo.singleCalls.Store(0)
	payRepo.batchCalls.Store(0)

	list, err := svc.ListAll(ctx, nil)
	if err != nil {
		t.Fatalf("ListAll failed: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 applicants, got %d", len(list))
	}
	if got := payRepo.batchCalls.Load(); got != 1 {
		t.Errorf("expected 1 batch lookup, got %d", got)
	}
	if got := payRepo.singleCalls.Load(); got != 0 {
		t.Errorf("expected 0 per-applicant payment queries (N+1), got %d", got)
	}

	byID := make(map[string]*service.ApplicationResponse, len(list))
	for _, item := range list {
		byID[item.ID] = item
	}
	got1 := byID[a1.ID]
	if got1 == nil || !got1.HasSlip || got1.SlipStatus == nil || *got1.SlipStatus != domain.PaymentPending || got1.SlipPaymentID == nil || *got1.SlipPaymentID != newer.ID.String() {
		t.Fatalf("unexpected slip fields for a1: %+v", got1)
	}
	got2 := byID[a2.ID]
	if got2 == nil || got2.HasSlip || got2.SlipStatus != nil || got2.SlipPaymentID != nil {
		t.Fatalf("expected no slip fields for a2, got: %+v", got2)
	}
}

func TestApplicantService_ParentContactFields(t *testing.T) {
	svc, appRepo, _ := setupTestServices()
	ctx := context.Background()

	// 1. Invalid parentPhone and oversized parentName / parentRelation are rejected.
	baseReq := service.ApplicationCreateRequest{
		FullName:       "น้องทิวา ทดสอบ",
		Nickname:       "ทิวา",
		Phone:          "0812345678",
		Email:          "tiwa@example.com",
		ParentName:     "สมศรี\u200B   ทดสอบ",
		ParentRelation: "  มารดา  ",
		ParentPhone:    "089-876-5432",
		School:         "โรงเรียนแม่โจ้",
		Grade:          "ม.5",
		ShirtSize:      "M",
	}
	badPhone := baseReq
	badPhone.ParentPhone = "12345"
	if _, err := svc.Submit(ctx, badPhone); !errors.Is(err, service.ErrInvalidParentPhone) {
		t.Fatalf("invalid parentPhone: expected ErrInvalidParentPhone, got %v", err)
	}
	longName := baseReq
	longName.ParentName = strings.Repeat("ก", 151)
	var verr *service.ValidationError
	if _, err := svc.Submit(ctx, longName); !errors.As(err, &verr) {
		t.Fatalf("oversized parentName: expected ValidationError, got %v", err)
	}
	longRel := baseReq
	longRel.ParentRelation = strings.Repeat("ข", 51)
	if _, err := svc.Submit(ctx, longRel); !errors.As(err, &verr) {
		t.Fatalf("oversized parentRelation: expected ValidationError, got %v", err)
	}

	// 2. Valid submit normalizes parent fields and omits them from public Submit / QueryStatus responses.
	submitted, err := svc.Submit(ctx, baseReq)
	if err != nil {
		t.Fatalf("submit with parent fields failed: %v", err)
	}
	if submitted.ParentName != "" || submitted.ParentRelation != "" || submitted.ParentPhone != "" {
		t.Fatalf("submit response must not expose parent PII, got %+v", submitted)
	}
	lookup, err := svc.QueryStatus(ctx, submitted.ID)
	if err != nil {
		t.Fatalf("QueryStatus failed: %v", err)
	}
	queried := lookup.ByCode
	if queried.ParentName != "" || queried.ParentRelation != "" || queried.ParentPhone != "" {
		t.Fatalf("public QueryStatus must omit parent PII, got %+v", queried)
	}

	// 3. Stored applicant and admin ListAll include normalized parent fields and emergency fallback.
	stored, err := appRepo.GetByApplicationNo(ctx, submitted.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ParentName == nil || *stored.ParentName != "สมศรี ทดสอบ" ||
		stored.ParentRelation == nil || *stored.ParentRelation != "มารดา" ||
		stored.ParentPhone == nil || *stored.ParentPhone != "0898765432" {
		t.Fatalf("unexpected stored parent fields: name=%v rel=%v phone=%v", stored.ParentName, stored.ParentRelation, stored.ParentPhone)
	}
	if stored.EmergencyContact != "สมศรี ทดสอบ" || stored.EmergencyPhone != "0898765432" {
		t.Fatalf("expected emergency contact/phone to mirror parent fields, got %q / %q", stored.EmergencyContact, stored.EmergencyPhone)
	}

	list, err := svc.ListAll(ctx, nil)
	if err != nil || len(list) != 1 {
		t.Fatalf("ListAll failed: len=%d err=%v", len(list), err)
	}
	if list[0].ParentName != "สมศรี ทดสอบ" || list[0].ParentRelation != "มารดา" || list[0].ParentPhone != "0898765432" {
		t.Fatalf("ListAll missing parent fields: %+v", list[0])
	}

	// 4. AdminUpdateProfile validates and updates parent fields and emergency contact fallback.
	badAdminPhone := "999"
	if _, err := svc.AdminUpdateProfile(ctx, submitted.ID, service.AdminProfileRequest{
		ParentPhone: &badAdminPhone,
	}, nil, "127.0.0.1"); !errors.Is(err, service.ErrInvalidParentPhone) {
		t.Fatalf("admin edit invalid parentPhone: expected ErrInvalidParentPhone, got %v", err)
	}
	updName, updRel, updPhone := "สมชาย  ทดสอบ", "บิดา", "087-777-8888"
	adminID := int64(1)
	updated, err := svc.AdminUpdateProfile(ctx, submitted.ID, service.AdminProfileRequest{
		ParentName:     &updName,
		ParentRelation: &updRel,
		ParentPhone:    &updPhone,
		Reason:         "แก้ข้อมูลผู้ปกครอง",
	}, &adminID, "127.0.0.1")
	if err != nil {
		t.Fatalf("AdminUpdateProfile failed: %v", err)
	}
	if updated.ParentName != "สมชาย ทดสอบ" || updated.ParentRelation != "บิดา" || updated.ParentPhone != "0877778888" {
		t.Fatalf("unexpected updated admin parent fields: %+v", updated)
	}
	afterAdmin, _ := appRepo.GetByApplicationNo(ctx, submitted.ID)
	if afterAdmin.EmergencyContact != "สมชาย ทดสอบ" || afterAdmin.EmergencyPhone != "0877778888" {
		t.Fatalf("expected emergency fields to update via admin edit, got %q / %q", afterAdmin.EmergencyContact, afterAdmin.EmergencyPhone)
	}

	// Clearing parent contact fields stores nil pointers and falls back emergency fields cleanly.
	empty := ""
	cleared, err := svc.AdminUpdateProfile(ctx, submitted.ID, service.AdminProfileRequest{
		ParentName:     &empty,
		ParentRelation: &empty,
		ParentPhone:    &empty,
		Reason:         "ล้างข้อมูลผู้ปกครอง",
	}, &adminID, "127.0.0.1")
	if err != nil {
		t.Fatalf("clearing parent fields failed: %v", err)
	}
	if cleared.ParentName != "" || cleared.ParentRelation != "" || cleared.ParentPhone != "" {
		t.Fatalf("expected cleared parent fields, got %+v", cleared)
	}
	afterClear, _ := appRepo.GetByApplicationNo(ctx, submitted.ID)
	if afterClear.ParentName != nil || afterClear.ParentRelation != nil || afterClear.ParentPhone != nil {
		t.Fatalf("expected nil parent pointers after clear, got %+v", afterClear)
	}
	if afterClear.EmergencyContact != "ผู้ปกครอง" || afterClear.EmergencyPhone != "0812345678" {
		t.Fatalf("expected emergency fallback after clear, got %q / %q", afterClear.EmergencyContact, afterClear.EmergencyPhone)
	}
}

func TestApplicantService_OfficialShirtSizes(t *testing.T) {
	svc, _, _ := setupTestServices()
	sizes := []string{"SSS", "SS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"}
	for i, sz := range sizes {
		res, err := svc.Submit(context.Background(), service.ApplicationCreateRequest{
			FullName:  "สมชาย ทดสอบ",
			Nickname:  "ชาย",
			Phone:     "08200000" + string(rune('1'+i)) + "0",
			Email:     "size" + sz + "@test.com",
			School:    "โรงเรียนแม่โจ้วิทยาคม",
			Grade:     "ม.5",
			ShirtSize: sz,
		})
		if err != nil {
			t.Fatalf("expected shirt size %q to succeed, got %v", sz, err)
		}
		if res.ShirtSize != sz {
			t.Fatalf("expected shirt size %q, got %q", sz, res.ShirtSize)
		}
	}
}

func TestApplicantService_ExpireOverdueUnpaid_120Hours(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)

	var seatChanges atomic.Int64
	now := time.Now().UTC()
	svc := service.NewApplicantService(appRepo, setRepo, payRepo).
		WithAudit(appRepo.Audit()).
		WithOnSeatChange(func() { seatChanges.Add(1) }).
		WithNow(func() time.Time { return now })

	submitSample := func(idx int, phone, email string) *service.ApplicationResponse {
		res, err := svc.Submit(ctx, service.ApplicationCreateRequest{
			FullName:  "สมชาย ทดสอบ",
			Nickname:  "ชาย",
			Phone:     phone,
			Email:     email,
			School:    "โรงเรียนแม่โจ้วิทยาคม",
			Grade:     "ม.5",
			ShirtSize: "L",
		})
		if err != nil {
			t.Fatalf("submit %d failed: %v", idx, err)
		}
		return res
	}

	// 1. Create 3 applicants: unpaid, pending-slip, approved-slip.
	unpaid := submitSample(1, "0830000001", "u1@test.com")
	pendingRes := submitSample(2, "0830000002", "u2@test.com")
	approvedRes := submitSample(3, "0830000003", "u3@test.com")

	pendingApp, _ := appRepo.GetByApplicationNo(ctx, pendingRes.ID)
	approvedApp, _ := appRepo.GetByApplicationNo(ctx, approvedRes.ID)

	if err := payRepo.Create(ctx, &domain.Payment{
		ApplicantID: pendingApp.ID,
		SlipURL:     "slips/pending.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentPending,
	}); err != nil {
		t.Fatalf("create pending payment: %v", err)
	}
	if err := payRepo.Create(ctx, &domain.Payment{
		ApplicantID: approvedApp.ID,
		SlipURL:     "slips/approved.jpg",
		Amount:      decimal.NewFromInt(1000),
		Status:      domain.PaymentApproved,
	}); err != nil {
		t.Fatalf("create approved payment: %v", err)
	}

	// 2. At +119h (< 120h), nobody expires.
	expired119, err := svc.ExpireOverdueUnpaid(ctx, now.Add(119*time.Hour))
	if err != nil {
		t.Fatalf("ExpireOverdueUnpaid at +119h failed: %v", err)
	}
	if len(expired119) != 0 {
		t.Fatalf("expected 0 expired at +119h, got %v", expired119)
	}

	// 3. At +121h (> 120h), only the unpaid applicant expires to REJECTED; slip holders stay active.
	seatChanges.Store(0)
	expired121, err := svc.ExpireOverdueUnpaid(ctx, now.Add(121*time.Hour))
	if err != nil {
		t.Fatalf("ExpireOverdueUnpaid at +121h failed: %v", err)
	}
	if len(expired121) != 1 || expired121[0] != unpaid.ID {
		t.Fatalf("expected only %s to expire at +121h, got %v", unpaid.ID, expired121)
	}
	if seatChanges.Load() != 1 {
		t.Fatalf("expected seat change callback once, got %d", seatChanges.Load())
	}

	gotUnpaid, _ := appRepo.GetByApplicationNo(ctx, unpaid.ID)
	if gotUnpaid.Status != domain.StatusRejected {
		t.Fatalf("expected expired unpaid status REJECTED, got %s", gotUnpaid.Status)
	}
	gotPending, _ := appRepo.GetByApplicationNo(ctx, pendingRes.ID)
	if gotPending.Status != domain.StatusPassed {
		t.Fatalf("expected pending-slip applicant to remain PASSED, got %s", gotPending.Status)
	}
	gotApproved, _ := appRepo.GetByApplicationNo(ctx, approvedRes.ID)
	if gotApproved.Status != domain.StatusPassed {
		t.Fatalf("expected approved-slip applicant to stay protected, got %s", gotApproved.Status)
	}
	if active, _ := appRepo.CountActive(ctx); active != 2 {
		t.Fatalf("expected 2 active seats remaining, got %d", active)
	}

	var foundLog bool
	for _, sl := range appRepo.StatusLogs() {
		if sl.ApplicantID != gotUnpaid.ID {
			continue
		}
		if sl.OldStatus == domain.StatusPassed && sl.NewStatus == domain.StatusRejected &&
			sl.Reason != nil && *sl.Reason == service.UnpaidExpiryReason {
			foundLog = true
		}
	}
	if !foundLog {
		t.Fatalf("expected applicant_status_logs row for unpaid auto-expiry")
	}

	var foundAudit bool
	for _, ae := range appRepo.Audit().Entries() {
		if ae.Action == domain.AuditPaymentExpired && ae.TargetID == unpaid.ID {
			foundAudit = true
		}
	}
	if !foundAudit {
		t.Fatalf("expected audit log %s for %s", domain.AuditPaymentExpired, unpaid.ID)
	}

	// 4. Full camp (maxCapacity = 1) with an unpaid 121h-old applicant automatically frees their
	// seat on the next Submit so the newcomer succeeds.
	capAppRepo := memory.NewMemoryApplicantRepo()
	capSetRepo := memory.NewMemorySettingRepo()
	capPayRepo := memory.NewMemoryPaymentRepo(capAppRepo)
	st, _ := capSetRepo.Get(ctx)
	st.MaxCapacity = 1
	_ = capSetRepo.Update(ctx, st)

	curNow := time.Now().UTC()
	capSvc := service.NewApplicantService(capAppRepo, capSetRepo, capPayRepo).
		WithAudit(capAppRepo.Audit()).
		WithNow(func() time.Time { return curNow })

	first, err := capSvc.Submit(ctx, service.ApplicationCreateRequest{
		FullName: "คนที่ หนึ่ง", Nickname: "หนึ่ง",
		Phone: "0840000001", Email: "c1@test.com", School: "รร.ทดสอบ", Grade: "ม.5", ShirtSize: "M",
	})
	if err != nil {
		t.Fatalf("first submit failed: %v", err)
	}

	// Same time -> quota full.
	if _, err := capSvc.Submit(ctx, service.ApplicationCreateRequest{
		FullName: "คนที่ สอง", Nickname: "สอง",
		Phone: "0840000002", Email: "c2@test.com", School: "รร.ทดสอบ", Grade: "ม.5", ShirtSize: "M",
	}); !errors.Is(err, service.ErrQuotaExceeded) {
		t.Fatalf("expected ErrQuotaExceeded before 120h, got %v", err)
	}

	// Advance clock by 121h -> Submit auto-expires the first unpaid applicant and takes the seat.
	curNow = curNow.Add(121 * time.Hour)
	second, err := capSvc.Submit(ctx, service.ApplicationCreateRequest{
		FullName: "คนที่ สอง", Nickname: "สอง",
		Phone: "0840000002", Email: "c2@test.com", School: "รร.ทดสอบ", Grade: "ม.5", ShirtSize: "M",
	})
	if err != nil {
		t.Fatalf("expected second submit after 121h expiry to succeed, got %v", err)
	}
	if second.Status != domain.StatusPassed {
		t.Fatalf("expected second applicant PASSED, got %s", second.Status)
	}
	firstAfter, _ := capAppRepo.GetByApplicationNo(ctx, first.ID)
	if firstAfter.Status != domain.StatusRejected {
		t.Fatalf("expected first applicant auto-rejected after 121h, got %s", firstAfter.Status)
	}
	if n, _ := capAppRepo.CountActive(ctx); n != 1 {
		t.Fatalf("expected 1 active seat after swap, got %d", n)
	}
}

func TestApplicantService_ExpireOverdueUnpaid_24hGracePeriod(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)

	now := time.Now().UTC()
	svc := service.NewApplicantService(appRepo, setRepo, payRepo).
		WithAudit(appRepo.Audit()).
		WithNow(func() time.Time { return now })
	psvc := service.NewPaymentService(payRepo, appRepo, setRepo, appRepo.Audit(), t.TempDir())

	submitSample := func(idx int, phone, email string) *domain.Applicant {
		res, err := svc.Submit(ctx, service.ApplicationCreateRequest{
			FullName:  "สมหญิง ทดสอบ",
			Nickname:  "หญิง",
			Phone:     phone,
			Email:     email,
			School:    "โรงเรียนแม่โจ้วิทยาคม",
			Grade:     "ม.5",
			ShirtSize: "M",
		})
		if err != nil {
			t.Fatalf("submit %d failed: %v", idx, err)
		}
		app, err := appRepo.GetByApplicationNo(ctx, res.ID)
		if err != nil {
			t.Fatalf("GetByApplicationNo %d failed: %v", idx, err)
		}
		return app
	}

	// Submit all 4 applicants first (before backdating timestamps, because Submit runs ExpireOverdueUnpaid).
	neverPaid := submitSample(1, "0850000001", "g1@test.com")
	rejectedSlipApp := submitSample(2, "0850000002", "g2@test.com")
	restoredApp := submitSample(3, "0850000003", "g3@test.com")
	fallbackApp := submitSample(4, "0850000004", "g4@test.com")

	// 1. Overdue unpaid applicant created 121h ago with no slip -> expires immediately.
	if err := appRepo.SetTimestampsForTest(neverPaid.ID, now.Add(-121*time.Hour), now.Add(-121*time.Hour)); err != nil {
		t.Fatal(err)
	}

	// 2. Applicant created 121h ago whose slip was just rejected via VerifySlip -> 24h grace period.
	rejectedPay := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: rejectedSlipApp.ID,
		SlipURL:     "slips/rejected-grace.jpg",
		Amount:      decimal.NewFromInt(1200),
		Status:      domain.PaymentPending,
	}
	if _, err := payRepo.CreateReplacingPending(ctx, rejectedPay); err != nil {
		t.Fatal(err)
	}
	if err := appRepo.SetTimestampsForTest(rejectedSlipApp.ID, now.Add(-121*time.Hour), now.Add(-121*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, rejectedSlipApp.ApplicationNo, rejectedPay.ID.String(), false, 1, "สลิปไม่ชัด", "127.0.0.1"); err != nil {
		t.Fatalf("VerifySlip reject failed: %v", err)
	}

	// 3. Applicant created 121h ago, rejected, then restored to PASSED by staff at `now` -> 24h grace from updated_at.
	adminID := int64(1)
	if _, err := svc.UpdateStatus(ctx, restoredApp.ApplicationNo, domain.StatusRejected, &adminID, "expired", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateStatus(ctx, restoredApp.ApplicationNo, domain.StatusPassed, &adminID, "restored", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := appRepo.SetTimestampsForTest(restoredApp.ID, now.Add(-121*time.Hour), now); err != nil {
		t.Fatal(err)
	}

	// 4. Applicant created 121h ago with updated_at=121h ago, but latest REJECTED slip has verified_at=nil and uploaded_at=10h ago.
	fallbackPay := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: fallbackApp.ID,
		SlipURL:     "slips/fallback-grace.jpg",
		Amount:      decimal.NewFromInt(1200),
		Status:      domain.PaymentRejected,
	}
	if err := payRepo.Create(ctx, fallbackPay); err != nil {
		t.Fatal(err)
	}
	if err := payRepo.SetPaymentTimestampsForTest(fallbackPay.ID, now.Add(-10*time.Hour), nil); err != nil {
		t.Fatal(err)
	}
	if err := appRepo.SetTimestampsForTest(fallbackApp.ID, now.Add(-121*time.Hour), now.Add(-121*time.Hour)); err != nil {
		t.Fatal(err)
	}

	// Sweep at now+1m: only neverPaid expires; all 3 grace-protected applicants remain PASSED.
	exp1, err := svc.ExpireOverdueUnpaid(ctx, now.Add(1*time.Minute))
	if err != nil {
		t.Fatalf("sweep at +1m failed: %v", err)
	}
	if len(exp1) != 1 || exp1[0] != neverPaid.ApplicationNo {
		t.Fatalf("expected only %s to expire at +1m, got %v", neverPaid.ApplicationNo, exp1)
	}

	// Sweep at now+15h: fallbackApp (10h + 15h = 25h > 24h) expires; rejectedSlipApp & restoredApp still protected.
	exp2, err := svc.ExpireOverdueUnpaid(ctx, now.Add(15*time.Hour))
	if err != nil {
		t.Fatalf("sweep at +15h failed: %v", err)
	}
	if len(exp2) != 1 || exp2[0] != fallbackApp.ApplicationNo {
		t.Fatalf("expected only %s to expire at +15h, got %v", fallbackApp.ApplicationNo, exp2)
	}

	// Sweep at now+23h: rejectedSlipApp & restoredApp still within 24h grace.
	exp3, err := svc.ExpireOverdueUnpaid(ctx, now.Add(23*time.Hour))
	if err != nil {
		t.Fatalf("sweep at +23h failed: %v", err)
	}
	if len(exp3) != 0 {
		t.Fatalf("expected 0 expired at +23h, got %v", exp3)
	}

	// Sweep at now+24h+1m: both rejectedSlipApp and restoredApp expire.
	exp4, err := svc.ExpireOverdueUnpaid(ctx, now.Add(24*time.Hour+1*time.Minute))
	if err != nil {
		t.Fatalf("sweep at +24h1m failed: %v", err)
	}
	if len(exp4) != 2 {
		t.Fatalf("expected 2 expired at +24h1m, got %v", exp4)
	}
}

type mockConfirmedMailer struct {
	confirmed []service.ConfirmedEmailData
}

func (m *mockConfirmedMailer) EnqueueRegistration(service.RegistrationEmailData) {}
func (m *mockConfirmedMailer) EnqueueConfirmed(d service.ConfirmedEmailData) {
	m.confirmed = append(m.confirmed, d)
}
func (m *mockConfirmedMailer) Shutdown(context.Context) error { return nil }

func TestApplicantService_UpdateStatusConfirmed_MarksAttendanceAndSendsMail(t *testing.T) {
	ctx := context.Background()
	svc, appRepo, _ := setupTestServices()
	mailer := &mockConfirmedMailer{}
	svc.WithMailer(mailer)

	res, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:  "กิตติ ยืนยัน",
		Nickname:  "กิต",
		Phone:     "0851112233",
		Email:     "kitti@example.com",
		School:    "โรงเรียนแม่โจ้วิทยาคม",
		Grade:     "ม.6",
		ShirtSize: "L",
	})
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	if res.AttendanceConfirmed {
		t.Fatal("expected initial AttendanceConfirmed=false")
	}

	adminID := int64(1)
	updated, err := svc.UpdateStatus(ctx, res.ID, domain.StatusConfirmed, &adminID, "ชำระเงินสด", "127.0.0.1")
	if err != nil {
		t.Fatalf("UpdateStatus to CONFIRMED failed: %v", err)
	}
	if !updated.AttendanceConfirmed || updated.Status != domain.StatusConfirmed {
		t.Fatalf("expected CONFIRMED + AttendanceConfirmed=true, got status=%s attendance=%v", updated.Status, updated.AttendanceConfirmed)
	}
	stored, _ := appRepo.GetByApplicationNo(ctx, res.ID)
	if !stored.AttendanceConfirmed {
		t.Fatal("expected stored applicant AttendanceConfirmed=true")
	}
	if len(mailer.confirmed) != 1 || mailer.confirmed[0].ApplicationNo != res.ID {
		t.Fatalf("expected 1 Stage 2 email enqueued, got %+v", mailer.confirmed)
	}

	// Re-submitting CONFIRMED when already CONFIRMED must not send a duplicate email.
	if _, err := svc.UpdateStatus(ctx, res.ID, domain.StatusConfirmed, &adminID, "note", "127.0.0.1"); err != nil {
		t.Fatalf("repeat UpdateStatus CONFIRMED failed: %v", err)
	}
	if len(mailer.confirmed) != 1 {
		t.Fatalf("expected no duplicate Stage 2 email when already CONFIRMED, got %d", len(mailer.confirmed))
	}
}

func TestApplicantService_AdminListIncludesPaymentNotesAndPublicHidesThem(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	svc := service.NewApplicantService(appRepo, setRepo, payRepo).WithAudit(appRepo.Audit())
	psvc := service.NewPaymentService(payRepo, appRepo, setRepo, appRepo.Audit(), t.TempDir())

	created, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName:  "นภา ทดสอบ",
		Nickname:  "ภา",
		Phone:     "0852223344",
		Email:     "napa@example.com",
		School:    "โรงเรียนยุพราช",
		Grade:     "ม.5",
		ShirtSize: "M",
	})
	if err != nil {
		t.Fatalf("submit failed: %v", err)
	}
	app, _ := appRepo.GetByApplicationNo(ctx, created.ID)
	p := &domain.Payment{
		ID:          uuid.New(),
		ApplicantID: app.ID,
		SlipURL:     "slips/note-check.jpg",
		Amount:      decimal.NewFromInt(1200),
		Status:      domain.PaymentPending,
	}
	if _, err := payRepo.CreateReplacingPending(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := psvc.VerifySlip(ctx, created.ID, p.ID.String(), false, 1, "ยอดเงินไม่ตรง", "127.0.0.1"); err != nil {
		t.Fatalf("VerifySlip reject failed: %v", err)
	}

	adminList, err := svc.ListAll(ctx, nil)
	if err != nil || len(adminList) != 1 {
		t.Fatalf("ListAll failed: len=%d err=%v", len(adminList), err)
	}
	got := adminList[0]
	if got.AdminNote == nil || *got.AdminNote != "ยอดเงินไม่ตรง" {
		t.Fatalf("expected AdminNote='ยอดเงินไม่ตรง', got %v", got.AdminNote)
	}
	if got.RejectionReason == nil || *got.RejectionReason != "ยอดเงินไม่ตรง" {
		t.Fatalf("expected RejectionReason='ยอดเงินไม่ตรง', got %v", got.RejectionReason)
	}
	if got.VerifiedAt == nil || *got.VerifiedAt == "" {
		t.Fatalf("expected VerifiedAt to be populated, got %v", got.VerifiedAt)
	}

	lookup, err := svc.QueryStatus(ctx, created.ID)
	if err != nil {
		t.Fatalf("QueryStatus failed: %v", err)
	}
	pub := lookup.ByCode
	if pub.AdminNote != nil || pub.RejectionReason != nil || pub.VerifiedAt != nil || pub.SlipURL != nil || pub.SlipPaymentID != nil {
		t.Fatalf("public status leaked admin slip metadata: %+v", pub)
	}
}
