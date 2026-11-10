package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

const (
	pgUniqueViolation  = "23505"
	pgLockNotAvailable = "55P03" // lock_timeout expired
)

// mapPgError turns unique-constraint violations and lock timeouts into domain errors so callers
// can react without string matching, and so constraint names never leak to API clients.
func mapPgError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	if pgErr.Code == pgLockNotAvailable {
		return domain.ErrLockTimeout
	}
	if pgErr.Code != pgUniqueViolation {
		return err
	}
	switch pgErr.ConstraintName {
	case "uq_applicants_idempotency_key":
		return domain.ErrDuplicateIdempotencyKey
	case "applicants_application_no_key":
		return domain.ErrDuplicateApplicationNo
	case "applicants_national_id_key", "applicants_phone_key", "applicants_email_key", "uq_applicants_email":
		return domain.ErrDuplicateApplicant
	case "uq_payments_slip_hash":
		return domain.ErrDuplicateSlipHash
	}
	return err
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// insertAudit writes one audit_logs row using either the pool or an open transaction.
func insertAudit(ctx context.Context, db execer, e *domain.AuditEntry) error {
	details := e.Details
	if details == nil {
		details = map[string]any{}
	}
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return fmt.Errorf("marshal audit details: %w", err)
	}
	var ip *string
	if e.IPAddress != "" {
		ip = &e.IPAddress
	}
	_, err = db.Exec(ctx, `
		INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, ip_address)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, e.AdminID, string(e.Action), nullIfEmpty(e.TargetType), nullIfEmpty(e.TargetID), detailsJSON, ip)
	if err != nil {
		return fmt.Errorf("insert audit log: %w", err)
	}
	return nil
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// AuditPostgresRepo writes standalone audit events such as admin logins.
type AuditPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewAuditPostgresRepo(pool *pgxpool.Pool) *AuditPostgresRepo {
	return &AuditPostgresRepo{pool: pool}
}

func (r *AuditPostgresRepo) Log(ctx context.Context, e *domain.AuditEntry) error {
	return insertAudit(ctx, r.pool, e)
}

// withAuditDetail returns a copy of e with one extra detail, leaving the caller's map untouched.
func withAuditDetail(e *domain.AuditEntry, key string, value any) *domain.AuditEntry {
	clone := *e
	clone.Details = make(map[string]any, len(e.Details)+1)
	for k, v := range e.Details {
		clone.Details[k] = v
	}
	clone.Details[key] = value
	return &clone
}

var (
	_ execer = (pgx.Tx)(nil)
	_ execer = (*pgxpool.Pool)(nil)
)
