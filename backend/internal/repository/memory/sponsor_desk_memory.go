package memory

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"

	"comcamp25-backend/internal/domain"
)

var (
	_ domain.SponsorInquiryRepository  = (*MemorySponsorInquiryRepo)(nil)
	_ domain.SponsorDonationRepository = (*MemorySponsorDonationRepo)(nil)
)

// MemorySponsorInquiryRepo stores sponsor inquiries and notification addresses in memory
// (development and tests).
type MemorySponsorInquiryRepo struct {
	mu     sync.RWMutex
	nextID int64
	data   map[int64]*domain.SponsorInquiry
	emails []string
	audit  *MemoryAuditRepo
}

// NewMemorySponsorInquiryRepo writes audit rows to audit (a fresh store when nil).
func NewMemorySponsorInquiryRepo(audit *MemoryAuditRepo) *MemorySponsorInquiryRepo {
	if audit == nil {
		audit = NewMemoryAuditRepo()
	}
	return &MemorySponsorInquiryRepo{data: make(map[int64]*domain.SponsorInquiry), audit: audit}
}

// Audit returns the audit store this repository writes to.
func (m *MemorySponsorInquiryRepo) Audit() *MemoryAuditRepo { return m.audit }

func cloneInquiry(i *domain.SponsorInquiry) *domain.SponsorInquiry {
	c := *i
	if i.HandledAt != nil {
		t := *i.HandledAt
		c.HandledAt = &t
	}
	if i.Amount != nil {
		a := *i.Amount
		c.Amount = &a
	}
	if i.File != nil {
		f := *i.File
		c.File = &f
	}
	return &c
}

func (m *MemorySponsorInquiryRepo) logAudit(ctx context.Context, audit *domain.AuditEntry, id int64) error {
	if audit == nil {
		return nil
	}
	entry := cloneSponsorAudit(audit)
	if entry.TargetID == "" && id > 0 {
		entry.TargetID = strconv.FormatInt(id, 10)
	}
	return m.audit.Log(ctx, entry)
}

func (m *MemorySponsorInquiryRepo) Create(ctx context.Context, inq *domain.SponsorInquiry, audit *domain.AuditEntry) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	inq.ID = m.nextID
	inq.CreatedAt = time.Now().UTC()
	m.data[inq.ID] = cloneInquiry(inq)
	if err := m.logAudit(ctx, audit, inq.ID); err != nil {
		delete(m.data, inq.ID)
		return err
	}
	return nil
}

func (m *MemorySponsorInquiryRepo) List(ctx context.Context) ([]*domain.SponsorInquiry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*domain.SponsorInquiry, 0, len(m.data))
	for _, i := range m.data {
		out = append(out, cloneInquiry(i))
	}
	sort.Slice(out, func(a, b int) bool {
		if !out[a].CreatedAt.Equal(out[b].CreatedAt) {
			return out[a].CreatedAt.After(out[b].CreatedAt)
		}
		return out[a].ID > out[b].ID
	})
	return out, nil
}

func (m *MemorySponsorInquiryRepo) GetByID(ctx context.Context, id int64) (*domain.SponsorInquiry, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneInquiry(cur), nil
}

func (m *MemorySponsorInquiryRepo) SetHandled(ctx context.Context, id int64, handled bool, audit *domain.AuditEntry) (*domain.SponsorInquiry, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	prev := cloneInquiry(cur)
	switch {
	case handled && cur.HandledAt == nil:
		now := time.Now().UTC()
		cur.HandledAt = &now
	case !handled:
		cur.HandledAt = nil
	}
	if err := m.logAudit(ctx, audit, id); err != nil {
		m.data[id] = prev
		return nil, err
	}
	return cloneInquiry(cur), nil
}

func (m *MemorySponsorInquiryRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.SponsorInquiry, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	delete(m.data, id)
	if err := m.logAudit(ctx, audit, id); err != nil {
		m.data[id] = cur
		return nil, err
	}
	return cloneInquiry(cur), nil
}

func (m *MemorySponsorInquiryRepo) ListNotifyEmails(ctx context.Context) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string{}, m.emails...), nil
}

func (m *MemorySponsorInquiryRepo) ReplaceNotifyEmails(ctx context.Context, emails []string, audit *domain.AuditEntry) ([]string, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	prev := m.emails
	m.emails = append([]string{}, emails...)
	if err := m.logAudit(ctx, audit, 0); err != nil {
		m.emails = prev
		return nil, err
	}
	return append([]string{}, m.emails...), nil
}

// MemorySponsorDonationRepo stores staff-recorded donations in memory (development and tests).
type MemorySponsorDonationRepo struct {
	mu     sync.RWMutex
	nextID int64
	data   map[int64]*domain.SponsorDonation
	audit  *MemoryAuditRepo
}

// NewMemorySponsorDonationRepo writes audit rows to audit (a fresh store when nil).
func NewMemorySponsorDonationRepo(audit *MemoryAuditRepo) *MemorySponsorDonationRepo {
	if audit == nil {
		audit = NewMemoryAuditRepo()
	}
	return &MemorySponsorDonationRepo{data: make(map[int64]*domain.SponsorDonation), audit: audit}
}

// Audit returns the audit store this repository writes to.
func (m *MemorySponsorDonationRepo) Audit() *MemoryAuditRepo { return m.audit }

func cloneDonation(d *domain.SponsorDonation) *domain.SponsorDonation {
	c := *d
	if d.Amount != nil {
		a := *d.Amount
		c.Amount = &a
	}
	if d.FacultySubmittedAt != nil {
		t := *d.FacultySubmittedAt
		c.FacultySubmittedAt = &t
	}
	if d.Signed != nil {
		f := *d.Signed
		c.Signed = &f
	}
	if d.Slip != nil {
		f := *d.Slip
		c.Slip = &f
	}
	return &c
}

func applyDonationFields(d *domain.SponsorDonation, f domain.SponsorDonationFields, now time.Time) {
	d.DonorName = f.DonorName
	d.Address = f.Address
	d.Phone = f.Phone
	d.Kind = f.Kind
	d.Amount = nil
	if f.Amount != nil {
		a := *f.Amount
		d.Amount = &a
	}
	d.GoodsDescription = f.GoodsDescription
	d.DonatedOn = f.DonatedOn
	d.Note = f.Note
	d.TaxID = f.TaxID
	d.AddressLine = f.AddressLine
	d.Subdistrict = f.Subdistrict
	d.District = f.District
	d.Province = f.Province
	d.Postcode = f.Postcode
	switch {
	case f.FacultySubmitted && d.FacultySubmittedAt == nil:
		t := now
		d.FacultySubmittedAt = &t
	case !f.FacultySubmitted:
		d.FacultySubmittedAt = nil
	}
	d.UpdatedAt = now
}

func (m *MemorySponsorDonationRepo) logAudit(ctx context.Context, audit *domain.AuditEntry, id int64, extra map[string]any) error {
	if audit == nil {
		return nil
	}
	entry := cloneSponsorAudit(audit)
	if entry.TargetID == "" {
		entry.TargetID = strconv.FormatInt(id, 10)
	}
	for k, v := range extra {
		entry.Details[k] = v
	}
	return m.audit.Log(ctx, entry)
}

func (m *MemorySponsorDonationRepo) List(ctx context.Context) ([]*domain.SponsorDonation, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*domain.SponsorDonation, 0, len(m.data))
	for _, d := range m.data {
		out = append(out, cloneDonation(d))
	}
	sort.Slice(out, func(a, b int) bool {
		if !out[a].CreatedAt.Equal(out[b].CreatedAt) {
			return out[a].CreatedAt.After(out[b].CreatedAt)
		}
		return out[a].ID > out[b].ID
	})
	return out, nil
}

func (m *MemorySponsorDonationRepo) GetByID(ctx context.Context, id int64) (*domain.SponsorDonation, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	d, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	return cloneDonation(d), nil
}

func (m *MemorySponsorDonationRepo) Create(ctx context.Context, f domain.SponsorDonationFields, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UTC()
	m.nextID++
	d := &domain.SponsorDonation{ID: m.nextID, CreatedAt: now}
	applyDonationFields(d, f, now)
	m.data[d.ID] = d
	if err := m.logAudit(ctx, audit, d.ID, nil); err != nil {
		delete(m.data, d.ID)
		return nil, err
	}
	return cloneDonation(d), nil
}

func (m *MemorySponsorDonationRepo) Update(ctx context.Context, id int64, f domain.SponsorDonationFields, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	prev := cloneDonation(cur)
	changed := cur.ChangedFields(f)
	applyDonationFields(cur, f, time.Now().UTC())
	if err := m.logAudit(ctx, audit, id, map[string]any{"fields": changed}); err != nil {
		m.data[id] = prev
		return nil, err
	}
	return cloneDonation(cur), nil
}

func (m *MemorySponsorDonationRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	delete(m.data, id)
	if err := m.logAudit(ctx, audit, id, nil); err != nil {
		m.data[id] = cur
		return nil, err
	}
	return cloneDonation(cur), nil
}

func donationFileSlot(d *domain.SponsorDonation, kind string) **domain.SponsorDonationFile {
	if kind == domain.SponsorFileSigned {
		return &d.Signed
	}
	return &d.Slip
}

func (m *MemorySponsorDonationRepo) PutFile(ctx context.Context, id int64, file domain.SponsorDonationFile, audit *domain.AuditEntry) (*domain.SponsorDonation, string, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, "", domain.ErrNotFound
	}
	prev := cloneDonation(cur)
	slot := donationFileSlot(cur, file.Kind)
	oldPath := ""
	if *slot != nil {
		oldPath = (*slot).Path
	}
	f := file
	f.UploadedAt = time.Now().UTC()
	*slot = &f
	if err := m.logAudit(ctx, audit, id, nil); err != nil {
		m.data[id] = prev
		return nil, "", err
	}
	return cloneDonation(cur), oldPath, nil
}

func (m *MemorySponsorDonationRepo) DeleteFile(ctx context.Context, id int64, kind string, audit *domain.AuditEntry) (*domain.SponsorDonation, string, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.data[id]
	if !ok {
		return nil, "", domain.ErrNotFound
	}
	slot := donationFileSlot(cur, kind)
	if *slot == nil {
		return nil, "", domain.ErrNotFound
	}
	prev := cloneDonation(cur)
	oldPath := (*slot).Path
	*slot = nil
	if err := m.logAudit(ctx, audit, id, nil); err != nil {
		m.data[id] = prev
		return nil, "", err
	}
	return cloneDonation(cur), oldPath, nil
}
