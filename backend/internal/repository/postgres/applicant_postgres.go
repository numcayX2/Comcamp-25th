package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

// quotaLockKey is the pg_advisory_xact_lock key that serialises capacity-checked inserts.
const quotaLockKey int64 = 25_000_001

type ApplicantPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewApplicantPostgresRepo(pool *pgxpool.Pool) *ApplicantPostgresRepo {
	return &ApplicantPostgresRepo{pool: pool}
}

const insertApplicantSQL = `
	INSERT INTO applicants (
		id, application_no, national_id, prefix, first_name, last_name, nickname,
		birth_date, gender, school, grade, phone, email, line_id,
		address_line, subdistrict, district, province, postal_code,
		parent_name, parent_relation, parent_phone, emergency_contact, emergency_phone,
		shirt_size, allergies, medical_conditions, has_laptop, motivation, portfolio_url,
		parent_permission_url, status, attendance_confirmed, certificate_url,
		idempotency_key, created_at, updated_at
	) VALUES (
		$1, $2, $3, $4, $5, $6, $7,
		$8, $9, $10, $11, $12, $13, $14,
		$15, $16, $17, $18, $19,
		$20, $21, $22, $23, $24,
		$25, $26, $27, $28, $29, $30,
		$31, $32, $33, $34,
		$35, $36, $37
	)
`

func insertApplicant(ctx context.Context, db execer, a *domain.Applicant) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	now := time.Now().UTC()
	a.CreatedAt = now
	a.UpdatedAt = now

	_, err := db.Exec(ctx, insertApplicantSQL,
		a.ID, a.ApplicationNo, a.NationalID, a.Prefix, a.FirstName, a.LastName, a.Nickname,
		a.BirthDate, a.Gender, a.School, a.Grade, a.Phone, a.Email, a.LineID,
		a.AddressLine, a.Subdistrict, a.District, a.Province, a.PostalCode,
		a.ParentName, a.ParentRelation, a.ParentPhone, a.EmergencyContact, a.EmergencyPhone,
		a.ShirtSize, a.Allergies, a.MedicalConditions, a.HasLaptop, a.Motivation, a.PortfolioURL,
		a.ParentPermissionURL, a.Status, a.AttendanceConfirmed, a.CertificateURL,
		a.IdempotencyKey, a.CreatedAt, a.UpdatedAt,
	)
	if err != nil {
		if mapped := mapPgError(err); mapped != err {
			return mapped
		}
		return fmt.Errorf("failed to insert applicant: %w", err)
	}
	return nil
}

func (r *ApplicantPostgresRepo) Create(ctx context.Context, a *domain.Applicant) error {
	return insertApplicant(ctx, r.pool, a)
}

// CreateWithinCapacity serialises submissions with a transaction-scoped advisory lock, so the
// count and the insert see the same state and the camp can never exceed maxCapacity even when
// hundreds of students submit at 00:00 (AGENTS.md §13.4).
func (r *ApplicantPostgresRepo) CreateWithinCapacity(ctx context.Context, a *domain.Applicant, maxCapacity int) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Bound the wait for the quota lock (AGENTS.md §13.7): under the 00:00 burst a request that
	// cannot get the lock in 3s fails fast with a retryable error instead of holding a pool
	// connection until the HTTP timeout. SET LOCAL ends with this transaction.
	if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '3s'`); err != nil {
		return fmt.Errorf("set lock_timeout: %w", err)
	}
	// The lock is taken before the count, so the count sees every committed insert.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, quotaLockKey); err != nil {
		if mapped := mapPgError(err); mapped != err {
			return mapped
		}
		return fmt.Errorf("acquire quota lock: %w", err)
	}

	if maxCapacity > 0 {
		var count int
		if err := tx.QueryRow(ctx, countActiveSQL).Scan(&count); err != nil {
			return fmt.Errorf("count active applicants: %w", err)
		}
		if count >= maxCapacity {
			return domain.ErrCapacityReached
		}
	}

	if err := insertApplicant(ctx, tx, a); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		if mapped := mapPgError(err); mapped != err {
			return mapped
		}
		return err
	}
	return nil
}

func (r *ApplicantPostgresRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE id = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, id))
}

func (r *ApplicantPostgresRepo) GetByApplicationNo(ctx context.Context, appNo string) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE application_no = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, appNo))
}

func (r *ApplicantPostgresRepo) GetByNationalID(ctx context.Context, nationalID string) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE national_id = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, nationalID))
}

func (r *ApplicantPostgresRepo) GetByIdempotencyKey(ctx context.Context, key uuid.UUID) (*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE idempotency_key = $1 AND deleted_at IS NULL`
	return r.scanSingle(r.pool.QueryRow(ctx, query, key))
}

func (r *ApplicantPostgresRepo) FindByQuery(ctx context.Context, q string) (*domain.Applicant, error) {
	query := `
		SELECT ` + applicantColumns + `
		FROM applicants
		WHERE (application_no = $1 OR national_id = $1 OR phone = $1)
		  AND deleted_at IS NULL
		LIMIT 1
	`
	return r.scanSingle(r.pool.QueryRow(ctx, query, q))
}

func (r *ApplicantPostgresRepo) ListAll(ctx context.Context, status *domain.ApplicationStatus) ([]*domain.Applicant, error) {
	query := `SELECT ` + applicantColumns + ` FROM applicants WHERE deleted_at IS NULL`
	var args []any
	if status != nil {
		query += ` AND status = $1`
		args = append(args, *status)
	}
	query += ` ORDER BY created_at ASC`

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list applicants: %w", err)
	}
	defer rows.Close()

	var list []*domain.Applicant
	for rows.Next() {
		a, err := scanApplicant(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}

// UpdateStatus changes the status and writes applicant_status_logs and audit_logs in the same
// transaction (AGENTS.md §13.6): either everything is recorded or nothing changes.
func (r *ApplicantPostgresRepo) UpdateStatus(ctx context.Context, id uuid.UUID, newStatus domain.ApplicationStatus, adminID *int64, reason string, audit *domain.AuditEntry) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var oldStatus domain.ApplicationStatus
	err = tx.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&oldStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock applicant: %w", err)
	}

	if err := setStatusTx(ctx, tx, id, oldStatus, newStatus, adminID, reason); err != nil {
		return err
	}

	if audit != nil {
		if err := insertAudit(ctx, tx, withAuditDetail(audit, "oldStatus", oldStatus)); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// setStatusTx updates applicants.status and appends the status log inside an open transaction.
func setStatusTx(ctx context.Context, tx pgx.Tx, id uuid.UUID, oldStatus, newStatus domain.ApplicationStatus, adminID *int64, reason string) error {
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE applicants SET status = $1, updated_at = $2 WHERE id = $3`, newStatus, now, id); err != nil {
		return fmt.Errorf("failed to update status: %w", err)
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, id, adminID, oldStatus, newStatus, reason, now)
	if err != nil {
		return fmt.Errorf("failed to insert status log: %w", err)
	}
	return nil
}

func (r *ApplicantPostgresRepo) SoftDelete(ctx context.Context, id uuid.UUID, adminID *int64, reason string, audit *domain.AuditEntry) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var oldStatus domain.ApplicationStatus
	err = tx.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&oldStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock applicant: %w", err)
	}

	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `UPDATE applicants SET deleted_at = $1, updated_at = $1 WHERE id = $2`, now, id); err != nil {
		return fmt.Errorf("failed to soft delete applicant: %w", err)
	}

	if audit != nil {
		if err := insertAudit(ctx, tx, withAuditDetail(audit, "oldStatus", oldStatus)); err != nil {
			return err
		}
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
		return domain.ErrNotFound
	}
	return nil
}

const countActiveSQL = `SELECT count(*) FROM applicants WHERE status != 'REJECTED' AND deleted_at IS NULL`

func (r *ApplicantPostgresRepo) CountActive(ctx context.Context) (int, error) {
	var count int
	err := r.pool.QueryRow(ctx, countActiveSQL).Scan(&count)
	return count, err
}

const applicantColumns = `
	id, application_no, national_id, prefix, first_name, last_name, nickname,
	birth_date, gender, school, grade, phone, email, line_id,
	address_line, subdistrict, district, province, postal_code,
	parent_name, parent_relation, parent_phone, emergency_contact, emergency_phone,
	shirt_size, allergies, medical_conditions, has_laptop, motivation, portfolio_url,
	parent_permission_url, status, attendance_confirmed, certificate_url,
	idempotency_key, created_at, updated_at, deleted_at
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
		&a.IdempotencyKey, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	return &a, nil
}
