package postgres

import (
	"context"
	"fmt"

	"comcamp25-backend/internal/domain"
)

// listPublicSQL selects ONLY the columns the public applicants list may show (PDPA allowlist,
// CLAUDE_REVAMP_HANDOFF.md 5.4). It never reads identifiers, contact, parent, health or
// motivation columns, so a later change to the Go projection cannot leak them by accident.
// id appears only in ORDER BY as a stable tiebreak and is never returned.
const listPublicSQL = `
	SELECT first_name, last_name, nickname, school, province, status
	FROM applicants
	WHERE deleted_at IS NULL AND status IN ('PASSED', 'CONFIRMED')
	ORDER BY created_at ASC, id ASC
`

func (r *ApplicantPostgresRepo) ListPublic(ctx context.Context) ([]domain.PublicApplicant, error) {
	rows, err := r.pool.Query(ctx, listPublicSQL)
	if err != nil {
		return nil, fmt.Errorf("failed to list public applicants: %w", err)
	}
	defer rows.Close()

	list := make([]domain.PublicApplicant, 0)
	for rows.Next() {
		var p domain.PublicApplicant
		if err := rows.Scan(&p.FirstName, &p.LastName, &p.Nickname, &p.School, &p.Province, &p.Status); err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
}
