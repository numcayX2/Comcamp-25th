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
)

func (s ApplicationStatus) IsValid() bool {
	switch s {
	case StatusPending, StatusPassed, StatusReserve, StatusConfirmed, StatusRejected:
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
	GetByID(ctx context.Context, id uuid.UUID) (*Applicant, error)
	GetByApplicationNo(ctx context.Context, appNo string) (*Applicant, error)
	GetByNationalID(ctx context.Context, nationalID string) (*Applicant, error)
	FindByQuery(ctx context.Context, query string) (*Applicant, error)
	ListAll(ctx context.Context, status *ApplicationStatus) ([]*Applicant, error)
	UpdateStatus(ctx context.Context, id uuid.UUID, newStatus ApplicationStatus, adminID *int64, reason string) error
	UpdateAttendance(ctx context.Context, id uuid.UUID, confirmed bool) error
	CountActive(ctx context.Context) (int, error)
}
