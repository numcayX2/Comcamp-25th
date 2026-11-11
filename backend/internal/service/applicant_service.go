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
	ErrInvalidGrade          = newValidationError("invalid grade (choose ม.4–ม.6 / ปวช.1–ปวช.3, or enter your own level, 2–20 characters)")
	ErrRequiredFields        = newValidationError("required fields cannot be blank")
	ErrInvalidStatus         = newValidationError("invalid status")
	ErrInvalidIdempotencyKey = newValidationError("X-Idempotency-Key must be a UUID")
	ErrInvalidQuery          = newValidationError("search query must be a national ID, phone number or application ID")
	ErrVerifyCodeRequired    = newValidationError("verifyCode must be the last 4 digits of the applicant's national ID")
	ErrInvalidVerifyCode     = errors.New("verification code does not match this application")
	ErrCannotWithdraw        = errors.New("this application can no longer be cancelled online (confirmed, slip already sent, or already closed), please contact staff")
	ErrProfileLocked         = errors.New("this application can no longer be edited, please contact staff")
	ErrIdentityLocked        = newValidationError("full name, national ID, phone, email and motivation cannot be changed here, please contact staff")
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
	// TurnstileToken is the single-use Cloudflare Turnstile response. It is verified, never
	// stored, and never logged.
	TurnstileToken string `json:"turnstileToken,omitempty"`
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
	SlipURL *string `json:"slipUrl,omitempty"`
	// SlipPaymentID (admin only) identifies the latest slip. The admin UI sends it back as
	// paymentId with the verdict, so a slip replaced meanwhile is not settled by mistake.
	SlipPaymentID *string `json:"slipPaymentId,omitempty"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt,omitempty"`
}

type ApplicantService struct {
	appRepo     domain.ApplicantRepository
	settingRepo domain.SettingRepository
	paymentRepo domain.PaymentRepository
	// captcha is nil only when Turnstile is deliberately off (development without a secret, tests).
	// main always sets it in production; config refuses to start without TURNSTILE_SECRET_KEY.
	captcha TurnstileVerifier
	// verify locks an application after repeated wrong verifyCode / nationalId answers. main
	// shares one guard with PaymentService (WithVerifyGuard) so the limit spans every endpoint.
	verify *VerifyGuard
}

// WithVerifyGuard replaces the service's own lockout guard with a shared one and returns the
// service.
func (s *ApplicantService) WithVerifyGuard(g *VerifyGuard) *ApplicantService {
	if g != nil {
		s.verify = g
	}
	return s
}

// WithTurnstile enables captcha verification on registration and returns the service.
func (s *ApplicantService) WithTurnstile(v TurnstileVerifier) *ApplicantService {
	s.captcha = v
	return s
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
	now := time.Now().UTC()
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

	applicant := &domain.Applicant{
		ID:               uuid.New(),
		NationalID:       req.NationalID,
		Prefix:           "",
		FirstName:        firstName,
		LastName:         lastName,
		Nickname:         req.Nickname,
		BirthDate:        time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC), // Default if not filled in minimal form
		Gender:           "unspecified",
		School:           req.School,
		Grade:            req.Grade,
		Phone:            req.Phone,
		Email:            req.Email,
		Province:         province,
		EmergencyContact: "ผู้ปกครอง",
		EmergencyPhone:   req.Phone,
		ShirtSize:        req.ShirtSize,
		HasLaptop:        true,
		Motivation:       &req.Motivation,
		// First come, first served: the quota check above is the selection, so the applicant holds
		// a seat (and may upload a slip) straight away, with no staff step in between.
		Status:              domain.StatusPassed,
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
	School, Province, Grade, ShirtSize           string
	Motivation                                   string
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
	p.School = cleanText(p.School)
	p.Grade = cleanText(p.Grade)
	p.Province = cleanText(p.Province)
	p.Motivation = strings.TrimSpace(stripZeroWidth(p.Motivation))
	p.ShirtSize = strings.ToUpper(strings.TrimSpace(stripZeroWidth(p.ShirtSize)))
	return p
}

func normalizeRequest(req ApplicationCreateRequest) ApplicationCreateRequest {
	p := normalizeProfile(profileInput{
		FullName: req.FullName, Nickname: req.Nickname, NationalID: req.NationalID, Phone: req.Phone,
		Email: req.Email, School: req.School, Province: req.Province, Grade: req.Grade,
		ShirtSize: req.ShirtSize, Motivation: req.Motivation,
	})
	return ApplicationCreateRequest{
		FullName: p.FullName, Nickname: p.Nickname, NationalID: p.NationalID, Phone: p.Phone,
		Email: p.Email, School: p.School, Grade: p.Grade, ShirtSize: p.ShirtSize,
		Motivation: p.Motivation, Province: p.Province,
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

// checkEmail: empty is allowed (the field is optional); otherwise a bare address within the limit.
func checkEmail(email string) error {
	if email == "" {
		return nil
	}
	if utf8.RuneCountInString(email) > maxEmailRunes {
		return ErrInvalidEmail
	}
	if addr, err := mail.ParseAddress(email); err != nil || addr.Address != email {
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
		{p.School, maxSchoolRunes, "school"},
		{p.Province, maxProvinceRunes, "province"},
		{p.Motivation, maxMotivationRunes, "motivation"},
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

// validateSecondary checks only the fields an applicant may edit themselves. Nothing here is an
// identifier, so there is no way to use it to swap who the application belongs to.
func validateSecondary(p profileInput) error {
	if p.Nickname == "" || p.School == "" || p.Province == "" || p.Grade == "" {
		return ErrRequiredFields
	}
	if !isValidShirtSize(p.ShirtSize) {
		return ErrInvalidShirtSize
	}
	if !isValidGrade(p.Grade) {
		return ErrInvalidGrade
	}
	return checkLengths(p)
}

func validateRequest(req ApplicationCreateRequest) error {
	return validateProfile(profileInput{
		FullName: req.FullName, Nickname: req.Nickname, NationalID: req.NationalID, Phone: req.Phone,
		Email: req.Email, School: req.School, Province: req.Province, Grade: req.Grade,
		ShirtSize: req.ShirtSize, Motivation: req.Motivation,
	})
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
// Repeated wrong codes lock the application (VerifyGuard); the client IP for the audit row comes
// from WithRemoteIP.
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

	if err := s.appRepo.UpdateAttendance(ctx, applicant.ID, confirmed); err != nil {
		return nil, err
	}
	applicant.AttendanceConfirmed = confirmed

	return s.toPublic(ctx, applicant), nil
}

// CanSeeFullNationalID reports whether an admin role may receive the raw 13-digit national ID.
// Only superadmin and staff may. The ID authorises the public withdraw endpoint
// (POST /api/applications/{id}/withdraw), so handing it to a finance or reviewer account would let
// that account cancel applications, which the router reserves for superadmin. Fail closed: an
// empty or unknown role gets the masked value.
func CanSeeFullNationalID(role domain.AdminRole) bool {
	return role == domain.RoleSuperadmin || role == domain.RoleStaff
}

// ListAll is the admin list. role is the caller's role: callers that may not see full national IDs
// (see CanSeeFullNationalID) get them masked like the public status page.
func (s *ApplicantService) ListAll(ctx context.Context, status *domain.ApplicationStatus, role domain.AdminRole) ([]*ApplicationResponse, error) {
	if status != nil && !status.IsValid() {
		return nil, ErrInvalidStatus
	}
	list, err := s.appRepo.ListAll(ctx, status)
	if err != nil {
		return nil, err
	}

	maskID := !CanSeeFullNationalID(role)
	responses := make([]*ApplicationResponse, 0, len(list))
	for _, a := range list {
		res, err := s.toAdmin(ctx, a)
		if err != nil {
			return nil, err
		}
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
	applicant.Status = newStatus

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

	return s.appRepo.SoftDelete(ctx, applicant.ID, &adminID, reason, audit)
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
	return nil
}

// SelfProfileRequest is the applicant's own edit of the secondary fields. The identity fields
// are declared only so that a request which tries to change them is refused (ErrIdentityLocked)
// instead of having them silently dropped: changing who an application belongs to is staff-only
// (anti-scalping, PDPA).
type SelfProfileRequest struct {
	// VerifyCode is the last 4 digits of the applicant national ID (AGENTS.md section 13.5).
	VerifyCode string `json:"verifyCode"`
	Nickname   string `json:"nickname"`
	School     string `json:"school"`
	Province   string `json:"province"`
	Grade      string `json:"grade"`
	ShirtSize  string `json:"shirtSize"`

	FullName   *string `json:"fullName,omitempty"`
	NationalID *string `json:"nationalId,omitempty"`
	Phone      *string `json:"phone,omitempty"`
	Email      *string `json:"email,omitempty"`
	Motivation *string `json:"motivation,omitempty"`
}

// AdminProfileRequest is the staff edit. A nil field keeps its stored value, so a client may send
// only what changed; the merged result is validated as a whole.
type AdminProfileRequest struct {
	FullName   *string `json:"fullName,omitempty"`
	Nickname   *string `json:"nickname,omitempty"`
	NationalID *string `json:"nationalId,omitempty"`
	Phone      *string `json:"phone,omitempty"`
	Email      *string `json:"email,omitempty"`
	School     *string `json:"school,omitempty"`
	Province   *string `json:"province,omitempty"`
	Grade      *string `json:"grade,omitempty"`
	ShirtSize  *string `json:"shirtSize,omitempty"`
	Motivation *string `json:"motivation,omitempty"`
	Reason     string  `json:"reason,omitempty"`
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
	if a.Motivation != nil {
		p.Motivation = *a.Motivation
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
		{"school", before.School, after.School},
		{"province", before.Province, after.Province},
		{"grade", before.Grade, after.Grade},
		{"shirtSize", before.ShirtSize, after.ShirtSize},
		{"motivation", before.Motivation, after.Motivation},
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
	return domain.ProfileFields{
		FirstName: first, LastName: last, Nickname: p.Nickname, NationalID: p.NationalID,
		Phone: p.Phone, Email: p.Email, School: p.School, Province: p.Province, Grade: p.Grade,
		ShirtSize: p.ShirtSize, Motivation: &motivation,
	}, nil
}

// UpdateOwnProfile lets an applicant fix their nickname, school, province, grade and shirt size
// from /status. Public, so it needs the application ID plus verifyCode, only works while the
// application still holds a seat, and refuses any attempt to touch identity fields. The change
// and its audit row (application.profile.update.self, no admin) commit together.
func (s *ApplicantService) UpdateOwnProfile(ctx context.Context, applicationNo string, req SelfProfileRequest, ip string) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.GetByApplicationNo(ctx, normalizeAppNo(applicationNo))
	if err != nil {
		return nil, notFoundOr(err)
	}
	// Authenticate before revealing anything about the application state.
	if err := s.verify.Check(ctx, applicant.ApplicationNo, VerifyActionProfile, ip, func() error {
		return CheckVerifyCode(applicant, req.VerifyCode)
	}); err != nil {
		return nil, err
	}
	if !applicant.Status.IsActive() {
		return nil, ErrProfileLocked
	}
	if req.FullName != nil || req.NationalID != nil || req.Phone != nil || req.Email != nil || req.Motivation != nil {
		return nil, ErrIdentityLocked
	}

	before := profileOf(applicant)
	after := normalizeProfile(profileInput{
		FullName: before.FullName, NationalID: before.NationalID, Phone: before.Phone, Email: before.Email,
		Motivation: before.Motivation,
		Nickname:   req.Nickname, School: req.School, Province: req.Province, Grade: req.Grade, ShirtSize: req.ShirtSize,
	})
	if err := validateSecondary(after); err != nil {
		return nil, err
	}

	changes := profileChanges(before, after)
	if len(changes) == 0 {
		return s.toPublic(ctx, applicant), nil
	}
	fields, err := profileFieldsOf(after)
	if err != nil {
		return nil, err
	}
	audit := &domain.AuditEntry{
		Action:     domain.AuditProfileUpdateSelf,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   applicant.ApplicationNo,
		Details:    map[string]any{"changes": changes, "ip": ip, "selfService": true},
		IPAddress:  ip,
	}
	if err := s.appRepo.UpdateProfile(ctx, applicant.ID, fields, true, audit); err != nil {
		if errors.Is(err, domain.ErrStateConflict) {
			return nil, ErrProfileLocked
		}
		return nil, notFoundOr(err)
	}

	updated, err := s.appRepo.GetByID(ctx, applicant.ID)
	if err != nil {
		return nil, notFoundOr(err)
	}
	return s.toPublic(ctx, updated), nil
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
		{&merged.Phone, req.Phone}, {&merged.Email, req.Email}, {&merged.School, req.School},
		{&merged.Province, req.Province}, {&merged.Grade, req.Grade}, {&merged.ShirtSize, req.ShirtSize},
		{&merged.Motivation, req.Motivation},
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
		pid := p.ID.String()
		res.SlipPaymentID = &pid
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
