package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func TestAuthService_Login(t *testing.T) {
	adminRepo := memory.NewMemoryAdminRepo()
	secret := "super-secure-jwt-secret-at-least-32-chars"
	authSvc := service.NewAuthService(adminRepo, nil, secret)

	hash, _ := service.HashPassword("secret123")
	_ = adminRepo.Create(context.Background(), &domain.Admin{
		Username:     "camp_leader",
		PasswordHash: hash,
		FullName:     "พี่ค่ายใหญ่",
		Role:         domain.RoleSuperadmin,
		IsActive:     true,
	})

	t.Run("Valid login", func(t *testing.T) {
		token, admin, err := authSvc.Login(context.Background(), "camp_leader", "secret123", "127.0.0.1")
		if err != nil {
			t.Fatalf("expected login to succeed, got %v", err)
		}
		if token == "" {
			t.Errorf("expected non-empty JWT token")
		}
		if admin.Username != "camp_leader" {
			t.Errorf("expected username camp_leader, got %s", admin.Username)
		}

		claims, err := authSvc.VerifyToken(token)
		if err != nil {
			t.Fatalf("failed to verify token: %v", err)
		}
		if claims.Username != "camp_leader" {
			t.Errorf("expected claims username camp_leader, got %s", claims.Username)
		}
	})

	t.Run("Invalid password", func(t *testing.T) {
		_, _, err := authSvc.Login(context.Background(), "camp_leader", "wrong_password", "127.0.0.1")
		if err != service.ErrInvalidCredentials {
			t.Fatalf("expected ErrInvalidCredentials, got %v", err)
		}
	})

	t.Run("Non-existent user", func(t *testing.T) {
		_, _, err := authSvc.Login(context.Background(), "nobody", "secret123", "127.0.0.1")
		if err != service.ErrInvalidCredentials {
			t.Fatalf("expected ErrInvalidCredentials, got %v", err)
		}
	})
}

// A password reset (or any change that bumps admins.updated_at) must end every session started
// before it, at the very next request.
func TestAuthService_AccountUpdateInvalidatesOlderTokens(t *testing.T) {
	ctx := context.Background()
	adminRepo := memory.NewMemoryAdminRepo()
	secret := "super-secure-jwt-secret-at-least-32-chars"
	authSvc := service.NewAuthService(adminRepo, nil, secret)

	hash, _ := service.HashPassword("old-password-123")
	admin := &domain.Admin{Username: "reset_me", PasswordHash: hash, FullName: "พี่รีเซ็ต", Role: domain.RoleStaff, IsActive: true}
	if err := adminRepo.Create(ctx, admin); err != nil {
		t.Fatal(err)
	}

	token, _, err := authSvc.Login(ctx, "reset_me", "old-password-123", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := authSvc.Authenticate(ctx, token)
	if err != nil {
		t.Fatalf("fresh token rejected: %v", err)
	}
	iat := claims.IssuedAt.Time

	// Logging in again (UpdateLastLogin) does not touch updated_at, so the first session survives.
	if _, _, err := authSvc.Login(ctx, "reset_me", "old-password-123", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if _, err := authSvc.Authenticate(ctx, token); err != nil {
		t.Fatalf("a second login ended the first session: %v", err)
	}

	// A change later in the same second as iat: updated_at is truncated to iat's precision, so the
	// token still counts (otherwise a login right after creating the account would fail).
	if err := adminRepo.SetUpdatedAt(admin.ID, iat.Add(900*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := authSvc.Authenticate(ctx, token); err != nil {
		t.Fatalf("change in the token's own second rejected it: %v", err)
	}

	// The password is reset in a later second: the old token stops working at once.
	if err := adminRepo.SetUpdatedAt(admin.ID, iat.Add(1500*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := authSvc.Authenticate(ctx, token); !errors.Is(err, service.ErrTokenStale) {
		t.Fatalf("token issued before the reset: expected ErrTokenStale, got %v", err)
	}
	// VerifyToken alone (signature and expiry) still passes: the check needs the account.
	if _, err := authSvc.VerifyToken(token); err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}

	// A token issued in the reset's second is accepted.
	after := iat.Add(1500 * time.Millisecond)
	fresh := signTestToken(t, secret, admin.ID, jwt.NewNumericDate(after))
	if _, err := authSvc.Authenticate(ctx, fresh); err != nil {
		t.Fatalf("token issued after the reset rejected: %v", err)
	}

	// A token without iat cannot be placed before or after the change, so it is refused.
	noIat := signTestToken(t, secret, admin.ID, nil)
	if _, err := authSvc.Authenticate(ctx, noIat); !errors.Is(err, service.ErrTokenStale) {
		t.Fatalf("token without iat: expected ErrTokenStale, got %v", err)
	}
}

// signTestToken signs a token the way Login does, with the given iat (nil = no iat claim).
func signTestToken(t *testing.T, secret string, adminID int64, iat *jwt.NumericDate) string {
	t.Helper()
	claims := service.AdminClaims{
		AdminID: adminID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  iat,
			Issuer:    "comcamp25-backend",
		},
	}
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}
