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
	"time"
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
	// ErrSlipLocked: the application is REFUND_PENDING, REFUNDED or REJECTED, so approving or
	// rejecting its slip would re-confirm a seat that was released. The slip stays viewable.
	ErrSlipLocked          = errors.New("this application was refunded or rejected, so its payment slip can no longer be reviewed")
	ErrSlipAlreadyVerified = domain.ErrPaymentAlreadyVerified
	// ErrSlipChanged: the slip the admin looked at is no longer the applicant's current slip (a new
	// one was uploaded in the meantime, or the paymentId is not theirs). Nothing was approved or
	// rejected; reload the application and review the new slip.
	ErrSlipChanged = errors.New("the applicant's slip has changed since you opened it, please reload and review the current slip")
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
	// verify is the per-application lockout for wrong verifyCodes, shared with ApplicantService.
	verify *VerifyGuard
}

// WithVerifyGuard replaces the service's own lockout guard with a shared one and returns the
// service.
func (s *PaymentService) WithVerifyGuard(g *VerifyGuard) *PaymentService {
	if g != nil {
		s.verify = g
	}
	return s
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
		// Never without a lockout: a service nobody wired still counts failures on its own.
		verify: NewVerifyGuard(auditRepo),
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
// (the last 4 digits of the national ID, see CheckVerifyCode; repeated wrong codes lock the
// application, see VerifyGuard). The file is written to disk and only its relative path goes into
// the database (AGENTS.md §13.3).
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
	if err := s.verify.Check(ctx, applicant.ApplicationNo, VerifyActionSlip, remoteIPFrom(ctx), func() error {
		return CheckVerifyCode(applicant, verifyCode)
	}); err != nil {
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
	// An applicant has at most one slip waiting for review: the new upload supersedes the earlier
	// PENDING one(s) in the same transaction, so repeated uploads cannot fill the disk or the
	// table (each is up to 5 MB). The approved-slip check above is repeated inside the
	// transaction, which closes the race with an admin approving at the same moment.
	superseded, err := s.paymentRepo.CreateReplacingPending(ctx, payment)
	if err != nil {
		_ = os.Remove(destPath)
		switch {
		case errors.Is(err, domain.ErrDuplicateSlipHash):
			return nil, ErrDuplicateSlip
		case errors.Is(err, domain.ErrPaymentAlreadyVerified):
			return nil, ErrSlipAlreadyApproved
		}
		return nil, fmt.Errorf("failed to save payment record: %w", err)
	}
	// The rows are gone; now their files. A failure here only leaves an orphan file behind (logged),
	// it cannot revive the old slip.
	for _, old := range superseded {
		s.removeSlipFile(old)
	}
	if len(superseded) > 0 {
		s.logSupersededSlips(ctx, applicant.ApplicationNo, payment.ID.String(), superseded, remoteIPFrom(ctx))
	}

	return &SlipUploadResult{
		ID:         applicant.ApplicationNo,
		Status:     string(applicant.Status),
		HasSlip:    true,
		SlipStatus: domain.PaymentPending,
		Message:    "อัปโหลดสลิปสำเร็จ รอดำเนินการตรวจสอบโดยเจ้าหน้าที่",
	}, nil
}

// slipFileName returns the bare file name of a stored slip_url, or false when it does not name a
// file inside the slip directory (a tampered row cannot point elsewhere). It also accepts rows
// written by older builds ("/uploads/slips/<name>").
func slipFileName(slipURL string) (string, bool) {
	name := filepath.Base(filepath.FromSlash(slipURL))
	if name == "." || name == string(filepath.Separator) || strings.HasPrefix(name, "..") {
		return "", false
	}
	return name, true
}

// removeSlipFile deletes the image of a payment row that no longer exists.
func (s *PaymentService) removeSlipFile(p *domain.Payment) {
	name, ok := slipFileName(p.SlipURL)
	if !ok {
		log.Printf("superseded slip %s: unusable slip_url, file not removed", p.ID)
		return
	}
	if err := os.Remove(filepath.Join(s.slipDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("superseded slip %s: cannot remove %s: %v", p.ID, name, err)
	}
}

// logSupersededSlips records that an upload replaced a slip that was still waiting for review.
func (s *PaymentService) logSupersededSlips(ctx context.Context, applicationNo, newPaymentID string, old []*domain.Payment, ip string) {
	if s.auditRepo == nil {
		return
	}
	ids := make([]string, len(old))
	for i, p := range old {
		ids[i] = p.ID.String()
	}
	entry := &domain.AuditEntry{
		Action:     domain.AuditSlipSuperseded,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicationNo,
		Details:    map[string]any{"newPaymentId": newPaymentID, "supersededPaymentIds": ids, "selfService": true},
		IPAddress:  ip,
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.auditRepo.Log(wctx, entry); err != nil {
		log.Printf("audit log write failed (%s): %v", entry.Action, err)
	}
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
	// PaymentID identifies the slip being streamed. The admin UI sends it back with the verdict
	// (VerifySlip) so a slip that was replaced meanwhile is not approved by mistake.
	PaymentID string
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
	name, ok := slipFileName(payment.SlipURL)
	if !ok {
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

	return &SlipFile{Path: filepath.Join(s.slipDir, name), ContentType: contentType, Name: name, PaymentID: payment.ID.String()}, nil
}

// VerifySlip approves or rejects the latest PENDING slip. Payment, applicant status, status log
// and audit row are written in one transaction.
//
// paymentID is the slip the admin actually looked at (SlipFile.PaymentID / slipPaymentId of the
// list). When given, it must still be the applicant's latest slip, otherwise ErrSlipChanged: an
// applicant who uploads a new slip while staff are viewing the old one cannot get the new,
// unseen image approved. Empty keeps the old behaviour (settle whatever is latest). Either way a
// slip replaced after the read below no longer exists when Verify runs, which also ends in
// ErrSlipChanged rather than settling the wrong image.
func (s *PaymentService) VerifySlip(ctx context.Context, applicationNo, paymentID string, approved bool, adminID int64, note, ip string) error {
	var wantID uuid.UUID
	if paymentID = strings.TrimSpace(paymentID); paymentID != "" {
		id, err := uuid.Parse(paymentID)
		if err != nil {
			return newValidationError("paymentId must be a valid UUID")
		}
		wantID = id
	}

	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxReasonRunes {
		return newValidationError(fmt.Sprintf("note is too long (max %d characters)", maxReasonRunes))
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return notFoundOr(err)
	}

	if !applicant.Status.IsActive() {
		return ErrSlipLocked
	}

	latestPayment, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
	if errors.Is(err, domain.ErrNotFound) {
		return ErrNoSlip
	}
	if err != nil {
		return err
	}
	if wantID != uuid.Nil && wantID != latestPayment.ID {
		return ErrSlipChanged
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
	// The repository re-checks the status under the row lock, so a refund recorded after the read
	// above still wins.
	if err := s.paymentRepo.Verify(ctx, latestPayment.ID, approved, adminID, note, audit); err != nil {
		if errors.Is(err, domain.ErrStateConflict) {
			return ErrSlipLocked
		}
		if errors.Is(err, domain.ErrNotFound) {
			// The slip was superseded by a newer upload between the read and the write.
			return ErrSlipChanged
		}
		return err
	}
	return nil
}
