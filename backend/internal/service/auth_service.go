package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"comcamp25-backend/internal/domain"
)

var (
	// ErrInvalidCredentials is returned for every failed login — unknown user, wrong password or
	// deactivated account — so the response never reveals which usernames exist.
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrAccountInactive    = errors.New("admin account is inactive")
	// ErrTokenStale is a token issued before the account was last changed (password reset, role
	// change or re-activation, which all bump admins.updated_at).
	ErrTokenStale = errors.New("token was issued before the account was last updated")
)

const (
	jwtIssuer = "comcamp25-backend"
	// TokenTTL is one staff shift; shorter tokens limit the damage of a leaked token.
	TokenTTL = 8 * time.Hour
	// PasswordHashCost is above the AGENTS.md §13.2 minimum of 10.
	PasswordHashCost = 12
)

type AdminClaims struct {
	AdminID  int64            `json:"adminId"`
	Username string           `json:"username"`
	Role     domain.AdminRole `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	adminRepo domain.AdminRepository
	auditRepo domain.AuditRepository
	jwtSecret []byte
}

// NewAuthService builds the admin auth service. auditRepo may be nil (no login auditing).
func NewAuthService(adminRepo domain.AdminRepository, auditRepo domain.AuditRepository, jwtSecret string) *AuthService {
	return &AuthService{
		adminRepo: adminRepo,
		auditRepo: auditRepo,
		jwtSecret: []byte(jwtSecret),
	}
}

var (
	dummyHashOnce sync.Once
	dummyHash     []byte
)

// equalizeTiming spends the same bcrypt work as a real password check, so response time does
// not reveal whether a username exists.
func equalizeTiming(password string) {
	dummyHashOnce.Do(func() {
		dummyHash, _ = bcrypt.GenerateFromPassword([]byte("comcamp25-timing-equalizer"), PasswordHashCost)
	})
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
}

func (s *AuthService) Login(ctx context.Context, username, password, ip string) (string, *domain.Admin, error) {
	admin, err := s.adminRepo.GetByUsername(ctx, username)
	if err != nil {
		if !errors.Is(err, domain.ErrNotFound) {
			return "", nil, fmt.Errorf("load admin: %w", err)
		}
		equalizeTiming(password)
		s.audit(ctx, nil, domain.AuditLoginFailure, username, ip, "unknown_user")
		return "", nil, ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(password)); err != nil {
		s.audit(ctx, &admin.ID, domain.AuditLoginFailure, username, ip, "bad_password")
		return "", nil, ErrInvalidCredentials
	}

	// Checked only after the password, and reported as a generic failure.
	if !admin.IsActive {
		s.audit(ctx, &admin.ID, domain.AuditLoginFailure, username, ip, "inactive")
		return "", nil, ErrInvalidCredentials
	}

	_ = s.adminRepo.UpdateLastLogin(ctx, admin.ID)

	now := time.Now()
	claims := AdminClaims{
		AdminID:  admin.ID,
		Username: admin.Username,
		Role:     admin.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(TokenTTL)),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			Issuer:    jwtIssuer,
		},
	}

	tokenString, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.jwtSecret)
	if err != nil {
		return "", nil, fmt.Errorf("failed to sign jwt: %w", err)
	}

	s.audit(ctx, &admin.ID, domain.AuditLoginSuccess, username, ip, "")
	return tokenString, admin, nil
}

func (s *AuthService) audit(ctx context.Context, adminID *int64, action domain.AuditAction, username, ip, reason string) {
	if s.auditRepo == nil {
		return
	}
	if len(username) > 50 {
		username = username[:50]
	}
	details := map[string]any{"username": username}
	if reason != "" {
		details["reason"] = reason
	}
	entry := &domain.AuditEntry{
		AdminID:    adminID,
		Action:     action,
		TargetType: domain.AuditTargetAdmin,
		TargetID:   username,
		Details:    details,
		IPAddress:  ip,
	}
	if err := s.auditRepo.Log(ctx, entry); err != nil {
		log.Printf("audit log write failed (%s): %v", action, err)
	}
}

// VerifyToken checks signature, algorithm, issuer and expiry only. Use Authenticate for requests.
func (s *AuthService) VerifyToken(tokenString string) (*AdminClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &AdminClaims{}, func(t *jwt.Token) (any, error) {
		return s.jwtSecret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(jwtIssuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*AdminClaims); ok && token.Valid {
		return claims, nil
	}
	return nil, errors.New("invalid token")
}

// Authenticate verifies the token and then re-loads the admin, rejecting deactivated accounts and
// tokens issued before the account was last updated, and taking the current role from the
// database rather than from the (possibly stale) token.
func (s *AuthService) Authenticate(ctx context.Context, tokenString string) (*AdminClaims, error) {
	claims, err := s.VerifyToken(tokenString)
	if err != nil {
		return nil, err
	}
	admin, err := s.adminRepo.GetByID(ctx, claims.AdminID)
	if err != nil {
		return nil, err
	}
	if !admin.IsActive {
		return nil, ErrAccountInactive
	}
	// A password reset (or any other change to the account) ends every session started before it.
	// iat has whole-second precision and updated_at does not, so updated_at is truncated to the
	// second: a login in the same second as the change still works. UpdateLastLogin does not touch
	// updated_at, so logging in again does not end the other sessions.
	if claims.IssuedAt == nil || claims.IssuedAt.Time.Before(admin.UpdatedAt.Truncate(time.Second)) {
		return nil, ErrTokenStale
	}
	claims.Username = admin.Username
	claims.Role = admin.Role
	return claims, nil
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), PasswordHashCost)
	return string(hash), err
}
