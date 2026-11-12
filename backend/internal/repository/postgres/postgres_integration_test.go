package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/postgres"
)

const testDSN = "host=127.0.0.1 port=5432 user=comcamp password=change_this_strong_password dbname=comcamp_db sslmode=disable"

func TestPostgres_FullIntegration(t *testing.T) {
	cfg := repository.DefaultPoolConfig(testDSN)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := repository.NewPool(ctx, cfg)
	if err != nil {
		t.Skipf("Skipping real database test: PostgreSQL not available (%v)", err)
		return
	}
	defer pool.Close()

	appRepo := postgres.NewApplicantPostgresRepo(pool)
	setRepo := postgres.NewSettingPostgresRepo(pool)
	admRepo := postgres.NewAdminPostgresRepo(pool)
	payRepo := postgres.NewPaymentPostgresRepo(pool)

	var testAdminID int64
	applicantID := uuid.New()
	applicantBlankEmail1ID := uuid.New()
	applicantBlankEmail2ID := uuid.New()
	var origSettings *domain.Settings

	t.Cleanup(func() {
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanCancel()
		if origSettings != nil {
			_ = setRepo.Update(cleanCtx, origSettings)
		}
		for _, id := range []uuid.UUID{applicantID, applicantBlankEmail1ID, applicantBlankEmail2ID} {
			_, _ = pool.Exec(cleanCtx, `DELETE FROM payments WHERE applicant_id = $1`, id)
			_, _ = pool.Exec(cleanCtx, `DELETE FROM applicant_status_logs WHERE applicant_id = $1`, id)
			_, _ = pool.Exec(cleanCtx, `DELETE FROM applicants WHERE id = $1`, id)
		}
		if testAdminID > 0 {
			_, _ = pool.Exec(cleanCtx, `DELETE FROM admins WHERE id = $1`, testAdminID)
		}
	})

	// 1. Test Settings Get & Update
	t.Run("1. Settings Get and Update", func(t *testing.T) {
		settings, err := setRepo.Get(ctx)
		if err != nil {
			t.Fatalf("failed to get settings: %v", err)
		}
		copied := *settings
		origSettings = &copied

		if settings.CampName != "ComCamp 25th" {
			t.Errorf("expected camp name 'ComCamp 25th', got '%s'", settings.CampName)
		}
		if settings.MaxCapacity != 30 {
			t.Errorf("expected max capacity 30, got %d", settings.MaxCapacity)
		}

		updated := *settings
		updated.MaxCapacity = 45
		if err := setRepo.Update(ctx, &updated); err != nil {
			t.Fatalf("failed to update settings: %v", err)
		}
		reloaded, err := setRepo.Get(ctx)
		if err != nil || reloaded.MaxCapacity != 45 {
			t.Fatalf("expected updated MaxCapacity=45, got %v (%v)", reloaded, err)
		}
		if err := setRepo.Update(ctx, origSettings); err != nil {
			t.Fatalf("failed to restore settings: %v", err)
		}
	})

	// 2. Test Admin Creation, Lookup & Count
	testUsername := "test_admin_" + uuid.New().String()[:8]
	t.Run("2. Admin Create, Lookup, and Count", func(t *testing.T) {
		admin := &domain.Admin{
			Username:     testUsername,
			PasswordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz123456",
			FullName:     "พี่ค่ายทดสอบ",
			Role:         domain.RoleAdmin,
			IsActive:     true,
		}
		if err := admRepo.Create(ctx, admin); err != nil {
			t.Fatalf("failed to create admin: %v", err)
		}
		testAdminID = admin.ID

		queried, err := admRepo.GetByUsername(ctx, testUsername)
		if err != nil {
			t.Fatalf("failed to get admin by username: %v", err)
		}
		if queried.FullName != "พี่ค่ายทดสอบ" {
			t.Errorf("expected full name 'พี่ค่ายทดสอบ', got '%s'", queried.FullName)
		}
		if err := admRepo.UpdateLastLogin(ctx, testAdminID); err != nil {
			t.Errorf("failed to update last login: %v", err)
		}
		if cnt, err := admRepo.Count(ctx); err != nil || cnt < 1 {
			t.Errorf("expected admin count >= 1, got %d (%v)", cnt, err)
		}
	})

	// 3. Test Applicant Lifecycle, Blank Emails, FindByIDOrAppNo, ListAll, CountConfirmed
	testNationalID := "15099" + uuid.New().String()[:8]
	testPhone := "08" + uuid.New().String()[:8]
	testAppNo := "CC25-" + uuid.New().String()[:6]

	t.Run("3. Applicant Insert, Query, Blank Emails, ListAll, CountConfirmed", func(t *testing.T) {
		mot := "อยากเรียนรู้ Hardware IoT และ AI Dashboard"
		applicant := &domain.Applicant{
			ID:                  applicantID,
			ApplicationNo:       testAppNo,
			NationalID:          testNationalID,
			Prefix:              "นาย",
			FirstName:           "ณัฐนนท์",
			LastName:            "ปัญญารักษ์",
			Nickname:            "นนท์",
			BirthDate:           time.Date(2008, 5, 20, 0, 0, 0, 0, time.UTC),
			Gender:              "male",
			School:              "โรงเรียนแม่โจ้วิทยาคม",
			Grade:               "ม.5",
			Phone:               testPhone,
			Email:               testAppNo + "@student.ac.th",
			Province:            "เชียงใหม่",
			EmergencyContact:    "มารดา",
			EmergencyPhone:      "0899998888",
			ShirtSize:           "L",
			HasLaptop:           true,
			Motivation:          &mot,
			Status:              domain.StatusPending,
			AttendanceConfirmed: false,
		}

		if err := appRepo.Create(ctx, applicant); err != nil {
			t.Fatalf("failed to insert applicant into real PostgreSQL: %v", err)
		}

		// Two applicants with blank email should both succeed
		for i, id := range []uuid.UUID{applicantBlankEmail1ID, applicantBlankEmail2ID} {
			blankApp := &domain.Applicant{
				ID:               id,
				ApplicationNo:    "CC25-BL" + uuid.New().String()[:4],
				NationalID:       "16099" + uuid.New().String()[:8],
				FirstName:        "ทดสอบ",
				LastName:         "ไม่มีเมล",
				Nickname:         "บี",
				BirthDate:        time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC),
				Gender:           "unspecified",
				School:           "โรงเรียนทดสอบ",
				Grade:            "ม.4",
				Phone:            "09" + uuid.New().String()[:8],
				Email:            "",
				Province:         "เชียงใหม่",
				EmergencyContact: "ผู้ปกครอง",
				EmergencyPhone:   "0811112222",
				ShirtSize:        "M",
				Status:           domain.StatusPending,
			}
			if err := appRepo.Create(ctx, blankApp); err != nil {
				t.Fatalf("blank email applicant %d failed: %v", i+1, err)
			}
		}

		byID, err := appRepo.GetByID(ctx, applicantID)
		if err != nil {
			t.Fatalf("failed to query applicant by ID: %v", err)
		}
		if byID.NationalID != testNationalID {
			t.Errorf("expected national ID %s, got %s", testNationalID, byID.NationalID)
		}

		// FindByIDOrAppNo supports UUID and lowercase appNo, not nationalID/phone
		if byAppNoLower, err := appRepo.FindByIDOrAppNo(ctx, strings.ToLower(testAppNo)); err != nil || byAppNoLower.ID != applicantID {
			t.Errorf("expected FindByIDOrAppNo lowercase match, got %v (%v)", byAppNoLower, err)
		}
		if _, err := appRepo.FindByIDOrAppNo(ctx, testNationalID); !errors.Is(err, domain.ErrApplicantNotFound) {
			t.Errorf("expected FindByIDOrAppNo not to match national ID, got %v", err)
		}

		byQuery, err := appRepo.FindByQuery(ctx, testAppNo)
		if err != nil || byQuery.ID != applicantID {
			t.Fatalf("failed to query applicant by appNo: %v", err)
		}

		if err := appRepo.UpdateAttendance(ctx, applicantID, true); err != nil {
			t.Fatalf("failed to update attendance: %v", err)
		}
		if err := appRepo.UpdateStatus(ctx, applicantID, domain.StatusPassed, &testAdminID, "ผ่านสัมภาษณ์รอบแรก"); err != nil {
			t.Fatalf("failed to update status: %v", err)
		}

		passedStatus := domain.StatusPassed
		passedList, err := appRepo.ListAll(ctx, &passedStatus)
		if err != nil {
			t.Fatalf("ListAll failed: %v", err)
		}
		found := false
		for _, item := range passedList {
			if item.ID == applicantID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected applicant %s in ListAll(PASSED)", applicantID)
		}

		if _, err := appRepo.CountActive(ctx); err != nil {
			t.Errorf("CountActive failed: %v", err)
		}
		if _, err := appRepo.CountConfirmed(ctx); err != nil {
			t.Errorf("CountConfirmed failed: %v", err)
		}
	})

	// 4. Test Payment & Verification Flow (approved=false then approved=true + GetLatestByApplicantIDs)
	t.Run("4. Payment Insert, Reject, Approve, and Batch Lookup", func(t *testing.T) {
		rejectedPaymentID := uuid.New()
		slipHash1 := "sha256_" + uuid.New().String()
		transRef1 := "KBANK_" + uuid.New().String()

		p1 := &domain.Payment{
			ID:            rejectedPaymentID,
			ApplicantID:   applicantID,
			SlipURL:       "/uploads/slips/test_slip_1.jpg",
			Amount:        decimal.NewFromFloat(300.00),
			Status:        domain.PaymentPending,
			TransRef:      &transRef1,
			SlipHash:      &slipHash1,
			VerifiedByAPI: false,
		}
		if err := payRepo.Create(ctx, p1); err != nil {
			t.Fatalf("failed to insert payment into PostgreSQL: %v", err)
		}

		isDup, err := payRepo.CheckDuplicateSlipHash(ctx, slipHash1)
		if err != nil || !isDup {
			t.Fatalf("expected duplicate check true, got %v (%v)", isDup, err)
		}

		// Verify with approved=false -> PaymentRejected, applicant stays PASSED
		if err := payRepo.Verify(ctx, rejectedPaymentID, false, testAdminID, "สลิปไม่ชัดเจน"); err != nil {
			t.Fatalf("failed to reject payment: %v", err)
		}
		gotRejected, err := payRepo.GetByID(ctx, rejectedPaymentID)
		if err != nil || gotRejected.Status != domain.PaymentRejected {
			t.Fatalf("expected PaymentRejected, got %v (%v)", gotRejected, err)
		}
		if gotRejected.RejectionReason == nil || *gotRejected.RejectionReason != "สลิปไม่ชัดเจน" {
			t.Errorf("expected rejection_reason to be persisted, got %v", gotRejected.RejectionReason)
		}
		stillPassed, _ := appRepo.GetByID(ctx, applicantID)
		if stillPassed.Status != domain.StatusPassed {
			t.Errorf("expected applicant to remain PASSED on rejection, got %s", stillPassed.Status)
		}

		// Re-verify guard
		if err := payRepo.Verify(ctx, rejectedPaymentID, true, testAdminID, "retry"); !errors.Is(err, domain.ErrPaymentAlreadyVerified) {
			t.Errorf("expected ErrPaymentAlreadyVerified, got %v", err)
		}

		// Second upload & approve -> CONFIRMED
		approvedPaymentID := uuid.New()
		slipHash2 := "sha256_" + uuid.New().String()
		transRef2 := "KBANK_" + uuid.New().String()
		time.Sleep(5 * time.Millisecond)
		p2 := &domain.Payment{
			ID:            approvedPaymentID,
			ApplicantID:   applicantID,
			SlipURL:       "/uploads/slips/test_slip_2.jpg",
			Amount:        decimal.NewFromFloat(300.00),
			Status:        domain.PaymentPending,
			TransRef:      &transRef2,
			SlipHash:      &slipHash2,
			VerifiedByAPI: false,
		}
		if err := payRepo.Create(ctx, p2); err != nil {
			t.Fatalf("failed to insert second payment: %v", err)
		}

		if err := payRepo.Verify(ctx, approvedPaymentID, true, testAdminID, "ยอดเงินเข้าบัญชีเรียบร้อย"); err != nil {
			t.Fatalf("failed to verify payment: %v", err)
		}

		confirmedApp, err := appRepo.GetByID(ctx, applicantID)
		if err != nil {
			t.Fatalf("failed to get applicant: %v", err)
		}
		if confirmedApp.Status != domain.StatusConfirmed || !confirmedApp.AttendanceConfirmed {
			t.Errorf("expected applicant CONFIRMED + attendance_confirmed=true, got %s (%v)", confirmedApp.Status, confirmedApp.AttendanceConfirmed)
		}

		latestByIDs, err := payRepo.GetLatestByApplicantIDs(ctx, []uuid.UUID{applicantID, applicantBlankEmail1ID})
		if err != nil {
			t.Fatalf("GetLatestByApplicantIDs failed: %v", err)
		}
		if latestByIDs[applicantID] == nil || latestByIDs[applicantID].ID != approvedPaymentID {
			t.Errorf("expected latest payment for %s to be %s, got %+v", applicantID, approvedPaymentID, latestByIDs[applicantID])
		}
	})
}
