package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

type ApplicantPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewApplicantPostgresRepo(pool *pgxpool.Pool) *ApplicantPostgresRepo {
	return &ApplicantPostgresRepo{pool: pool}
}

func (r *ApplicantPostgresRepo) Create(ctx context.Context, a *domain.Applicant) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	query := `
		INSERT INTO applicants (
			id, application_no, national_id, prefix, first_name, last_name, nickname,
			birth_date, gender, school, grade, phone, email, line_id,
			address_line, subdistrict, district, province, postal_code,
			parent_name, parent_relation, parent_phone, emergency_contact, emergency_phone,
			shirt_size, allergies, medical_conditions, has_laptop, motivation, portfolio_url,
			parent_permission_url, status, attendance_confirmed, certificate_url,
			created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7,
			$8, $9, $10, $11, $12, NULLIF($13, ''), $14,
			$15, $16, $17, $18, $19,
			$20, $21, $22, $23, $24,
			$25, $26, $27, $28, $29, $30,
			$31, $32, $33, $34,
			$35, $36
		)
	`

	_, err := r.pool.Exec(ctx, query,
		a.ID, a.ApplicationNo, a.NationalID, a.Prefix, a.FirstName, a.LastName, a.Nickname,
		a.BirthDate, a.Gender, a.School, a.Grade, a.Phone, a.Email, a.LineID,
		a.AddressLine, a.Subdistrict, a.District, a.Province, a.PostalCode,
		a.ParentName, a.ParentRelation, a.ParentPhone, a.EmergencyContact, a.EmergencyPhone,
		a.ShirtSize, a.Allergies, a.MedicalConditions, a.HasLaptop, a.Motivation, a.PortfolioURL,
		a.ParentPermissionURL, a.Status, a.AttendanceConfirmed, a.CertificateURL,
		a.CreatedAt, a.UpdatedAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if strings.Contains(strings.ToLower(pgErr.ConstraintName), "application_no") {
				return domain.ErrDuplicateApplicationNo
			}
			return fmt.Errorf("%w: %s", domain.ErrDuplicateApplicant, pgErr.ConstraintName)
		}
		return fmt.Errorf("failed to insert applicant: %w", err)
	}
	return nil
}

func (r *ApplicantPostgresRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE id = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, id))
}

func (r *ApplicantPostgresRepo) GetByApplicationNo(ctx context.Context, appNo string) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE UPPER(application_no) = UPPER($1) AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, strings.TrimSpace(appNo)))
}

func (r *ApplicantPostgresRepo) GetByNationalID(ctx context.Context, nationalID string) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE national_id = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, nationalID))
}

func (r *ApplicantPostgresRepo) FindByQuery(ctx context.Context, q string) (*domain.Applicant, error) {
	trimmed := strings.TrimSpace(q)
	query := `
		SELECT ` + applicantColumns + `
		FROM applicants
		WHERE (UPPER(application_no) = UPPER($1) OR national_id = $1 OR phone = $1)
		  AND deleted_at IS NULL
		LIMIT 1
	`
	return r.scanSingle(r.pool.QueryRow(ctx, query, trimmed))
}

func (r *ApplicantPostgresRepo) FindByIDOrAppNo(ctx context.Context, idOrAppNo string) (*domain.Applicant, error) {
	trimmed := strings.TrimSpace(idOrAppNo)
	if parsedID, err := uuid.Parse(trimmed); err == nil {
		return r.GetByID(ctx, parsedID)
	}
	return r.GetByApplicationNo(ctx, trimmed)
}

func (r *ApplicantPostgresRepo) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE deleted_at IS NULL`
	var args []any
	if status != nil {
		query += ` AND status = $1`
		args = append(args, *status)
	}
	query += ` ORDER BY created_at ASC, id ASC`

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list applicants: %w", err)
	}
	defer rows.Close()

	list := make([]*domain.Applicant, 0)
	for rows.Next() {
		a, err := scanApplicant(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate applicants: %w", err)
	}
	return list, nil
}

func (r *ApplicantPostgresRepo) UpdateStatus(ctx context.Context, id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var oldStatus domain.ApplicationStatus
	err = tx.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&oldStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrApplicantNotFound
		}
		return fmt.Errorf("failed to lock applicant: %w", err)
	}

	if newStatus == domain.StatusConfirmed && oldStatus != domain.StatusConfirmed {
		var maxCapacity int
		if err := tx.QueryRow(ctx, `SELECT max_capacity FROM settings WHERE id = 1 FOR UPDATE`).Scan(&maxCapacity); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ErrSettingsNotFound
			}
			return fmt.Errorf("failed to lock settings: %w", err)
		}

		var confirmedCount int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM applicants WHERE status = 'CONFIRMED' AND deleted_at IS NULL`).Scan(&confirmedCount); err != nil {
			return fmt.Errorf("failed to count confirmed applicants: %w", err)
		}
		if confirmedCount >= maxCapacity {
			return domain.ErrQuotaExceeded
		}
	}

	now := time.Now().UTC()
	if newStatus == domain.StatusConfirmed {
		_, err = tx.Exec(ctx, `UPDATE applicants SET status = $1, attendance_confirmed = true, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL`, newStatus, now, id)
	} else {
		_, err = tx.Exec(ctx, `UPDATE applicants SET status = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL`, newStatus, now, id)
	}
	if err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason, created_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6)
	`, id, adminID, oldStatus, newStatus, reason, now)
	if err != nil {
		return fmt.Errorf("failed to insert status log: %w", err)
	}

	return tx.Commit(ctx)
}

func (r *ApplicantPostgresRepo) UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool) error {
	query := `UPDATE applicants SET attendance_confirmed = $1, updated_at = $2 WHERE id = $3 AND deleted_at IS NULL`
	tag, err := r.pool.Exec(ctx, query, confirmed, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrApplicantNotFound
	}
	return nil
}

func (r *ApplicantPostgresRepo) CountActive(ctx context.Context) (int, error) {
	var count int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM applicants WHERE status != 'REJECTED' AND deleted_at IS NULL`).Scan(&count)
	return count, err
}

func (r *ApplicantPostgresRepo) CountConfirmed(ctx context.Context) (int, error) {
	var count int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM applicants WHERE status = 'CONFIRMED' AND deleted_at IS NULL`).Scan(&count)
	return count, err
}

const applicantColumns = `
	id, application_no, national_id, prefix, first_name, last_name, nickname,
	birth_date, gender, school, grade, phone, COALESCE(email, '') AS email, line_id,
	address_line, subdistrict, district, province, postal_code,
	parent_name, parent_relation, parent_phone, emergency_contact, emergency_phone,
	shirt_size, allergies, medical_conditions, has_laptop, motivation, portfolio_url,
	parent_permission_url, status, attendance_confirmed, certificate_url,
	created_at, updated_at, deleted_at
`

func (r *ApplicantPostgresRepo) scanSingle(row pgx.Row) (*domain.Applicant, error) {
	return scanApplicant(row)
}

type scannable interface {
	Scan(dest ...any) error
}

func scanApplicant(s scannable) (*domain.Applicant, error) {
	var a domain.Applicant
	err := s.Scan(
		&a.ID, &a.ApplicationNo, &a.NationalID, &a.Prefix, &a.FirstName, &a.LastName, &a.Nickname,
		&a.BirthDate, &a.Gender, &a.School, &a.Grade, &a.Phone, &a.Email, &a.LineID,
		&a.AddressLine, &a.Subdistrict, &a.District, &a.Province, &a.PostalCode,
		&a.ParentName, &a.ParentRelation, &a.ParentPhone, &a.EmergencyContact, &a.EmergencyPhone,
		&a.ShirtSize, &a.Allergies, &a.MedicalConditions, &a.HasLaptop, &a.Motivation, &a.PortfolioURL,
		&a.ParentPermissionURL, &a.Status, &a.AttendanceConfirmed, &a.CertificateURL,
		&a.CreatedAt, &a.UpdatedAt, &a.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrApplicantNotFound
		}
		return nil, err
	}
	return &a, nil
}
