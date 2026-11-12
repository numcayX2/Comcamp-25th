package domain

import (
	"context"
	"time"
)

type AdminRole string

const (
	RoleAdmin AdminRole = "admin"
)

func (r AdminRole) IsValid() bool {
	return r == RoleAdmin
}

type AdminClaims struct {
	AdminID   int64     `json:"adminId"`
	Username  string    `json:"username"`
	Role      AdminRole `json:"role"`
	TokenID   string    `json:"jti,omitempty"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

type Admin struct {
	ID           int64      `db:"id" json:"id"`
	Username     string     `db:"username" json:"username"`
	PasswordHash string     `db:"password_hash" json:"-"`
	FullName     string     `db:"full_name" json:"fullName"`
	Role         AdminRole  `db:"role" json:"role"`
	IsActive     bool       `db:"is_active" json:"isActive"`
	LastLoginAt  *time.Time `db:"last_login_at" json:"lastLoginAt,omitempty"`
	CreatedAt    time.Time  `db:"created_at" json:"createdAt"`
	UpdatedAt    time.Time  `db:"updated_at" json:"updatedAt"`
}

type AdminRepository interface {
	GetByID(ctx context.Context, id int64) (*Admin, error)
	GetByUsername(ctx context.Context, username string) (*Admin, error)
	UpdateLastLogin(ctx context.Context, id int64) error
	Create(ctx context.Context, admin *Admin) error
	Count(ctx context.Context) (int, error)
}
