package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"comcamp25-backend/internal/domain"
)

const (
	jwtIssuer = "comcamp25-api"
	tokenTTL  = 24 * time.Hour
)

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrTokenRevoked       = errors.New("token has been revoked")
	ErrAccountInactive    = errors.New("admin account is inactive")

	// Precomputed dummy bcrypt hash used to equalize login timing when a username does not exist.
	dummyPasswordHash []byte
)

func init() {
	hash, err := bcrypt.GenerateFromPassword([]byte("comcamp25-constant-time-dummy-secret"), bcrypt.DefaultCost)
	if err == nil {
		dummyPasswordHash = hash
	}
}

type jwtAdminClaims struct {
	AdminID  int64            `json:"adminId"`
	Username string           `json:"username"`
	Role     domain.AdminRole `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	adminRepo domain.AdminRepository
	jwtSecret []byte

	revokedMu sync.RWMutex
	revoked   map[string]time.Time
}

func NewAuthService(adminRepo domain.AdminRepository, jwtSecret string) *AuthService {
	return &AuthService{
		adminRepo: adminRepo,
		jwtSecret: []byte(jwtSecret),
		revoked:   make(map[string]time.Time),
	}
}

func (s *AuthService) Login(ctx context.Context, username, password string) (string, *domain.Admin, error) {
	username = strings.TrimSpace(username)

	var (
		admin *domain.Admin
		err   error
	)
	if username != "" {
		admin, err = s.adminRepo.GetByUsername(ctx, username)
		if err != nil && !errors.Is(err, domain.ErrAdminNotFound) {
			return "", nil, fmt.Errorf("failed to fetch admin: %w", err)
		}
	}

	targetHash := dummyPasswordHash
	if admin != nil && admin.PasswordHash != "" {
		targetHash = []byte(admin.PasswordHash)
	}

	// Always execute bcrypt comparison before checking IsActive to prevent username & status enumeration.
	cmpErr := bcrypt.CompareHashAndPassword(targetHash, []byte(password))
	if username == "" || password == "" || admin == nil || cmpErr != nil || !admin.IsActive || !admin.Role.IsValid() {
		return "", nil, ErrInvalidCredentials
	}

	_ = s.adminRepo.UpdateLastLogin(ctx, admin.ID)

	now := time.Now().UTC()
	exp := now.Add(tokenTTL)
	jti := uuid.NewString()

	claims := jwtAdminClaims{
		AdminID:  admin.ID,
		Username: admin.Username,
		Role:     admin.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        jti,
			Issuer:    jwtIssuer,
			Subject:   fmt.Sprintf("%d", admin.ID),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(s.jwtSecret)
	if err != nil {
		return "", nil, fmt.Errorf("failed to sign jwt: %w", err)
	}

	return tokenString, admin, nil
}

// VerifyToken validates JWT signature (HS256), issuer, expiration, revocation status,
// and ensures the admin account is still active with a valid admin role.
func (s *AuthService) VerifyToken(ctx context.Context, tokenString string) (*domain.AdminClaims, error) {
	if strings.TrimSpace(tokenString) == "" {
		return nil, errors.New("empty token")
	}

	token, err := jwt.ParseWithClaims(
		tokenString,
		&jwtAdminClaims{},
		func(t *jwt.Token) (any, error) {
			if t.Method == nil || t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return s.jwtSecret, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(jwtIssuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}

	claims, ok := token.Claims.(*jwtAdminClaims)
	if !ok || !token.Valid || claims.ID == "" || claims.AdminID <= 0 {
		return nil, errors.New("invalid token claims")
	}

	if s.isRevoked(claims.ID) {
		return nil, ErrTokenRevoked
	}

	admin, err := s.adminRepo.GetByID(ctx, claims.AdminID)
	if err != nil {
		return nil, ErrInvalidCredentials
	}
	if !admin.IsActive || !admin.Role.IsValid() || claims.Role != admin.Role {
		return nil, ErrAccountInactive
	}

	var expiresAt time.Time
	if claims.ExpiresAt != nil {
		expiresAt = claims.ExpiresAt.Time
	}

	return &domain.AdminClaims{
		AdminID:   admin.ID,
		Username:  admin.Username,
		Role:      admin.Role,
		TokenID:   claims.ID,
		ExpiresAt: expiresAt,
	}, nil
}

// Logout revokes the token associated with the provided admin claims until its expiration.
func (s *AuthService) Logout(claims *domain.AdminClaims) {
	if claims == nil || claims.TokenID == "" {
		return
	}
	s.RevokeToken(claims.TokenID, claims.ExpiresAt)
}

// RevokeToken adds a token's jti to the revocation map and prunes expired entries.
func (s *AuthService) RevokeToken(jti string, expiresAt time.Time) {
	if strings.TrimSpace(jti) == "" {
		return
	}
	now := time.Now().UTC()
	if expiresAt.IsZero() {
		expiresAt = now.Add(tokenTTL)
	}

	s.revokedMu.Lock()
	defer s.revokedMu.Unlock()

	for id, exp := range s.revoked {
		if now.After(exp) {
			delete(s.revoked, id)
		}
	}
	s.revoked[jti] = expiresAt
}

func (s *AuthService) isRevoked(jti string) bool {
	now := time.Now().UTC()

	s.revokedMu.RLock()
	exp, exists := s.revoked[jti]
	s.revokedMu.RUnlock()

	if !exists {
		return false
	}
	if now.After(exp) {
		s.revokedMu.Lock()
		if currentExp, ok := s.revoked[jti]; ok && now.After(currentExp) {
			delete(s.revoked, jti)
		}
		s.revokedMu.Unlock()
		return false
	}
	return true
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}
