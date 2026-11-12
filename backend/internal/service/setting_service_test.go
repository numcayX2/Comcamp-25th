package service_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func TestSettingService_GetPublicSettings(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	svc := service.NewSettingService(setRepo, appRepo)

	pub, err := svc.GetPublicSettings(ctx)
	if err != nil {
		t.Fatalf("GetPublicSettings failed: %v", err)
	}
	if !pub.IsOpen || pub.CampFee == nil || !pub.CampFee.Equal(decimal.NewFromInt(300)) {
		t.Errorf("unexpected default public settings: %+v", pub)
	}
	if pub.IsCertificateReleased {
		t.Errorf("expected IsCertificateReleased=false by default")
	}

	// Zero campFee returns nil CampFee, past CertificateReleaseAt sets IsCertificateReleased=true, IsManualClosed closes registration
	past := time.Now().UTC().Add(-10 * time.Minute)
	_ = setRepo.Update(ctx, &domain.Settings{
		ID:                   1,
		CampName:             "ComCamp 25th",
		RegistrationOpenAt:   time.Now().UTC().Add(-time.Hour),
		RegistrationCloseAt:  time.Now().UTC().Add(time.Hour),
		CertificateReleaseAt: &past,
		MaxCapacity:          40,
		CampFee:              decimal.Zero,
		IsManualClosed:       true,
	})
	pub2, err := svc.GetPublicSettings(ctx)
	if err != nil {
		t.Fatalf("GetPublicSettings failed: %v", err)
	}
	if pub2.IsOpen {
		t.Errorf("expected IsOpen=false when IsManualClosed=true")
	}
	if pub2.CampFee != nil {
		t.Errorf("expected CampFee=nil when CampFee<=0, got %v", pub2.CampFee)
	}
	if !pub2.IsCertificateReleased {
		t.Errorf("expected IsCertificateReleased=true when CertificateReleaseAt is in the past")
	}
}

func TestSettingService_UpdateSettings_ValidationAndSuccess(t *testing.T) {
	ctx := context.Background()
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	svc := service.NewSettingService(setRepo, appRepo)

	invalidTimestamp := "2026-13-45 not-rfc3339"
	emptyName := "   "
	longName := strings.Repeat("A", 151)
	zeroCap := 0
	negCap := -5
	negFee := decimal.NewFromInt(-1)
	openAfter := "2026-12-10T00:00:00Z"
	closeBefore := "2026-12-09T00:00:00Z"
	sameTime := "2026-12-10T00:00:00Z"

	invalidCases := []struct {
		name string
		req  service.UpdateSettingsRequest
	}{
		{"invalid registrationOpenAt RFC3339", service.UpdateSettingsRequest{RegistrationOpenAt: &invalidTimestamp}},
		{"invalid registrationCloseAt RFC3339", service.UpdateSettingsRequest{RegistrationCloseAt: &invalidTimestamp}},
		{"invalid announcementAt RFC3339", service.UpdateSettingsRequest{AnnouncementAt: &invalidTimestamp}},
		{"invalid paymentOpenAt RFC3339", service.UpdateSettingsRequest{PaymentOpenAt: &invalidTimestamp}},
		{"invalid paymentDeadline RFC3339", service.UpdateSettingsRequest{PaymentDeadline: &invalidTimestamp}},
		{"invalid certificateReleaseAt RFC3339", service.UpdateSettingsRequest{CertificateReleaseAt: &invalidTimestamp}},
		{"openAt > closeAt", service.UpdateSettingsRequest{RegistrationOpenAt: &openAfter, RegistrationCloseAt: &closeBefore}},
		{"openAt == closeAt", service.UpdateSettingsRequest{RegistrationOpenAt: &sameTime, RegistrationCloseAt: &sameTime}},
		{"maxCapacity == 0", service.UpdateSettingsRequest{MaxCapacity: &zeroCap}},
		{"maxCapacity < 0", service.UpdateSettingsRequest{MaxCapacity: &negCap}},
		{"campFee < 0", service.UpdateSettingsRequest{CampFee: &negFee}},
		{"blank campName", service.UpdateSettingsRequest{CampName: &emptyName}},
		{"too long campName", service.UpdateSettingsRequest{CampName: &longName}},
	}

	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.UpdateSettings(ctx, tc.req, 1); !errors.Is(err, service.ErrInvalidSettings) {
				t.Fatalf("expected ErrInvalidSettings for %s, got %v", tc.name, err)
			}
		})
	}

	if _, err := svc.UpdateSettings(ctx, service.UpdateSettingsRequest{}, 0); err == nil {
		t.Errorf("expected error for adminID <= 0")
	}

	// Valid full update
	validName := "ComCamp #25 Official"
	validOpen := "2026-11-01T00:00:00Z"
	validClose := "2026-11-30T23:59:59Z"
	validCap := 60
	validFee := decimal.NewFromInt(0)
	manualClosed := true

	updated, err := svc.UpdateSettings(ctx, service.UpdateSettingsRequest{
		CampName:            &validName,
		RegistrationOpenAt:  &validOpen,
		RegistrationCloseAt: &validClose,
		MaxCapacity:         &validCap,
		CampFee:             &validFee,
		IsManualClosed:      &manualClosed,
	}, 42)
	if err != nil {
		t.Fatalf("expected valid UpdateSettings to succeed, got %v", err)
	}
	if updated.CampName != validName || updated.MaxCapacity != 60 || !updated.IsManualClosed || updated.UpdatedByAdminID == nil || *updated.UpdatedByAdminID != 42 {
		t.Errorf("unexpected updated settings: %+v", updated)
	}
}
