package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

type AdminPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewAdminPostgresRepo(pool *pgxpool.Pool) *AdminPostgresRepo {
	return &AdminPostgresRepo{pool: pool}
}

func (r *AdminPostgresRepo) GetByID(ctx context.Context, id int64) (*domain.Admin, error) {
	query := `
		SELECT id, username, password_hash, full_name, role, is_active, last_login_at, created_at, updated_at
		FROM admins
		WHERE id = $1
	`
	return r.scan(r.pool.QueryRow(ctx, query, id))
}

func (r *AdminPostgresRepo) GetByUsername(ctx context.Context, username string) (*domain.Admin, error) {
	query := `
		SELECT id, username, password_hash, full_name, role, is_active, last_login_at, created_at, updated_at
		FROM admins
		WHERE username = $1
	`
	return r.scan(r.pool.QueryRow(ctx, query, username))
}

func (r *AdminPostgresRepo) UpdateLastLogin(ctx context.Context, id int64) error {
	query := `UPDATE admins SET last_login_at = $1 WHERE id = $2`
	tag, err := r.pool.Exec(ctx, query, time.Now().UTC(), id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrAdminNotFound
	}
	return nil
}

func (r *AdminPostgresRepo) Create(ctx context.Context, a *domain.Admin) error {
	if a.Role == "" {
		a.Role = domain.RoleAdmin
	}
	query := `
		INSERT INTO admins (username, password_hash, full_name, role, is_active, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, created_at, updated_at
	`
	now := time.Now().UTC()
	err := r.pool.QueryRow(ctx, query, a.Username, a.PasswordHash, a.FullName, a.Role, a.IsActive, now, now).
		Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return domain.ErrDuplicateAdmin
		}
		return fmt.Errorf("failed to create admin: %w", err)
	}
	return nil
}

func (r *AdminPostgresRepo) Count(ctx context.Context) (int, error) {
	var count int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM admins`).Scan(&count)
	return count, err
}

func (r *AdminPostgresRepo) scan(row pgx.Row) (*domain.Admin, error) {
	var a domain.Admin
	err := row.Scan(&a.ID, &a.Username, &a.PasswordHash, &a.FullName, &a.Role, &a.IsActive, &a.LastLoginAt, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrAdminNotFound
		}
		return nil, fmt.Errorf("failed to scan admin: %w", err)
	}
	return &a, nil
}
