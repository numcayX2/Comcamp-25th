package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

var (
	ErrDuplicateSlip   = errors.New("this slip has already been uploaded (duplicate slip detected)")
	ErrNotPassed       = errors.New("cannot upload slip: applicant has not passed selection")
	ErrInvalidFileType = errors.New("invalid file type: only JPG, PNG, and WebP images are allowed")
)

type PaymentService struct {
	paymentRepo domain.PaymentRepository
	appRepo     domain.ApplicantRepository
	settingRepo domain.SettingRepository
	uploadDir   string
}

func NewPaymentService(
	paymentRepo domain.PaymentRepository,
	appRepo domain.ApplicantRepository,
	settingRepo domain.SettingRepository,
	uploadDir string,
) *PaymentService {
	slipDir := filepath.Join(uploadDir, "slips")
	_ = os.MkdirAll(slipDir, 0755)
	return &PaymentService{
		paymentRepo: paymentRepo,
		appRepo:     appRepo,
		settingRepo: settingRepo,
		uploadDir:   slipDir,
	}
}

type SlipUploadResult struct {
	ID      string `json:"id"`
	SlipURL string `json:"slipUrl"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func (s *PaymentService) UploadSlip(ctx context.Context, appIdentifier string, fileData []byte, ext string) (*SlipUploadResult, error) {
	applicant, err := s.appRepo.FindByQuery(ctx, appIdentifier)
	if err != nil {
		return nil, ErrApplicantNotFound
	}

	if applicant.Status != domain.StatusPassed && applicant.Status != domain.StatusConfirmed {
		return nil, ErrNotPassed
	}

	// 1. Anti-fraud check: Compute SHA256 of the uploaded slip file
	hashBytes := sha256.Sum256(fileData)
	slipHash := hex.EncodeToString(hashBytes[:])

	isDup, _ := s.paymentRepo.CheckDuplicateSlipHash(ctx, slipHash)
	if isDup {
		return nil, ErrDuplicateSlip
	}

	// 2. Validate MIME type and File Extension
	mimeType := http.DetectContentType(fileData)
	if !strings.HasPrefix(mimeType, "image/") && mimeType != "application/octet-stream" {
		return nil, ErrInvalidFileType
	}

	cleanExt := strings.ToLower(filepath.Ext(ext))
	if cleanExt != ".jpg" && cleanExt != ".jpeg" && cleanExt != ".png" && cleanExt != ".webp" {
		cleanExt = ".jpg"
	}
	fileName := fmt.Sprintf("%s-%d%s", applicant.ApplicationNo, time.Now().Unix(), cleanExt)
	destPath := filepath.Join(s.uploadDir, fileName)
	if err := os.WriteFile(destPath, fileData, 0644); err != nil {
		return nil, fmt.Errorf("failed to save slip file: %w", err)
	}

	slipURL := "/uploads/slips/" + fileName

	// Get camp fee from settings
	campFee := decimal.NewFromFloat(0.00)
	settings, err := s.settingRepo.Get(ctx)
	if err == nil && settings != nil {
		campFee = settings.CampFee
	}

	payment := &domain.Payment{
		ID:            uuid.New(),
		ApplicantID:   applicant.ID,
		SlipURL:       slipURL,
		Amount:        campFee,
		Status:        domain.PaymentPending,
		SlipHash:      &slipHash,
		VerifiedByAPI: false,
	}

	if err := s.paymentRepo.Create(ctx, payment); err != nil {
		return nil, fmt.Errorf("failed to save payment record: %w", err)
	}

	return &SlipUploadResult{
		ID:      applicant.ApplicationNo,
		SlipURL: slipURL,
		Status:  string(applicant.Status),
		Message: "อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่",
	}, nil
}

func (s *PaymentService) VerifySlip(ctx context.Context, appIdentifier string, approved bool, adminID int64, note string) error {
	applicant, err := s.appRepo.FindByQuery(ctx, appIdentifier)
	if err != nil {
		return ErrApplicantNotFound
	}

	latestPayment, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if err != nil {
		return errors.New("no payment slip found for this applicant")
	}

	if err := s.paymentRepo.Verify(ctx, latestPayment.ID, approved, adminID, note); err != nil {
		return err
	}

	newStatus := domain.StatusConfirmed
	if !approved {
		newStatus = domain.StatusPassed // Allow re-upload
	}
	_ = s.appRepo.UpdateStatus(ctx, applicant.ID, newStatus, &adminID, note)

	return nil
}
