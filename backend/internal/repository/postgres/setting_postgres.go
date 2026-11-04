package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

type SettingPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewSettingPostgresRepo(pool *pgxpool.Pool) *SettingPostgresRepo {
	return &SettingPostgresRepo{pool: pool}
}

func (r *SettingPostgresRepo) Get(ctx context.Context) (*domain.Settings, error) {
	query := `
		SELECT id, camp_name, registration_open_at, registration_close_at,
		       announcement_at, payment_open_at, payment_deadline, certificate_release_at,
		       max_capacity, camp_fee, is_manual_closed, updated_by_admin_id, updated_at
		FROM settings
		WHERE id = 1
	`
	var s domain.Settings
	err := r.pool.QueryRow(ctx, query).Scan(
		&s.ID, &s.CampName, &s.RegistrationOpenAt, &s.RegistrationCloseAt,
		&s.AnnouncementAt, &s.PaymentOpenAt, &s.PaymentDeadline, &s.CertificateReleaseAt,
		&s.MaxCapacity, &s.CampFee, &s.IsManualClosed, &s.UpdatedByAdminID, &s.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("settings not found")
		}
		return nil, fmt.Errorf("failed to get settings: %w", err)
	}
	return &s, nil
}

func (r *SettingPostgresRepo) Update(ctx context.Context, s *domain.Settings) error {
	query := `
		UPDATE settings
		SET camp_name = $1,
		    registration_open_at = $2,
		    registration_close_at = $3,
		    announcement_at = $4,
		    payment_open_at = $5,
		    payment_deadline = $6,
		    certificate_release_at = $7,
		    max_capacity = $8,
		    camp_fee = $9,
		    is_manual_closed = $10,
		    updated_by_admin_id = $11,
		    updated_at = $12
		WHERE id = 1
	`
	now := time.Now().UTC()
	s.UpdatedAt = now
	_, err := r.pool.Exec(ctx, query,
		s.CampName, s.RegistrationOpenAt, s.RegistrationCloseAt,
		s.AnnouncementAt, s.PaymentOpenAt, s.PaymentDeadline, s.CertificateReleaseAt,
		s.MaxCapacity, s.CampFee, s.IsManualClosed, s.UpdatedByAdminID, now,
	)
	return err
}
