package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
)

var (
	ErrInvalidSettings  = errors.New("invalid camp settings")
	ErrSettingsNotFound = domain.ErrSettingsNotFound
)

type UpdateSettingsRequest struct {
	CampName             *string          `json:"campName,omitempty"`
	RegistrationOpenAt   *string          `json:"registrationOpenAt,omitempty"`
	RegistrationCloseAt  *string          `json:"registrationCloseAt,omitempty"`
	AnnouncementAt       *string          `json:"announcementAt,omitempty"`
	PaymentOpenAt        *string          `json:"paymentOpenAt,omitempty"`
	PaymentDeadline      *string          `json:"paymentDeadline,omitempty"`
	CertificateReleaseAt *string          `json:"certificateReleaseAt,omitempty"`
	MaxCapacity          *int             `json:"maxCapacity,omitempty"`
	CampFee              *decimal.Decimal `json:"campFee,omitempty"`
	IsManualClosed       *bool            `json:"isManualClosed,omitempty"`
}

type SettingService struct {
	settingRepo domain.SettingRepository
	appRepo     domain.ApplicantRepository
}

func NewSettingService(settingRepo domain.SettingRepository, appRepo domain.ApplicantRepository) *SettingService {
	return &SettingService{
		settingRepo: settingRepo,
		appRepo:     appRepo,
	}
}

func (s *SettingService) GetPublicSettings(ctx context.Context) (*domain.PublicSettingsResponse, error) {
	settings, err := s.settingRepo.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load settings: %w", err)
	}

	now := time.Now().UTC()
	isOpen := isRegistrationOpenAt(settings, now)

	activeCount, err := s.appRepo.CountActive(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to count active applicants: %w", err)
	}

	isCertReleased := settings.CertificateReleaseAt != nil && !now.Before(*settings.CertificateReleaseAt)

	var campFee *decimal.Decimal
	if settings.CampFee.GreaterThan(decimal.Zero) {
		fee := settings.CampFee
		campFee = &fee
	}

	return &domain.PublicSettingsResponse{
		ServerTime:            now.Format(time.RFC3339),
		RegistrationOpenAt:    settings.RegistrationOpenAt.Format(time.RFC3339),
		IsOpen:                isOpen,
		CurrentCount:          activeCount,
		MaxCapacity:           settings.MaxCapacity,
		CampFee:               campFee,
		IsCertificateReleased: isCertReleased,
	}, nil
}

func (s *SettingService) GetAdminSettings(ctx context.Context) (*domain.Settings, error) {
	return s.settingRepo.Get(ctx)
}

func (s *SettingService) UpdateSettings(ctx context.Context, req UpdateSettingsRequest, adminID int64) (*domain.Settings, error) {
	if adminID <= 0 {
		return nil, errors.New("valid admin ID is required")
	}

	settings, err := s.settingRepo.Get(ctx)
	if err != nil {
		return nil, err
	}

	if req.CampName != nil {
		name := strings.TrimSpace(*req.CampName)
		if name == "" || utf8.RuneCountInString(name) > 150 {
			return nil, fmt.Errorf("%w: campName must be between 1 and 150 characters", ErrInvalidSettings)
		}
		settings.CampName = name
	}

	if req.RegistrationOpenAt != nil {
		t, err := parseRFC3339Timestamp("registrationOpenAt", *req.RegistrationOpenAt)
		if err != nil {
			return nil, err
		}
		settings.RegistrationOpenAt = t
	}
	if req.RegistrationCloseAt != nil {
		t, err := parseRFC3339Timestamp("registrationCloseAt", *req.RegistrationCloseAt)
		if err != nil {
			return nil, err
		}
		settings.RegistrationCloseAt = t
	}
	if !settings.RegistrationOpenAt.Before(settings.RegistrationCloseAt) {
		return nil, fmt.Errorf("%w: registrationOpenAt must be before registrationCloseAt", ErrInvalidSettings)
	}

	if req.AnnouncementAt != nil {
		t, err := parseRFC3339Timestamp("announcementAt", *req.AnnouncementAt)
		if err != nil {
			return nil, err
		}
		settings.AnnouncementAt = &t
	}
	if req.PaymentOpenAt != nil {
		t, err := parseRFC3339Timestamp("paymentOpenAt", *req.PaymentOpenAt)
		if err != nil {
			return nil, err
		}
		settings.PaymentOpenAt = &t
	}
	if req.PaymentDeadline != nil {
		t, err := parseRFC3339Timestamp("paymentDeadline", *req.PaymentDeadline)
		if err != nil {
			return nil, err
		}
		settings.PaymentDeadline = &t
	}
	if req.CertificateReleaseAt != nil {
		t, err := parseRFC3339Timestamp("certificateReleaseAt", *req.CertificateReleaseAt)
		if err != nil {
			return nil, err
		}
		settings.CertificateReleaseAt = &t
	}

	if req.MaxCapacity != nil {
		if *req.MaxCapacity <= 0 {
			return nil, fmt.Errorf("%w: maxCapacity must be greater than 0", ErrInvalidSettings)
		}
		settings.MaxCapacity = *req.MaxCapacity
	}
	if req.CampFee != nil {
		if req.CampFee.IsNegative() {
			return nil, fmt.Errorf("%w: campFee must be non-negative", ErrInvalidSettings)
		}
		settings.CampFee = *req.CampFee
	}
	if req.IsManualClosed != nil {
		settings.IsManualClosed = *req.IsManualClosed
	}

	settings.UpdatedByAdminID = &adminID
	settings.UpdatedAt = time.Now().UTC()

	if err := s.settingRepo.Update(ctx, settings); err != nil {
		return nil, fmt.Errorf("failed to update settings: %w", err)
	}

	return settings, nil
}

func parseRFC3339Timestamp(field, value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	t, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %s must be a valid RFC3339 timestamp", ErrInvalidSettings, field)
	}
	return t.UTC(), nil
}
