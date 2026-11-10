package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

// MaxSlipBytes is the slip upload limit (AGENTS.md §13.4).
const MaxSlipBytes = 5 << 20

var (
	ErrDuplicateSlip       = errors.New("this slip has already been uploaded")
	ErrNotPassed           = errors.New("cannot upload slip: applicant has not passed selection")
	ErrInvalidFileType     = newValidationError("invalid file type: only JPG, PNG, and WebP images are allowed")
	ErrSlipTooLarge        = errors.New("slip image must not exceed 5 MB")
	ErrEmptySlip           = newValidationError("slip file is empty")
	ErrSlipAlreadyApproved = errors.New("payment for this application has already been approved")
	ErrNoSlip              = errors.New("no payment slip found for this applicant")
	ErrSlipAlreadyVerified = domain.ErrPaymentAlreadyVerified
	// ErrInvalidImageDimensions: width or height is 0 or above MaxSlipDimension (image bomb guard).
	ErrInvalidImageDimensions = fmt.Errorf("image must be between 1×1 and %d×%d pixels", MaxSlipDimension, MaxSlipDimension)
)

// allowedSlipTypes maps the sniffed content type (magic bytes, not the client's filename or
// Content-Type header) to the extension we store the file under.
var allowedSlipTypes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

var slipContentTypes = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
}

type PaymentService struct {
	paymentRepo domain.PaymentRepository
	appRepo     domain.ApplicantRepository
	settingRepo domain.SettingRepository
	auditRepo   domain.AuditRepository
	slipDir     string
}

// NewPaymentService stores slips under uploadDir/slips. auditRepo may be nil.
func NewPaymentService(
	paymentRepo domain.PaymentRepository,
	appRepo domain.ApplicantRepository,
	settingRepo domain.SettingRepository,
	auditRepo domain.AuditRepository,
	uploadDir string,
) *PaymentService {
	slipDir := filepath.Join(uploadDir, "slips")
	if err := os.MkdirAll(slipDir, 0o700); err != nil {
		log.Printf("WARNING: cannot create slip directory %s: %v", slipDir, err)
	}
	return &PaymentService{
		paymentRepo: paymentRepo,
		appRepo:     appRepo,
		settingRepo: settingRepo,
		auditRepo:   auditRepo,
		slipDir:     slipDir,
	}
}

type SlipUploadResult struct {
	ID         string               `json:"id"`
	Status     string               `json:"status"`
	HasSlip    bool                 `json:"hasSlip"`
	SlipStatus domain.PaymentStatus `json:"slipStatus"`
	Message    string               `json:"message"`
}

// UploadSlip stores a payment slip for an applicant identified by application ID and verifyCode
// (the last 4 digits of the national ID, see CheckVerifyCode). The file is written to disk and
// only its relative path goes into the database (AGENTS.md §13.3).
func (s *PaymentService) UploadSlip(ctx context.Context, applicationNo, verifyCode string, fileData []byte) (*SlipUploadResult, error) {
	if len(fileData) == 0 {
		return nil, ErrEmptySlip
	}
	if len(fileData) > MaxSlipBytes {
		return nil, ErrSlipTooLarge
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}
	if err := CheckVerifyCode(applicant, verifyCode); err != nil {
		return nil, err
	}
	if applicant.Status != domain.StatusPassed && applicant.Status != domain.StatusConfirmed {
		return nil, ErrNotPassed
	}

	latest, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}
	if latest != nil && latest.Status == domain.PaymentApproved {
		return nil, ErrSlipAlreadyApproved
	}

	// 1. Magic-byte check: exactly JPEG, PNG or WebP. The extension comes from the detected type.
	contentType := http.DetectContentType(fileData)
	ext, ok := allowedSlipTypes[contentType]
	if !ok {
		return nil, ErrInvalidFileType
	}

	// 1b. Pixel-flood guard (AGENTS.md §13.4): read the dimensions from the header only and reject
	//     anything over 4096 px before the file is hashed or written. A file whose header cannot
	//     be parsed is not a usable image, whatever its magic bytes say.
	width, height, err := slipDimensions(fileData, contentType)
	if err != nil {
		return nil, ErrInvalidFileType
	}
	if !validSlipDimensions(width, height) {
		return nil, ErrInvalidImageDimensions
	}

	// 2. Anti-fraud: SHA-256 of the file. A lookup failure blocks the upload (fail closed); the
	//    unique index on payments.slip_hash also catches two identical uploads racing each other.
	sum := sha256.Sum256(fileData)
	slipHash := hex.EncodeToString(sum[:])
	isDup, err := s.paymentRepo.CheckDuplicateSlipHash(ctx, slipHash)
	if err != nil {
		return nil, fmt.Errorf("duplicate slip check: %w", err)
	}
	if isDup {
		return nil, ErrDuplicateSlip
	}

	settings, err := s.settingRepo.Get(ctx)
	if err != nil || settings == nil {
		return nil, fmt.Errorf("%w: %v", ErrSettingsUnavailable, err)
	}

	// 3. Unguessable server-side name; the client filename is never used.
	//    Two-phase write (AGENTS.md §13.3): the file is on disk and fsynced before the database
	//    row exists, and removed again if the row cannot be written, so a payment row never
	//    points at a missing file and a failed upload leaves no orphan file.
	fileName := applicant.ApplicationNo + "-" + uuid.NewString() + ext
	destPath := filepath.Join(s.slipDir, fileName)
	if err := writeFileExclusive(destPath, fileData); err != nil {
		return nil, fmt.Errorf("failed to save slip file: %w", err)
	}

	payment := &domain.Payment{
		ID:            uuid.New(),
		ApplicantID:   applicant.ID,
		SlipURL:       "slips/" + fileName,
		Amount:        settings.CampFee,
		Status:        domain.PaymentPending,
		SlipHash:      &slipHash,
		VerifiedByAPI: false,
	}
	if err := s.paymentRepo.Create(ctx, payment); err != nil {
		_ = os.Remove(destPath)
		if errors.Is(err, domain.ErrDuplicateSlipHash) {
			return nil, ErrDuplicateSlip
		}
		return nil, fmt.Errorf("failed to save payment record: %w", err)
	}

	return &SlipUploadResult{
		ID:         applicant.ApplicationNo,
		Status:     string(applicant.Status),
		HasSlip:    true,
		SlipStatus: domain.PaymentPending,
		Message:    "อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่",
	}, nil
}

// writeFileExclusive creates path (failing if it exists), writes data and flushes it to stable
// storage with Sync before returning, so a crash right after the payment row commits cannot
// leave a truncated slip. Any failure removes the partial file.
func writeFileExclusive(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

// SlipFile describes the latest slip of an applicant for the authenticated admin endpoint.
type SlipFile struct {
	Path        string
	ContentType string
	Name        string
}

// OpenLatestSlip resolves the applicant's latest slip on disk and records the access in the
// audit log (slips contain names and bank details).
func (s *PaymentService) OpenLatestSlip(ctx context.Context, applicationNo string, adminID *int64, ip string) (*SlipFile, error) {
	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}
	payment, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, ErrNoSlip
	}
	if err != nil {
		return nil, err
	}

	// filepath.Base also accepts rows written by older builds ("/uploads/slips/<name>") and makes
	// a tampered slip_url unable to point outside the slip directory.
	name := filepath.Base(filepath.FromSlash(payment.SlipURL))
	if name == "." || name == string(filepath.Separator) || strings.HasPrefix(name, "..") {
		return nil, ErrNoSlip
	}
	contentType, ok := slipContentTypes[strings.ToLower(filepath.Ext(name))]
	if !ok {
		return nil, ErrNoSlip
	}

	if s.auditRepo != nil {
		entry := &domain.AuditEntry{
			AdminID:    adminID,
			Action:     domain.AuditSlipViewed,
			TargetType: domain.AuditTargetApplicant,
			TargetID:   applicant.ApplicationNo,
			Details:    map[string]any{"paymentId": payment.ID.String()},
			IPAddress:  ip,
		}
		if err := s.auditRepo.Log(ctx, entry); err != nil {
			log.Printf("audit log write failed (%s): %v", entry.Action, err)
		}
	}

	return &SlipFile{Path: filepath.Join(s.slipDir, name), ContentType: contentType, Name: name}, nil
}

// VerifySlip approves or rejects the latest PENDING slip. Payment, applicant status, status log
// and audit row are written in one transaction.
func (s *PaymentService) VerifySlip(ctx context.Context, applicationNo string, approved bool, adminID int64, note, ip string) error {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxReasonRunes {
		return newValidationError(fmt.Sprintf("note is too long (max %d characters)", maxReasonRunes))
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return notFoundOr(err)
	}

	latestPayment, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if errors.Is(err, domain.ErrNotFound) {
		return ErrNoSlip
	}
	if err != nil {
		return err
	}

	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSlipVerify,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details: map[string]any{
			"paymentId": latestPayment.ID.String(),
			"approved":  approved,
			"note":      note,
		},
		IPAddress: ip,
	}
	return s.paymentRepo.Verify(ctx, latestPayment.ID, approved, adminID, note, audit)
}
