package domain

import (
	"context"
	"errors"
	"time"
)

// ErrSponsorOrderMismatch is returned by SponsorRepository.Reorder when the supplied id slice
// does not match the exact set of existing sponsors (missing, duplicate, or unknown id).
var ErrSponsorOrderMismatch = errors.New("sponsor order ids must match the exact set of existing sponsors")

// Sponsor is one sponsor logo displayed on the public landing page and managed in /admin.
// LogoPath, LogoMIME and LogoHash are internal storage fields and are never serialized directly.
type Sponsor struct {
	ID        int64     `db:"id" json:"id"`
	Name      string    `db:"name" json:"name"`
	URL       string    `db:"url" json:"url"`
	ShowName  bool      `db:"show_name" json:"showName"`
	SortOrder int       `db:"sort_order" json:"sortOrder"`
	LogoPath  string    `db:"logo_path" json:"-"`
	LogoMIME  string    `db:"logo_mime" json:"-"`
	LogoHash  string    `db:"logo_hash" json:"-"`
	CreatedAt time.Time `db:"created_at" json:"createdAt"`
	UpdatedAt time.Time `db:"updated_at" json:"updatedAt"`
}

// SponsorPatch carries optional fields for an atomic sponsor update. Nil fields remain unchanged.
type SponsorPatch struct {
	Name     *string
	URL      *string
	ShowName *bool
	LogoPath *string
	LogoMIME *string
	LogoHash *string
}

type SponsorRepository interface {
	// List returns every sponsor ordered by sort_order ASC, id ASC.
	List(ctx context.Context) ([]*Sponsor, error)
	// GetByID returns one sponsor or ErrNotFound.
	GetByID(ctx context.Context, id int64) (*Sponsor, error)
	// Create appends s at sort_order = max+1 (0 when empty) and writes the audit row in the
	// same transaction. On success s.ID, s.SortOrder, s.CreatedAt and s.UpdatedAt are populated.
	Create(ctx context.Context, s *Sponsor, audit *AuditEntry) error
	// Update atomically applies patch to sponsor id and writes the audit row (with old -> new
	// field changes and logoReplaced) in the same transaction. When the logo is replaced,
	// oldLogoPath holds the previous logo_path so the caller can remove the old file after commit.
	Update(ctx context.Context, id int64, patch SponsorPatch, audit *AuditEntry) (updated *Sponsor, oldLogoPath string, err error)
	// Delete removes sponsor id and writes the audit row in the same transaction, returning the
	// deleted row so the caller can remove its logo file after commit.
	Delete(ctx context.Context, id int64, audit *AuditEntry) (deleted *Sponsor, err error)
	// Reorder assigns sort_order = 0..n-1 according to ids and writes the audit row in the same
	// transaction. Returns ErrSponsorOrderMismatch when ids is not the exact set of existing ids.
	Reorder(ctx context.Context, ids []int64, audit *AuditEntry) ([]*Sponsor, error)
}
