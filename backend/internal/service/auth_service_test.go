package service_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

type mutableAdminRepo struct {
	*memory.MemoryAdminRepo
	overrideActive map[int64]bool
	overrideRole   map[int64]domain.AdminRole
}

func (m *mutableAdminRepo) GetByID(ctx context.Context, id int64) (*domain.Admin, error) {
	a, err := m.MemoryAdminRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if active, ok := m.overrideActive[id]; ok {
		a.IsActive = active
	}
	if role, ok := m.overrideRole[id]; ok {
		a.Role = role
	}
	return a, nil
}

func (m *mutableAdminRepo) GetByUsername(ctx context.Context, username string) (*domain.Admin, error) {
	a, err := m.MemoryAdminRepo.GetByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if active, ok := m.overrideActive[a.ID]; ok {
		a.IsActive = active
	}
	if role, ok := m.overrideRole[a.ID]; ok {
		a.Role = role
	}
	return a, nil
}

func TestAuthService_LoginAndVerify(t *testing.T) {
	ctx := context.Background()
	baseRepo := memory.NewMemoryAdminRepo()
	adminRepo := &mutableAdminRepo{
		MemoryAdminRepo: baseRepo,
		overrideActive:  make(map[int64]bool),
		overrideRole:    make(map[int64]domain.AdminRole),
	}
	secret := "super-secure-jwt-secret-at-least-32-chars"
	authSvc := service.NewAuthService(adminRepo, secret)

	hash, _ := service.HashPassword("secret123")
	activeAdmin := &domain.Admin{
		Username:     "camp_leader",
		PasswordHash: hash,
		FullName:     "พี่ค่ายใหญ่",
		Role:         domain.RoleAdmin,
		IsActive:     true,
	}
	_ = baseRepo.Create(ctx, activeAdmin)

	inactiveAdmin := &domain.Admin{
		Username:     "inactive_admin",
		PasswordHash: hash,
		FullName:     "Inactive",
		Role:         domain.RoleAdmin,
		IsActive:     false,
	}
	_ = baseRepo.Create(ctx, inactiveAdmin)

	nonAdminRole := &domain.Admin{
		Username:     "staff_user",
		PasswordHash: hash,
		FullName:     "Staff",
		Role:         domain.AdminRole("staff"),
		IsActive:     true,
	}
	_ = baseRepo.Create(ctx, nonAdminRole)

	t.Run("Valid login and token verification", func(t *testing.T) {
		token, admin, err := authSvc.Login(ctx, "camp_leader", "secret123")
		if err != nil {
			t.Fatalf("expected login to succeed, got %v", err)
		}
		if token == "" {
			t.Errorf("expected non-empty JWT token")
		}
		if admin.Username != "camp_leader" {
			t.Errorf("expected username camp_leader, got %s", admin.Username)
		}

		claims, err := authSvc.VerifyToken(ctx, token)
		if err != nil {
			t.Fatalf("failed to verify token: %v", err)
		}
		if claims.Username != "camp_leader" || claims.Role != domain.RoleAdmin || claims.TokenID == "" {
			t.Errorf("unexpected claims: %+v", claims)
		}
	})

	t.Run("Uniform ErrInvalidCredentials prevents enumeration", func(t *testing.T) {
		cases := []struct {
			name     string
			username string
			password string
		}{
			{"wrong password", "camp_leader", "wrong_password"},
			{"unknown user", "nobody", "secret123"},
			{"inactive user", "inactive_admin", "secret123"},
			{"non-admin role", "staff_user", "secret123"},
			{"empty username", "", "secret123"},
			{"empty password", "camp_leader", ""},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				_, _, err := authSvc.Login(ctx, tc.username, tc.password)
				if !errors.Is(err, service.ErrInvalidCredentials) {
					t.Fatalf("expected ErrInvalidCredentials, got %v", err)
				}
			})
		}
	})

	t.Run("Logout revokes token immediately", func(t *testing.T) {
		token, _, err := authSvc.Login(ctx, "camp_leader", "secret123")
		if err != nil {
			t.Fatalf("login failed: %v", err)
		}
		claims, err := authSvc.VerifyToken(ctx, token)
		if err != nil {
			t.Fatalf("verify before logout failed: %v", err)
		}

		authSvc.Logout(claims)

		if _, err := authSvc.VerifyToken(ctx, token); !errors.Is(err, service.ErrTokenRevoked) {
			t.Fatalf("expected ErrTokenRevoked after Logout, got %v", err)
		}
	})

	t.Run("DB re-check rejects deactivated admin and changed role", func(t *testing.T) {
		token, _, err := authSvc.Login(ctx, "camp_leader", "secret123")
		if err != nil {
			t.Fatalf("login failed: %v", err)
		}

		// Deactivate admin in DB after token issuance
		adminRepo.overrideActive[activeAdmin.ID] = false
		if _, err := authSvc.VerifyToken(ctx, token); !errors.Is(err, service.ErrAccountInactive) {
			t.Fatalf("expected ErrAccountInactive for deactivated admin, got %v", err)
		}
		delete(adminRepo.overrideActive, activeAdmin.ID)

		// Demote role in DB after token issuance
		adminRepo.overrideRole[activeAdmin.ID] = domain.AdminRole("staff")
		if _, err := authSvc.VerifyToken(ctx, token); !errors.Is(err, service.ErrAccountInactive) {
			t.Fatalf("expected ErrAccountInactive for role mismatch, got %v", err)
		}
		delete(adminRepo.overrideRole, activeAdmin.ID)
	})

	t.Run("HS256 pinning, Issuer, exp, and jti checks", func(t *testing.T) {
		now := time.Now().UTC()
		makeToken := func(method jwt.SigningMethod, key any, issuer, jti string, exp *jwt.NumericDate) string {
			claims := jwt.MapClaims{
				"adminId":  activeAdmin.ID,
				"username": activeAdmin.Username,
				"role":     string(domain.RoleAdmin),
				"iat":      now.Unix(),
			}
			if issuer != "" {
				claims["iss"] = issuer
			}
			if jti != "" {
				claims["jti"] = jti
			}
			if exp != nil {
				claims["exp"] = exp.Unix()
			}
			tok := jwt.NewWithClaims(method, claims)
			signed, err := tok.SignedString(key)
			if err != nil {
				t.Fatalf("failed to sign test token: %v", err)
			}
			return signed
		}

		// alg=none rejected
		noneTok := makeToken(jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, "comcamp25-api", "jti-1", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, noneTok); err == nil {
			t.Errorf("expected alg=none token to be rejected")
		}

		// alg=HS512 rejected (only HS256 pinned)
		hs512Tok := makeToken(jwt.SigningMethodHS512, []byte(secret), "comcamp25-api", "jti-2", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, hs512Tok); err == nil {
			t.Errorf("expected HS512 token to be rejected")
		}

		// alg=RS256 rejected
		privKey, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatalf("rsa keygen failed: %v", err)
		}
		rs256Tok := makeToken(jwt.SigningMethodRS256, privKey, "comcamp25-api", "jti-3", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, rs256Tok); err == nil {
			t.Errorf("expected RS256 token to be rejected")
		}

		// wrong issuer rejected
		badIssTok := makeToken(jwt.SigningMethodHS256, []byte(secret), "other-issuer", "jti-4", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, badIssTok); err == nil {
			t.Errorf("expected wrong issuer token to be rejected")
		}

		// missing issuer rejected
		noIssTok := makeToken(jwt.SigningMethodHS256, []byte(secret), "", "jti-5", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, noIssTok); err == nil {
			t.Errorf("expected missing issuer token to be rejected")
		}

		// missing exp rejected
		noExpTok := makeToken(jwt.SigningMethodHS256, []byte(secret), "comcamp25-api", "jti-6", nil)
		if _, err := authSvc.VerifyToken(ctx, noExpTok); err == nil {
			t.Errorf("expected token without exp to be rejected")
		}

		// missing jti rejected
		noJTITok := makeToken(jwt.SigningMethodHS256, []byte(secret), "comcamp25-api", "", jwt.NewNumericDate(now.Add(time.Hour)))
		if _, err := authSvc.VerifyToken(ctx, noJTITok); err == nil {
			t.Errorf("expected token without jti to be rejected")
		}
	})
}
