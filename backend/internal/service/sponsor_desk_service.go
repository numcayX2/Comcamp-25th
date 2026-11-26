package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

// Sponsor inquiry / donation bounds (migration 000015, sponsor contract).
const (
	MaxSponsorDocBytes          = 8 << 20 // 8 MB per signed form / slip scan
	MaxSponsorDocDimension      = 10000
	MaxSponsorNotifyEmails      = 10
	maxInquiryNameRunes         = 120
	maxInquiryDetailsRunes      = 500
	maxDonorNameRunes           = 200
	maxDonationTextRunes        = 500
	maxSponsorAddressLineRunes  = 200
	maxSponsorAreaRunes         = 100
	sponsorDocsSubdir           = "sponsor-docs"
	sponsorInquiryFilePrefix    = "inquiry"
	sponsorDonationAmountMaxTHB = 10_000_000
)

var (
	ErrSponsorRecordNotFound = errors.New("not found")
	ErrSponsorDocTooLarge    = errors.New("file must not exceed 8 MB")
	ErrSponsorDocDimensions  = fmt.Errorf("image must be between 1×1 and %d×%d pixels", MaxSponsorDocDimension, MaxSponsorDocDimension)
	errSponsorDocType        = newValidationError("invalid file type: only PDF, JPG, PNG and WebP files are allowed")
)

// sponsorDocTypes maps sniffed MIME types to stored extensions. SVG, HTML and GIF are excluded.
var sponsorDocTypes = map[string]string{
	"application/pdf": "pdf",
	"image/jpeg":      "jpg",
	"image/png":       "png",
	"image/webp":      "webp",
}

var sponsorAmountRe = regexp.MustCompile(`^[0-9]{1,8}(\.[0-9]{1,2})?$`)

// SponsorInquiryRequest is the body of POST /api/sponsor-inquiries. Website is a honeypot.
// Amount (baht, > 0, ≤ 2 decimals, ≤ 10,000,000) is required for money inquiries in both routes
// and rejected for goods. For JSON money inquiries taxId and the five address fields are required;
// goods rejects them. POST /api/sponsor-inquiries/upload ignores them (the attached form carries them).
type SponsorInquiryRequest struct {
	Name           string `json:"name"`
	Phone          string `json:"phone"`
	Email          string `json:"email"`
	Kind           string `json:"kind"`
	Details        string `json:"details"`
	Amount         string `json:"amount"`
	TaxID          string `json:"taxId"`
	AddressLine    string `json:"addressLine"`
	Subdistrict    string `json:"subdistrict"`
	District       string `json:"district"`
	Province       string `json:"province"`
	Postcode       string `json:"postcode"`
	TurnstileToken string `json:"turnstileToken"`
	Website        string `json:"website"`
}

// SponsorInquiryEntry is one inquiry in the admin API. File is the attached donation form's
// metadata (uploadedAt = createdAt), never its path; nil when the sponsor typed the form instead.
type SponsorInquiryEntry struct {
	ID          int64                     `json:"id"`
	Name        string                    `json:"name"`
	Phone       string                    `json:"phone"`
	Email       string                    `json:"email"`
	Kind        string                    `json:"kind"`
	Details     string                    `json:"details"`
	Amount      *string                   `json:"amount"`
	TaxID       string                    `json:"taxId"`
	AddressLine string                    `json:"addressLine"`
	Subdistrict string                    `json:"subdistrict"`
	District    string                    `json:"district"`
	Province    string                    `json:"province"`
	Postcode    string                    `json:"postcode"`
	File        *SponsorDonationFileEntry `json:"file"`
	Handled     bool                      `json:"handled"`
	HandledAt   *time.Time                `json:"handledAt"`
	CreatedAt   time.Time                 `json:"createdAt"`
}

// SponsorInquiryEmailData is one staff notification about a new inquiry (one per recipient).
// FileMIME is the attached form's type ("" = no file); the file itself is never emailed.
type SponsorInquiryEmailData struct {
	InquiryID int64
	To        string
	Name      string
	Phone     string
	Email     string
	Kind      string
	Details   string
	Amount    *string // canonical baht amount (money inquiries), nil otherwise
	FileMIME  string
	CreatedAt time.Time
}

// SponsorInquiryNotifier queues staff notification emails (AsyncSMTPMailer in production).
type SponsorInquiryNotifier interface {
	EnqueueSponsorInquiry(data SponsorInquiryEmailData)
}

// SponsorInquiryService handles the public inquiry form, the attached donation forms and their
// admin management.
type SponsorInquiryService struct {
	repo     domain.SponsorInquiryRepository
	audit    domain.AuditRepository
	docsDir  string
	captcha  TurnstileVerifier
	notifier SponsorInquiryNotifier
}

// NewSponsorInquiryService stores attached forms under uploadDir/sponsor-docs (shared with the
// donation files); audit records file views.
func NewSponsorInquiryService(repo domain.SponsorInquiryRepository, audit domain.AuditRepository, uploadDir string) *SponsorInquiryService {
	dir := filepath.Join(uploadDir, sponsorDocsSubdir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("WARNING: cannot create sponsor docs directory %s: %v", dir, err)
	}
	return &SponsorInquiryService{repo: repo, audit: audit, docsDir: dir}
}

// WithTurnstile enables captcha verification on the public form (nil = off: development, tests).
func (s *SponsorInquiryService) WithTurnstile(v TurnstileVerifier) *SponsorInquiryService {
	s.captcha = v
	return s
}

// WithNotifier sets where staff notification emails are queued.
func (s *SponsorInquiryService) WithNotifier(n SponsorInquiryNotifier) *SponsorInquiryService {
	s.notifier = n
	return s
}

// Submit validates and stores a public inquiry, then notifies staff after commit. file is the
// filled donation form from POST /api/sponsor-inquiries/upload (nil from the JSON route): it is
// validated (magic bytes, header-only dimensions, EXIF stripped) before Turnstile, written
// exclusively with fsync before the DB insert and removed again when the insert fails. A filled
// honeypot answers success without storing or sending anything. The client IP comes from ctx
// (WithRemoteIP).
func (s *SponsorInquiryService) Submit(ctx context.Context, req SponsorInquiryRequest, file []byte) error {
	if strings.TrimSpace(req.Website) != "" {
		return nil
	}
	withFile := file != nil
	if withFile {
		if strings.TrimSpace(req.Kind) == "" {
			req.Kind = domain.SponsorKindMoney
		}
		// Upload inquiries carry tax ID and address inside the attached form; ignore any sent text fields.
		req.TaxID, req.AddressLine, req.Subdistrict, req.District, req.Province, req.Postcode = "", "", "", "", "", ""
	}
	inq, err := validateSponsorInquiry(req, withFile)
	if err != nil {
		return err
	}
	if withFile && inq.Kind != domain.SponsorKindMoney {
		// The faculty form is a cash donation form: goods cannot be claimed as a tax deduction, so
		// there is no form to send for them. A bare upload (no kind) is a money inquiry.
		return newValidationError("the donation form is for cash donations only")
	}
	var cleaned []byte
	var mimeType, ext, hash string
	if withFile {
		if cleaned, mimeType, ext, hash, err = prepareSponsorDoc(file); err != nil {
			return err
		}
	}
	// Validation runs first so a typo or a wrong file does not burn the single-use Turnstile token.
	if s.captcha != nil {
		if err := s.captcha.Verify(ctx, req.TurnstileToken, remoteIPFrom(ctx), ""); err != nil {
			return err
		}
	}
	details := map[string]any{"kind": inq.Kind}
	dest := ""
	if withFile {
		name := fmt.Sprintf("%s-%s.%s", sponsorInquiryFilePrefix, uuid.NewString(), ext)
		dest = filepath.Join(s.docsDir, name)
		if err := writeFileExclusive(dest, cleaned); err != nil {
			return fmt.Errorf("save sponsor inquiry form: %w", err)
		}
		inq.File = &domain.SponsorInquiryFile{
			Path: sponsorDocsSubdir + "/" + name, MIME: mimeType, SizeBytes: len(cleaned), SHA256: hash,
		}
		details["mime"] = mimeType
		details["size"] = len(cleaned)
	}
	audit := &domain.AuditEntry{
		Action:     domain.AuditSponsorInquiryCreate,
		TargetType: domain.AuditTargetSponsorInquiry,
		Details:    details,
		IPAddress:  remoteIPFrom(ctx),
	}
	if err := s.repo.Create(ctx, inq, audit); err != nil {
		if dest != "" {
			_ = os.Remove(dest)
		}
		return fmt.Errorf("create sponsor inquiry: %w", err)
	}
	s.notify(ctx, inq)
	return nil
}

func (s *SponsorInquiryService) notify(ctx context.Context, inq *domain.SponsorInquiry) {
	if s.notifier == nil {
		return
	}
	emails, err := s.repo.ListNotifyEmails(ctx)
	if err != nil {
		log.Printf("sponsor inquiry %d: cannot load notify emails: %v", inq.ID, err)
		return
	}
	fileMIME := ""
	if inq.File != nil {
		fileMIME = inq.File.MIME
	}
	for _, to := range emails {
		s.notifier.EnqueueSponsorInquiry(SponsorInquiryEmailData{
			InquiryID: inq.ID, To: to, Name: inq.Name, Phone: inq.Phone, Email: inq.Email,
			Kind: inq.Kind, Details: inq.Details, Amount: inq.Amount, FileMIME: fileMIME, CreatedAt: inq.CreatedAt,
		})
	}
}

func (s *SponsorInquiryService) List(ctx context.Context) ([]SponsorInquiryEntry, error) {
	list, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SponsorInquiryEntry, 0, len(list))
	for _, i := range list {
		out = append(out, toInquiryEntry(i))
	}
	return out, nil
}

func (s *SponsorInquiryService) SetHandled(ctx context.Context, id int64, handled bool, adminID int64, ip string) (*SponsorInquiryEntry, error) {
	if id <= 0 {
		return nil, ErrSponsorRecordNotFound
	}
	inq, err := s.repo.SetHandled(ctx, id, handled, sponsorAudit(domain.AuditSponsorInquiryUpdate, domain.AuditTargetSponsorInquiry, id, adminID, ip, map[string]any{"handled": handled}))
	if err != nil {
		return nil, sponsorRecordNotFoundOr(err)
	}
	e := toInquiryEntry(inq)
	return &e, nil
}

// Delete removes the inquiry and audit row atomically, then its attached form after commit.
func (s *SponsorInquiryService) Delete(ctx context.Context, id int64, adminID int64, ip string) error {
	if id <= 0 {
		return ErrSponsorRecordNotFound
	}
	inq, err := s.repo.Delete(ctx, id, sponsorAudit(domain.AuditSponsorInquiryDelete, domain.AuditTargetSponsorInquiry, id, adminID, ip, nil))
	if err != nil {
		return sponsorRecordNotFoundOr(err)
	}
	if inq.File != nil {
		removeSponsorDoc(s.docsDir, inq.File.Path)
	}
	return nil
}

// OpenFile resolves the attached form strictly from its DB path inside UPLOAD_DIR/sponsor-docs and
// records the view in the audit log.
func (s *SponsorInquiryService) OpenFile(ctx context.Context, id int64, adminID int64, ip string) (*SponsorDocFile, error) {
	if id <= 0 {
		return nil, ErrSponsorRecordNotFound
	}
	inq, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, sponsorRecordNotFoundOr(err)
	}
	if inq.File == nil {
		return nil, ErrSponsorRecordNotFound
	}
	ext, ok := sponsorDocTypes[inq.File.MIME]
	if !ok {
		return nil, ErrSponsorRecordNotFound
	}
	full, ok := resolveSponsorDoc(s.docsDir, inq.File.Path)
	if !ok {
		log.Printf("sponsor docs: unusable path for inquiry %d", id)
		return nil, ErrSponsorRecordNotFound
	}
	if s.audit != nil {
		_ = s.audit.Log(ctx, sponsorAudit(domain.AuditSponsorInquiryFileView, domain.AuditTargetSponsorInquiry, id, adminID, ip, nil))
	}
	return &SponsorDocFile{
		Path:        full,
		ContentType: inq.File.MIME,
		FileName:    fmt.Sprintf("sponsor-inquiry-%d.%s", id, ext),
	}, nil
}

func (s *SponsorInquiryService) NotifyEmails(ctx context.Context) ([]string, error) {
	return s.repo.ListNotifyEmails(ctx)
}

// ReplaceNotifyEmails trims, lowercases and dedupes (keeping order) up to 10 bare addresses.
func (s *SponsorInquiryService) ReplaceNotifyEmails(ctx context.Context, raw []string, adminID int64, ip string) ([]string, error) {
	emails, err := normalizeNotifyEmails(raw)
	if err != nil {
		return nil, err
	}
	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSponsorNotifyUpdate,
		TargetType: domain.AuditTargetSponsorInquiry,
		Details:    map[string]any{"count": len(emails)},
		IPAddress:  ip,
	}
	return s.repo.ReplaceNotifyEmails(ctx, emails, audit)
}

func normalizeNotifyEmails(raw []string) ([]string, error) {
	out := make([]string, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, r := range raw {
		e := cleanEmail(r)
		if checkEmail(e) != nil {
			return nil, newValidationError("each notification email must be a valid address of at most 150 characters")
		}
		if seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	if len(out) > MaxSponsorNotifyEmails {
		return nil, newValidationError(fmt.Sprintf("at most %d notification emails", MaxSponsorNotifyEmails))
	}
	return out, nil
}

func validateSponsorInquiry(req SponsorInquiryRequest, withFile bool) (*domain.SponsorInquiry, error) {
	name, err := sponsorLine("name", req.Name, 1, maxInquiryNameRunes)
	if err != nil {
		return nil, err
	}
	// Businesses often give a landline (053-xxx-xxx, 9 digits), same rule as a donation record.
	phone := cleanNumber(req.Phone)
	if !strings.HasPrefix(phone, "0") || len(phone) < 9 || len(phone) > 10 || !isNumeric(phone) {
		return nil, newValidationError("phone must be 9-10 digits starting with 0")
	}
	email := cleanEmail(req.Email)
	if email != "" && checkEmail(email) != nil {
		return nil, newValidationError("invalid email")
	}
	kind, err := sponsorKind(req.Kind)
	if err != nil {
		return nil, err
	}
	var amount *string
	if kind == domain.SponsorKindGoods {
		if strings.TrimSpace(stripZeroWidth(req.Amount)) != "" {
			return nil, newValidationError("amount is not allowed for goods donations")
		}
	} else if amount, err = sponsorAmount(&req.Amount, true); err != nil {
		return nil, err
	}
	details, err := sponsorMultiline("details", req.Details, 0, maxInquiryDetailsRunes)
	if err != nil {
		return nil, err
	}
	var tax sponsorTaxAddress
	if !withFile {
		tax, err = validateSponsorTaxAddress(sponsorTaxAddress{
			taxID:       req.TaxID,
			addressLine: req.AddressLine,
			subdistrict: req.Subdistrict,
			district:    req.District,
			province:    req.Province,
			postcode:    req.Postcode,
		}, kind, true)
		if err != nil {
			return nil, err
		}
	}
	return &domain.SponsorInquiry{
		Name: name, Phone: phone, Email: email, Kind: kind, Details: details, Amount: amount,
		TaxID: tax.taxID, AddressLine: tax.addressLine, Subdistrict: tax.subdistrict,
		District: tax.district, Province: tax.province, Postcode: tax.postcode,
	}, nil
}

type sponsorTaxAddress struct {
	taxID       string
	addressLine string
	subdistrict string
	district    string
	province    string
	postcode    string
}

// isValidThaiTaxID checks the standard 13-digit Thai national ID / juristic tax ID modulo-11
// checksum: check = (11 - sum(d[i]*(13-i), i=0..11) % 11) % 10 == d[12].
func isValidThaiTaxID(digits string) bool {
	if len(digits) != 13 || !isNumeric(digits) {
		return false
	}
	sum := 0
	for i := range 12 {
		sum += int(digits[i]-'0') * (13 - i)
	}
	check := (11 - (sum % 11)) % 10
	return check == int(digits[12]-'0')
}

func validateSponsorTaxAddress(raw sponsorTaxAddress, kind string, requiredForMoney bool) (sponsorTaxAddress, error) {
	if kind == domain.SponsorKindGoods {
		for _, v := range []string{raw.taxID, raw.addressLine, raw.subdistrict, raw.district, raw.province, raw.postcode} {
			if strings.TrimSpace(stripZeroWidth(v)) != "" {
				return sponsorTaxAddress{}, newValidationError("taxId and address fields are not allowed for goods donations")
			}
		}
		return sponsorTaxAddress{}, nil
	}
	var out sponsorTaxAddress
	var err error
	minRunes := 0
	if requiredForMoney {
		minRunes = 1
	}

	out.taxID = cleanNumber(raw.taxID)
	if out.taxID == "" {
		if requiredForMoney {
			return sponsorTaxAddress{}, newValidationError("taxId is required for money donations")
		}
	} else if !isValidThaiTaxID(out.taxID) {
		return sponsorTaxAddress{}, newValidationError("taxId must be a valid 13-digit Thai tax or national ID")
	}

	if out.addressLine, err = sponsorLine("addressLine", raw.addressLine, minRunes, maxSponsorAddressLineRunes); err != nil {
		return sponsorTaxAddress{}, err
	}
	if out.subdistrict, err = sponsorLine("subdistrict", raw.subdistrict, minRunes, maxSponsorAreaRunes); err != nil {
		return sponsorTaxAddress{}, err
	}
	if out.district, err = sponsorLine("district", raw.district, minRunes, maxSponsorAreaRunes); err != nil {
		return sponsorTaxAddress{}, err
	}
	if out.province, err = sponsorLine("province", raw.province, minRunes, maxSponsorAreaRunes); err != nil {
		return sponsorTaxAddress{}, err
	}
	if out.province != "" {
		out.province = canonicalProvince(out.province)
		if !isThaiProvince(out.province) {
			return sponsorTaxAddress{}, newValidationError("province must be one of the 77 Thai provinces")
		}
	}
	out.postcode = NormalizeDigitsAndIdentifier(raw.postcode)
	if out.postcode == "" {
		if requiredForMoney {
			return sponsorTaxAddress{}, newValidationError("postcode is required for money donations")
		}
	} else if len(out.postcode) != 5 || !isNumeric(out.postcode) {
		return sponsorTaxAddress{}, newValidationError("postcode must be 5 digits")
	}
	return out, nil
}

func toInquiryEntry(i *domain.SponsorInquiry) SponsorInquiryEntry {
	e := SponsorInquiryEntry{
		ID: i.ID, Name: i.Name, Phone: i.Phone, Email: i.Email, Kind: i.Kind, Details: i.Details, Amount: canonicalAmount(i.Amount),
		TaxID: i.TaxID, AddressLine: i.AddressLine, Subdistrict: i.Subdistrict,
		District: i.District, Province: i.Province, Postcode: i.Postcode,
		Handled: i.HandledAt != nil, HandledAt: i.HandledAt, CreatedAt: i.CreatedAt,
	}
	if i.File != nil {
		e.File = &SponsorDonationFileEntry{MIME: i.File.MIME, Size: i.File.SizeBytes, UploadedAt: i.CreatedAt}
	}
	return e
}

// SponsorDonationInput is the body of POST / PATCH /api/admin/sponsor-donations.
type SponsorDonationInput struct {
	DonorName        string  `json:"donorName"`
	Address          string  `json:"address"`
	Phone            string  `json:"phone"`
	Kind             string  `json:"kind"`
	Amount           *string `json:"amount"`
	GoodsDescription string  `json:"goodsDescription"`
	DonatedOn        string  `json:"donatedOn"`
	Note             string  `json:"note"`
	TaxID            string  `json:"taxId"`
	AddressLine      string  `json:"addressLine"`
	Subdistrict      string  `json:"subdistrict"`
	District         string  `json:"district"`
	Province         string  `json:"province"`
	Postcode         string  `json:"postcode"`
	FacultySubmitted bool    `json:"facultySubmitted"`
}

// SponsorDonationFileEntry is a stored file's public metadata (never its path).
type SponsorDonationFileEntry struct {
	MIME       string    `json:"mime"`
	Size       int       `json:"size"`
	UploadedAt time.Time `json:"uploadedAt"`
}

type SponsorDonationFiles struct {
	Signed *SponsorDonationFileEntry `json:"signed"`
	Slip   *SponsorDonationFileEntry `json:"slip"`
}

// SponsorDonationEntry is one donation in the admin API.
type SponsorDonationEntry struct {
	ID                 int64                `json:"id"`
	DonorName          string               `json:"donorName"`
	Address            string               `json:"address"`
	Phone              string               `json:"phone"`
	Kind               string               `json:"kind"`
	Amount             *string              `json:"amount"`
	GoodsDescription   string               `json:"goodsDescription"`
	DonatedOn          string               `json:"donatedOn"`
	Note               string               `json:"note"`
	TaxID              string               `json:"taxId"`
	AddressLine        string               `json:"addressLine"`
	Subdistrict        string               `json:"subdistrict"`
	District           string               `json:"district"`
	Province           string               `json:"province"`
	Postcode           string               `json:"postcode"`
	FacultySubmitted   bool                 `json:"facultySubmitted"`
	FacultySubmittedAt *time.Time           `json:"facultySubmittedAt"`
	Files              SponsorDonationFiles `json:"files"`
	CreatedAt          time.Time            `json:"createdAt"`
	UpdatedAt          time.Time            `json:"updatedAt"`
}

// SponsorDocFile is a validated stored file ready to stream.
type SponsorDocFile struct {
	Path        string
	ContentType string
	FileName    string
}

// SponsorDonationService manages staff-recorded donations and their signed form / slip files.
type SponsorDonationService struct {
	repo    domain.SponsorDonationRepository
	audit   domain.AuditRepository
	docsDir string
}

// NewSponsorDonationService stores files under uploadDir/sponsor-docs; audit records file views.
func NewSponsorDonationService(repo domain.SponsorDonationRepository, audit domain.AuditRepository, uploadDir string) *SponsorDonationService {
	dir := filepath.Join(uploadDir, sponsorDocsSubdir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Printf("WARNING: cannot create sponsor docs directory %s: %v", dir, err)
	}
	return &SponsorDonationService{repo: repo, audit: audit, docsDir: dir}
}

func (s *SponsorDonationService) List(ctx context.Context) ([]SponsorDonationEntry, error) {
	list, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]SponsorDonationEntry, 0, len(list))
	for _, d := range list {
		out = append(out, toDonationEntry(d))
	}
	return out, nil
}

func (s *SponsorDonationService) Create(ctx context.Context, in SponsorDonationInput, adminID int64, ip string) (*SponsorDonationEntry, error) {
	f, err := validateDonationInput(in)
	if err != nil {
		return nil, err
	}
	d, err := s.repo.Create(ctx, f, sponsorAudit(domain.AuditSponsorDonationCreate, domain.AuditTargetSponsorDonation, 0, adminID, ip, map[string]any{"kind": f.Kind}))
	if err != nil {
		return nil, fmt.Errorf("create sponsor donation: %w", err)
	}
	e := toDonationEntry(d)
	return &e, nil
}

func (s *SponsorDonationService) Update(ctx context.Context, id int64, in SponsorDonationInput, adminID int64, ip string) (*SponsorDonationEntry, error) {
	if id <= 0 {
		return nil, ErrSponsorRecordNotFound
	}
	f, err := validateDonationInput(in)
	if err != nil {
		return nil, err
	}
	d, err := s.repo.Update(ctx, id, f, sponsorAudit(domain.AuditSponsorDonationUpdate, domain.AuditTargetSponsorDonation, id, adminID, ip, nil))
	if err != nil {
		return nil, sponsorRecordNotFoundOr(err)
	}
	e := toDonationEntry(d)
	return &e, nil
}

// Delete removes the donation and audit row atomically, then its files after commit.
func (s *SponsorDonationService) Delete(ctx context.Context, id int64, adminID int64, ip string) error {
	if id <= 0 {
		return ErrSponsorRecordNotFound
	}
	d, err := s.repo.Delete(ctx, id, sponsorAudit(domain.AuditSponsorDonationDelete, domain.AuditTargetSponsorDonation, id, adminID, ip, nil))
	if err != nil {
		return sponsorRecordNotFoundOr(err)
	}
	for _, f := range []*domain.SponsorDonationFile{d.Signed, d.Slip} {
		if f != nil {
			removeSponsorDoc(s.docsDir, f.Path)
		}
	}
	return nil
}

// PutFile validates data (magic bytes, header-only dimensions, EXIF stripped), writes it
// exclusively with fsync before the DB upsert, removes it again when the DB write fails, and
// removes a replaced file only after commit.
func (s *SponsorDonationService) PutFile(ctx context.Context, id int64, kind string, data []byte, adminID int64, ip string) (*SponsorDonationEntry, error) {
	if id <= 0 || !validSponsorFileKind(kind) {
		return nil, ErrSponsorRecordNotFound
	}
	cleaned, mimeType, ext, hash, err := prepareSponsorDoc(data)
	if err != nil {
		return nil, err
	}
	name := fmt.Sprintf("%d-%s-%s.%s", id, kind, uuid.NewString(), ext)
	dest := filepath.Join(s.docsDir, name)
	if err := writeFileExclusive(dest, cleaned); err != nil {
		return nil, fmt.Errorf("save sponsor document: %w", err)
	}
	file := domain.SponsorDonationFile{
		Kind: kind, Path: sponsorDocsSubdir + "/" + name, MIME: mimeType, SizeBytes: len(cleaned), SHA256: hash,
	}
	audit := sponsorAudit(domain.AuditSponsorDonationFileUp, domain.AuditTargetSponsorDonation, id, adminID, ip,
		map[string]any{"kind": kind, "mime": mimeType, "size": len(cleaned)})
	d, oldPath, err := s.repo.PutFile(ctx, id, file, audit)
	if err != nil {
		_ = os.Remove(dest)
		return nil, sponsorRecordNotFoundOr(err)
	}
	if oldPath != "" && oldPath != file.Path {
		removeSponsorDoc(s.docsDir, oldPath)
	}
	e := toDonationEntry(d)
	return &e, nil
}

// DeleteFile removes the file row + audit atomically, then the file after commit.
func (s *SponsorDonationService) DeleteFile(ctx context.Context, id int64, kind string, adminID int64, ip string) (*SponsorDonationEntry, error) {
	if id <= 0 || !validSponsorFileKind(kind) {
		return nil, ErrSponsorRecordNotFound
	}
	d, oldPath, err := s.repo.DeleteFile(ctx, id, kind, sponsorAudit(domain.AuditSponsorDonationFileDel, domain.AuditTargetSponsorDonation, id, adminID, ip, map[string]any{"kind": kind}))
	if err != nil {
		return nil, sponsorRecordNotFoundOr(err)
	}
	removeSponsorDoc(s.docsDir, oldPath)
	e := toDonationEntry(d)
	return &e, nil
}

// OpenFile resolves the stored file strictly from its DB path inside UPLOAD_DIR/sponsor-docs and
// records the view in the audit log.
func (s *SponsorDonationService) OpenFile(ctx context.Context, id int64, kind string, adminID int64, ip string) (*SponsorDocFile, error) {
	if id <= 0 || !validSponsorFileKind(kind) {
		return nil, ErrSponsorRecordNotFound
	}
	d, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, sponsorRecordNotFoundOr(err)
	}
	f := d.Signed
	if kind == domain.SponsorFileSlip {
		f = d.Slip
	}
	if f == nil {
		return nil, ErrSponsorRecordNotFound
	}
	ext, ok := sponsorDocTypes[f.MIME]
	if !ok {
		return nil, ErrSponsorRecordNotFound
	}
	full, ok := resolveSponsorDoc(s.docsDir, f.Path)
	if !ok {
		log.Printf("sponsor docs: unusable path for donation %d (%s)", id, kind)
		return nil, ErrSponsorRecordNotFound
	}
	if s.audit != nil {
		_ = s.audit.Log(ctx, sponsorAudit(domain.AuditSponsorDonationFileView, domain.AuditTargetSponsorDonation, id, adminID, ip, map[string]any{"kind": kind}))
	}
	return &SponsorDocFile{
		Path:        full,
		ContentType: f.MIME,
		FileName:    fmt.Sprintf("sponsor-%d-%s.%s", id, kind, ext),
	}, nil
}

// resolveSponsorDoc accepts only "sponsor-docs/<plain name>" and returns a path directly inside
// docsDir.
func resolveSponsorDoc(docsDir, rel string) (string, bool) {
	if rel == "" || strings.ContainsRune(rel, '\x00') {
		return "", false
	}
	slash := filepath.ToSlash(rel)
	name, ok := strings.CutPrefix(slash, sponsorDocsSubdir+"/")
	if !ok || name == "" || name == "." || strings.ContainsAny(name, `/\:`) || strings.Contains(name, "..") {
		return "", false
	}
	base, err := filepath.Abs(docsDir)
	if err != nil {
		return "", false
	}
	full := filepath.Join(base, name)
	if filepath.Dir(full) != base {
		return "", false
	}
	return full, true
}

func removeSponsorDoc(docsDir, rel string) {
	full, ok := resolveSponsorDoc(docsDir, rel)
	if !ok {
		log.Printf("sponsor docs: unusable path %q, file not removed", rel)
		return
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("sponsor docs: cannot remove %s: %v", filepath.Base(full), err)
	}
}

func prepareSponsorDoc(data []byte) (cleaned []byte, mimeType, ext, hash string, err error) {
	if len(data) == 0 {
		return nil, "", "", "", newValidationError("file is required")
	}
	if len(data) > MaxSponsorDocBytes {
		return nil, "", "", "", ErrSponsorDocTooLarge
	}
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		mimeType = "application/pdf"
	} else {
		mimeType = http.DetectContentType(data)
		if !strings.HasPrefix(mimeType, "image/") {
			return nil, "", "", "", errSponsorDocType
		}
	}
	ext, ok := sponsorDocTypes[mimeType]
	if !ok {
		return nil, "", "", "", errSponsorDocType
	}
	cleaned = data
	if mimeType != "application/pdf" {
		w, h, dimErr := slipDimensions(data, mimeType)
		if dimErr != nil {
			return nil, "", "", "", errSponsorDocType
		}
		if w <= 0 || h <= 0 || w > MaxSponsorDocDimension || h > MaxSponsorDocDimension {
			return nil, "", "", "", ErrSponsorDocDimensions
		}
		if mimeType == "image/jpeg" {
			cleaned = stripJPEGExif(data)
		}
	}
	sum := sha256.Sum256(cleaned)
	return cleaned, mimeType, ext, hex.EncodeToString(sum[:]), nil
}

func validateDonationInput(in SponsorDonationInput) (domain.SponsorDonationFields, error) {
	var f domain.SponsorDonationFields
	var err error
	if f.DonorName, err = sponsorLine("donorName", in.DonorName, 1, maxDonorNameRunes); err != nil {
		return f, err
	}
	if f.Address, err = sponsorMultiline("address", in.Address, 0, maxDonationTextRunes); err != nil {
		return f, err
	}
	f.Phone = cleanNumber(in.Phone)
	if f.Phone != "" && (len(f.Phone) < 9 || len(f.Phone) > 10 || !isNumeric(f.Phone)) {
		return f, newValidationError("phone must be empty or 9-10 digits")
	}
	if f.Kind, err = sponsorKind(in.Kind); err != nil {
		return f, err
	}
	if f.Amount, err = sponsorAmount(in.Amount, f.Kind == domain.SponsorKindMoney); err != nil {
		return f, err
	}
	if f.GoodsDescription, err = sponsorMultiline("goodsDescription", in.GoodsDescription, 0, maxDonationTextRunes); err != nil {
		return f, err
	}
	switch {
	case f.Kind == domain.SponsorKindGoods && f.GoodsDescription == "":
		return f, newValidationError("goodsDescription is required for goods donations")
	case f.Kind == domain.SponsorKindMoney && f.GoodsDescription != "":
		return f, newValidationError("goodsDescription must be empty for money donations")
	}
	f.DonatedOn = strings.TrimSpace(in.DonatedOn)
	if f.DonatedOn != "" {
		if t, perr := time.Parse("2006-01-02", f.DonatedOn); perr != nil || t.Format("2006-01-02") != f.DonatedOn {
			return f, newValidationError("donatedOn must be empty or YYYY-MM-DD")
		}
	}
	if f.Note, err = sponsorMultiline("note", in.Note, 0, maxDonationTextRunes); err != nil {
		return f, err
	}
	tax, err := validateSponsorTaxAddress(sponsorTaxAddress{
		taxID:       in.TaxID,
		addressLine: in.AddressLine,
		subdistrict: in.Subdistrict,
		district:    in.District,
		province:    in.Province,
		postcode:    in.Postcode,
	}, f.Kind, false)
	if err != nil {
		return f, err
	}
	f.TaxID = tax.taxID
	f.AddressLine = tax.addressLine
	f.Subdistrict = tax.subdistrict
	f.District = tax.district
	f.Province = tax.province
	f.Postcode = tax.postcode
	f.FacultySubmitted = in.FacultySubmitted
	return f, nil
}

// sponsorAmount parses a baht amount with at most 2 decimals and returns its canonical form
// ("1200", "1500.5"). Money needs > 0; goods (estimated value) allows 0 or null.
func sponsorAmount(raw *string, money bool) (*string, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		if money {
			return nil, newValidationError("amount is required for money donations")
		}
		return nil, nil
	}
	s := strings.ReplaceAll(NormalizeDigitsAndIdentifier(*raw), ",", "")
	if !sponsorAmountRe.MatchString(s) {
		return nil, newValidationError("amount must be a number with at most 2 decimals")
	}
	d, err := decimal.NewFromString(s)
	if err != nil {
		return nil, newValidationError("amount must be a number with at most 2 decimals")
	}
	if d.GreaterThan(decimal.NewFromInt(sponsorDonationAmountMaxTHB)) {
		return nil, newValidationError("amount must not exceed 10,000,000")
	}
	if money && !d.IsPositive() {
		return nil, newValidationError("amount must be greater than 0")
	}
	out := d.String()
	return &out, nil
}

func sponsorKind(raw string) (string, error) {
	k := strings.TrimSpace(raw)
	if k != domain.SponsorKindMoney && k != domain.SponsorKindGoods {
		return "", newValidationError("kind must be money or goods")
	}
	return k, nil
}

func validSponsorFileKind(k string) bool {
	return k == domain.SponsorFileSigned || k == domain.SponsorFileSlip
}

// sponsorLine is a single-line text field: zero-width stripped, trimmed, no control characters.
func sponsorLine(field, raw string, minRunes, maxRunes int) (string, error) {
	v := strings.TrimSpace(stripZeroWidth(raw))
	if !utf8.ValidString(v) {
		return "", newValidationError(field + " must be valid UTF-8")
	}
	if n := utf8.RuneCountInString(v); n < minRunes || n > maxRunes {
		return "", newValidationError(fmt.Sprintf("%s must be %d-%d characters", field, minRunes, maxRunes))
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return "", newValidationError(field + " must not contain control characters")
		}
	}
	return v, nil
}

// sponsorMultiline is sponsorLine that also allows newlines (CRLF normalised to LF).
func sponsorMultiline(field, raw string, minRunes, maxRunes int) (string, error) {
	v := strings.TrimSpace(strings.ReplaceAll(stripZeroWidth(raw), "\r\n", "\n"))
	if !utf8.ValidString(v) {
		return "", newValidationError(field + " must be valid UTF-8")
	}
	if n := utf8.RuneCountInString(v); n < minRunes || n > maxRunes {
		return "", newValidationError(fmt.Sprintf("%s must be at most %d characters", field, maxRunes))
	}
	for _, r := range v {
		if r != '\n' && unicode.IsControl(r) {
			return "", newValidationError(field + " must not contain control characters")
		}
	}
	return v, nil
}

func sponsorAudit(action domain.AuditAction, target string, id, adminID int64, ip string, details map[string]any) *domain.AuditEntry {
	if details == nil {
		details = map[string]any{}
	}
	e := &domain.AuditEntry{AdminID: &adminID, Action: action, TargetType: target, Details: details, IPAddress: ip}
	if id > 0 {
		e.TargetID = strconv.FormatInt(id, 10)
	}
	return e
}

func toDonationEntry(d *domain.SponsorDonation) SponsorDonationEntry {
	return SponsorDonationEntry{
		ID: d.ID, DonorName: d.DonorName, Address: d.Address, Phone: d.Phone, Kind: d.Kind,
		Amount: canonicalAmount(d.Amount), GoodsDescription: d.GoodsDescription, DonatedOn: d.DonatedOn,
		Note: d.Note,
		TaxID: d.TaxID, AddressLine: d.AddressLine, Subdistrict: d.Subdistrict,
		District: d.District, Province: d.Province, Postcode: d.Postcode,
		FacultySubmitted: d.FacultySubmittedAt != nil, FacultySubmittedAt: d.FacultySubmittedAt,
		Files:     SponsorDonationFiles{Signed: toDonationFileEntry(d.Signed), Slip: toDonationFileEntry(d.Slip)},
		CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt,
	}
}

func canonicalAmount(a *string) *string {
	if a == nil {
		return nil
	}
	d, err := decimal.NewFromString(*a)
	if err != nil {
		return a
	}
	s := d.String()
	return &s
}

func toDonationFileEntry(f *domain.SponsorDonationFile) *SponsorDonationFileEntry {
	if f == nil {
		return nil
	}
	return &SponsorDonationFileEntry{MIME: f.MIME, Size: f.SizeBytes, UploadedAt: f.UploadedAt}
}

func sponsorRecordNotFoundOr(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return ErrSponsorRecordNotFound
	}
	return err
}
