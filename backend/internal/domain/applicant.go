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
)

func (s ApplicationStatus) IsValid() bool {
	switch s {
	case StatusPending, StatusPassed, StatusReserve, StatusConfirmed, StatusRejected,
		StatusRefundPending, StatusRefunded:
		return true
	}
	return false
}

// IsActive reports whether an application in this status holds a seat: every status except
// REJECTED, REFUND_PENDING and REFUNDED. The quota count, self-service editing and slip review
// all follow this one definition. (The SQL twin is countActiveSQL in the postgres package.)
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
	NationalID          string            `db:"national_id" json:"nationalId"`
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
}

func (a *Applicant) FullName() string {
	if a.Prefix != "" {
		return a.Prefix + a.FirstName + " " + a.LastName
	}
	return a.FirstName + " " + a.LastName
}

// ProfileFields are the applicant columns that can be edited after registration.
type ProfileFields struct {
	FirstName  string
	LastName   string
	Nickname   string
	NationalID string
	Phone      string
	Email      string
	School     string
	Province   string
	Grade      string
	ShirtSize  string
	Motivation *string
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
	GetByNationalID(ctx context.Context, nationalID string) (*Applicant, error)
	FindByQuery(ctx context.Context, query string) (*Applicant, error)
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
	SoftDelete(ctx context.Context, id uuid.UUID, adminID *int64, reason string, audit *AuditEntry) error
	// UpdateAttendance records the applicant's answer and writes the audit entry (when non-nil) in
	// one transaction. It is refused with ErrStateConflict unless the application is still PASSED
	// or CONFIRMED at the moment of the write, and ErrNotFound when it is missing or deleted.
	UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool, audit *AuditEntry) error
	CountActive(ctx context.Context) (int, error)
}
