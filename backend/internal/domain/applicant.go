package domain

import (
	"context"
	"time"

	"github.com/google/uuid"
)

type ApplicationStatus string

const (
	StatusPending   ApplicationStatus = "PENDING"
	StatusPassed    ApplicationStatus = "PASSED"
	StatusReserve   ApplicationStatus = "RESERVE"
	StatusConfirmed ApplicationStatus = "CONFIRMED"
	StatusRejected  ApplicationStatus = "REJECTED"
	// StatusRefundPending / StatusRefunded: the applicant paid and then cancelled. The seat is
	// released straight away (see IsActive) while the row stays in the ledger for accounting.
	StatusRefundPending ApplicationStatus = "REFUND_PENDING"
	StatusRefunded      ApplicationStatus = "REFUNDED"
	// StatusForfeited: the seat was released automatically because the fee was not paid in time
	// (ExpireOverdueUnpaid). The row stays live, so its phone and email stay taken: registering
	// again with either is refused with ErrForfeitedApplicant until staff restore or delete it.
	StatusForfeited ApplicationStatus = "FORFEITED"
)

// Why a soft-deleted application was deleted (applicants.deleted_reason, migration 000013).
const (
	DeletedReasonSelfWithdrawn = "SELF_WITHDRAWN"
	DeletedReasonAdminDeleted  = "ADMIN_DELETED"
)

func (s ApplicationStatus) IsValid() bool {
	switch s {
	case StatusPending, StatusPassed, StatusReserve, StatusConfirmed, StatusRejected,
		StatusRefundPending, StatusRefunded, StatusForfeited:
		return true
	}
	return false
}

// IsActive reports whether an application in this status holds a seat: every status except
// REJECTED, REFUND_PENDING, REFUNDED and FORFEITED. The quota count, self-service editing and slip
// review all follow this one definition. (The SQL twin is countActiveSQL in the postgres package.)
func (s ApplicationStatus) IsActive() bool {
	switch s {
	case StatusPending, StatusPassed, StatusReserve, StatusConfirmed:
		return true
	}
	return false
}

type Applicant struct {
	ID                  uuid.UUID         `db:"id" json:"id"`
	ApplicationNo       string            `db:"application_no" json:"applicationNo"`
	Prefix              string            `db:"prefix" json:"prefix"`
	FirstName           string            `db:"first_name" json:"firstName"`
	LastName            string            `db:"last_name" json:"lastName"`
	Nickname            string            `db:"nickname" json:"nickname"`
	BirthDate           time.Time         `db:"birth_date" json:"birthDate"`
	Gender              string            `db:"gender" json:"gender"`
	School              string            `db:"school" json:"school"`
	Grade               string            `db:"grade" json:"grade"`
	Phone               string            `db:"phone" json:"phone"`
	Email               string            `db:"email" json:"email"`
	LineID              *string           `db:"line_id" json:"lineId,omitempty"`
	AddressLine         *string           `db:"address_line" json:"addressLine,omitempty"`
	Subdistrict         *string           `db:"subdistrict" json:"subdistrict,omitempty"`
	District            *string           `db:"district" json:"district,omitempty"`
	Province            string            `db:"province" json:"province"`
	PostalCode          *string           `db:"postal_code" json:"postalCode,omitempty"`
	ParentName          *string           `db:"parent_name" json:"parentName,omitempty"`
	ParentRelation      *string           `db:"parent_relation" json:"parentRelation,omitempty"`
	ParentPhone         *string           `db:"parent_phone" json:"parentPhone,omitempty"`
	EmergencyContact    string            `db:"emergency_contact" json:"emergencyContact"`
	EmergencyPhone      string            `db:"emergency_phone" json:"emergencyPhone"`
	ShirtSize           string            `db:"shirt_size" json:"shirtSize"`
	Allergies           *string           `db:"allergies" json:"allergies,omitempty"`
	MedicalConditions   *string           `db:"medical_conditions" json:"medicalConditions,omitempty"`
	HasLaptop           bool              `db:"has_laptop" json:"hasLaptop"`
	Motivation          *string           `db:"motivation" json:"motivation,omitempty"`
	PortfolioURL        *string           `db:"portfolio_url" json:"portfolioUrl,omitempty"`
	ParentPermissionURL *string           `db:"parent_permission_url" json:"parentPermissionUrl,omitempty"`
	Status              ApplicationStatus `db:"status" json:"status"`
	AttendanceConfirmed bool              `db:"attendance_confirmed" json:"attendanceConfirmed"`
	CertificateURL      *string           `db:"certificate_url" json:"certificateUrl,omitempty"`
	IdempotencyKey      *uuid.UUID        `db:"idempotency_key" json:"-"`
	CreatedAt           time.Time         `db:"created_at" json:"createdAt"`
	UpdatedAt           time.Time         `db:"updated_at" json:"updatedAt"`
	DeletedAt           *time.Time        `db:"deleted_at" json:"-"`
	// ReferralSources are the allowlisted codes of where the applicant heard about the camp
	// (service.referralCodes); ReferralOther is the free text that goes with "other".
	ReferralSources []string `db:"referral_sources" json:"referralSources"`
	ReferralOther   string   `db:"referral_other" json:"referralOther,omitempty"`
	// DeletedReason is DeletedReasonSelfWithdrawn or DeletedReasonAdminDeleted on a deleted row.
	DeletedReason string `db:"deleted_reason" json:"-"`
}

func (a *Applicant) FullName() string {
	if a.Prefix != "" {
		return a.Prefix + a.FirstName + " " + a.LastName
	}
	return a.FirstName + " " + a.LastName
}

// PublicApplicant is the allowlisted projection behind the public applicants list
// (GET /api/applications/public). It deliberately carries only what the registration consent
// discloses (name, nickname, school, province) plus the status, so no query that fills it can
// ever read an identifier, contact or health column (PDPA, CLAUDE_REVAMP_HANDOFF.md 5.4).
type PublicApplicant struct {
	FirstName string
	LastName  string
	Nickname  string
	School    string
	Province  string
	Status    ApplicationStatus
}

// WithdrawnApplicant is one application the applicant withdrew themselves (deleted_reason
// SELF_WITHDRAWN), for the read-only staff list. Reason is what they typed when withdrawing.
type WithdrawnApplicant struct {
	ApplicationNo string
	Prefix        string
	FirstName     string
	LastName      string
	Nickname      string
	Phone         string
	School        string
	Province      string
	Status        ApplicationStatus
	CreatedAt     time.Time
	WithdrawnAt   time.Time
	Reason        string
}

// ProfileFields are the applicant columns that can be edited after registration.
type ProfileFields struct {
	FirstName         string
	LastName          string
	Nickname          string
	Phone             string
	Email             string
	School            string
	Province          string
	Grade             string
	ShirtSize         string
	Motivation        *string
	Allergies         *string
	MedicalConditions *string
	ParentName        *string
	ParentRelation    *string
	ParentPhone       *string
	EmergencyContact  string
	EmergencyPhone    string
	ReferralSources   []string
	ReferralOther     string
}

type ApplicantStatusLog struct {
	ID               int64             `db:"id" json:"id"`
	ApplicantID      uuid.UUID         `db:"applicant_id" json:"applicantId"`
	ChangedByAdminID *int64            `db:"changed_by_admin_id" json:"changedByAdminId,omitempty"`
	OldStatus        ApplicationStatus `db:"old_status" json:"oldStatus"`
	NewStatus        ApplicationStatus `db:"new_status" json:"newStatus"`
	Reason           *string           `db:"reason" json:"reason,omitempty"`
	CreatedAt        time.Time         `db:"created_at" json:"createdAt"`
}

type ApplicantRepository interface {
	Create(ctx context.Context, applicant *Applicant) error
	// CreateWithinCapacity atomically checks the active-applicant count against maxCapacity and
	// inserts, so concurrent submits can never exceed the quota. maxCapacity <= 0 means unlimited.
	// Returns ErrCapacityReached, ErrDuplicateApplicant or ErrDuplicateIdempotencyKey.
	CreateWithinCapacity(ctx context.Context, applicant *Applicant, maxCapacity int) error
	GetByIdempotencyKey(ctx context.Context, key uuid.UUID) (*Applicant, error)
	GetByID(ctx context.Context, id uuid.UUID) (*Applicant, error)
	GetByApplicationNo(ctx context.Context, appNo string) (*Applicant, error)
	// GetByPhone returns the live application registered with this phone number (the phone is
	// unique among live rows, uq_applicants_phone_live).
	GetByPhone(ctx context.Context, phone string) (*Applicant, error)
	ListAll(ctx context.Context, status *ApplicationStatus) ([]*Applicant, error)
	// UpdateStatus changes the status and writes applicant_status_logs plus the audit entry
	// (when non-nil) in one transaction.
	UpdateStatus(ctx context.Context, id uuid.UUID, newStatus ApplicationStatus, adminID *int64, reason string, audit *AuditEntry) error
	// UpdateStatusWithinCapacity is UpdateStatus for a change that may take a seat back (from
	// REJECTED / REFUND_PENDING / REFUNDED to an active status). Under the same advisory lock as
	// CreateWithinCapacity it re-reads the status and returns ErrCapacityReached when the camp is
	// full. maxCapacity <= 0 means unlimited.
	UpdateStatusWithinCapacity(ctx context.Context, id uuid.UUID, newStatus ApplicationStatus, adminID *int64, reason string, audit *AuditEntry, maxCapacity int) error
	// UpdateProfile rewrites the editable profile columns, bumps updated_at and writes the audit
	// entry in one transaction. With requireActive the row is locked first and the write is
	// refused with ErrStateConflict unless the application still holds a seat. Identifier
	// collisions with other live rows return ErrDuplicateApplicant.
	UpdateProfile(ctx context.Context, id uuid.UUID, p ProfileFields, requireActive bool, audit *AuditEntry) error
	// SoftDelete hides the applicant: a staff delete (adminID set, deleted_reason ADMIN_DELETED) or the
	// applicant's own withdrawal (adminID nil, SELF_WITHDRAWN).
	SoftDelete(ctx context.Context, id uuid.UUID, adminID *int64, reason string, audit *AuditEntry) error
	// UpdateAttendance records the applicant's answer and writes the audit entry (when non-nil) in
	// one transaction. It is refused with ErrStateConflict unless the application is still PASSED
	// or CONFIRMED at the moment of the write, and ErrNotFound when it is missing or deleted.
	UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool, audit *AuditEntry) error
	// ExpireOverdueUnpaid transitions active unpaid applications (PENDING, PASSED, RESERVE)
	// created at or before createdCutoff (now - UnpaidExpiryWindow) whose updated_at and latest
	// REJECTED slip timestamp (verified_at, falling back to uploaded_at) are at or before
	// graceCutoff (now - UnpaidGraceWindow) and that have no PENDING/APPROVED slip to FORFEITED,
	// writing status and audit logs atomically and returning the expired application_no list.
	// Both cutoffs come from the service so the repositories never re-derive one from the other.
	ExpireOverdueUnpaid(ctx context.Context, createdCutoff, graceCutoff time.Time, reason string) ([]string, error)
	// HasForfeitedIdentity reports whether a live FORFEITED application holds this phone or this
	// (non-empty) email.
	HasForfeitedIdentity(ctx context.Context, phone, email string) (bool, error)
	// ListWithdrawn returns the applications their applicants withdrew (deleted_reason
	// SELF_WITHDRAWN), most recent first.
	ListWithdrawn(ctx context.Context) ([]WithdrawnApplicant, error)
	// PurgeWithdrawn permanently deletes a self-withdrawn application (deleted_reason SELF_WITHDRAWN)
	// together with its payment rows and status history, writing the audit entry in the same
	// transaction, and returns the slip_url of every deleted payment so the caller can remove the
	// files. A live or staff-deleted application is ErrNotFound and is left untouched.
	PurgeWithdrawn(ctx context.Context, applicationNo string, audit *AuditEntry) ([]string, error)
	CountActive(ctx context.Context) (int, error)
	// ListPublic returns the public-list projection of every live (non-deleted) application whose
	// status is PASSED or CONFIRMED, oldest first (created_at ascending, id as tiebreak).
	ListPublic(ctx context.Context) ([]PublicApplicant, error)
}
