package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

// sponsorLockKey serialises sponsor mutations (create/update/delete/reorder) so sort_order
// assignment and full-set reorder checks cannot interleave, without contending with quotaLockKey.
const sponsorLockKey int64 = 25_000_002

var _ domain.SponsorRepository = (*SponsorPostgresRepo)(nil)

type SponsorPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewSponsorPostgresRepo(pool *pgxpool.Pool) *SponsorPostgresRepo {
	return &SponsorPostgresRepo{pool: pool}
}

const sponsorColumns = `id, name, url, show_name, sort_order, logo_path, logo_mime, logo_hash, created_at, updated_at`

func scanSponsor(s scannable) (*domain.Sponsor, error) {
	var sp domain.Sponsor
	err := s.Scan(
		&sp.ID, &sp.Name, &sp.URL, &sp.ShowName, &sp.SortOrder,
		&sp.LogoPath, &sp.LogoMIME, &sp.LogoHash, &sp.CreatedAt, &sp.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	return &sp, nil
}

func (r *SponsorPostgresRepo) List(ctx context.Context) ([]*domain.Sponsor, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+sponsorColumns+` FROM sponsors ORDER BY sort_order ASC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list sponsors: %w", err)
	}
	defer rows.Close()

	list := make([]*domain.Sponsor, 0)
	for rows.Next() {
		sp, err := scanSponsor(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, sp)
	}
	return list, rows.Err()
}

func (r *SponsorPostgresRepo) GetByID(ctx context.Context, id int64) (*domain.Sponsor, error) {
	return scanSponsor(r.pool.QueryRow(ctx, `SELECT `+sponsorColumns+` FROM sponsors WHERE id = $1`, id))
}

func (r *SponsorPostgresRepo) Create(ctx context.Context, s *domain.Sponsor, audit *domain.AuditEntry) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorLockKey); err != nil {
		return fmt.Errorf("lock sponsors: %w", err)
	}

	var nextOrder int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order) + 1, 0) FROM sponsors`).Scan(&nextOrder); err != nil {
		return fmt.Errorf("compute next sponsor sort_order: %w", err)
	}

	now := time.Now().UTC()
	var id int64
	err = tx.QueryRow(ctx, `
		INSERT INTO sponsors (name, url, show_name, sort_order, logo_path, logo_mime, logo_hash, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id
	`, s.Name, s.URL, s.ShowName, nextOrder, s.LogoPath, s.LogoMIME, s.LogoHash, now, now).Scan(&id)
	if err != nil {
		return fmt.Errorf("insert sponsor: %w", err)
	}

	s.ID = id
	s.SortOrder = nextOrder
	s.CreatedAt = now
	s.UpdatedAt = now

	if audit != nil {
		entry := cloneAuditEntry(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(id, 10)
		}
		entry.Details["name"] = s.Name
		entry.Details["url"] = s.URL
		entry.Details["showName"] = s.ShowName
		entry.Details["sortOrder"] = s.SortOrder
		if err := insertAudit(ctx, tx, entry); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *SponsorPostgresRepo) Update(ctx context.Context, id int64, patch domain.SponsorPatch, audit *domain.AuditEntry) (*domain.Sponsor, string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorLockKey); err != nil {
		return nil, "", fmt.Errorf("lock sponsors: %w", err)
	}

	existing, err := scanSponsor(tx.QueryRow(ctx, `SELECT `+sponsorColumns+` FROM sponsors WHERE id = $1 FOR UPDATE`, id))
	if err != nil {
		return nil, "", err
	}

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
		return existing, "", nil
	}

	now := time.Now().UTC()
	next.UpdatedAt = now
	_, err = tx.Exec(ctx, `
		UPDATE sponsors
		SET name = $1, url = $2, show_name = $3, logo_path = $4, logo_mime = $5, logo_hash = $6, updated_at = $7
		WHERE id = $8
	`, next.Name, next.URL, next.ShowName, next.LogoPath, next.LogoMIME, next.LogoHash, now, id)
	if err != nil {
		return nil, "", fmt.Errorf("update sponsor: %w", err)
	}

	if audit != nil {
		entry := cloneAuditEntry(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(id, 10)
		}
		entry.Details = details
		if err := insertAudit(ctx, tx, entry); err != nil {
			return nil, "", err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return &next, oldLogoPath, nil
}

func (r *SponsorPostgresRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.Sponsor, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorLockKey); err != nil {
		return nil, fmt.Errorf("lock sponsors: %w", err)
	}

	existing, err := scanSponsor(tx.QueryRow(ctx, `SELECT `+sponsorColumns+` FROM sponsors WHERE id = $1 FOR UPDATE`, id))
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM sponsors WHERE id = $1`, id); err != nil {
		return nil, fmt.Errorf("delete sponsor: %w", err)
	}

	if audit != nil {
		entry := cloneAuditEntry(audit)
		if entry.TargetID == "" {
			entry.TargetID = strconv.FormatInt(id, 10)
		}
		entry.Details["name"] = existing.Name
		if err := insertAudit(ctx, tx, entry); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return existing, nil
}

func (r *SponsorPostgresRepo) Reorder(ctx context.Context, ids []int64, audit *domain.AuditEntry) ([]*domain.Sponsor, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, sponsorLockKey); err != nil {
		return nil, fmt.Errorf("lock sponsors: %w", err)
	}

	rows, err := tx.Query(ctx, `SELECT id FROM sponsors ORDER BY sort_order ASC, id ASC FOR UPDATE`)
	if err != nil {
		return nil, fmt.Errorf("read sponsor ids: %w", err)
	}
	existingIDs := make([]int64, 0)
	existingSet := make(map[int64]bool)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		existingIDs = append(existingIDs, id)
		existingSet[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(ids) != len(existingIDs) {
		return nil, domain.ErrSponsorOrderMismatch
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if !existingSet[id] || seen[id] {
			return nil, domain.ErrSponsorOrderMismatch
		}
		seen[id] = true
	}

	now := time.Now().UTC()
	for idx, id := range ids {
		if _, err := tx.Exec(ctx, `UPDATE sponsors SET sort_order = $1, updated_at = $2 WHERE id = $3`, idx, now, id); err != nil {
			return nil, fmt.Errorf("reorder sponsor %d: %w", id, err)
		}
	}

	if audit != nil {
		entry := cloneAuditEntry(audit)
		entry.Details["ids"] = append([]int64(nil), ids...)
		entry.Details["previousIds"] = existingIDs
		if err := insertAudit(ctx, tx, entry); err != nil {
			return nil, err
		}
	}

	outRows, err := tx.Query(ctx, `SELECT `+sponsorColumns+` FROM sponsors ORDER BY sort_order ASC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list reordered sponsors: %w", err)
	}
	defer outRows.Close()

	list := make([]*domain.Sponsor, 0, len(ids))
	for outRows.Next() {
		sp, err := scanSponsor(outRows)
		if err != nil {
			return nil, err
		}
		list = append(list, sp)
	}
	if err := outRows.Err(); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return list, nil
}

func cloneAuditEntry(e *domain.AuditEntry) *domain.AuditEntry {
	clone := *e
	clone.Details = make(map[string]any, len(e.Details)+4)
	for k, v := range e.Details {
		clone.Details[k] = v
	}
	return &clone
}
