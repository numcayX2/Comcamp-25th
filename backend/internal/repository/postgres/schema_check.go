package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// RowQuerier is the part of *pgxpool.Pool (or pgx.Conn) the schema checks need.
type RowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// LegacyNationalIDColumnPresent reports whether applicants.national_id still exists in the
// current schema, i.e. migration 000011 has not been applied. This build no longer writes that
// column (NOT NULL before 000011), so every submit would fail on such a schema.
func LegacyNationalIDColumnPresent(ctx context.Context, q RowQuerier) (bool, error) {
	var present bool
	err := q.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'applicants' AND column_name = 'national_id')`).Scan(&present)
	return present, err
}
