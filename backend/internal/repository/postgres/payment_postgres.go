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

type PaymentPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewPaymentPostgresRepo(pool *pgxpool.Pool) *PaymentPostgresRepo {
	return &PaymentPostgresRepo{pool: pool}
}

func (r *PaymentPostgresRepo) Create(ctx context.Context, p *domain.Payment) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	now := time.Now().UTC()
	p.UploadedAt = now

	query := `
		INSERT INTO payments (
			id, applicant_id, slip_url, amount, status,
			trans_ref, slip_hash, transfer_at, verified_by_api,
			verified_by_admin_id, admin_note, rejection_reason, uploaded_at, verified_at
		) VALUES (
			$1, $2, $3, $4, $5,
			$6, $7, $8, $9,
			$10, $11, $12, $13, $14
		)
	`
	_, err := r.pool.Exec(ctx, query,
		p.ID, p.ApplicantID, p.SlipURL, p.Amount, p.Status,
		p.TransRef, p.SlipHash, p.TransferAt, p.VerifiedByAPI,
		p.VerifiedByAdminID, p.AdminNote, p.RejectionReason, now, p.VerifiedAt,
	)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			if strings.Contains(strings.ToLower(pgErr.ConstraintName), "trans_ref") {
				return domain.ErrDuplicateTransRef
			}
			return domain.ErrDuplicateSlip
		}
		return fmt.Errorf("failed to create payment: %w", err)
	}
	return nil
}

func (r *PaymentPostgresRepo) GetByID(ctx context.Context, id uuid.UUID) (*domain.Payment, error) {
	query := `SELECT ` + paymentColumns + ` FROM payments WHERE id = $1`
	return r.scan(r.pool.QueryRow(ctx, query, id))
}

func (r *PaymentPostgresRepo) GetByApplicantID(ctx context.Context, applicantID uuid.UUID) ([]*domain.Payment, error) {
	query := `SELECT ` + paymentColumns + ` FROM payments WHERE applicant_id = $1 ORDER BY uploaded_at DESC`
	rows, err := r.pool.Query(ctx, query, applicantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]*domain.Payment, 0)
	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

func (r *PaymentPostgresRepo) GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	query := `SELECT ` + paymentColumns + ` FROM payments WHERE applicant_id = $1 ORDER BY uploaded_at DESC LIMIT 1`
	return r.scan(r.pool.QueryRow(ctx, query, applicantID))
}

func (r *PaymentPostgresRepo) GetLatestByApplicantIDs(ctx context.Context, applicantIDs []uuid.UUID) (map[uuid.UUID]*domain.Payment, error) {
	result := make(map[uuid.UUID]*domain.Payment, len(applicantIDs))
	if len(applicantIDs) == 0 {
		return result, nil
	}

	query := `
		SELECT DISTINCT ON (applicant_id) ` + paymentColumns + `
		FROM payments
		WHERE applicant_id = ANY($1)
		ORDER BY applicant_id, uploaded_at DESC
	`
	rows, err := r.pool.Query(ctx, query, applicantIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to batch fetch latest payments: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			return nil, err
		}
		result[p.ApplicantID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate latest payments: %w", err)
	}
	return result, nil
}

func (r *PaymentPostgresRepo) CheckDuplicateTransRef(ctx context.Context, transRef string) (bool, error) {
	if transRef == "" {
		return false, nil
	}
	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM payments WHERE trans_ref = $1)`
	err := r.pool.QueryRow(ctx, query, transRef).Scan(&exists)
	return exists, err
}

func (r *PaymentPostgresRepo) CheckDuplicateSlipHash(ctx context.Context, slipHash string) (bool, error) {
	if slipHash == "" {
		return false, nil
	}
	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM payments WHERE slip_hash = $1)`
	err := r.pool.QueryRow(ctx, query, slipHash).Scan(&exists)
	return exists, err
}

func (r *PaymentPostgresRepo) Verify(ctx context.Context, paymentID uuid.UUID, approved bool, adminID int64, note string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var (
		applicantID uuid.UUID
		payStatus   domain.PaymentStatus
	)
	err = tx.QueryRow(ctx, `SELECT applicant_id, status FROM payments WHERE id = $1 FOR UPDATE`, paymentID).
		Scan(&applicantID, &payStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrPaymentNotFound
		}
		return fmt.Errorf("failed to lock payment: %w", err)
	}

	if payStatus != domain.PaymentPending {
		return domain.ErrPaymentAlreadyVerified
	}

	var prevStatus domain.ApplicationStatus
	err = tx.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, applicantID).
		Scan(&prevStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrApplicantNotFound
		}
		return fmt.Errorf("failed to lock applicant: %w", err)
	}

	now := time.Now().UTC()
	var notePtr *string
	if note != "" {
		n := note
		notePtr = &n
	}

	if approved {
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
		if prevStatus != domain.StatusConfirmed && confirmedCount >= maxCapacity {
			return domain.ErrQuotaExceeded
		}

		_, err = tx.Exec(ctx, `
			UPDATE payments
			SET status = 'APPROVED', verified_by_admin_id = $1, admin_note = $2, rejection_reason = NULL, verified_at = $3
			WHERE id = $4
		`, adminID, notePtr, now, paymentID)
		if err != nil {
			return fmt.Errorf("failed to approve payment: %w", err)
		}

		_, err = tx.Exec(ctx, `
			UPDATE applicants
			SET status = 'CONFIRMED', attendance_confirmed = true, updated_at = $1
			WHERE id = $2 AND deleted_at IS NULL
		`, now, applicantID)
		if err != nil {
			return fmt.Errorf("failed to confirm applicant: %w", err)
		}

		reason := note
		if reason == "" {
			reason = "Payment approved"
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason, created_at)
			VALUES ($1, $2, $3, 'CONFIRMED', $4, $5)
		`, applicantID, adminID, prevStatus, reason, now)
		if err != nil {
			return fmt.Errorf("failed to insert status log: %w", err)
		}
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE payments
			SET status = 'REJECTED', verified_by_admin_id = $1, admin_note = $2, rejection_reason = $2, verified_at = $3
			WHERE id = $4
		`, adminID, notePtr, now, paymentID)
		if err != nil {
			return fmt.Errorf("failed to reject payment: %w", err)
		}

		_, err = tx.Exec(ctx, `
			UPDATE applicants
			SET status = 'PASSED', updated_at = $1
			WHERE id = $2 AND deleted_at IS NULL
		`, now, applicantID)
		if err != nil {
			return fmt.Errorf("failed to preserve applicant passed status: %w", err)
		}

		reason := note
		if reason == "" {
			reason = "Payment rejected"
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason, created_at)
			VALUES ($1, $2, $3, 'PASSED', $4, $5)
		`, applicantID, adminID, prevStatus, reason, now)
		if err != nil {
			return fmt.Errorf("failed to insert status log: %w", err)
		}
	}

	return tx.Commit(ctx)
}

const paymentColumns = `
	id, applicant_id, slip_url, amount, status, trans_ref, slip_hash,
	transfer_at, verified_by_api, verified_by_admin_id, admin_note, rejection_reason,
	uploaded_at, verified_at
`

func (r *PaymentPostgresRepo) scan(row pgx.Row) (*domain.Payment, error) {
	return scanPayment(row)
}

func scanPayment(s scannable) (*domain.Payment, error) {
	var p domain.Payment
	err := s.Scan(
		&p.ID, &p.ApplicantID, &p.SlipURL, &p.Amount, &p.Status, &p.TransRef, &p.SlipHash,
		&p.TransferAt, &p.VerifiedByAPI, &p.VerifiedByAdminID, &p.AdminNote, &p.RejectionReason,
		&p.UploadedAt, &p.VerifiedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrPaymentNotFound
		}
		return nil, err
	}
	return &p, nil
}
