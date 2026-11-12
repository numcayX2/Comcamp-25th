package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

const maxSlipFileSizeBytes = 5 << 20 // 5MB

var (
	ErrDuplicateSlip          = domain.ErrDuplicateSlip
	ErrPaymentNotFound        = domain.ErrPaymentNotFound
	ErrPaymentAlreadyVerified = domain.ErrPaymentAlreadyVerified
	ErrApplicantRejected      = errors.New("cannot upload slip: applicant has been rejected")
	ErrCannotUploadSlip       = errors.New("cannot upload slip: applicant must be in PASSED status")
	ErrInvalidFileType        = errors.New("invalid file type: only valid JPG, PNG, GIF, and WebP images are allowed")
	ErrSlipTooLarge           = errors.New("slip file size exceeds 5MB limit")
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
	_ = os.MkdirAll(slipDir, 0750)
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

func (s *PaymentService) UploadSlip(ctx context.Context, appIdentifier string, fileData []byte, originalFilename string) (*SlipUploadResult, error) {
	if len(fileData) == 0 {
		return nil, ErrInvalidFileType
	}
	if len(fileData) > maxSlipFileSizeBytes {
		return nil, ErrSlipTooLarge
	}

	applicant, err := s.appRepo.FindByIDOrAppNo(ctx, appIdentifier)
	if err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		return nil, fmt.Errorf("failed to find applicant: %w", err)
	}

	if applicant.Status != domain.StatusPassed {
		return nil, ErrCannotUploadSlip
	}

	canonicalExt, err := validateSlipImage(fileData, originalFilename)
	if err != nil {
		return nil, err
	}

	// Anti-fraud check: Compute SHA-256 of the uploaded slip file.
	hashBytes := sha256.Sum256(fileData)
	slipHash := hex.EncodeToString(hashBytes[:])

	isDup, err := s.paymentRepo.CheckDuplicateSlipHash(ctx, slipHash)
	if err != nil {
		return nil, fmt.Errorf("failed to verify duplicate slip hash: %w", err)
	}
	if isDup {
		return nil, ErrDuplicateSlip
	}

	settings, err := s.settingRepo.Get(ctx)
	if err != nil || settings == nil {
		return nil, fmt.Errorf("failed to load camp settings: %w", err)
	}

	randBytes := make([]byte, 16)
	if _, err := rand.Read(randBytes); err != nil {
		return nil, fmt.Errorf("failed to generate slip filename: %w", err)
	}
	fileName := fmt.Sprintf("CC25-%s%s", hex.EncodeToString(randBytes), canonicalExt)

	if err := os.MkdirAll(s.uploadDir, 0750); err != nil {
		return nil, fmt.Errorf("failed to prepare upload directory: %w", err)
	}

	destPath := filepath.Join(s.uploadDir, fileName)
	if err := os.WriteFile(destPath, fileData, 0640); err != nil {
		return nil, fmt.Errorf("failed to save slip file: %w", err)
	}

	slipURL := "/uploads/slips/" + fileName
	payment := &domain.Payment{
		ID:            uuid.New(),
		ApplicantID:   applicant.ID,
		SlipURL:       slipURL,
		Amount:        settings.CampFee,
		Status:        domain.PaymentPending,
		SlipHash:      &slipHash,
		VerifiedByAPI: false,
	}

	if err := s.paymentRepo.Create(ctx, payment); err != nil {
		_ = os.Remove(destPath)
		if errors.Is(err, domain.ErrDuplicateSlip) {
			return nil, ErrDuplicateSlip
		}
		if errors.Is(err, domain.ErrDuplicateTransRef) {
			return nil, domain.ErrDuplicateTransRef
		}
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
	if adminID <= 0 {
		return errors.New("valid admin ID is required")
	}

	applicant, err := s.appRepo.FindByIDOrAppNo(ctx, appIdentifier)
	if err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return ErrApplicantNotFound
		}
		return fmt.Errorf("failed to find applicant: %w", err)
	}

	latestPayment, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if err != nil {
		if errors.Is(err, domain.ErrPaymentNotFound) {
			return ErrPaymentNotFound
		}
		return fmt.Errorf("failed to load payment slip: %w", err)
	}

	if err := s.paymentRepo.Verify(ctx, latestPayment.ID, approved, adminID, strings.TrimSpace(note)); err != nil {
		return err
	}

	return nil
}

func validateSlipImage(fileData []byte, originalFilename string) (string, error) {
	if rawExt := strings.ToLower(filepath.Ext(strings.TrimSpace(originalFilename))); rawExt != "" {
		switch rawExt {
		case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		default:
			return "", ErrInvalidFileType
		}
	}

	mimeType := http.DetectContentType(fileData)
	switch mimeType {
	case "image/jpeg", "image/png", "image/gif":
		_, format, err := image.DecodeConfig(bytes.NewReader(fileData))
		if err != nil {
			return "", ErrInvalidFileType
		}
		switch format {
		case "jpeg":
			return ".jpg", nil
		case "png":
			return ".png", nil
		case "gif":
			return ".gif", nil
		default:
			return "", ErrInvalidFileType
		}
	case "image/webp":
		if !isValidWebP(fileData) {
			return "", ErrInvalidFileType
		}
		return ".webp", nil
	default:
		return "", ErrInvalidFileType
	}
}

func isValidWebP(data []byte) bool {
	if len(data) < 16 {
		return false
	}
	if string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return false
	}
	riffSize := binary.LittleEndian.Uint32(data[4:8])
	if riffSize < 8 {
		return false
	}
	chunkHeader := string(data[12:16])
	switch chunkHeader {
	case "VP8 ", "VP8L", "VP8X":
		return true
	default:
		return false
	}
}
