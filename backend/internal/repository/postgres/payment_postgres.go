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
	return err
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

	var list []*domain.Payment
	for rows.Next() {
		p, err := scanPayment(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, nil
}

func (r *PaymentPostgresRepo) GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*domain.Payment, error) {
	query := `SELECT ` + paymentColumns + ` FROM payments WHERE applicant_id = $1 ORDER BY uploaded_at DESC LIMIT 1`
	return r.scan(r.pool.QueryRow(ctx, query, applicantID))
}

func (r *PaymentPostgresRepo) CheckDuplicateTransRef(ctx context.Context, transRef string) (bool, error) {
	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM payments WHERE trans_ref = $1)`
	err := r.pool.QueryRow(ctx, query, transRef).Scan(&exists)
	return exists, err
}

func (r *PaymentPostgresRepo) CheckDuplicateSlipHash(ctx context.Context, slipHash string) (bool, error) {
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

	var applicantID uuid.UUID
	now := time.Now().UTC()
	var newStatus domain.PaymentStatus
	if approved {
		newStatus = domain.PaymentApproved
	} else {
		newStatus = domain.PaymentRejected
	}

	queryPayment := `
		UPDATE payments
		SET status = $1, verified_by_admin_id = $2, admin_note = $3, verified_at = $4
		WHERE id = $5
		RETURNING applicant_id
	`
	err = tx.QueryRow(ctx, queryPayment, newStatus, adminID, note, now, paymentID).Scan(&applicantID)
	if err != nil {
		return fmt.Errorf("failed to update payment: %w", err)
	}

	if approved {
		queryApplicant := `UPDATE applicants SET status = 'CONFIRMED', updated_at = $1 WHERE id = $2`
		_, err = tx.Exec(ctx, queryApplicant, now, applicantID)
		if err != nil {
			return fmt.Errorf("failed to update applicant to confirmed: %w", err)
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
			return nil, errors.New("payment not found")
		}
		return nil, err
	}
	return &p, nil
}
