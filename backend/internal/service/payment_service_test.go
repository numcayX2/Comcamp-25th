package service_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
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

func makeValidJPEG(t *testing.T, r, g, b uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatalf("failed to encode jpeg: %v", err)
	}
	return buf.Bytes()
}

func makeValidPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("failed to encode png: %v", err)
	}
	return buf.Bytes()
}

func makeValidGIF(t *testing.T) []byte {
	t.Helper()
	palette := color.Palette{color.Black, color.White}
	img := image.NewPaletted(image.Rect(0, 0, 4, 4), palette)
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("failed to encode gif: %v", err)
	}
	return buf.Bytes()
}

func makeValidWebP() []byte {
	// Minimal valid RIFF/WEBP/VP8 header (>=16 bytes, detected by http.DetectContentType as image/webp)
	data := make([]byte, 24)
	copy(data[0:4], "RIFF")
	// riffSize = len(data) - 8 = 16 (little endian)
	data[4] = 16
	copy(data[8:12], "WEBP")
	copy(data[12:16], "VP8 ")
	return data
}

type failingPaymentCreateRepo struct {
	*memory.MemoryPaymentRepo
	createErr error
}

func (f *failingPaymentCreateRepo) Create(ctx context.Context, p *domain.Payment) error {
	return f.createErr
}

func setupPaymentEnv(t *testing.T, maxCapacity int) (
	*service.PaymentService,
	*memory.MemoryApplicantRepo,
	*memory.MemoryPaymentRepo,
	*memory.MemorySettingRepo,
	string,
) {
	t.Helper()
	uploadDir := t.TempDir()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	_ = setRepo.Update(context.Background(), &domain.Settings{
		ID:                  1,
		CampName:            "ComCamp 25th",
		RegistrationOpenAt:  time.Now().Add(-time.Hour),
		RegistrationCloseAt: time.Now().Add(time.Hour),
		MaxCapacity:         maxCapacity,
		CampFee:             decimal.NewFromInt(300),
	})
	appRepo.SetSettingRepo(setRepo)
	payRepo := memory.NewMemoryPaymentRepoWithSettings(appRepo, setRepo)
	paySvc := service.NewPaymentService(payRepo, appRepo, setRepo, uploadDir)
	return paySvc, appRepo, payRepo, setRepo, uploadDir
}

func createApplicantWithStatus(t *testing.T, repo *memory.MemoryApplicantRepo, appNo, nid, phone string, status domain.ApplicationStatus) *domain.Applicant {
	t.Helper()
	a := &domain.Applicant{
		ID:               uuid.New(),
		ApplicationNo:    appNo,
		NationalID:       nid,
		FirstName:        "ทดสอบ",
		LastName:         "สลิป",
		Nickname:         "เทส",
		BirthDate:        time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC),
		Gender:           "unspecified",
		School:           "โรงเรียนทดสอบ",
		Grade:            "ม.5",
		Phone:            phone,
		Email:            appNo + "@example.com",
		Province:         "เชียงใหม่",
		EmergencyContact: "ผู้ปกครอง",
		EmergencyPhone:   phone,
		ShirtSize:        "M",
		Status:           status,
	}
	if err := repo.Create(context.Background(), a); err != nil {
		t.Fatalf("failed to create applicant: %v", err)
	}
	return a
}

func countFilesInDir(t *testing.T, dir string) int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s) failed: %v", dir, err)
	}
	return len(entries)
}

func TestPaymentService_UploadSlip_FormatsAndValidation(t *testing.T) {
	ctx := context.Background()
	paySvc, appRepo, _, _, uploadDir := setupPaymentEnv(t, 30)
	slipsDir := filepath.Join(uploadDir, "slips")

	passedApp := createApplicantWithStatus(t, appRepo, "CC25-PASS01", "1111111111111", "0811111111", domain.StatusPassed)

	t.Run("accepts valid JPEG, PNG, GIF, WebP and lowercase appNo", func(t *testing.T) {
		samples := []struct {
			name string
			data []byte
			ext  string
		}{
			{"slip.jpg", makeValidJPEG(t, 10, 20, 30), ".jpg"},
			{"slip.png", makeValidPNG(t), ".png"},
			{"slip.gif", makeValidGIF(t), ".gif"},
			{"slip.webp", makeValidWebP(), ".webp"},
		}
		for _, sample := range samples {
			res, err := paySvc.UploadSlip(ctx, strings.ToLower(passedApp.ApplicationNo), sample.data, sample.name)
			if err != nil {
				t.Fatalf("expected %s to succeed, got %v", sample.name, err)
			}
			if !strings.HasSuffix(res.SlipURL, sample.ext) {
				t.Errorf("expected SlipURL suffix %s, got %s", sample.ext, res.SlipURL)
			}
		}
	})

	t.Run("rejects empty, oversized, fake JPEG, octet-stream, and bad extensions without saving file", func(t *testing.T) {
		beforeCount := countFilesInDir(t, slipsDir)

		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, nil, "empty.jpg"); !errors.Is(err, service.ErrInvalidFileType) {
			t.Errorf("expected ErrInvalidFileType for empty data, got %v", err)
		}

		tooBig := make([]byte, (5<<20)+1)
		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, tooBig, "huge.jpg"); !errors.Is(err, service.ErrSlipTooLarge) {
			t.Errorf("expected ErrSlipTooLarge, got %v", err)
		}

		// Fake JPEG header (not decodable by image.DecodeConfig)
		fakeJPEG := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x01, 0x00, 0x48}
		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, fakeJPEG, "fake.jpg"); !errors.Is(err, service.ErrInvalidFileType) {
			t.Errorf("expected ErrInvalidFileType for corrupt/fake jpeg, got %v", err)
		}

		// application/octet-stream disguised as .jpg
		octet := []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07}
		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, octet, "payload.jpg"); !errors.Is(err, service.ErrInvalidFileType) {
			t.Errorf("expected ErrInvalidFileType for octet-stream, got %v", err)
		}

		// Disallowed extension even with valid JPEG bytes
		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, makeValidJPEG(t, 1, 2, 3), "script.html"); !errors.Is(err, service.ErrInvalidFileType) {
			t.Errorf("expected ErrInvalidFileType for .html extension, got %v", err)
		}

		if afterCount := countFilesInDir(t, slipsDir); afterCount != beforeCount {
			t.Errorf("expected no orphaned disk files on validation failures: before=%d after=%d", beforeCount, afterCount)
		}
	})

	t.Run("rejects non-PASSED applicant statuses", func(t *testing.T) {
		statuses := []domain.ApplicationStatus{
			domain.StatusPending,
			domain.StatusReserve,
			domain.StatusRejected,
			domain.StatusConfirmed,
		}
		validImg := makeValidJPEG(t, 50, 60, 70)
		for i, st := range statuses {
			a := createApplicantWithStatus(
				t,
				appRepo,
				fmt.Sprintf("CC25-ST%02d", i),
				fmt.Sprintf("22222222222%02d", i),
				fmt.Sprintf("08222222%02d", i),
				st,
			)
			if _, err := paySvc.UploadSlip(ctx, a.ApplicationNo, validImg, "slip.jpg"); !errors.Is(err, service.ErrCannotUploadSlip) {
				t.Errorf("status %s: expected ErrCannotUploadSlip, got %v", st, err)
			}
		}
	})

	t.Run("duplicate slip_hash returns ErrDuplicateSlip and leaves no orphaned file", func(t *testing.T) {
		dupImg := makeValidJPEG(t, 99, 88, 77)
		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, dupImg, "first.jpg"); err != nil {
			t.Fatalf("first upload failed: %v", err)
		}
		countAfterFirst := countFilesInDir(t, slipsDir)

		if _, err := paySvc.UploadSlip(ctx, passedApp.ApplicationNo, dupImg, "second.jpg"); !errors.Is(err, service.ErrDuplicateSlip) {
			t.Fatalf("expected ErrDuplicateSlip, got %v", err)
		}
		if countAfterSecond := countFilesInDir(t, slipsDir); countAfterSecond != countAfterFirst {
			t.Errorf("expected no orphaned file after duplicate slip: want %d, got %d", countAfterFirst, countAfterSecond)
		}
	})

	t.Run("disk file is removed if paymentRepo.Create fails", func(t *testing.T) {
		failDir := t.TempDir()
		_, _, basePayRepo, setRepo, _ := setupPaymentEnv(t, 30)
		a := createApplicantWithStatus(t, appRepo, "CC25-FAIL01", "3333333333331", "0833333331", domain.StatusPassed)
		failSvc := service.NewPaymentService(
			&failingPaymentCreateRepo{MemoryPaymentRepo: basePayRepo, createErr: domain.ErrDuplicateSlip},
			appRepo,
			setRepo,
			failDir,
		)
		if _, err := failSvc.UploadSlip(ctx, a.ApplicationNo, makeValidJPEG(t, 12, 34, 56), "slip.jpg"); !errors.Is(err, service.ErrDuplicateSlip) {
			t.Fatalf("expected ErrDuplicateSlip, got %v", err)
		}
		if got := countFilesInDir(t, filepath.Join(failDir, "slips")); got != 0 {
			t.Errorf("expected 0 orphaned files when Create fails, got %d", got)
		}
	})
}

func TestPaymentService_ConcurrentUploads(t *testing.T) {
	ctx := context.Background()
	paySvc, appRepo, _, _, uploadDir := setupPaymentEnv(t, 30)
	slipsDir := filepath.Join(uploadDir, "slips")

	a1 := createApplicantWithStatus(t, appRepo, "CC25-CONC01", "4444444444441", "0844444441", domain.StatusPassed)
	a2 := createApplicantWithStatus(t, appRepo, "CC25-CONC02", "4444444444442", "0844444442", domain.StatusPassed)

	// Same slip bytes uploaded concurrently -> exactly 1 succeeds, others get ErrDuplicateSlip, only 1 file on disk
	sameBytes := makeValidJPEG(t, 200, 100, 50)
	const workers = 6
	var wg sync.WaitGroup
	errs := make(chan error, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			target := a1.ApplicationNo
			if idx%2 == 1 {
				target = a2.ApplicationNo
			}
			_, err := paySvc.UploadSlip(ctx, target, sameBytes, "concurrent.jpg")
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	successCount := 0
	dupCount := 0
	for err := range errs {
		if err == nil {
			successCount++
		} else if errors.Is(err, service.ErrDuplicateSlip) {
			dupCount++
		} else {
			t.Errorf("unexpected concurrent error: %v", err)
		}
	}
	if successCount != 1 || dupCount != workers-1 {
		t.Errorf("expected 1 success and %d duplicate errors, got success=%d dup=%d", workers-1, successCount, dupCount)
	}
	if files := countFilesInDir(t, slipsDir); files != 1 {
		t.Errorf("expected exactly 1 file on disk after concurrent duplicate upload, got %d", files)
	}
}

func TestPaymentService_VerifySlip_ApproveRejectAndCapacity(t *testing.T) {
	ctx := context.Background()
	paySvc, appRepo, payRepo, _, _ := setupPaymentEnv(t, 1)

	a1 := createApplicantWithStatus(t, appRepo, "CC25-VER01", "5555555555551", "0855555551", domain.StatusPassed)
	a2 := createApplicantWithStatus(t, appRepo, "CC25-VER02", "5555555555552", "0855555552", domain.StatusPassed)

	if _, err := paySvc.UploadSlip(ctx, a1.ApplicationNo, makeValidJPEG(t, 1, 1, 1), "s1.jpg"); err != nil {
		t.Fatalf("upload a1 failed: %v", err)
	}

	// Reject slip -> PaymentRejected, applicant stays PASSED
	if err := paySvc.VerifySlip(ctx, a1.ApplicationNo, false, 1, "ยอดไม่ตรง"); err != nil {
		t.Fatalf("VerifySlip reject failed: %v", err)
	}
	gotA1, _ := appRepo.GetByID(ctx, a1.ID)
	if gotA1.Status != domain.StatusPassed {
		t.Errorf("expected a1 status PASSED after slip rejection, got %s", gotA1.Status)
	}
	latestA1, _ := payRepo.GetLatestByApplicantID(ctx, a1.ID)
	if latestA1.Status != domain.PaymentRejected || latestA1.RejectionReason == nil || *latestA1.RejectionReason != "ยอดไม่ตรง" {
		t.Errorf("expected REJECTED payment with note, got %+v", latestA1)
	}

	// Re-verify guard -> ErrPaymentAlreadyVerified
	if err := paySvc.VerifySlip(ctx, a1.ApplicationNo, true, 1, "retry"); !errors.Is(err, service.ErrPaymentAlreadyVerified) {
		t.Errorf("expected ErrPaymentAlreadyVerified, got %v", err)
	}

	// Re-upload for a1 and approve -> CONFIRMED
	time.Sleep(2 * time.Millisecond)
	if _, err := paySvc.UploadSlip(ctx, a1.ApplicationNo, makeValidJPEG(t, 2, 2, 2), "s1b.jpg"); err != nil {
		t.Fatalf("re-upload a1 failed: %v", err)
	}
	if err := paySvc.VerifySlip(ctx, a1.ApplicationNo, true, 1, "ok"); err != nil {
		t.Fatalf("VerifySlip approve failed: %v", err)
	}
	gotA1Confirmed, _ := appRepo.GetByID(ctx, a1.ID)
	if gotA1Confirmed.Status != domain.StatusConfirmed || !gotA1Confirmed.AttendanceConfirmed {
		t.Errorf("expected a1 CONFIRMED + attendanceConfirmed=true, got %+v", gotA1Confirmed)
	}

	// a2 uploads and admin tries to approve when max_capacity=1 is full -> ErrQuotaExceeded
	if _, err := paySvc.UploadSlip(ctx, a2.ApplicationNo, makeValidJPEG(t, 3, 3, 3), "s2.jpg"); err != nil {
		t.Fatalf("upload a2 failed: %v", err)
	}
	if err := paySvc.VerifySlip(ctx, a2.ApplicationNo, true, 1, "approve over cap"); !errors.Is(err, service.ErrQuotaExceeded) {
		t.Errorf("expected ErrQuotaExceeded when maxCapacity=1 is reached, got %v", err)
	}

	// Invalid adminID rejected
	if err := paySvc.VerifySlip(ctx, a2.ApplicationNo, true, 0, "no admin"); err == nil {
		t.Errorf("expected error for adminID <= 0")
	}
}
