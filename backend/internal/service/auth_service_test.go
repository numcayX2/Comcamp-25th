package service_test

import (
	"context"
	"testing"

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
