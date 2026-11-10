package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

// ValidationError marks client input problems; handlers map it to 400 with its message.
type ValidationError struct{ msg string }

func (e *ValidationError) Error() string { return e.msg }

func newValidationError(msg string) *ValidationError { return &ValidationError{msg: msg} }

var (
	ErrRegistrationClosed    = errors.New("registration is currently closed")
	ErrQuotaExceeded         = errors.New("camp capacity quota reached")
	ErrApplicantNotFound     = errors.New("applicant not found")
	ErrCannotConfirm         = errors.New("cannot confirm attendance: status is not PASSED")
	ErrSettingsUnavailable   = errors.New("registration settings are temporarily unavailable")
	ErrRegistrationBusy      = errors.New("registration is very busy right now, please try again")
	ErrDuplicateApplicant    = domain.ErrDuplicateApplicant
	ErrIdempotencyKeyReused  = errors.New("this idempotency key was already used for a different application")
	ErrInvalidNationalID     = newValidationError("invalid national ID (must be 13 digits with a valid check digit)")
	ErrInvalidPhone          = newValidationError("invalid phone number (must be 10 digits starting with 0)")
	ErrInvalidShirtSize      = newValidationError("invalid shirt size (choose XS, S, M, L, XL, 2XL, 3XL)")
	ErrInvalidEmail          = newValidationError("invalid email address")
	ErrInvalidGrade          = newValidationError("invalid grade (choose ม.4–ม.6 or ปวช.1–ปวช.3)")
	ErrRequiredFields        = newValidationError("required fields cannot be blank")
	ErrInvalidStatus         = newValidationError("invalid status")
	ErrInvalidIdempotencyKey = newValidationError("X-Idempotency-Key must be a UUID")
	ErrInvalidQuery          = newValidationError("search query must be a national ID, phone number or application ID")
	ErrVerifyCodeRequired    = newValidationError("verifyCode must be the last 4 digits of the applicant's national ID")
	ErrInvalidVerifyCode     = errors.New("verification code does not match this application")
)

// Field length limits mirror the VARCHAR sizes in the schema so oversized input is a clean 400,
// not a database error.
const (
	maxNameRunes       = 100
	maxNicknameRunes   = 50
	maxSchoolRunes     = 150
	maxProvinceRunes   = 100
	maxEmailRunes      = 150
	maxMotivationRunes = 2000
	maxReasonRunes     = 500
	maxQueryLen        = 20
)

var allowedGrades = map[string]bool{
	"ม.4": true, "ม.5": true, "ม.6": true, "ปวช.1": true, "ปวช.2": true, "ปวช.3": true,
}

type ApplicationCreateRequest struct {
	FullName   string `json:"fullName"`
	Nickname   string `json:"nickname"`
	NationalID string `json:"nationalId"`
	Phone      string `json:"phone"`
	Email      string `json:"email"`
	School     string `json:"school"`
	Grade      string `json:"grade"`
	ShirtSize  string `json:"shirtSize"`
	Motivation string `json:"motivation"`
	Province   string `json:"province,omitempty"`
}

// ApplicationResponse is the applicant DTO. Public endpoints return the masked view (see
// toPublic); only /api/admin/* returns full values, the motivation and the slip URL.
type ApplicationResponse struct {
	ID                  string                   `json:"id"`
	FullName            string                   `json:"fullName"`
	Nickname            string                   `json:"nickname"`
	NationalID          string                   `json:"nationalId"`
	Phone               string                   `json:"phone"`
	Email               string                   `json:"email"`
	School              string                   `json:"school"`
	Grade               string                   `json:"grade"`
	ShirtSize           string                   `json:"shirtSize"`
	Province            string                   `json:"province,omitempty"`
	Motivation          string                   `json:"motivation,omitempty"`
	Status              domain.ApplicationStatus `json:"status"`
	AttendanceConfirmed bool                     `json:"attendanceConfirmed"`
	HasSlip             bool                     `json:"hasSlip"`
	SlipStatus          *domain.PaymentStatus    `json:"slipStatus,omitempty"`
	// SlipURL is set only in admin responses: an authenticated API path, never a public file URL.
	SlipURL   *string `json:"slipUrl,omitempty"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt,omitempty"`
}

type ApplicantService struct {
	appRepo     domain.ApplicantRepository
	settingRepo domain.SettingRepository
	paymentRepo domain.PaymentRepository
}

func NewApplicantService(
	appRepo domain.ApplicantRepository,
	settingRepo domain.SettingRepository,
	paymentRepo domain.PaymentRepository,
) *ApplicantService {
	return &ApplicantService{
		appRepo:     appRepo,
		settingRepo: settingRepo,
		paymentRepo: paymentRepo,
	}
}

// Submit registers an application without an idempotency key.
func (s *ApplicantService) Submit(ctx context.Context, req ApplicationCreateRequest) (*ApplicationResponse, error) {
	res, _, err := s.SubmitWithKey(ctx, req, "")
	return res, err
}

// SubmitWithKey registers an application. When idempotencyKey is set (X-Idempotency-Key,
// AGENTS.md §9.2.4 / §13.4) a retry of the same submission returns the stored application with
// replayed = true instead of failing or creating a duplicate.
func (s *ApplicantService) SubmitWithKey(ctx context.Context, req ApplicationCreateRequest, idempotencyKey string) (res *ApplicationResponse, replayed bool, err error) {
	req = normalizeRequest(req)
	if err := validateRequest(req); err != nil {
		return nil, false, err
	}

	var key *uuid.UUID
	if idempotencyKey = strings.TrimSpace(idempotencyKey); idempotencyKey != "" {
		parsed, err := uuid.Parse(idempotencyKey)
		if err != nil {
			return nil, false, ErrInvalidIdempotencyKey
		}
		key = &parsed

		// Replays are answered before the schedule/quota checks: a student whose first attempt
		// was saved just before the quota filled must still get their receipt.
		if existing, err := s.replay(ctx, parsed, req.NationalID); existing != nil || err != nil {
			return existing, existing != nil, err
		}
	}

	// Fail closed: without settings we cannot know whether registration is open.
	settings, err := s.settingRepo.Get(ctx)
	if err != nil || settings == nil {
		return nil, false, fmt.Errorf("%w: %v", ErrSettingsUnavailable, err)
	}
	now := time.Now().UTC()
	if settings.IsManualClosed || now.Before(settings.RegistrationOpenAt) || now.After(settings.RegistrationCloseAt) {
		return nil, false, ErrRegistrationClosed
	}

	// Split full name into first and last name if possible
	parts := strings.SplitN(req.FullName, " ", 2)
	firstName := parts[0]
	lastName := ""
	if len(parts) > 1 {
		lastName = strings.TrimSpace(parts[1])
	}
	if utf8.RuneCountInString(firstName) > maxNameRunes || utf8.RuneCountInString(lastName) > maxNameRunes {
		return nil, false, newValidationError("full name is too long")
	}

	province := req.Province
	if province == "" {
		province = "เชียงใหม่" // Default fallback
	}

	applicant := &domain.Applicant{
		ID:                  uuid.New(),
		NationalID:          req.NationalID,
		Prefix:              "",
		FirstName:           firstName,
		LastName:            lastName,
		Nickname:            req.Nickname,
		BirthDate:           time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC), // Default if not filled in minimal form
		Gender:              "unspecified",
		School:              req.School,
		Grade:               req.Grade,
		Phone:               req.Phone,
		Email:               req.Email,
		Province:            province,
		EmergencyContact:    "ผู้ปกครอง",
		EmergencyPhone:      req.Phone,
		ShirtSize:           req.ShirtSize,
		HasLaptop:           true,
		Motivation:          &req.Motivation,
		Status:              domain.StatusPending,
		AttendanceConfirmed: false,
		IdempotencyKey:      key,
	}

	// The count-and-insert is atomic in the repository, so a midnight rush cannot overfill the camp.
	for attempt := 0; ; attempt++ {
		applicant.ApplicationNo = generateAppNo()
		err = s.appRepo.CreateWithinCapacity(ctx, applicant, settings.MaxCapacity)
		if !errors.Is(err, domain.ErrDuplicateApplicationNo) || attempt >= 4 {
			break
		}
	}

	switch {
	case err == nil:
		return s.toPublic(ctx, applicant), false, nil
	case errors.Is(err, domain.ErrCapacityReached):
		return nil, false, ErrQuotaExceeded
	case errors.Is(err, domain.ErrDuplicateApplicant):
		return nil, false, ErrDuplicateApplicant
	case errors.Is(err, domain.ErrLockTimeout):
		// Nothing was stored; the client retries with the same idempotency key.
		return nil, false, ErrRegistrationBusy
	case errors.Is(err, domain.ErrDuplicateIdempotencyKey) && key != nil:
		// A concurrent retry with the same key won the insert race.
		existing, rerr := s.replay(ctx, *key, req.NationalID)
		if rerr != nil {
			return nil, false, rerr
		}
		if existing == nil {
			return nil, false, ErrIdempotencyKeyReused
		}
		return existing, true, nil
	default:
		return nil, false, fmt.Errorf("failed to register applicant: %w", err)
	}
}

// replay returns the application stored under key, or (nil, nil) when there is none. A key that
// belongs to a different national ID is rejected rather than leaking that application.
func (s *ApplicantService) replay(ctx context.Context, key uuid.UUID, nationalID string) (*ApplicationResponse, error) {
	existing, err := s.appRepo.GetByIdempotencyKey(ctx, key)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("idempotency lookup: %w", err)
	}
	if existing.NationalID != nationalID {
		return nil, ErrIdempotencyKeyReused
	}
	return s.toPublic(ctx, existing), nil
}

func normalizeRequest(req ApplicationCreateRequest) ApplicationCreateRequest {
	// IDs and phone numbers pasted from LINE / Facebook chats carry zero-width characters and
	// are often written 081-234-5678 (AGENTS.md §9.2.2). Strip them before validation.
	req.NationalID = cleanNumber(req.NationalID)
	req.Phone = cleanNumber(req.Phone)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.FullName = strings.Join(strings.Fields(req.FullName), " ")
	req.Nickname = strings.TrimSpace(req.Nickname)
	req.School = strings.TrimSpace(req.School)
	req.Grade = strings.TrimSpace(req.Grade)
	req.Province = strings.TrimSpace(req.Province)
	req.Motivation = strings.TrimSpace(req.Motivation)
	req.ShirtSize = strings.ToUpper(strings.TrimSpace(req.ShirtSize))
	return req
}

// isValidThaiNationalID reports whether id is 13 digits whose last digit is the Thai Mod-11
// check digit: (11 - (sum(d[i] * (13 - i)) for i in 0..11) % 11) % 10.
func isValidThaiNationalID(id string) bool {
	if len(id) != 13 || !isNumeric(id) {
		return false
	}
	sum := 0
	for i := 0; i < 12; i++ {
		sum += int(id[i]-'0') * (13 - i)
	}
	return (11-sum%11)%10 == int(id[12]-'0')
}

func validateRequest(req ApplicationCreateRequest) error {
	if !isValidThaiNationalID(req.NationalID) {
		return ErrInvalidNationalID
	}
	if len(req.Phone) != 10 || !strings.HasPrefix(req.Phone, "0") || !isNumeric(req.Phone) {
		return ErrInvalidPhone
	}
	if req.FullName == "" || req.Nickname == "" || req.School == "" || req.Grade == "" {
		return ErrRequiredFields
	}
	if !isValidShirtSize(req.ShirtSize) {
		return ErrInvalidShirtSize
	}
	if !allowedGrades[req.Grade] {
		return ErrInvalidGrade
	}
	if req.Email != "" {
		if utf8.RuneCountInString(req.Email) > maxEmailRunes {
			return ErrInvalidEmail
		}
		if addr, err := mail.ParseAddress(req.Email); err != nil || addr.Address != req.Email {
			return ErrInvalidEmail
		}
	}
	for _, f := range []struct {
		value string
		max   int
		name  string
	}{
		{req.Nickname, maxNicknameRunes, "nickname"},
		{req.School, maxSchoolRunes, "school"},
		{req.Province, maxProvinceRunes, "province"},
		{req.Motivation, maxMotivationRunes, "motivation"},
	} {
		if utf8.RuneCountInString(f.value) > f.max {
			return newValidationError(fmt.Sprintf("%s is too long (max %d characters)", f.name, f.max))
		}
	}
	return nil
}

// QueryStatus is the public lookup by national ID, phone or application ID. It returns the
// masked view only.
func (s *ApplicantService) QueryStatus(ctx context.Context, query string) (*ApplicationResponse, error) {
	query = normalizeLookupQuery(query)
	if query == "" || len(query) > maxQueryLen {
		return nil, ErrInvalidQuery
	}

	applicant, err := s.appRepo.FindByQuery(ctx, query)
	if err != nil {
		return nil, notFoundOr(err)
	}
	return s.toPublic(ctx, applicant), nil
}

// ConfirmAttendance is public, so it only accepts the application ID (not a phone number) and
// requires verifyCode, the last 4 digits of the applicant's national ID (see CheckVerifyCode).
func (s *ApplicantService) ConfirmAttendance(ctx context.Context, applicationNo, verifyCode string, confirmed bool) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}
	if err := CheckVerifyCode(applicant, verifyCode); err != nil {
		return nil, err
	}

	if applicant.Status != domain.StatusPassed && applicant.Status != domain.StatusConfirmed {
		return nil, ErrCannotConfirm
	}

	if err := s.appRepo.UpdateAttendance(ctx, applicant.ID, confirmed); err != nil {
		return nil, err
	}
	applicant.AttendanceConfirmed = confirmed

	return s.toPublic(ctx, applicant), nil
}

func (s *ApplicantService) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*ApplicationResponse, error) {
	if status != nil && !status.IsValid() {
		return nil, ErrInvalidStatus
	}
	list, err := s.appRepo.ListAll(ctx, status)
	if err != nil {
		return nil, err
	}

	responses := make([]*ApplicationResponse, 0, len(list))
	for _, a := range list {
		res, err := s.toAdmin(ctx, a)
		if err != nil {
			return nil, err
		}
		responses = append(responses, res)
	}
	return responses, nil
}

// UpdateStatus is the admin status change. The status log and the audit_logs row are written in
// the same transaction as the change (AGENTS.md §13.6).
func (s *ApplicantService) UpdateStatus(ctx context.Context, applicationNo string, newStatus domain.ApplicationStatus, adminID *int64, reason, ip string) (*ApplicationResponse, error) {
	if !newStatus.IsValid() {
		return nil, ErrInvalidStatus
	}
	reason = strings.TrimSpace(reason)
	if utf8.RuneCountInString(reason) > maxReasonRunes {
		return nil, newValidationError(fmt.Sprintf("reason is too long (max %d characters)", maxReasonRunes))
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}

	audit := &domain.AuditEntry{
		AdminID:    adminID,
		Action:     domain.AuditStatusUpdate,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details:    map[string]any{"newStatus": newStatus, "reason": reason},
		IPAddress:  ip,
	}
	if err := s.appRepo.UpdateStatus(ctx, applicant.ID, newStatus, adminID, reason, audit); err != nil {
		return nil, err
	}
	applicant.Status = newStatus

	return s.toAdmin(ctx, applicant)
}

func (s *ApplicantService) latestPayment(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	if s.paymentRepo == nil {
		return nil, nil
	}
	p, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicantID)
	if errors.Is(err, domain.ErrNotFound) {
		return nil, nil
	}
	return p, err
}

func (s *ApplicantService) baseResponse(a *domain.Applicant) *ApplicationResponse {
	fullName := a.FirstName
	if a.LastName != "" {
		fullName += " " + a.LastName
	}
	return &ApplicationResponse{
		ID:                  a.ApplicationNo,
		FullName:            fullName,
		Nickname:            a.Nickname,
		NationalID:          a.NationalID,
		Phone:               a.Phone,
		Email:               a.Email,
		School:              a.School,
		Grade:               a.Grade,
		ShirtSize:           a.ShirtSize,
		Province:            a.Province,
		Status:              a.Status,
		AttendanceConfirmed: a.AttendanceConfirmed,
		CreatedAt:           a.CreatedAt.Format(time.RFC3339),
		UpdatedAt:           a.UpdatedAt.Format(time.RFC3339),
	}
}

// toPublic masks identifiers and drops free text. A failed payment lookup only hides the slip
// state; it must not fail a status check.
func (s *ApplicantService) toPublic(ctx context.Context, a *domain.Applicant) *ApplicationResponse {
	res := s.baseResponse(a)
	res.NationalID = MaskNationalID(a.NationalID)
	res.Phone = MaskPhone(a.Phone)
	res.Email = MaskEmail(a.Email)
	if p, _ := s.latestPayment(ctx, a.ID); p != nil {
		res.HasSlip = true
		st := p.Status
		res.SlipStatus = &st
	}
	return res
}

func (s *ApplicantService) toAdmin(ctx context.Context, a *domain.Applicant) (*ApplicationResponse, error) {
	res := s.baseResponse(a)
	if a.Motivation != nil {
		res.Motivation = *a.Motivation
	}
	p, err := s.latestPayment(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	if p != nil {
		res.HasSlip = true
		st := p.Status
		res.SlipStatus = &st
		url := AdminSlipPath(a.ApplicationNo)
		res.SlipURL = &url
	}
	return res, nil
}

// AdminSlipPath is the authenticated endpoint that streams an applicant's latest slip image.
func AdminSlipPath(applicationNo string) string {
	return "/api/admin/applications/" + applicationNo + "/slip"
}

func notFoundOr(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return ErrApplicantNotFound
	}
	return err
}

// normalizeAppNo accepts an application ID as a student might paste it: with zero-width
// characters, lower case, or without the hyphen ("cc25e85b53" → "CC25-E85B53").
func normalizeAppNo(s string) string {
	s = strings.ToUpper(strings.TrimSpace(stripZeroWidth(s)))
	if m := looseAppNoRe.FindStringSubmatch(s); m != nil {
		return "CC25-" + m[1]
	}
	return s
}

var looseAppNoRe = regexp.MustCompile(`^CC25[-\s]?([0-9A-F]{6})$`)

// isZeroWidth reports the invisible characters LINE and Facebook leave in copied text:
// ZERO WIDTH SPACE / NON-JOINER / JOINER (U+200B–U+200D), WORD JOINER (U+2060) and the
// byte-order mark / ZERO WIDTH NO-BREAK SPACE (U+FEFF).
func isZeroWidth(r rune) bool {
	return (r >= '\u200B' && r <= '\u200D') || r == '\u2060' || r == '\uFEFF'
}

// isNumberSeparator reports characters people put inside IDs and phone numbers: spaces and
// hyphens, including the Unicode dashes and minus sign a phone keyboard may substitute.
func isNumberSeparator(r rune) bool {
	return r == '-' || (r >= '\u2010' && r <= '\u2015') || r == '\u2212' || unicode.IsSpace(r)
}

func stripZeroWidth(s string) string {
	return strings.Map(func(r rune) rune {
		if isZeroWidth(r) {
			return -1
		}
		return r
	}, s)
}

// cleanNumber removes zero-width characters, hyphens and spaces from a national ID or phone
// number. Anything else (letters, other symbols) is kept so validation still rejects it.
func cleanNumber(s string) string {
	return strings.Map(func(r rune) rune {
		if isZeroWidth(r) || isNumberSeparator(r) {
			return -1
		}
		return r
	}, s)
}

// normalizeLookupQuery prepares the public status query. A national ID or phone number written
// with hyphens/spaces ("1-5099-00112-23-3", "081 234 5678") becomes digits only; anything else is
// treated as an application ID, whose own hyphen is kept (see normalizeAppNo).
func normalizeLookupQuery(q string) string {
	q = strings.TrimSpace(stripZeroWidth(q))
	if digits := cleanNumber(q); digits != "" && isNumeric(digits) {
		return digits
	}
	return normalizeAppNo(q)
}

var numericRe = regexp.MustCompile(`^[0-9]+$`)

func isNumeric(s string) bool {
	return numericRe.MatchString(s)
}

func isValidShirtSize(size string) bool {
	switch size {
	case "XS", "S", "M", "L", "XL", "2XL", "3XL":
		return true
	}
	return false
}

func generateAppNo() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return fmt.Sprintf("CC25-%X", b)
}
