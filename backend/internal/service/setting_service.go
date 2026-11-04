package service

import (
	"context"
	"time"

	"comcamp25-backend/internal/domain"
)

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
	if settings.MaxCapacity > 0 && activeCount >= settings.MaxCapacity {
		isOpen = false
	}

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
