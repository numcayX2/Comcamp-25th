package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

type PaymentStatus string

const (
	PaymentPending  PaymentStatus = "PENDING"
	PaymentApproved PaymentStatus = "APPROVED"
	PaymentRejected PaymentStatus = "REJECTED"
)

type Payment struct {
	ID                uuid.UUID       `db:"id" json:"id"`
	ApplicantID       uuid.UUID       `db:"applicant_id" json:"applicantId"`
	SlipURL           string          `db:"slip_url" json:"slipUrl"`
	Amount            decimal.Decimal `db:"amount" json:"amount"`
	Status            PaymentStatus   `db:"status" json:"status"`
	TransRef          *string         `db:"trans_ref" json:"transRef,omitempty"`
	SlipHash          *string         `db:"slip_hash" json:"slipHash,omitempty"`
	TransferAt        *time.Time      `db:"transfer_at" json:"transferAt,omitempty"`
	VerifiedByAPI     bool            `db:"verified_by_api" json:"verifiedByApi"`
	VerifiedByAdminID *int64          `db:"verified_by_admin_id" json:"verifiedByAdminId,omitempty"`
	AdminNote         *string         `db:"admin_note" json:"adminNote,omitempty"`
	RejectionReason   *string         `db:"rejection_reason" json:"rejectionReason,omitempty"`
	UploadedAt        time.Time       `db:"uploaded_at" json:"uploadedAt"`
	VerifiedAt        *time.Time      `db:"verified_at" json:"verifiedAt,omitempty"`
}

type PaymentRepository interface {
	Create(ctx context.Context, payment *Payment) error
	GetByID(ctx context.Context, id uuid.UUID) (*Payment, error)
	GetByApplicantID(ctx context.Context, applicantID uuid.UUID) ([]*Payment, error)
	GetLatestByApplicantID(ctx context.Context, applicantID uuid.UUID) (*Payment, error)
	CheckDuplicateTransRef(ctx context.Context, transRef string) (bool, error)
	CheckDuplicateSlipHash(ctx context.Context, slipHash string) (bool, error)
	// CreateReplacingPending stores p as the applicant's newest slip and, in the same transaction,
	// deletes every earlier PENDING slip of that applicant (an applicant has at most one slip
	// waiting for review, so uploads cannot pile up on disk and in the table). The removed rows
	// are returned so the caller can delete their files. Uploads for one applicant are serialised.
	// Returns ErrPaymentAlreadyVerified, creating nothing, when the applicant already has an
	// APPROVED slip. REJECTED rows are history and are kept.
	CreateReplacingPending(ctx context.Context, p *Payment) (superseded []*Payment, err error)
	// Verify settles a PENDING payment and, in the same transaction, moves the applicant to
	// CONFIRMED (approved) or back to PASSED (rejected, so they can re-upload), writing the
	// status log and the audit entry. Returns ErrPaymentAlreadyVerified if it is not PENDING.
	Verify(ctx context.Context, paymentID uuid.UUID, approved bool, adminID int64, note string, audit *AuditEntry) error
}
