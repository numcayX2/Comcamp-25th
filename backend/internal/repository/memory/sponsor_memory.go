package memory

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"

	"comcamp25-backend/internal/domain"
)

var _ domain.SponsorRepository = (*MemorySponsorRepo)(nil)

// MemorySponsorRepo provides thread-safe in-memory storage for sponsors (development and tests).
type MemorySponsorRepo struct {
	mu     sync.RWMutex
	nextID int64
	data   map[int64]*domain.Sponsor
	audit  *MemoryAuditRepo
}

// NewMemorySponsorRepo creates a sponsor repository backed by audit (a fresh MemoryAuditRepo is
// created when audit is nil).
func NewMemorySponsorRepo(audit *MemoryAuditRepo) *MemorySponsorRepo {
	if audit == nil {
		audit = NewMemoryAuditRepo()
	}
	return &MemorySponsorRepo{
		data:  make(map[int64]*domain.Sponsor),
		audit: audit,
	}
}

// Audit returns the audit store this repository writes to.
func (m *MemorySponsorRepo) Audit() *MemoryAuditRepo { return m.audit }

func (m *MemorySponsorRepo) List(ctx context.Context) ([]*domain.Sponsor, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.listLocked(), nil
}

func (m *MemorySponsorRepo) listLocked() []*domain.Sponsor {
	out := make([]*domain.Sponsor, 0, len(m.data))
	for _, s := range m.data {
		clone := *s
		out = append(out, &clone)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (m *MemorySponsorRepo) GetByID(ctx context.Context, id int64) (*domain.Sponsor, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	clone := *s
	return &clone, nil
}

func (m *MemorySponsorRepo) Create(ctx context.Context, s *domain.Sponsor, audit *domain.AuditEntry) error {
	if err := checkAuditDetails(audit); err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	nextOrder := 0
	for _, existing := range m.data {
		if existing.SortOrder+1 > nextOrder {
			nextOrder = existing.SortOrder + 1
		}
	}

	m.nextID++
	now := time.Now().UTC()
	s.ID = m.nextID
	s.SortOrder = nextOrder
	s.CreatedAt = now
	s.UpdatedAt = now

	clone := *s
	m.data[s.ID] = &clone

	if audit != nil {
		entry := cloneSponsorAudit(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(s.ID, 10)
		}
		entry.Details["name"] = s.Name
		entry.Details["url"] = s.URL
		entry.Details["showName"] = s.ShowName
		entry.Details["sortOrder"] = s.SortOrder
		if err := m.audit.Log(ctx, entry); err != nil {
			delete(m.data, s.ID)
			return err
		}
	}
	return nil
}

func (m *MemorySponsorRepo) Update(ctx context.Context, id int64, patch domain.SponsorPatch, audit *domain.AuditEntry) (*domain.Sponsor, string, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, "", err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	existing, ok := m.data[id]
	if !ok {
		return nil, "", domain.ErrNotFound
	}

	prev := *existing
	next := *existing
	details := map[string]any{}
	if audit != nil {
		for k, v := range audit.Details {
			details[k] = v
		}
	}

	changed := false
	if patch.Name != nil && *patch.Name != existing.Name {
		details["name"] = map[string]any{"old": existing.Name, "new": *patch.Name}
		next.Name = *patch.Name
		changed = true
	}
	if patch.URL != nil && *patch.URL != existing.URL {
		details["url"] = map[string]any{"old": existing.URL, "new": *patch.URL}
		next.URL = *patch.URL
		changed = true
	}
	if patch.ShowName != nil && *patch.ShowName != existing.ShowName {
		details["showName"] = map[string]any{"old": existing.ShowName, "new": *patch.ShowName}
		next.ShowName = *patch.ShowName
		changed = true
	}

	oldLogoPath := ""
	logoReplaced := false
	if patch.LogoPath != nil && patch.LogoMIME != nil && patch.LogoHash != nil {
		oldLogoPath = existing.LogoPath
		next.LogoPath = *patch.LogoPath
		next.LogoMIME = *patch.LogoMIME
		next.LogoHash = *patch.LogoHash
		logoReplaced = true
		changed = true
	}
	details["logoReplaced"] = logoReplaced

	if !changed {
		return &prev, "", nil
	}

	next.UpdatedAt = time.Now().UTC()
	stored := next
	m.data[id] = &stored

	if audit != nil {
		entry := cloneSponsorAudit(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(id, 10)
		}
		entry.Details = details
		if err := m.audit.Log(ctx, entry); err != nil {
			m.data[id] = &prev
			return nil, "", err
		}
	}

	out := next
	return &out, oldLogoPath, nil
}

func (m *MemorySponsorRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.Sponsor, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	existing, ok := m.data[id]
	if !ok {
		return nil, domain.ErrNotFound
	}
	prev := *existing
	delete(m.data, id)

	if audit != nil {
		entry := cloneSponsorAudit(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(id, 10)
		}
		entry.Details["name"] = prev.Name
		if err := m.audit.Log(ctx, entry); err != nil {
			m.data[id] = &prev
			return nil, err
		}
	}

	return &prev, nil
}

func (m *MemorySponsorRepo) Reorder(ctx context.Context, ids []int64, audit *domain.AuditEntry) ([]*domain.Sponsor, error) {
	if err := checkAuditDetails(audit); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if len(ids) != len(m.data) {
		return nil, domain.ErrSponsorOrderMismatch
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if _, ok := m.data[id]; !ok || seen[id] {
			return nil, domain.ErrSponsorOrderMismatch
		}
		seen[id] = true
	}

	current := m.listLocked()
	previousIDs := make([]int64, len(current))
	prevOrders := make(map[int64]int, len(current))
	prevUpdated := make(map[int64]time.Time, len(current))
	for i, s := range current {
		previousIDs[i] = s.ID
		prevOrders[s.ID] = s.SortOrder
		prevUpdated[s.ID] = s.UpdatedAt
	}

	now := time.Now().UTC()
	for idx, id := range ids {
		s := m.data[id]
		s.SortOrder = idx
		s.UpdatedAt = now
	}

	if audit != nil {
		entry := cloneSponsorAudit(audit)
		entry.Details["ids"] = append([]int64(nil), ids...)
		entry.Details["previousIds"] = previousIDs
		if err := m.audit.Log(ctx, entry); err != nil {
			for id, ord := range prevOrders {
				m.data[id].SortOrder = ord
				m.data[id].UpdatedAt = prevUpdated[id]
			}
			return nil, err
		}
	}

	return m.listLocked(), nil
}

func cloneSponsorAudit(e *domain.AuditEntry) *domain.AuditEntry {
	clone := *e
	clone.Details = make(map[string]any, len(e.Details)+4)
	for k, v := range e.Details {
		clone.Details[k] = v
	}
	return &clone
}
