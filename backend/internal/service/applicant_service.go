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
	ErrInvalidParentPhone    = newValidationError("invalid parent phone number (must be 10 digits starting with 0)")
	ErrInvalidShirtSize      = newValidationError("invalid shirt size (choose SSS, SS, S, M, L, XL, 2XL, 3XL, 4XL)")
	ErrInvalidEmail          = newValidationError("invalid email address")
	ErrInvalidGrade          = newValidationError("invalid grade (choose ม.4–ม.6 / ปวช.1–ปวช.3, or enter your own level, 2–20 characters)")
	ErrRequiredFields        = newValidationError("required fields cannot be blank")
	ErrInvalidStatus         = newValidationError("invalid status")
	ErrInvalidIdempotencyKey = newValidationError("X-Idempotency-Key must be a UUID")
	ErrInvalidQuery          = newValidationError("search query must be a national ID, phone number or application ID")
	ErrVerifyCodeRequired    = newValidationError("verifyCode must be the last 4 digits of the applicant's national ID")
	ErrInvalidVerifyCode     = errors.New("verification code does not match this application")
	ErrCannotWithdraw        = errors.New("this application can no longer be cancelled online (confirmed, slip already sent, or already closed), please contact staff")
)

// Field length limits mirror the VARCHAR sizes in the schema so oversized input is a clean 400,
// not a database error.
const (
	maxNameRunes              = 100
	maxNicknameRunes          = 50
	maxParentNameRunes        = 150
	maxParentRelationRunes    = 50
	maxSchoolRunes            = 150
	maxProvinceRunes          = 100
	maxEmailRunes             = 150
	maxMotivationRunes        = 2000
	maxAllergiesRunes         = 500
	maxMedicalConditionsRunes = 500
	maxReasonRunes            = 500
	maxQueryLen               = 20
)

var allowedGrades = map[string]bool{
	"ม.4": true, "ม.5": true, "ม.6": true, "ปวช.1": true, "ปวช.2": true, "ปวช.3": true,
}

// isValidGrade accepts the listed levels, or a short free-text level for applicants outside them
// (the form's "อื่นๆ" option). The column is VARCHAR(20), so the text is capped at 20 characters.
func isValidGrade(g string) bool {
	if allowedGrades[g] {
		return true
	}
	n := utf8.RuneCountInString(g)
	if n < 2 || n > 20 || g == "อื่นๆ" {
		return false
	}
	for _, r := range g {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

type ApplicationCreateRequest struct {
	FullName          string `json:"fullName"`
	Nickname          string `json:"nickname"`
	NationalID        string `json:"nationalId"`
	Phone             string `json:"phone"`
	Email             string `json:"email"`
	ParentName        string `json:"parentName,omitempty"`
	ParentRelation    string `json:"parentRelation,omitempty"`
	ParentPhone       string `json:"parentPhone,omitempty"`
	School            string `json:"school"`
	Grade             string `json:"grade"`
	ShirtSize         string `json:"shirtSize"`
	Motivation        string `json:"motivation"`
	Allergies         string `json:"allergies,omitempty"`
	MedicalConditions string `json:"medicalConditions,omitempty"`
	Province          string `json:"province,omitempty"`
	// TurnstileToken is the single-use Cloudflare Turnstile response. It is verified, never
	// stored, and never logged.
	TurnstileToken string `json:"turnstileToken,omitempty"`
}

// ApplicationResponse is the applicant DTO. Public endpoints return the masked view (see
// toPublic); only /api/admin/* returns full values, parent contact details, free-text notes
// (motivation, allergies, medicalConditions) and the slip URL.
type ApplicationResponse struct {
	ID                  string                   `json:"id"`
	FullName            string                   `json:"fullName"`
	Nickname            string                   `json:"nickname"`
	NationalID          string                   `json:"nationalId"`
	Phone               string                   `json:"phone"`
	Email               string                   `json:"email"`
	ParentName          string                   `json:"parentName,omitempty"`
	ParentRelation      string                   `json:"parentRelation,omitempty"`
	ParentPhone         string                   `json:"parentPhone,omitempty"`
	School              string                   `json:"school"`
	Grade               string                   `json:"grade"`
	ShirtSize           string                   `json:"shirtSize"`
	Province            string                   `json:"province,omitempty"`
	Motivation          string                   `json:"motivation,omitempty"`
	Allergies           string                   `json:"allergies,omitempty"`
	MedicalConditions   string                   `json:"medicalConditions,omitempty"`
	Status              domain.ApplicationStatus `json:"status"`
	AttendanceConfirmed bool                     `json:"attendanceConfirmed"`
	HasSlip             bool                     `json:"hasSlip"`
	SlipStatus          *domain.PaymentStatus    `json:"slipStatus,omitempty"`
	// SlipURL is set only in admin responses: an authenticated API path, never a public file URL.
	SlipURL *string `json:"slipUrl,omitempty"`
	// SlipPaymentID (admin only) identifies the latest slip. The admin UI sends it back as
	// paymentId with the verdict, so a slip replaced meanwhile is not settled by mistake.
	SlipPaymentID   *string `json:"slipPaymentId,omitempty"`
	AdminNote       *string `json:"adminNote,omitempty"`
	RejectionReason *string `json:"rejectionReason,omitempty"`
	VerifiedAt      *string `json:"verifiedAt,omitempty"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt,omitempty"`
}

type ApplicantService struct {
	// audit receives standalone events such as the CSV export record (see WithAudit).
	audit       domain.AuditRepository
	appRepo     domain.ApplicantRepository
	settingRepo domain.SettingRepository
	paymentRepo domain.PaymentRepository
	// captcha is nil only when Turnstile is deliberately off (development without a secret, tests).
	// main always sets it in production; config refuses to start without TURNSTILE_SECRET_KEY.
	captcha TurnstileVerifier
	// verify locks an application after repeated wrong verifyCode / nationalId answers. main
	// shares one guard with PaymentService (WithVerifyGuard) so the limit spans every endpoint.
	verify *VerifyGuard
	// onSeatChange notifies SettingService to drop its short public-settings cache when seats change.
	onSeatChange func()
	// mailer dispatches registration / confirmation emails asynchronously after commit.
	mailer EmailNotifier
	// now returns the current wall-clock time; defaults to time.Now and can be overridden in tests.
	now func() time.Time
}

const (
	// UnpaidExpiryWindow is the deadline (5 days) after registration by which an applicant
	// must upload a payment slip before their seat is automatically released.
	UnpaidExpiryWindow = 120 * time.Hour
	// UnpaidGraceWindow is the minimum 24h window granted after updated_at or a slip rejection
	// so applicants rejected or restored late in (or after) the 5-day window are not re-expired
	// before they can re-upload. The enforced deadline is
	// max(created + UnpaidExpiryWindow, updated_at + UnpaidGraceWindow, latest REJECTED slip + UnpaidGraceWindow).
	UnpaidGraceWindow = 24 * time.Hour
	// UnpaidExpiryReason is recorded in applicant_status_logs and audit_logs when auto-expired.
	UnpaidExpiryReason = "ตัดสิทธิ์อัตโนมัติเนื่องจากไม่ชำระเงินและแนบสลิปภายใน 5 วัน (120 ชั่วโมง) หลังสมัคร"
)

// WithVerifyGuard replaces the service's own lockout guard with a shared one and returns the
// service.
func (s *ApplicantService) WithVerifyGuard(g *VerifyGuard) *ApplicantService {
	if g != nil {
		s.verify = g
	}
	return s
}

// WithNow overrides the wall clock (for deterministic unit tests) and returns the service.
func (s *ApplicantService) WithNow(fn func() time.Time) *ApplicantService {
	if fn != nil {
		s.now = fn
	}
	return s
}

func (s *ApplicantService) currentTime() time.Time {
	if s.now != nil {
		return s.now().UTC()
	}
	return time.Now().UTC()
}

// WithAudit sets the store for standalone audit events (the CSV export record) and returns the
// service. Without it RecordExport refuses, so an export is never silently left unrecorded.
func (s *ApplicantService) WithAudit(a domain.AuditRepository) *ApplicantService {
	s.audit = a
	return s
}

// WithTurnstile enables captcha verification on registration and returns the service.
func (s *ApplicantService) WithTurnstile(v TurnstileVerifier) *ApplicantService {
	s.captcha = v
	return s
}

// WithOnSeatChange registers a hook called after a commit changes active seat count.
func (s *ApplicantService) WithOnSeatChange(fn func()) *ApplicantService {
	s.onSeatChange = fn
	return s
}

// WithMailer configures the asynchronous transactional mailer and returns the service.
func (s *ApplicantService) WithMailer(m EmailNotifier) *ApplicantService {
	s.mailer = m
	return s
}

func formatCampFeeTHB(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "1,200"
	}
	intPart, fracPart, hasDot := strings.Cut(raw, ".")
	if hasDot {
		fracPart = strings.TrimRight(fracPart, "0")
	}
	if len(intPart) <= 3 {
		if fracPart != "" {
			return intPart + "." + fracPart
		}
		return intPart
	}
	var b strings.Builder
	rem := len(intPart) % 3
	if rem > 0 {
		b.WriteString(intPart[:rem])
		if len(intPart) > rem {
			b.WriteByte(',')
		}
	}
	for i := rem; i < len(intPart); i += 3 {
		if i > rem {
			b.WriteByte(',')
		}
		b.WriteString(intPart[i : i+3])
	}
	if fracPart != "" {
		b.WriteByte('.')
		b.WriteString(fracPart)
	}
	return b.String()
}

func (s *ApplicantService) notifySeatChange() {
	if s.onSeatChange != nil {
		s.onSeatChange()
	}
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
		// Never without a lockout: a service nobody wired still counts failures on its own.
		verify: NewVerifyGuard(nil),
		now:    time.Now,
	}
}

// ExpireOverdueUnpaid transitions unpaid active applications older than UnpaidExpiryWindow (120h)
// without a PENDING or APPROVED slip to REJECTED, invalidating the public settings cache whenever
// at least one seat is released. Both cutoffs are derived here from the two window constants and
// handed to the repository, so the grace offset can never drift from the expiry window again.
func (s *ApplicantService) ExpireOverdueUnpaid(ctx context.Context, now time.Time) ([]string, error) {
	utcNow := now.UTC()
	expired, err := s.appRepo.ExpireOverdueUnpaid(ctx, utcNow.Add(-UnpaidExpiryWindow), utcNow.Add(-UnpaidGraceWindow), UnpaidExpiryReason)
	if len(expired) > 0 {
		s.notifySeatChange()
	}
	return expired, err
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
		// It also runs before the captcha: a Turnstile token is single-use, so a retry of an
		// already-saved submission (the mobile network dropped the 201) carries a spent token.
		if existing, err := s.replay(ctx, parsed, req.NationalID); existing != nil || err != nil {
			return existing, existing != nil, err
		}
	}

	// Fail closed: without settings we cannot know whether registration is open.
	// This runs BEFORE the captcha on purpose. While registration is closed no Turnstile call is
	// made at all, so a bot cannot pre-verify (token, idempotency key) pairs with Cloudflare in
	// the seconds before 00:00:00 and replay them at midnight, and the API makes no outbound
	// requests for traffic it is going to refuse anyway.
	settings, err := s.settingRepo.Get(ctx)
	if err != nil || settings == nil {
		return nil, false, fmt.Errorf("%w: %v", ErrSettingsUnavailable, err)
	}
	now := s.currentTime()
	if settings.IsManualClosed || now.Before(settings.RegistrationOpenAt) || now.After(settings.RegistrationCloseAt) {
		return nil, false, ErrRegistrationClosed
	}

	// Bot check before any quota or database write. Fail closed: no verdict, no seat.
	if s.captcha != nil {
		if err := s.captcha.Verify(ctx, req.TurnstileToken, remoteIPFrom(ctx), turnstileKey(key, req.NationalID)); err != nil {
			return nil, false, err
		}
	}

	firstName, lastName, err := splitFullName(req.FullName)
	if err != nil {
		return nil, false, err
	}

	province := req.Province
	if province == "" {
		province = "เชียงใหม่" // Default fallback
	}

	emergencyContact, emergencyPhone := emergencyContactFallback(req.ParentName, req.ParentPhone, req.Phone)

	applicant := &domain.Applicant{
		ID:                uuid.New(),
		NationalID:        req.NationalID,
		Prefix:            "",
		FirstName:         firstName,
		LastName:          lastName,
		Nickname:          req.Nickname,
		BirthDate:         time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC), // Default if not filled in minimal form
		Gender:            "unspecified",
		School:            req.School,
		Grade:             req.Grade,
		Phone:             req.Phone,
		Email:             req.Email,
		Province:          province,
		ParentName:        nonEmptyPtr(req.ParentName),
		ParentRelation:    nonEmptyPtr(req.ParentRelation),
		ParentPhone:       nonEmptyPtr(req.ParentPhone),
		EmergencyContact:  emergencyContact,
		EmergencyPhone:    emergencyPhone,
		ShirtSize:         req.ShirtSize,
		HasLaptop:         true,
		Motivation:        &req.Motivation,
		Allergies:         &req.Allergies,
		MedicalConditions: &req.MedicalConditions,
		// First come, first served: the quota check above is the selection, so the applicant holds
		// a seat (and may upload a slip) straight away, with no staff step in between.
		Status:              domain.StatusPassed,
		AttendanceConfirmed: false,
		IdempotencyKey:      key,
	}

	// Free any unpaid seats older than 120h right before checking capacity so overdue slots become
	// available immediately to the incoming applicant.
	_, _ = s.ExpireOverdueUnpaid(ctx, s.currentTime())

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
		s.notifySeatChange()
		if s.mailer != nil && applicant.Email != "" {
			createdAt := applicant.CreatedAt
			if createdAt.IsZero() {
				createdAt = s.currentTime()
			}
			s.mailer.EnqueueRegistration(RegistrationEmailData{
				ApplicationNo: applicant.ApplicationNo,
				FullName:      applicant.FullName(),
				Nickname:      applicant.Nickname,
				Email:         applicant.Email,
				CampFee:       formatCampFeeTHB(settings.CampFee.String()),
				CreatedAt:     createdAt,
			})
		}
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

// turnstileKey derives the idempotency key sent to Cloudflare from the client's X-Idempotency-Key
// and the national ID being registered (a name-based UUID, so it is a valid UUID and stable for a
// retry of the same submission). Cloudflare treats a repeated (token, key) pair as the same
// request and answers from its cache, so binding the national ID into the key means a token that
// was verified for one ID cannot be replayed for a different ID under the same client key.
// No client key means no idempotency key for Cloudflare either.
func turnstileKey(key *uuid.UUID, nationalID string) string {
	if key == nil {
		return ""
	}
	return uuid.NewSHA1(*key, []byte(nationalID)).String()
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

// profileInput is the set of editable text fields shared by registration, the applicant's own
// profile edit and the staff profile edit, so all three normalise and validate the same way.
type profileInput struct {
	FullName, Nickname, NationalID, Phone, Email string
	ParentName, ParentRelation, ParentPhone      string
	School, Province, Grade, ShirtSize           string
	Motivation, Allergies, MedicalConditions     string
}

func nonEmptyPtr(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func emergencyContactFallback(parentName, parentPhone, applicantPhone string) (string, string) {
	contact := "ผู้ปกครอง"
	if parentName != "" {
		contact = parentName
	}
	phone := applicantPhone
	if parentPhone != "" {
		phone = parentPhone
	}
	return contact, phone
}

func profileInputOfRequest(req ApplicationCreateRequest) profileInput {
	return profileInput{
		FullName: req.FullName, Nickname: req.Nickname, NationalID: req.NationalID, Phone: req.Phone,
		Email: req.Email, ParentName: req.ParentName, ParentRelation: req.ParentRelation, ParentPhone: req.ParentPhone,
		School: req.School, Province: req.Province, Grade: req.Grade,
		ShirtSize: req.ShirtSize, Motivation: req.Motivation,
		Allergies: req.Allergies, MedicalConditions: req.MedicalConditions,
	}
}

// cleanText normalises a single-line field: invisible characters pasted from LINE / Facebook are
// dropped and runs of whitespace collapse to one space.
func cleanText(s string) string {
	return strings.Join(strings.Fields(stripZeroWidth(s)), " ")
}

func cleanEmail(s string) string {
	return strings.ToLower(strings.Map(func(r rune) rune {
		if isZeroWidth(r) || unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s))
}

func normalizeProfile(p profileInput) profileInput {
	// IDs and phone numbers pasted from LINE / Facebook chats carry zero-width characters and
	// are often written 081-234-5678 (AGENTS.md §9.2.2). Strip them before validation.
	p.NationalID = cleanNumber(p.NationalID)
	p.Phone = cleanNumber(p.Phone)
	p.Email = cleanEmail(p.Email)
	p.FullName = cleanText(p.FullName)
	p.Nickname = cleanText(p.Nickname)
	p.ParentName = cleanText(p.ParentName)
	p.ParentRelation = cleanText(p.ParentRelation)
	p.ParentPhone = cleanNumber(p.ParentPhone)
	p.School = cleanText(p.School)
	p.Grade = cleanText(p.Grade)
	p.Province = cleanText(p.Province)
	p.Motivation = strings.TrimSpace(stripZeroWidth(p.Motivation))
	p.Allergies = strings.TrimSpace(stripZeroWidth(p.Allergies))
	p.MedicalConditions = strings.TrimSpace(stripZeroWidth(p.MedicalConditions))
	p.ShirtSize = strings.ToUpper(strings.TrimSpace(stripZeroWidth(p.ShirtSize)))
	return p
}

func normalizeRequest(req ApplicationCreateRequest) ApplicationCreateRequest {
	p := normalizeProfile(profileInputOfRequest(req))
	return ApplicationCreateRequest{
		FullName: p.FullName, Nickname: p.Nickname, NationalID: p.NationalID, Phone: p.Phone,
		Email: p.Email, ParentName: p.ParentName, ParentRelation: p.ParentRelation, ParentPhone: p.ParentPhone,
		School: p.School, Grade: p.Grade, ShirtSize: p.ShirtSize,
		Motivation: p.Motivation, Allergies: p.Allergies, MedicalConditions: p.MedicalConditions,
		Province:       p.Province,
		TurnstileToken: strings.TrimSpace(req.TurnstileToken),
	}
}

// splitFullName splits "first last" at the first space; the surname may be empty.
func splitFullName(full string) (first, last string, err error) {
	parts := strings.SplitN(full, " ", 2)
	first = parts[0]
	if len(parts) > 1 {
		last = strings.TrimSpace(parts[1])
	}
	if utf8.RuneCountInString(first) > maxNameRunes || utf8.RuneCountInString(last) > maxNameRunes {
		return "", "", newValidationError("full name is too long")
	}
	return first, last, nil
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

func checkNationalID(id string) error {
	if !isValidThaiNationalID(id) {
		return ErrInvalidNationalID
	}
	return nil
}

func checkPhone(phone string) error {
	if len(phone) != 10 || !strings.HasPrefix(phone, "0") || !isNumeric(phone) {
		return ErrInvalidPhone
	}
	return nil
}

// checkEmail requires a non-empty bare address within the limit whose domain contains a dot.
func checkEmail(email string) error {
	if email == "" || utf8.RuneCountInString(email) > maxEmailRunes {
		return ErrInvalidEmail
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return ErrInvalidEmail
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at == len(email)-1 {
		return ErrInvalidEmail
	}
	domainPart := email[at+1:]
	if !strings.Contains(domainPart, ".") || strings.HasPrefix(domainPart, ".") || strings.HasSuffix(domainPart, ".") {
		return ErrInvalidEmail
	}
	return nil
}

func checkLengths(p profileInput) error {
	for _, f := range []struct {
		value string
		max   int
		name  string
	}{
		{p.Nickname, maxNicknameRunes, "nickname"},
		{p.ParentName, maxParentNameRunes, "parentName"},
		{p.ParentRelation, maxParentRelationRunes, "parentRelation"},
		{p.School, maxSchoolRunes, "school"},
		{p.Province, maxProvinceRunes, "province"},
		{p.Motivation, maxMotivationRunes, "motivation"},
		{p.Allergies, maxAllergiesRunes, "allergies"},
		{p.MedicalConditions, maxMedicalConditionsRunes, "medicalConditions"},
	} {
		if utf8.RuneCountInString(f.value) > f.max {
			return newValidationError(fmt.Sprintf("%s is too long (max %d characters)", f.name, f.max))
		}
	}
	return nil
}

// validateProfile checks every field of a normalised profile (registration and staff edit).
// Province may be blank here: registration fills in a default for it.
func validateProfile(p profileInput) error {
	if err := checkNationalID(p.NationalID); err != nil {
		return err
	}
	if err := checkPhone(p.Phone); err != nil {
		return err
	}
	if p.ParentPhone != "" {
		if err := checkPhone(p.ParentPhone); err != nil {
			return ErrInvalidParentPhone
		}
	}
	if p.FullName == "" || p.Nickname == "" || p.School == "" || p.Grade == "" {
		return ErrRequiredFields
	}
	if !isValidShirtSize(p.ShirtSize) {
		return ErrInvalidShirtSize
	}
	if !isValidGrade(p.Grade) {
		return ErrInvalidGrade
	}
	if err := checkEmail(p.Email); err != nil {
		return err
	}
	return checkLengths(p)
}

func validateRequest(req ApplicationCreateRequest) error {
	return validateProfile(profileInputOfRequest(req))
}

// QueryStatus is the public lookup by national ID, phone or application ID. It returns the
// masked view only.
func (s *ApplicantService) QueryStatus(ctx context.Context, query string) (*ApplicationResponse, error) {
	query = normalizeLookupQuery(query)
	if query == "" || len(query) > maxQueryLen {
		return nil, ErrInvalidQuery
	}

	_, _ = s.ExpireOverdueUnpaid(ctx, s.currentTime())

	applicant, err := s.appRepo.FindByQuery(ctx, query)
	if err != nil {
		return nil, notFoundOr(err)
	}
	return s.toPublic(ctx, applicant), nil
}

// ConfirmAttendance is public, so it only accepts the application ID (not a phone number) and
// requires verifyCode, the last 4 digits of the applicant's national ID (see CheckVerifyCode).
// Repeated wrong codes lock the application (VerifyGuard). The answer is written with an
// application.attendance.confirm audit row carrying confirmed and the client IP, which the handler
// passes in with WithRemoteIP. The repository re-checks the status at the write, so an application
// staff rejected after the read below is refused with ErrCannotConfirm.
func (s *ApplicantService) ConfirmAttendance(ctx context.Context, applicationNo, verifyCode string, confirmed bool) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}
	if err := s.verify.Check(ctx, applicant.ApplicationNo, VerifyActionConfirm, remoteIPFrom(ctx), func() error {
		return CheckVerifyCode(applicant, verifyCode)
	}); err != nil {
		return nil, err
	}

	if applicant.Status != domain.StatusPassed && applicant.Status != domain.StatusConfirmed {
		return nil, ErrCannotConfirm
	}

	audit := &domain.AuditEntry{
		Action:     domain.AuditAttendanceConfirm,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details:    map[string]any{"confirmed": confirmed},
		IPAddress:  remoteIPFrom(ctx),
	}
	if err := s.appRepo.UpdateAttendance(ctx, applicant.ID, confirmed, audit); err != nil {
		if errors.Is(err, domain.ErrStateConflict) {
			return nil, ErrCannotConfirm
		}
		return nil, notFoundOr(err)
	}
	applicant.AttendanceConfirmed = confirmed

	return s.toPublic(ctx, applicant), nil
}

// CanSeeFullNationalID reports whether an admin role may receive the raw 13-digit national ID.
// Only admin may, because the ID authorises the public withdraw endpoint
// (POST /api/applications/{id}/withdraw). Fail closed: an empty or unknown role gets the masked value.
func CanSeeFullNationalID(role domain.AdminRole) bool {
	return role == domain.RoleAdmin
}

// ListAll is the admin list. role is the caller's role: callers that may not see full national IDs
// (see CanSeeFullNationalID) get them masked like the public status page.
func (s *ApplicantService) ListAll(ctx context.Context, status *domain.ApplicationStatus, role domain.AdminRole) ([]*ApplicationResponse, error) {
	if status != nil && !status.IsValid() {
		return nil, ErrInvalidStatus
	}
	_, _ = s.ExpireOverdueUnpaid(ctx, s.currentTime())
	list, err := s.appRepo.ListAll(ctx, status)
	if err != nil {
		return nil, err
	}

	ids := make([]uuid.UUID, len(list))
	for i, a := range list {
		ids[i] = a.ID
	}
	latestPayments, err := s.paymentRepo.GetLatestByApplicantIDs(ctx, ids)
	if err != nil {
		return nil, err
	}

	maskID := !CanSeeFullNationalID(role)
	responses := make([]*ApplicationResponse, 0, len(list))
	for _, a := range list {
		res := s.toAdminWithPayment(a, latestPayments[a.ID])
		if maskID {
			res.NationalID = MaskNationalID(a.NationalID)
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
	// Taking a seat back (REJECTED / REFUND_PENDING / REFUNDED -> an active status) must respect
	// the quota: those statuses released their seat, and someone else may have taken it. The
	// repository re-checks under the quota lock, so this holds against concurrent registrations.
	retakesSeat := !applicant.Status.IsActive() && newStatus.IsActive()
	if !retakesSeat {
		err := s.appRepo.UpdateStatus(ctx, applicant.ID, newStatus, adminID, reason, audit)
		switch {
		case err == nil:
		case errors.Is(err, domain.ErrStateConflict):
			// The read above is not locked. Another admin released the seat meanwhile, so this
			// change now takes it back: the repository refused, redo it under the quota lock.
			retakesSeat = true
		default:
			return nil, notFoundOr(err)
		}
	}
	if retakesSeat {
		settings, err := s.settingRepo.Get(ctx)
		if err != nil || settings == nil {
			return nil, fmt.Errorf("%w: %v", ErrSettingsUnavailable, err)
		}
		err = s.appRepo.UpdateStatusWithinCapacity(ctx, applicant.ID, newStatus, adminID, reason, audit, settings.MaxCapacity)
		switch {
		case err == nil:
		case errors.Is(err, domain.ErrCapacityReached):
			return nil, ErrQuotaExceeded
		case errors.Is(err, domain.ErrLockTimeout):
			return nil, ErrRegistrationBusy
		default:
			return nil, notFoundOr(err)
		}
	}
	previousStatus := applicant.Status
	if retakesSeat || previousStatus.IsActive() != newStatus.IsActive() {
		s.notifySeatChange()
	}
	applicant.Status = newStatus
	if newStatus == domain.StatusConfirmed {
		applicant.AttendanceConfirmed = true
		if previousStatus != domain.StatusConfirmed && s.mailer != nil && applicant.Email != "" {
			s.mailer.EnqueueConfirmed(ConfirmedEmailData{
				ApplicationNo: applicant.ApplicationNo,
				FullName:      applicant.FullName(),
				Nickname:      applicant.Nickname,
				Email:         applicant.Email,
				ShirtSize:     applicant.ShirtSize,
			})
		}
	}

	return s.toAdmin(ctx, applicant)
}

func (s *ApplicantService) Delete(ctx context.Context, applicationNo string, adminID int64, reason, ip string) error {
	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return notFoundOr(err)
	}

	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditApplicantDelete,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details: map[string]any{
			"fullName":   applicant.FullName(),
			"nationalId": applicant.NationalID,
			"reason":     reason,
		},
		IPAddress: ip,
	}

	if err := s.appRepo.SoftDelete(ctx, applicant.ID, &adminID, reason, audit); err != nil {
		return err
	}
	s.notifySeatChange()
	return nil
}

// Withdraw lets applicants cancel their own application from the receipt or /status page. It is
// public and gives a seat away for good, so it needs the application ID plus the applicant's full
// 13-digit national ID (see CheckNationalID), not just the 4-digit verifyCode. Wrong IDs count
// towards the same per-application lockout as verifyCode (VerifyGuard). The row is soft-deleted,
// which frees the seat (CountActive ignores deleted rows) and lets the same person register again.
//
// Money may already have changed hands, and a soft-deleted row disappears from /admin, so only
// applicants with nothing to settle can withdraw: no CONFIRMED place, no slip waiting for review
// or already approved, and not an application that is already closed (REJECTED, REFUND_PENDING,
// REFUNDED). Everyone else gets ErrCannotWithdraw and is told to contact staff, who record the
// cancellation as REFUND_PENDING so the refund stays on the ledger.
func (s *ApplicantService) Withdraw(ctx context.Context, applicationNo, nationalID, reason, ip string) error {
	reason = strings.TrimSpace(stripZeroWidth(reason))
	if utf8.RuneCountInString(reason) > maxReasonRunes {
		return newValidationError(fmt.Sprintf("reason is too long (max %d characters)", maxReasonRunes))
	}
	// Checked before the lookup, so a malformed ID never reveals whether the application exists.
	nid, err := ParseWithdrawNationalID(nationalID)
	if err != nil {
		return err
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return notFoundOr(err)
	}
	if err := s.verify.Check(ctx, applicant.ApplicationNo, VerifyActionWithdraw, ip, func() error {
		return CheckNationalID(applicant, nid)
	}); err != nil {
		return err
	}

	if applicant.Status == domain.StatusConfirmed || !applicant.Status.IsActive() {
		return ErrCannotWithdraw
	}
	payment, err := s.latestPayment(ctx, applicant.ID)
	if err != nil {
		return err
	}
	if payment != nil && (payment.Status == domain.PaymentPending || payment.Status == domain.PaymentApproved) {
		return ErrCannotWithdraw
	}

	details := map[string]any{"reason": reason, "ip": ip, "selfService": true}
	if payment != nil {
		// Only a rejected slip gets here: staff still want to know one was sent.
		details["slipStatus"] = payment.Status
	}
	audit := &domain.AuditEntry{
		Action:     domain.AuditApplicantWithdrawSelf,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details:    details,
		IPAddress:  ip,
	}
	// The checks above ran on an unlocked read; the repository repeats them under its locks, so a
	// slip uploaded or approved at the same moment still blocks the withdrawal.
	if err := s.appRepo.SoftDelete(ctx, applicant.ID, nil, reason, audit); err != nil {
		if errors.Is(err, domain.ErrStateConflict) {
			return ErrCannotWithdraw
		}
		return notFoundOr(err)
	}
	s.notifySeatChange()
	return nil
}

// AdminProfileRequest is the staff edit. A nil field keeps its stored value, so a client may send
// only what changed; the merged result is validated as a whole.
type AdminProfileRequest struct {
	FullName          *string `json:"fullName,omitempty"`
	Nickname          *string `json:"nickname,omitempty"`
	NationalID        *string `json:"nationalId,omitempty"`
	Phone             *string `json:"phone,omitempty"`
	Email             *string `json:"email,omitempty"`
	ParentName        *string `json:"parentName,omitempty"`
	ParentRelation    *string `json:"parentRelation,omitempty"`
	ParentPhone       *string `json:"parentPhone,omitempty"`
	School            *string `json:"school,omitempty"`
	Province          *string `json:"province,omitempty"`
	Grade             *string `json:"grade,omitempty"`
	ShirtSize         *string `json:"shirtSize,omitempty"`
	Motivation        *string `json:"motivation,omitempty"`
	Allergies         *string `json:"allergies,omitempty"`
	MedicalConditions *string `json:"medicalConditions,omitempty"`
	Reason            string  `json:"reason,omitempty"`
}

// profileOf is the stored profile as the shared validators see it.
func profileOf(a *domain.Applicant) profileInput {
	full := a.FirstName
	if a.LastName != "" {
		full += " " + a.LastName
	}
	p := profileInput{
		FullName: full, Nickname: a.Nickname, NationalID: a.NationalID, Phone: a.Phone, Email: a.Email,
		School: a.School, Province: a.Province, Grade: a.Grade, ShirtSize: a.ShirtSize,
	}
	if a.ParentName != nil {
		p.ParentName = *a.ParentName
	}
	if a.ParentRelation != nil {
		p.ParentRelation = *a.ParentRelation
	}
	if a.ParentPhone != nil {
		p.ParentPhone = *a.ParentPhone
	}
	if a.Motivation != nil {
		p.Motivation = *a.Motivation
	}
	if a.Allergies != nil {
		p.Allergies = *a.Allergies
	}
	if a.MedicalConditions != nil {
		p.MedicalConditions = *a.MedicalConditions
	}
	return p
}

// profileChanges lists the fields whose value differs, as {"field": {"old": ..., "new": ...}} for
// the audit log.
func profileChanges(before, after profileInput) map[string]map[string]string {
	changes := map[string]map[string]string{}
	for _, f := range []struct{ name, old, new string }{
		{"fullName", before.FullName, after.FullName},
		{"nickname", before.Nickname, after.Nickname},
		{"nationalId", before.NationalID, after.NationalID},
		{"phone", before.Phone, after.Phone},
		{"email", before.Email, after.Email},
		{"parentName", before.ParentName, after.ParentName},
		{"parentRelation", before.ParentRelation, after.ParentRelation},
		{"parentPhone", before.ParentPhone, after.ParentPhone},
		{"school", before.School, after.School},
		{"province", before.Province, after.Province},
		{"grade", before.Grade, after.Grade},
		{"shirtSize", before.ShirtSize, after.ShirtSize},
		{"motivation", before.Motivation, after.Motivation},
		{"allergies", before.Allergies, after.Allergies},
		{"medicalConditions", before.MedicalConditions, after.MedicalConditions},
	} {
		if f.old != f.new {
			changes[f.name] = map[string]string{"old": f.old, "new": f.new}
		}
	}
	return changes
}

// profileFieldsOf converts a validated profile to the repository column set.
func profileFieldsOf(p profileInput) (domain.ProfileFields, error) {
	first, last, err := splitFullName(p.FullName)
	if err != nil {
		return domain.ProfileFields{}, err
	}
	motivation := p.Motivation
	allergies := p.Allergies
	medicalConditions := p.MedicalConditions
	emergencyContact, emergencyPhone := emergencyContactFallback(p.ParentName, p.ParentPhone, p.Phone)
	return domain.ProfileFields{
		FirstName: first, LastName: last, Nickname: p.Nickname, NationalID: p.NationalID,
		Phone: p.Phone, Email: p.Email, School: p.School, Province: p.Province, Grade: p.Grade,
		ShirtSize: p.ShirtSize, Motivation: &motivation, Allergies: &allergies,
		MedicalConditions: &medicalConditions,
		ParentName:        nonEmptyPtr(p.ParentName),
		ParentRelation:    nonEmptyPtr(p.ParentRelation),
		ParentPhone:       nonEmptyPtr(p.ParentPhone),
		EmergencyContact:  emergencyContact,
		EmergencyPhone:    emergencyPhone,
	}, nil
}

// AdminUpdateProfile is the staff edit of any application (any status). The merged profile gets
// the same full validation as registration, a collision with another live applicant national
// ID, phone or email is ErrDuplicateApplicant, and keeping the applicant own identifiers is
// fine. The change and its audit row (old -> new per field, plus the reason) commit together.
func (s *ApplicantService) AdminUpdateProfile(ctx context.Context, applicationNo string, req AdminProfileRequest, adminID *int64, ip string) (*ApplicationResponse, error) {
	reason := strings.TrimSpace(stripZeroWidth(req.Reason))
	if utf8.RuneCountInString(reason) > maxReasonRunes {
		return nil, newValidationError(fmt.Sprintf("reason is too long (max %d characters)", maxReasonRunes))
	}

	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}

	before := profileOf(applicant)
	merged := before
	for _, f := range []struct {
		dst *string
		src *string
	}{
		{&merged.FullName, req.FullName}, {&merged.Nickname, req.Nickname}, {&merged.NationalID, req.NationalID},
		{&merged.Phone, req.Phone}, {&merged.Email, req.Email},
		{&merged.ParentName, req.ParentName}, {&merged.ParentRelation, req.ParentRelation}, {&merged.ParentPhone, req.ParentPhone},
		{&merged.School, req.School}, {&merged.Province, req.Province}, {&merged.Grade, req.Grade}, {&merged.ShirtSize, req.ShirtSize},
		{&merged.Motivation, req.Motivation}, {&merged.Allergies, req.Allergies}, {&merged.MedicalConditions, req.MedicalConditions},
	} {
		if f.src != nil {
			*f.dst = *f.src
		}
	}
	after := normalizeProfile(merged)
	if err := validateProfile(after); err != nil {
		return nil, err
	}
	if after.Province == "" {
		return nil, ErrRequiredFields
	}

	changes := profileChanges(before, after)
	if len(changes) == 0 {
		return s.toAdmin(ctx, applicant)
	}
	fields, err := profileFieldsOf(after)
	if err != nil {
		return nil, err
	}
	audit := &domain.AuditEntry{
		AdminID:    adminID,
		Action:     domain.AuditProfileUpdate,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details:    map[string]any{"changes": changes, "reason": reason, "ip": ip},
		IPAddress:  ip,
	}
	if err := s.appRepo.UpdateProfile(ctx, applicant.ID, fields, false, audit); err != nil {
		return nil, notFoundOr(err)
	}

	updated, err := s.appRepo.GetByID(ctx, applicant.ID)
	if err != nil {
		return nil, notFoundOr(err)
	}
	return s.toAdmin(ctx, updated)
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
	p, err := s.latestPayment(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	return s.toAdminWithPayment(a, p), nil
}

func (s *ApplicantService) toAdminWithPayment(a *domain.Applicant, p *domain.Payment) *ApplicationResponse {
	res := s.baseResponse(a)
	if a.ParentName != nil {
		res.ParentName = *a.ParentName
	}
	if a.ParentRelation != nil {
		res.ParentRelation = *a.ParentRelation
	}
	if a.ParentPhone != nil {
		res.ParentPhone = *a.ParentPhone
	}
	if a.Motivation != nil {
		res.Motivation = *a.Motivation
	}
	if a.Allergies != nil {
		res.Allergies = *a.Allergies
	}
	if a.MedicalConditions != nil {
		res.MedicalConditions = *a.MedicalConditions
	}
	if p != nil {
		res.HasSlip = true
		st := p.Status
		res.SlipStatus = &st
		url := AdminSlipPath(a.ApplicationNo)
		res.SlipURL = &url
		pid := p.ID.String()
		res.SlipPaymentID = &pid
		if p.AdminNote != nil {
			note := *p.AdminNote
			res.AdminNote = &note
		}
		if p.RejectionReason != nil {
			reason := *p.RejectionReason
			res.RejectionReason = &reason
		}
		if p.VerifiedAt != nil {
			ts := p.VerifiedAt.UTC().Format(time.RFC3339)
			res.VerifiedAt = &ts
		}
	}
	return res
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
// characters, Thai numerals, lower case, or without the hyphen ("cc๒๕e85b53" → "CC25-E85B53").
func normalizeAppNo(s string) string {
	s = strings.ToUpper(NormalizeDigitsAndIdentifier(s))
	if m := looseAppNoRe.FindStringSubmatch(s); m != nil {
		return "CC25-" + m[1]
	}
	return s
}

var looseAppNoRe = regexp.MustCompile(`^CC25[-\s]?([0-9A-F]{6})$`)

// normalizeThaiDigit maps Unicode Thai digits (U+0E50 '๐'–U+0E59 '๙') to ASCII '0'–'9'.
func normalizeThaiDigit(r rune) rune {
	if r >= '\u0E50' && r <= '\u0E59' {
		return '0' + (r - '\u0E50')
	}
	return r
}

// NormalizeDigitsAndIdentifier strips zero-width characters, trims surrounding whitespace, and
// normalizes Thai Unicode numerals ('๐'–'๙') to ASCII '0'–'9'.
// Use only for identifiers/numeric fields — never for free-text fields (fullName, school, motivation).
func NormalizeDigitsAndIdentifier(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if isZeroWidth(r) {
			return -1
		}
		return normalizeThaiDigit(r)
	}, s))
}

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

// cleanNumber removes zero-width characters, hyphens and spaces from a national ID, phone
// number, or verification code and converts Thai numerals ('๐'–'๙') to ASCII '0'–'9'.
// Anything else (letters, other symbols) is kept so validation still rejects it.
func cleanNumber(s string) string {
	return strings.Map(func(r rune) rune {
		if isZeroWidth(r) || isNumberSeparator(r) {
			return -1
		}
		return normalizeThaiDigit(r)
	}, s)
}

// normalizeLookupQuery prepares the public status query. A national ID or phone number written
// with Thai digits or hyphens/spaces ("๑-๕๐๙๙-๐๐๑๑๒-๒๓-๓", "๐๘๑ ๒๓๔ ๕๖๗๘") becomes ASCII
// digits only; anything else is treated as an application ID (see normalizeAppNo).
func normalizeLookupQuery(q string) string {
	q = NormalizeDigitsAndIdentifier(q)
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
	case "SSS", "SS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL":
		return true
	}
	return false
}

func generateAppNo() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return fmt.Sprintf("CC25-%X", b)
}

// MaxExportAuditIDs bounds one export record. The JSON body limit is 64 KB, and a camp of at most
// 1000 seats (plus rejected and refunded history) stays well below this.
const MaxExportAuditIDs = 2000

var (
	ErrEmptyExport   = newValidationError("applicationIds must contain at least 1 item")
	ErrInvalidExport = newValidationError("applicationIds must be a list of at most 2000 application IDs (CC25-XXXXXX)")
	// ErrAuditUnavailable means the service was built without WithAudit; the export is refused.
	ErrAuditUnavailable = errors.New("audit log is not configured")
)

// ExportRecord describes one CSV export from the staff dashboard.
type ExportRecord struct {
	// ApplicationIDs are the rows in the file, in the order the dashboard shows them.
	ApplicationIDs []string
	// StatusFilter is the dashboard's status tab, "" for all.
	StatusFilter string
	// SearchFiltered reports that a search narrowed the list. The search text itself is not
	// recorded: staff search by phone number or national ID.
	SearchFiltered bool
}

// RecordExport writes the application.export.csv audit row (count, application IDs, filter, admin
// and IP) for a CSV the dashboard is about to build. The dashboard builds the file only after this
// succeeds, so every export it makes leaves a trace. It cannot stop someone who already holds the
// list in the browser from copying it another way: the row records honest exports, it is not a
// control on the data itself.
func (s *ApplicantService) RecordExport(ctx context.Context, adminID int64, rec ExportRecord, ip string) (int, error) {
	if s.audit == nil {
		return 0, ErrAuditUnavailable
	}
	if len(rec.ApplicationIDs) == 0 {
		return 0, ErrEmptyExport
	}
	if len(rec.ApplicationIDs) > MaxExportAuditIDs {
		return 0, ErrInvalidExport
	}
	ids := make([]string, 0, len(rec.ApplicationIDs))
	seen := make(map[string]struct{}, len(rec.ApplicationIDs))
	for _, id := range rec.ApplicationIDs {
		n := normalizeAppNo(id)
		if n == "" || !looseAppNoRe.MatchString(n) {
			return 0, ErrInvalidExport
		}
		if _, dup := seen[n]; dup {
			continue
		}
		seen[n] = struct{}{}
		ids = append(ids, n)
	}
	details := map[string]any{
		"count":          len(ids),
		"applicationIds": ids,
		"searchFiltered": rec.SearchFiltered,
	}
	if rec.StatusFilter != "" {
		st := domain.ApplicationStatus(rec.StatusFilter)
		if !st.IsValid() {
			return 0, ErrInvalidStatus
		}
		details["statusFilter"] = st
	}
	entry := &domain.AuditEntry{
		Action:     domain.AuditApplicantExportCSV,
		TargetType: domain.AuditTargetApplicant,
		Details:    details,
		IPAddress:  ip,
	}
	if adminID != 0 {
		entry.AdminID = &adminID
	}
	if err := s.audit.Log(ctx, entry); err != nil {
		return 0, fmt.Errorf("record export: %w", err)
	}
	return len(ids), nil
}
