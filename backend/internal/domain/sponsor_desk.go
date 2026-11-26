package domain

import (
	"context"
	"time"
)

// Sponsor kinds (inquiries and donations) and donation file kinds (migration 000015).
const (
	SponsorKindMoney = "money"
	SponsorKindGoods = "goods"

	SponsorFileSigned = "signed"
	SponsorFileSlip   = "slip"
)

// SponsorInquiry is one "แจ้งความประสงค์สนับสนุน" submission from the public /sponsor page.
// File is the filled donation form the sponsor attached instead of typing (nil = none). Slip is
// the transfer slip a money sponsor attaches (required for new money inquiries since migration
// 000019; nil for goods and older rows), stored with the same metadata shape as File.
// Amount is the declared baht amount as a canonical decimal string (required for money inquiries
// since migration 000018; nil for goods and older rows). TaxID and the five structured address
// fields are populated for typed money inquiries (empty for goods inquiries and uploaded forms).
type SponsorInquiry struct {
	ID          int64
	Name        string
	Phone       string
	Email       string
	Kind        string
	Details     string
	Amount      *string
	TaxID       string
	AddressLine string
	Subdistrict string
	District    string
	Province    string
	Postcode    string
	File        *SponsorInquiryFile
	Slip        *SponsorInquiryFile
	HandledAt   *time.Time
	CreatedAt   time.Time
}

// SponsorInquiryFile is the stored metadata of an attached form (migration 000016) or transfer
// slip (migration 000019). Path is
// relative to UPLOAD_DIR ("sponsor-docs/<name>") and never serialized; the upload time is the
// inquiry's CreatedAt.
type SponsorInquiryFile struct {
	Path      string
	MIME      string
	SizeBytes int
	SHA256    string
}

// SponsorDonationFile is the stored metadata of a donation's signed form or transfer slip.
// Path is relative to UPLOAD_DIR ("sponsor-docs/<name>") and never serialized.
type SponsorDonationFile struct {
	Kind       string
	Path       string
	MIME       string
	SizeBytes  int
	SHA256     string
	UploadedAt time.Time
}

// SponsorDonation is a donation recorded by staff. Amount is a canonical decimal string (nil = not
// set); DonatedOn is "YYYY-MM-DD" or "". TaxID and structured address fields are optional for money
// donations and always empty for goods donations.
type SponsorDonation struct {
	ID                 int64
	DonorName          string
	Address            string
	Phone              string
	Kind               string
	Amount             *string
	GoodsDescription   string
	DonatedOn          string
	Note               string
	TaxID              string
	AddressLine        string
	Subdistrict        string
	District           string
	Province           string
	Postcode           string
	FacultySubmittedAt *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
	Signed             *SponsorDonationFile
	Slip               *SponsorDonationFile
}

// SponsorDonationFields are the staff-editable donation fields (full replacement on update).
// FacultySubmitted true keeps an existing faculty_submitted_at (or sets it to now); false clears it.
type SponsorDonationFields struct {
	DonorName        string
	Address          string
	Phone            string
	Kind             string
	Amount           *string
	GoodsDescription string
	DonatedOn        string
	Note             string
	TaxID            string
	AddressLine      string
	Subdistrict      string
	District         string
	Province         string
	Postcode         string
	FacultySubmitted bool
}

// ChangedFields returns the JSON names of the editable fields f would change on d (audit details
// carry names only, never values).
func (d *SponsorDonation) ChangedFields(f SponsorDonationFields) []string {
	changed := make([]string, 0, 15)
	add := func(cond bool, name string) {
		if cond {
			changed = append(changed, name)
		}
	}
	add(d.DonorName != f.DonorName, "donorName")
	add(d.Address != f.Address, "address")
	add(d.Phone != f.Phone, "phone")
	add(d.Kind != f.Kind, "kind")
	add((d.Amount == nil) != (f.Amount == nil) || (d.Amount != nil && *d.Amount != *f.Amount), "amount")
	add(d.GoodsDescription != f.GoodsDescription, "goodsDescription")
	add(d.DonatedOn != f.DonatedOn, "donatedOn")
	add(d.Note != f.Note, "note")
	add(d.TaxID != f.TaxID, "taxId")
	add(d.AddressLine != f.AddressLine, "addressLine")
	add(d.Subdistrict != f.Subdistrict, "subdistrict")
	add(d.District != f.District, "district")
	add(d.Province != f.Province, "province")
	add(d.Postcode != f.Postcode, "postcode")
	add((d.FacultySubmittedAt != nil) != f.FacultySubmitted, "facultySubmitted")
	return changed
}

type SponsorInquiryRepository interface {
	// Create inserts inq (with its file metadata when set) and writes the audit row in the same
	// transaction (ID/CreatedAt populated).
	Create(ctx context.Context, inq *SponsorInquiry, audit *AuditEntry) error
	// List returns every inquiry newest first (created_at DESC, id DESC).
	List(ctx context.Context) ([]*SponsorInquiry, error)
	// GetByID returns one inquiry, or ErrNotFound.
	GetByID(ctx context.Context, id int64) (*SponsorInquiry, error)
	// SetHandled sets handled_at = now() (keeping an earlier value) or clears it, with the audit row
	// in the same transaction. ErrNotFound when id does not exist.
	SetHandled(ctx context.Context, id int64, handled bool, audit *AuditEntry) (*SponsorInquiry, error)
	// Delete removes inquiry id with the audit row in the same transaction, returning the deleted
	// row so the caller can remove its file after commit. ErrNotFound when absent.
	Delete(ctx context.Context, id int64, audit *AuditEntry) (*SponsorInquiry, error)
	// ListNotifyEmails returns the staff notification addresses in their saved order.
	ListNotifyEmails(ctx context.Context) ([]string, error)
	// ReplaceNotifyEmails replaces the whole address list (already validated, unique) with the audit
	// row in the same transaction.
	ReplaceNotifyEmails(ctx context.Context, emails []string, audit *AuditEntry) ([]string, error)
}

type SponsorDonationRepository interface {
	// List returns every donation (with file metadata) newest first.
	List(ctx context.Context) ([]*SponsorDonation, error)
	// GetByID returns one donation with its file metadata, or ErrNotFound.
	GetByID(ctx context.Context, id int64) (*SponsorDonation, error)
	// Create inserts a donation and writes the audit row in the same transaction.
	Create(ctx context.Context, f SponsorDonationFields, audit *AuditEntry) (*SponsorDonation, error)
	// Update replaces the editable fields of donation id. The audit row (details "fields" = names
	// of the changed fields) is written in the same transaction.
	Update(ctx context.Context, id int64, f SponsorDonationFields, audit *AuditEntry) (*SponsorDonation, error)
	// Delete removes donation id (and its file rows) with the audit row in the same transaction,
	// returning the deleted donation so the caller can remove its files after commit.
	Delete(ctx context.Context, id int64, audit *AuditEntry) (*SponsorDonation, error)
	// PutFile upserts the file row (donation_id, file.Kind) with the audit row in the same
	// transaction. oldPath is the replaced file's path ("" when none) to remove after commit.
	PutFile(ctx context.Context, id int64, file SponsorDonationFile, audit *AuditEntry) (updated *SponsorDonation, oldPath string, err error)
	// DeleteFile removes the file row (donation_id, kind) with the audit row in the same
	// transaction, returning the removed path. ErrNotFound when the donation or the file is absent.
	DeleteFile(ctx context.Context, id int64, kind string, audit *AuditEntry) (updated *SponsorDonation, oldPath string, err error)
}
