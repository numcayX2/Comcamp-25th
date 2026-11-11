package postgres_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/postgres"
)

// testDSN comes from the environment so no database password lives in the repository.
// Example: TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=... dbname=comcamp_db sslmode=disable"
var testDSN = os.Getenv("TEST_DATABASE_DSN")

func setupRealDB(t *testing.T) *postgres.ApplicantPostgresRepo {
	t.Helper()
	if testDSN == "" {
		t.Skip("Skipping integration test: TEST_DATABASE_DSN is not set")
	}

	cfg := repository.DefaultPoolConfig(testDSN)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	pool, err := repository.NewPool(ctx, cfg)
	if err != nil {
		t.Skipf("Skipping integration test: PostgreSQL is not reachable (%v)", err)
		return nil
	}
	t.Cleanup(func() {
		pool.Close()
	})

	return postgres.NewApplicantPostgresRepo(pool)
}

func TestPostgres_FullIntegration(t *testing.T) {
	if testDSN == "" {
		t.Skip("Skipping real database test: TEST_DATABASE_DSN is not set")
	}
	cfg := repository.DefaultPoolConfig(testDSN)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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

	// 1. Test Settings
	t.Run("1. Settings Get", func(t *testing.T) {
		settings, err := setRepo.Get(ctx)
		if err != nil {
			t.Fatalf("failed to get settings: %v", err)
		}
		if settings.CampName != "ComCamp 25th" {
			t.Errorf("expected camp name 'ComCamp 25th', got '%s'", settings.CampName)
		}
		if settings.MaxCapacity != 30 {
			t.Errorf("expected max capacity 30, got %d", settings.MaxCapacity)
		}
	})

	// 2. Test Admin Creation & Lookup
	var testAdminID int64
	testUsername := "test_admin_" + uuid.New().String()[:8]
	t.Run("2. Admin Create and Lookup", func(t *testing.T) {
		admin := &domain.Admin{
			Username:     testUsername,
			PasswordHash: "$2a$10$abcdefghijklmnopqrstuvwxyz123456",
			FullName:     "พี่ค่ายทดสอบ",
			Role:         domain.RoleSuperadmin,
			IsActive:     true,
		}
		err := admRepo.Create(ctx, admin)
		if err != nil {
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

		err = admRepo.UpdateLastLogin(ctx, testAdminID)
		if err != nil {
			t.Errorf("failed to update last login: %v", err)
		}
	})

	// 3. Test Applicant Lifecycle
	testNationalID := "15099" + uuid.New().String()[:8]
	testPhone := "08" + uuid.New().String()[:8]
	testAppNo := "CC25-" + uuid.New().String()[:6]
	applicantID := uuid.New()

	t.Run("3. Applicant Insert and Query", func(t *testing.T) {
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

		err := appRepo.Create(ctx, applicant)
		if err != nil {
			t.Fatalf("failed to insert applicant into real PostgreSQL: %v", err)
		}

		// Query by ID
		byID, err := appRepo.GetByID(ctx, applicantID)
		if err != nil {
			t.Fatalf("failed to query applicant by ID: %v", err)
		}
		if byID.NationalID != testNationalID {
			t.Errorf("expected national ID %s, got %s", testNationalID, byID.NationalID)
		}

		// Query by Search Query
		byQuery, err := appRepo.FindByQuery(ctx, testAppNo)
		if err != nil {
			t.Fatalf("failed to query applicant by appNo: %v", err)
		}
		if byQuery.ID != applicantID {
			t.Errorf("expected ID %v, got %v", applicantID, byQuery.ID)
		}

		// Attendance cannot be recorded while the application is still PENDING
		if err := appRepo.UpdateAttendance(ctx, applicantID, true, nil); !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("attendance while PENDING: expected ErrStateConflict, got %v", err)
		}

		// Update Status with Audit Log
		err = appRepo.UpdateStatus(ctx, applicantID, domain.StatusPassed, &testAdminID, "ผ่านสัมภาษณ์รอบแรก", &domain.AuditEntry{AdminID: &testAdminID, Action: domain.AuditStatusUpdate, TargetType: domain.AuditTargetApplicant, TargetID: "integration-test", IPAddress: "127.0.0.1"})
		if err != nil {
			t.Fatalf("failed to update status: %v", err)
		}

		// Update Attendance (allowed once PASSED)
		if err := appRepo.UpdateAttendance(ctx, applicantID, true, nil); err != nil {
			t.Fatalf("failed to update attendance: %v", err)
		}

		updatedApp, _ := appRepo.GetByID(ctx, applicantID)
		if updatedApp.Status != domain.StatusPassed {
			t.Errorf("expected status PASSED, got %s", updatedApp.Status)
		}
		if !updatedApp.AttendanceConfirmed {
			t.Errorf("expected attendance to be confirmed")
		}
	})

	// 4. Test Payment & Verification Flow
	t.Run("4. Payment Insert, Anti-Fraud Hash, and Verification", func(t *testing.T) {
		paymentID := uuid.New()
		slipHash := "sha256_" + uuid.New().String()
		transRef := "KBANK_" + uuid.New().String()

		payment := &domain.Payment{
			ID:            paymentID,
			ApplicantID:   applicantID,
			SlipURL:       "/uploads/slips/test_slip.jpg",
			Amount:        decimal.NewFromFloat(300.00),
			Status:        domain.PaymentPending,
			TransRef:      &transRef,
			SlipHash:      &slipHash,
			VerifiedByAPI: false,
		}

		err := payRepo.Create(ctx, payment)
		if err != nil {
			t.Fatalf("failed to insert payment into PostgreSQL: %v", err)
		}

		// Check Duplicate Hash
		isDup, err := payRepo.CheckDuplicateSlipHash(ctx, slipHash)
		if err != nil {
			t.Fatalf("failed to check duplicate slip hash: %v", err)
		}
		if !isDup {
			t.Errorf("expected duplicate check to return true")
		}

		// Admin Verifies Payment -> Applicant status automatically becomes CONFIRMED
		err = payRepo.Verify(ctx, paymentID, true, testAdminID, "ยอดเงินเข้าบัญชีเรียบร้อย", &domain.AuditEntry{AdminID: &testAdminID, Action: domain.AuditSlipVerify, TargetType: domain.AuditTargetApplicant, TargetID: "integration-test", IPAddress: "127.0.0.1"})
		if err != nil {
			t.Fatalf("failed to verify payment: %v", err)
		}

		confirmedApp, err := appRepo.GetByID(ctx, applicantID)
		if err != nil {
			t.Fatalf("failed to get applicant: %v", err)
		}
		if confirmedApp.Status != domain.StatusConfirmed {
			t.Errorf("expected applicant status to become CONFIRMED, got %s", confirmedApp.Status)
		}
	})

	// 5. Cleanup test data
	t.Run("5. Cleanup test records", func(t *testing.T) {
		_, _ = pool.Exec(ctx, `DELETE FROM payments WHERE applicant_id = $1`, applicantID)
		_, _ = pool.Exec(ctx, `DELETE FROM applicant_status_logs WHERE applicant_id = $1`, applicantID)
		_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE target_id = 'integration-test'`)
		_, _ = pool.Exec(ctx, `DELETE FROM applicants WHERE id = $1`, applicantID)
		_, _ = pool.Exec(ctx, `DELETE FROM admins WHERE id = $1`, testAdminID)
	})
}
