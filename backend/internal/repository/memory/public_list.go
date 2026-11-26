package memory

import (
	"bytes"
	"context"
	"sort"

	"comcamp25-backend/internal/domain"
)

// ListPublic mirrors the postgres query behind GET /api/applications/public: live PASSED or
// CONFIRMED applications, oldest first (created_at, then id), copied into the allowlisted
// projection so no other column leaves the store.
func (m *MemoryApplicantRepo) ListPublic(ctx context.Context) ([]domain.PublicApplicant, error) {
	m.mu.RLock()
	type sortable struct {
		row domain.PublicApplicant
		a   *domain.Applicant
	}
	picked := make([]sortable, 0, len(m.data))
	for _, a := range m.data {
		if a.DeletedAt != nil {
			continue
		}
		if a.Status != domain.StatusPassed && a.Status != domain.StatusConfirmed {
			continue
		}
		picked = append(picked, sortable{
			row: domain.PublicApplicant{
				Prefix:    a.Prefix,
				FirstName: a.FirstName,
				LastName:  a.LastName,
				School:    a.School,
				Province:  a.Province,
				Status:    a.Status,
			},
			a: a,
		})
	}
	sort.Slice(picked, func(i, j int) bool {
		ai, aj := picked[i].a, picked[j].a
		if !ai.CreatedAt.Equal(aj.CreatedAt) {
			return ai.CreatedAt.Before(aj.CreatedAt)
		}
		return bytes.Compare(ai.ID[:], aj.ID[:]) < 0
	})
	m.mu.RUnlock()

	out := make([]domain.PublicApplicant, len(picked))
	for i, p := range picked {
		out[i] = p.row
	}
	return out, nil
}
