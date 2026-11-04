package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
)

var (
	ErrRegistrationClosed = errors.New("registration is currently closed")
	ErrQuotaExceeded      = errors.New("camp capacity quota reached")
	ErrInvalidNationalID  = errors.New("invalid national ID (must be 13 digits)")
	ErrInvalidPhone       = errors.New("invalid phone number (must be 10 digits starting with 0)")
	ErrInvalidShirtSize   = errors.New("invalid shirt size (choose XS, S, M, L, XL, 2XL, 3XL)")
	ErrApplicantNotFound  = errors.New("applicant not found")
	ErrCannotConfirm      = errors.New("cannot confirm attendance: status is not PASSED")
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
	Status              domain.ApplicationStatus `json:"status"`
	AttendanceConfirmed bool                     `json:"attendanceConfirmed"`
	SlipURL             *string                  `json:"slipUrl,omitempty"`
	CreatedAt           string                   `json:"createdAt"`
	UpdatedAt           string                   `json:"updatedAt,omitempty"`
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
	// Clean and normalize inputs
	req.NationalID = strings.TrimSpace(req.NationalID)
	req.Phone = strings.TrimSpace(req.Phone)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	req.FullName = strings.TrimSpace(req.FullName)
	req.Nickname = strings.TrimSpace(req.Nickname)
	req.School = strings.TrimSpace(req.School)
	req.Grade = strings.TrimSpace(req.Grade)
	req.ShirtSize = strings.ToUpper(strings.TrimSpace(req.ShirtSize))

	// 1. Validate Form Fields
	if len(req.NationalID) != 13 || !isNumeric(req.NationalID) {
		return nil, ErrInvalidNationalID
	}
	if len(req.Phone) != 10 || !strings.HasPrefix(req.Phone, "0") || !isNumeric(req.Phone) {
		return nil, ErrInvalidPhone
	}
	if req.FullName == "" || req.Nickname == "" || req.School == "" || req.Grade == "" {
		return nil, errors.New("required fields cannot be blank")
	}
	if !isValidShirtSize(req.ShirtSize) {
		return nil, ErrInvalidShirtSize
	}

	// 2. Check Camp Schedule & Settings
	settings, err := s.settingRepo.Get(ctx)
	if err == nil && settings != nil {
		now := time.Now().UTC()
		if settings.IsManualClosed {
			return nil, ErrRegistrationClosed
		}
		if now.Before(settings.RegistrationOpenAt) || now.After(settings.RegistrationCloseAt) {
			return nil, ErrRegistrationClosed
		}

		// Check Quota
		activeCount, err := s.appRepo.CountActive(ctx)
		if err == nil && settings.MaxCapacity > 0 && activeCount >= settings.MaxCapacity {
			return nil, ErrQuotaExceeded
		}
	}

	// Split full name into first and last name if possible
	parts := strings.SplitN(req.FullName, " ", 2)
	firstName := parts[0]
	lastName := ""
	if len(parts) > 1 {
		lastName = parts[1]
	}

	province := req.Province
	if province == "" {
		province = "เชียงใหม่" // Default fallback
	}

	appNo := generateAppNo()

	applicant := &domain.Applicant{
		ID:                  uuid.New(),
		ApplicationNo:       appNo,
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
	}

	if err := s.appRepo.Create(ctx, applicant); err != nil {
		return nil, fmt.Errorf("failed to register applicant: %w", err)
	}

	return s.toResponse(applicant, nil), nil
}

func (s *ApplicantService) QueryStatus(ctx context.Context, query string) (*ApplicationResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, errors.New("search query is required")
	}

	applicant, err := s.appRepo.FindByQuery(ctx, query)
	if err != nil {
		return nil, ErrApplicantNotFound
	}

	var slipURL *string
	if s.paymentRepo != nil {
		latestPayment, _ := s.paymentRepo.GetLatestByApplicantID(ctx, applicant.ID)
		if latestPayment != nil {
			slipURL = &latestPayment.SlipURL
		}
	}

	return s.toResponse(applicant, slipURL), nil
}

func (s *ApplicantService) ConfirmAttendance(ctx context.Context, appIdentifier string, confirmed bool) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.FindByQuery(ctx, appIdentifier)
	if err != nil {
		return nil, ErrApplicantNotFound
	}

	if applicant.Status != domain.StatusPassed && applicant.Status != domain.StatusConfirmed {
		return nil, ErrCannotConfirm
	}

	if err := s.appRepo.UpdateAttendance(ctx, applicant.ID, confirmed); err != nil {
		return nil, err
	}
	applicant.AttendanceConfirmed = confirmed

	return s.toResponse(applicant, nil), nil
}

func (s *ApplicantService) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*ApplicationResponse, error) {
	list, err := s.appRepo.ListAll(ctx, status)
	if err != nil {
		return nil, err
	}

	var responses []*ApplicationResponse
	for _, a := range list {
		var slipURL *string
		if s.paymentRepo != nil {
			payment, _ := s.paymentRepo.GetLatestByApplicantID(ctx, a.ID)
			if payment != nil {
				slipURL = &payment.SlipURL
			}
		}
		responses = append(responses, s.toResponse(a, slipURL))
	}
	return responses, nil
}

func (s *ApplicantService) UpdateStatus(ctx context.Context, appIdentifier string, newStatus domain.ApplicationStatus, adminID *int64, reason string) (*ApplicationResponse, error) {
	applicant, err := s.appRepo.FindByQuery(ctx, appIdentifier)
	if err != nil {
		return nil, ErrApplicantNotFound
	}

	if !newStatus.IsValid() {
		return nil, errors.New("invalid status")
	}

	if err := s.appRepo.UpdateStatus(ctx, applicant.ID, newStatus, adminID, reason); err != nil {
		return nil, err
	}
	applicant.Status = newStatus

	return s.toResponse(applicant, nil), nil
}

func (s *ApplicantService) toResponse(a *domain.Applicant, slipURL *string) *ApplicationResponse {
	fullName := a.FirstName
	if a.LastName != "" {
		fullName += " " + a.LastName
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
		Status:              a.Status,
		AttendanceConfirmed: a.AttendanceConfirmed,
		SlipURL:             slipURL,
		CreatedAt:           a.CreatedAt.Format(time.RFC3339),
		UpdatedAt:           a.UpdatedAt.Format(time.RFC3339),
	}
	return res
}

func isNumeric(s string) bool {
	matched, _ := regexp.MatchString(`^[0-9]+$`, s)
	return matched
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
