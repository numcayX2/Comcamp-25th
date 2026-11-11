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
	return mapPgError(err)
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

// Verify settles a PENDING payment and moves the applicant (CONFIRMED on approval, back to PASSED
// on rejection so they can re-upload), writing the status log and audit row — all in one
// transaction, with the payment row locked so two staff cannot verify the same slip twice.
func (r *PaymentPostgresRepo) Verify(ctx context.Context, paymentID uuid.UUID, approved bool, adminID int64, note string, audit *domain.AuditEntry) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var applicantID uuid.UUID
	var paymentStatus domain.PaymentStatus
	err = tx.QueryRow(ctx, `SELECT applicant_id, status FROM payments WHERE id = $1 FOR UPDATE`, paymentID).
		Scan(&applicantID, &paymentStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock payment: %w", err)
	}
	if paymentStatus != domain.PaymentPending {
		return domain.ErrPaymentAlreadyVerified
	}

	var oldStatus domain.ApplicationStatus
	err = tx.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 FOR UPDATE`, applicantID).Scan(&oldStatus)
	if err != nil {
		return fmt.Errorf("lock applicant: %w", err)
	}
	// A refunded or rejected application has left the camp: its slip is kept for the ledger but
	// can no longer be approved or rejected (that would re-confirm a seat that was released).
	if !oldStatus.IsActive() {
		return domain.ErrStateConflict
	}

	now := time.Now().UTC()
	newPaymentStatus, newStatus := domain.PaymentRejected, domain.StatusPassed
	if approved {
		newPaymentStatus, newStatus = domain.PaymentApproved, domain.StatusConfirmed
	}

	var rejection *string
	if !approved {
		rejection = &note
	}
	// Optimistic status check on top of the row lock (AGENTS.md §13.7): the update only applies
	// while the slip is still PENDING, so two staff settling the same slip cannot both succeed.
	tag, err := tx.Exec(ctx, `
		UPDATE payments
		SET status = $1, verified_by_admin_id = $2, admin_note = $3, rejection_reason = $4, verified_at = $5
		WHERE id = $6 AND status = $7
	`, newPaymentStatus, adminID, note, rejection, now, paymentID, domain.PaymentPending)
	if err != nil {
		return fmt.Errorf("failed to update payment: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrPaymentAlreadyVerified
	}

	if oldStatus != newStatus {
		if err := setStatusTx(ctx, tx, applicantID, oldStatus, newStatus, &adminID, note); err != nil {
			return err
		}
	}

	if audit != nil {
		entry := withAuditDetail(audit, "oldStatus", oldStatus)
		entry.Details["newStatus"] = newStatus
		if err := insertAudit(ctx, tx, entry); err != nil {
			return err
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
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	return &p, nil
}
