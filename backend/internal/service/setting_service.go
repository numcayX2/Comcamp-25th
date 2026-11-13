package service

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/shopspring/decimal"
	"golang.org/x/sync/singleflight"

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

// publicSettingsCacheTTL bounds how long GetPublicSettings reuses one snapshot during a burst.
// Admin settings updates and applicant seat changes invalidate it immediately, and expiresAt is
// capped at the next scheduled transition (e.g. 00:00:00 open) so flips happen on time.
const publicSettingsCacheTTL = time.Second

type cachedPublicSettings struct {
	response  domain.PublicSettingsResponse
	feeValue  decimal.Decimal
	expiresAt time.Time
}

type SettingService struct {
	settingRepo domain.SettingRepository
	appRepo     domain.ApplicantRepository
	auditRepo   domain.AuditRepository

	pubMu    sync.RWMutex
	pubCache *cachedPublicSettings
	pubVer   atomic.Uint64
	pubGroup singleflight.Group
}

// NewSettingService; auditRepo may be nil (settings changes are then not audited).
func NewSettingService(settingRepo domain.SettingRepository, appRepo domain.ApplicantRepository, auditRepo domain.AuditRepository) *SettingService {
	return &SettingService{
		settingRepo: settingRepo,
		appRepo:     appRepo,
		auditRepo:   auditRepo,
	}
}

// InvalidatePublicCache drops the cached GET /api/settings/public snapshot so the next read
// queries fresh settings and active seat count. Bumping pubVer stops an in-flight singleflight
// lookup from writing stale pre-mutation state back into the cache.
func (s *SettingService) InvalidatePublicCache() {
	s.pubVer.Add(1)
	s.pubMu.Lock()
	s.pubCache = nil
	s.pubMu.Unlock()
}

func clonePublicSettings(src domain.PublicSettingsResponse, feeValue decimal.Decimal) *domain.PublicSettingsResponse {
	out := src
	fee := feeValue
	out.CampFee = &fee
	return &out
}

func (s *SettingService) GetPublicSettings(ctx context.Context) (*domain.PublicSettingsResponse, error) {
	now := time.Now().UTC()
	s.pubMu.RLock()
	if s.pubCache != nil && now.Before(s.pubCache.expiresAt) {
		resp := clonePublicSettings(s.pubCache.response, s.pubCache.feeValue)
		s.pubMu.RUnlock()
		return resp, nil
	}
	s.pubMu.RUnlock()

	// Coalesce concurrent misses during the midnight refresh spike, isolated from a single
	// caller's cancellation so one aborted connection never breaks the shared lookup.
	ch := s.pubGroup.DoChan("public", func() (any, error) {
		startVer := s.pubVer.Load()
		qCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		settings, err := s.settingRepo.Get(qCtx)
		if err != nil {
			return nil, err
		}

		now := time.Now().UTC()
		isOpen := !settings.IsManualClosed &&
			now.After(settings.RegistrationOpenAt) &&
			now.Before(settings.RegistrationCloseAt)

		activeCount, countErr := s.appRepo.CountActive(qCtx)
		if countErr != nil {
			return nil, countErr
		}
		isCertReleased := settings.CertificateReleaseAt != nil && now.After(*settings.CertificateReleaseAt)

		resp := domain.PublicSettingsResponse{
			ServerTime:            now.Format(time.RFC3339),
			RegistrationOpenAt:    settings.RegistrationOpenAt.Format(time.RFC3339),
			IsOpen:                isOpen,
			CurrentCount:          activeCount,
			MaxCapacity:           settings.MaxCapacity,
			CampFee:               &settings.CampFee,
			IsCertificateReleased: isCertReleased,
		}

		expiresAt := now.Add(publicSettingsCacheTTL)
		for _, boundary := range []*time.Time{
			&settings.RegistrationOpenAt,
			&settings.RegistrationCloseAt,
			settings.CertificateReleaseAt,
		} {
			if boundary != nil && boundary.After(now) && boundary.Before(expiresAt) {
				expiresAt = *boundary
			}
		}

		if s.pubVer.Load() == startVer && expiresAt.After(now) {
			entry := &cachedPublicSettings{
				response:  resp,
				feeValue:  settings.CampFee,
				expiresAt: expiresAt,
			}
			s.pubMu.Lock()
			if s.pubVer.Load() == startVer {
				s.pubCache = entry
			}
			s.pubMu.Unlock()
		}

		return clonePublicSettings(resp, settings.CampFee), nil
	})

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		src := res.Val.(*domain.PublicSettingsResponse)
		fee := settingsFeeCopy(src.CampFee)
		return clonePublicSettings(*src, fee), nil
	}
}

func settingsFeeCopy(fee *decimal.Decimal) decimal.Decimal {
	if fee == nil {
		return decimal.Zero
	}
	return *fee
}

func (s *SettingService) GetAdminSettings(ctx context.Context) (*domain.Settings, error) {
	return s.settingRepo.Get(ctx)
}

// Admin-adjustable limits. maxCapacity is the seat quota enforced at submit time (default 30
// from migration 000001); staff can raise or lower it without a deploy.
const (
	maxCampNameRunes = 150 // settings.camp_name VARCHAR(150)
	maxCapacityLimit = 1000
)

var maxCampFee = decimal.NewFromInt(100_000)

// UpdateSettings applies a partial update from PATCH /api/admin/settings. Every field is
// validated (a malformed date is a 400, never silently ignored) and the change is written to
// audit_logs with the admin and IP (AGENTS.md §13.6).
func (s *SettingService) UpdateSettings(ctx context.Context, req UpdateSettingsRequest, adminID int64, ip string) (*domain.Settings, error) {
	settings, err := s.settingRepo.Get(ctx)
	if err != nil {
		return nil, err
	}
	changed := map[string]any{}

	if req.CampName != nil {
		name := strings.TrimSpace(*req.CampName)
		if name == "" || utf8.RuneCountInString(name) > maxCampNameRunes {
			return nil, newValidationError(fmt.Sprintf("campName must be 1-%d characters", maxCampNameRunes))
		}
		settings.CampName = name
		changed["campName"] = name
	}

	required := []struct {
		name string
		in   *string
		dst  *time.Time
	}{
		{"registrationOpenAt", req.RegistrationOpenAt, &settings.RegistrationOpenAt},
		{"registrationCloseAt", req.RegistrationCloseAt, &settings.RegistrationCloseAt},
	}
	for _, f := range required {
		if f.in == nil {
			continue
		}
		t, err := parseSettingTime(f.name, *f.in)
		if err != nil {
			return nil, err
		}
		*f.dst = t
		changed[f.name] = t.Format(time.RFC3339)
	}

	optional := []struct {
		name string
		in   *string
		dst  **time.Time
	}{
		{"announcementAt", req.AnnouncementAt, &settings.AnnouncementAt},
		{"paymentOpenAt", req.PaymentOpenAt, &settings.PaymentOpenAt},
		{"paymentDeadline", req.PaymentDeadline, &settings.PaymentDeadline},
		{"certificateReleaseAt", req.CertificateReleaseAt, &settings.CertificateReleaseAt},
	}
	for _, f := range optional {
		if f.in == nil {
			continue
		}
		t, err := parseSettingTime(f.name, *f.in)
		if err != nil {
			return nil, err
		}
		*f.dst = &t
		changed[f.name] = t.Format(time.RFC3339)
	}

	if !settings.RegistrationCloseAt.After(settings.RegistrationOpenAt) {
		return nil, newValidationError("registrationCloseAt must be after registrationOpenAt")
	}

	if req.MaxCapacity != nil {
		if *req.MaxCapacity < 1 || *req.MaxCapacity > maxCapacityLimit {
			return nil, newValidationError(fmt.Sprintf("maxCapacity must be between 1 and %d", maxCapacityLimit))
		}
		// Never shrink the quota below seats already taken: that would leave the camp
		// over-subscribed with no way to tell who to drop.
		current, err := s.appRepo.CountActive(ctx)
		if err != nil {
			return nil, err
		}
		if *req.MaxCapacity < current {
			return nil, newValidationError("maxCapacity cannot be lower than the current applicant count")
		}
		changed["maxCapacity"] = map[string]int{"old": settings.MaxCapacity, "new": *req.MaxCapacity}
		settings.MaxCapacity = *req.MaxCapacity
	}
	if req.CampFee != nil {
		if req.CampFee.IsNegative() || req.CampFee.GreaterThan(maxCampFee) {
			return nil, newValidationError("campFee must be between 0 and 100000")
		}
		settings.CampFee = req.CampFee.Round(2)
		changed["campFee"] = settings.CampFee.StringFixed(2)
	}
	if req.IsManualClosed != nil {
		settings.IsManualClosed = *req.IsManualClosed
		changed["isManualClosed"] = *req.IsManualClosed
	}

	if len(changed) == 0 {
		return nil, newValidationError("no settings to update")
	}

	settings.UpdatedByAdminID = &adminID
	settings.UpdatedAt = time.Now().UTC()
	if err := s.settingRepo.Update(ctx, settings); err != nil {
		return nil, err
	}
	s.InvalidatePublicCache()

	if s.auditRepo != nil {
		entry := &domain.AuditEntry{
			AdminID:    &adminID,
			Action:     domain.AuditSettingsUpdate,
			TargetType: domain.AuditTargetSettings,
			TargetID:   "1",
			Details:    changed,
			IPAddress:  ip,
		}
		if err := s.auditRepo.Log(ctx, entry); err != nil {
			log.Printf("audit log write failed (%s): %v", entry.Action, err)
		}
	}
	return settings, nil
}

func parseSettingTime(field, v string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(v))
	if err != nil {
		return time.Time{}, newValidationError(field + " must be an RFC 3339 time, e.g. 2026-11-16T00:00:00+07:00")
	}
	return t.UTC(), nil
}
