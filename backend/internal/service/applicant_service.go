package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

const (
	maxAppNoGenerateAttempts = 5
	maxFullNameLen           = 200
	maxNicknameLen           = 50
	maxSchoolLen             = 150
	maxEmailLen              = 150
	maxProvinceLen           = 100
	maxMotivationLen         = 2000
)

var (
	ErrRegistrationClosed      = errors.New("registration is currently closed")
	ErrQuotaExceeded           = domain.ErrQuotaExceeded
	ErrApplicantNotFound       = domain.ErrApplicantNotFound
	ErrDuplicateApplicant      = domain.ErrDuplicateApplicant
	ErrInvalidNationalID       = errors.New("invalid national ID (must be 13 digits)")
	ErrInvalidPhone            = errors.New("invalid phone number (must be 10 digits starting with 0)")
	ErrInvalidShirtSize        = errors.New("invalid shirt size (choose XS, S, M, L, XL, 2XL, 3XL)")
	ErrInvalidEmail            = errors.New("invalid email address")
	ErrInvalidGrade            = errors.New("invalid grade (choose ม.4, ม.5, ม.6, ปวช.1, ปวช.2, or ปวช.3)")
	ErrInvalidInput            = errors.New("invalid or missing required fields")
	ErrCannotConfirm           = errors.New("cannot confirm attendance: status is not PASSED")
	ErrInvalidStatus           = domain.ErrInvalidStatus
	ErrInvalidStatusTransition = errors.New("invalid application status transition")
)

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
	Motivation          string                   `json:"motivation"`
	Province            string                   `json:"province,omitempty"`
	Status              domain.ApplicationStatus `json:"status"`
	AttendanceConfirmed bool                     `json:"attendanceConfirmed"`
	SlipURL             *string                  `json:"slipUrl,omitempty"`
	SlipStatus          *string                  `json:"slipStatus,omitempty"`
	SlipUploadedAt      *string                  `json:"slipUploadedAt,omitempty"`
	SlipVerifiedBy      *string                  `json:"slipVerifiedBy,omitempty"`
	RejectionReason     *string                  `json:"rejectionReason,omitempty"`
	CreatedAt           string                   `json:"createdAt"`
	UpdatedAt           string                   `json:"updatedAt,omitempty"`
}

type AdminListFilter struct {
	Status *domain.ApplicationStatus
	Query  string
}

type PaginatedApplicationsResponse struct {
	Items      []*ApplicationResponse `json:"items"`
	Total      int                    `json:"total"`
	Page       int                    `json:"page"`
	Limit      int                    `json:"limit"`
	TotalPages int                    `json:"totalPages"`
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

func (s *ApplicantService) Submit(ctx context.Context, req ApplicationCreateRequest) (*ApplicationResponse, error) {
	req.NationalID = strings.TrimSpace(req.NationalID)
	req.Phone = strings.TrimSpace(req.Phone)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.FullName = strings.TrimSpace(req.FullName)
	req.Nickname = strings.TrimSpace(req.Nickname)
	req.School = strings.TrimSpace(req.School)
	req.Grade = strings.TrimSpace(req.Grade)
	req.ShirtSize = strings.ToUpper(strings.TrimSpace(req.ShirtSize))
	req.Province = strings.TrimSpace(req.Province)
	req.Motivation = strings.TrimSpace(req.Motivation)

	if len(req.NationalID) != 13 || !isNumeric(req.NationalID) {
		return nil, ErrInvalidNationalID
	}
	if len(req.Phone) != 10 || !strings.HasPrefix(req.Phone, "0") || !isNumeric(req.Phone) {
		return nil, ErrInvalidPhone
	}
	if req.FullName == "" || req.Nickname == "" || req.School == "" || req.Grade == "" {
		return nil, fmt.Errorf("%w: required fields cannot be blank", ErrInvalidInput)
	}
	if utf8.RuneCountInString(req.FullName) > maxFullNameLen ||
		utf8.RuneCountInString(req.Nickname) > maxNicknameLen ||
		utf8.RuneCountInString(req.School) > maxSchoolLen ||
		utf8.RuneCountInString(req.Email) > maxEmailLen ||
		utf8.RuneCountInString(req.Province) > maxProvinceLen ||
		utf8.RuneCountInString(req.Motivation) > maxMotivationLen {
		return nil, fmt.Errorf("%w: one or more fields exceed maximum length", ErrInvalidInput)
	}
	if !isValidGrade(req.Grade) {
		return nil, ErrInvalidGrade
	}
	if !isValidShirtSize(req.ShirtSize) {
		return nil, ErrInvalidShirtSize
	}
	if req.Email != "" && !isValidEmail(req.Email) {
		return nil, ErrInvalidEmail
	}

	// Fail closed if camp settings cannot be loaded.
	settings, err := s.settingRepo.Get(ctx)
	if err != nil || settings == nil {
		return nil, fmt.Errorf("failed to load registration settings: %w", err)
	}
	if !isRegistrationOpenAt(settings, time.Now().UTC()) {
		return nil, ErrRegistrationClosed
	}

	parts := strings.SplitN(req.FullName, " ", 2)
	firstName := strings.TrimSpace(parts[0])
	lastName := ""
	if len(parts) > 1 {
		lastName = strings.TrimSpace(parts[1])
	}

	province := req.Province
	if province == "" {
		province = "เชียงใหม่"
	}

	for attempt := 0; attempt < maxAppNoGenerateAttempts; attempt++ {
		appNo, genErr := generateAppNo()
		if genErr != nil {
			return nil, fmt.Errorf("failed to generate application number: %w", genErr)
		}

		applicant := &domain.Applicant{
			ID:                  uuid.New(),
			ApplicationNo:       appNo,
			NationalID:          req.NationalID,
			Prefix:              "",
			FirstName:           firstName,
			LastName:            lastName,
			Nickname:            req.Nickname,
			BirthDate:           time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC),
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
		}

		err := s.appRepo.Create(ctx, applicant)
		if err == nil {
			return s.toResponse(applicant, nil), nil
		}
		if errors.Is(err, domain.ErrDuplicateApplicationNo) {
			continue
		}
		if errors.Is(err, domain.ErrDuplicateApplicant) {
			return nil, ErrDuplicateApplicant
		}
		return nil, fmt.Errorf("failed to register applicant: %w", err)
	}

	return nil, errors.New("failed to allocate unique application number")
}

func (s *ApplicantService) QueryStatus(ctx context.Context, query string) (*ApplicationResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("%w: search query is required", ErrInvalidInput)
	}

	applicant, err := s.appRepo.FindByQuery(ctx, query)
	if err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		return nil, fmt.Errorf("failed to query applicant status: %w", err)
	}

	latestPayment, err := s.getLatestPayment(ctx, applicant.ID)
	if err != nil {
		return nil, err
	}

	res := s.toResponse(applicant, latestPayment)
	maskPII(res)
	return res, nil
}

func (s *ApplicantService) ConfirmAttendance(ctx context.Context, appIdentifier string, confirmed bool) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.FindByIDOrAppNo(ctx, appIdentifier)
	if err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		return nil, fmt.Errorf("failed to find applicant: %w", err)
	}

	if applicant.Status != domain.StatusPassed {
		return nil, ErrCannotConfirm
	}

	if err := s.appRepo.UpdateAttendance(ctx, applicant.ID, confirmed); err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		return nil, fmt.Errorf("failed to update attendance confirmation: %w", err)
	}
	applicant.AttendanceConfirmed = confirmed

	reason := "Applicant confirmed attendance"
	if !confirmed {
		reason = "Applicant declined attendance"
	}
	if err := s.appRepo.UpdateStatus(ctx, applicant.ID, applicant.Status, nil, reason); err != nil {
		return nil, fmt.Errorf("failed to log attendance confirmation: %w", err)
	}

	latestPayment, err := s.getLatestPayment(ctx, applicant.ID)
	if err != nil {
		return nil, err
	}

	return s.toResponse(applicant, latestPayment), nil
}

func (s *ApplicantService) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*ApplicationResponse, error) {
	return s.ListFiltered(ctx, AdminListFilter{Status: status})
}

func (s *ApplicantService) ListFiltered(ctx context.Context, filter AdminListFilter) ([]*ApplicationResponse, error) {
	if filter.Status != nil && !filter.Status.IsValid() {
		return nil, ErrInvalidStatus
	}

	list, err := s.appRepo.ListAll(ctx, filter.Status)
	if err != nil {
		return nil, fmt.Errorf("failed to list applicants: %w", err)
	}

	query := strings.ToLower(strings.TrimSpace(filter.Query))
	filtered := make([]*domain.Applicant, 0, len(list))
	for _, a := range list {
		if query != "" && !matchesAdminQuery(a, query) {
			continue
		}
		filtered = append(filtered, a)
	}

	paymentsByApplicant := make(map[uuid.UUID]*domain.Payment)
	if s.paymentRepo != nil && len(filtered) > 0 {
		ids := make([]uuid.UUID, 0, len(filtered))
		for _, a := range filtered {
			ids = append(ids, a.ID)
		}
		var payErr error
		paymentsByApplicant, payErr = s.paymentRepo.GetLatestByApplicantIDs(ctx, ids)
		if payErr != nil {
			return nil, fmt.Errorf("failed to batch load payments: %w", payErr)
		}
	}

	responses := make([]*ApplicationResponse, 0, len(filtered))
	for _, a := range filtered {
		responses = append(responses, s.toResponse(a, paymentsByApplicant[a.ID]))
	}
	return responses, nil
}

func (s *ApplicantService) UpdateStatus(ctx context.Context, appIdentifier string, newStatus domain.ApplicationStatus, adminID *int64, reason string) (*ApplicationResponse, error) {
	if !newStatus.IsValid() {
		return nil, ErrInvalidStatus
	}

	applicant, err := s.appRepo.FindByIDOrAppNo(ctx, appIdentifier)
	if err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		return nil, fmt.Errorf("failed to find applicant: %w", err)
	}

	if !isAllowedStatusTransition(applicant.Status, newStatus) {
		return nil, fmt.Errorf("%w: cannot transition from %s to %s", ErrInvalidStatusTransition, applicant.Status, newStatus)
	}

	if newStatus == domain.StatusConfirmed && applicant.Status != domain.StatusConfirmed {
		settings, err := s.settingRepo.Get(ctx)
		if err != nil || settings == nil {
			return nil, fmt.Errorf("failed to load camp settings: %w", err)
		}
		confirmedCount, err := s.appRepo.CountConfirmed(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to count confirmed applicants: %w", err)
		}
		if confirmedCount >= settings.MaxCapacity {
			return nil, ErrQuotaExceeded
		}
	}

	reason = strings.TrimSpace(reason)
	if err := s.appRepo.UpdateStatus(ctx, applicant.ID, newStatus, adminID, reason); err != nil {
		if errors.Is(err, domain.ErrApplicantNotFound) {
			return nil, ErrApplicantNotFound
		}
		if errors.Is(err, domain.ErrQuotaExceeded) {
			return nil, ErrQuotaExceeded
		}
		return nil, fmt.Errorf("failed to update applicant status: %w", err)
	}

	applicant.Status = newStatus
	if newStatus == domain.StatusConfirmed {
		applicant.AttendanceConfirmed = true
	}

	latestPayment, err := s.getLatestPayment(ctx, applicant.ID)
	if err != nil {
		return nil, err
	}

	return s.toResponse(applicant, latestPayment), nil
}

func (s *ApplicantService) getLatestPayment(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	if s.paymentRepo == nil {
		return nil, nil
	}
	p, err := s.paymentRepo.GetLatestByApplicantID(ctx, applicantID)
	if err != nil {
		if errors.Is(err, domain.ErrPaymentNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to load latest payment: %w", err)
	}
	return p, nil
}

func (s *ApplicantService) toResponse(a *domain.Applicant, payment *domain.Payment) *ApplicationResponse {
	fullName := strings.TrimSpace(a.FirstName)
	if a.LastName != "" {
		fullName = strings.TrimSpace(fullName + " " + a.LastName)
	}
	if a.Prefix != "" {
		fullName = strings.TrimSpace(a.Prefix + fullName)
	}

	mot := ""
	if a.Motivation != nil {
		mot = *a.Motivation
	}

	res := &ApplicationResponse{
		ID:                  a.ApplicationNo,
		FullName:            fullName,
		Nickname:            a.Nickname,
		NationalID:          a.NationalID,
		Phone:               a.Phone,
		Email:               a.Email,
		School:              a.School,
		Grade:               a.Grade,
		ShirtSize:           a.ShirtSize,
		Motivation:          mot,
		Province:            a.Province,
		Status:              a.Status,
		AttendanceConfirmed: a.AttendanceConfirmed,
		CreatedAt:           a.CreatedAt.Format(time.RFC3339),
		UpdatedAt:           a.UpdatedAt.Format(time.RFC3339),
	}

	if payment != nil {
		slipURL := payment.SlipURL
		res.SlipURL = &slipURL

		slipStatus := string(payment.Status)
		res.SlipStatus = &slipStatus

		uploadedAt := payment.UploadedAt.UTC().Format(time.RFC3339)
		res.SlipUploadedAt = &uploadedAt

		if payment.VerifiedByAdminID != nil {
			verifiedBy := strconv.FormatInt(*payment.VerifiedByAdminID, 10)
			res.SlipVerifiedBy = &verifiedBy
		}
		if payment.Status == domain.PaymentRejected && payment.RejectionReason != nil && *payment.RejectionReason != "" {
			reason := *payment.RejectionReason
			res.RejectionReason = &reason
		}
	}

	return res
}

func isRegistrationOpenAt(settings *domain.Settings, now time.Time) bool {
	if settings == nil || settings.IsManualClosed {
		return false
	}
	return !now.Before(settings.RegistrationOpenAt) && now.Before(settings.RegistrationCloseAt)
}

func isAllowedStatusTransition(from, to domain.ApplicationStatus) bool {
	if from == to {
		return true
	}
	switch from {
	case domain.StatusPending:
		return to == domain.StatusPassed || to == domain.StatusReserve || to == domain.StatusRejected
	case domain.StatusPassed:
		return to == domain.StatusConfirmed || to == domain.StatusReserve || to == domain.StatusRejected || to == domain.StatusPending
	case domain.StatusReserve:
		return to == domain.StatusPassed || to == domain.StatusRejected || to == domain.StatusPending
	case domain.StatusConfirmed:
		return to == domain.StatusPassed || to == domain.StatusRejected
	case domain.StatusRejected:
		return to == domain.StatusPending || to == domain.StatusPassed || to == domain.StatusReserve
	default:
		return false
	}
}

func matchesAdminQuery(a *domain.Applicant, q string) bool {
	return strings.Contains(strings.ToLower(a.ApplicationNo), q) ||
		strings.Contains(strings.ToLower(a.FullName()), q) ||
		strings.Contains(strings.ToLower(a.Nickname), q) ||
		strings.Contains(a.NationalID, q) ||
		strings.Contains(a.Phone, q) ||
		strings.Contains(strings.ToLower(a.Email), q) ||
		strings.Contains(strings.ToLower(a.School), q) ||
		strings.Contains(strings.ToLower(a.Province), q)
}

func maskPII(res *ApplicationResponse) {
	if res == nil {
		return
	}
	res.NationalID = maskNationalID(res.NationalID)
	res.Phone = maskPhone(res.Phone)
	res.Email = maskEmail(res.Email)
}

func maskNationalID(id string) string {
	if len(id) != 13 {
		if len(id) <= 4 {
			return "****"
		}
		return id[:2] + strings.Repeat("*", len(id)-4) + id[len(id)-2:]
	}
	return id[:5] + "******" + id[11:]
}

func maskPhone(phone string) string {
	if len(phone) < 7 {
		return "****"
	}
	return phone[:3] + strings.Repeat("*", len(phone)-6) + phone[len(phone)-3:]
}

func maskEmail(email string) string {
	if email == "" {
		return ""
	}
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 || parts[0] == "" {
		return "***"
	}
	local := parts[0]
	r := []rune(local)
	if len(r) <= 1 {
		return "*@" + parts[1]
	}
	return string(r[0]) + "***@" + parts[1]
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isValidShirtSize(size string) bool {
	switch size {
	case "XS", "S", "M", "L", "XL", "2XL", "3XL":
		return true
	}
	return false
}

func isValidGrade(grade string) bool {
	switch grade {
	case "ม.4", "ม.5", "ม.6", "ปวช.1", "ปวช.2", "ปวช.3":
		return true
	}
	return false
}

func isValidEmail(email string) bool {
	if email == "" || strings.ContainsAny(email, " \t\r\n") {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email {
		return false
	}
	parts := strings.Split(email, "@")
	return len(parts) == 2 && parts[0] != "" && strings.Contains(parts[1], ".") && !strings.HasPrefix(parts[1], ".") && !strings.HasSuffix(parts[1], ".")
}

func generateAppNo() (string, error) {
	b := make([]byte, 3)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("CC25-%X", b), nil
}
