package service

import (
	"context"
	"time"

	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
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
		return nil, err
	}

	now := time.Now().UTC()
	isOpen := !settings.IsManualClosed &&
		now.After(settings.RegistrationOpenAt) &&
		now.Before(settings.RegistrationCloseAt)

	activeCount, _ := s.appRepo.CountActive(ctx)
	isCertReleased := settings.CertificateReleaseAt != nil && now.After(*settings.CertificateReleaseAt)

	return &domain.PublicSettingsResponse{
		ServerTime:            now.Format(time.RFC3339),
		RegistrationOpenAt:    settings.RegistrationOpenAt.Format(time.RFC3339),
		IsOpen:                isOpen,
		CurrentCount:          activeCount,
		MaxCapacity:           settings.MaxCapacity,
		CampFee:               &settings.CampFee,
		IsCertificateReleased: isCertReleased,
	}, nil
}

func (s *SettingService) GetAdminSettings(ctx context.Context) (*domain.Settings, error) {
	return s.settingRepo.Get(ctx)
}

func (s *SettingService) UpdateSettings(ctx context.Context, req UpdateSettingsRequest, adminID int64) (*domain.Settings, error) {
	settings, err := s.settingRepo.Get(ctx)
	if err != nil {
		return nil, err
	}

	if req.CampName != nil {
		settings.CampName = *req.CampName
	}
	if req.RegistrationOpenAt != nil {
		if t, err := time.Parse(time.RFC3339, *req.RegistrationOpenAt); err == nil {
			settings.RegistrationOpenAt = t
		}
	}
	if req.RegistrationCloseAt != nil {
		if t, err := time.Parse(time.RFC3339, *req.RegistrationCloseAt); err == nil {
			settings.RegistrationCloseAt = t
		}
	}
	if req.AnnouncementAt != nil {
		if t, err := time.Parse(time.RFC3339, *req.AnnouncementAt); err == nil {
			settings.AnnouncementAt = &t
		}
	}
	if req.PaymentOpenAt != nil {
		if t, err := time.Parse(time.RFC3339, *req.PaymentOpenAt); err == nil {
			settings.PaymentOpenAt = &t
		}
	}
	if req.PaymentDeadline != nil {
		if t, err := time.Parse(time.RFC3339, *req.PaymentDeadline); err == nil {
			settings.PaymentDeadline = &t
		}
	}
	if req.CertificateReleaseAt != nil {
		if t, err := time.Parse(time.RFC3339, *req.CertificateReleaseAt); err == nil {
			settings.CertificateReleaseAt = &t
		}
	}
	if req.MaxCapacity != nil && *req.MaxCapacity > 0 {
		settings.MaxCapacity = *req.MaxCapacity
	}
	if req.CampFee != nil {
		settings.CampFee = *req.CampFee
	}
	if req.IsManualClosed != nil {
		settings.IsManualClosed = *req.IsManualClosed
	}

	settings.UpdatedByAdminID = &adminID
	settings.UpdatedAt = time.Now().UTC()

	if err := s.settingRepo.Update(ctx, settings); err != nil {
		return nil, err
	}

	return settings, nil
}
