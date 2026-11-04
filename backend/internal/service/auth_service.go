package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"comcamp25-backend/internal/domain"
)

var (
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrAccountInactive    = errors.New("admin account is inactive")
)

type AdminClaims struct {
	AdminID  int64            `json:"adminId"`
	Username string           `json:"username"`
	Role     domain.AdminRole `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	adminRepo domain.AdminRepository
	jwtSecret []byte
}

func NewAuthService(adminRepo domain.AdminRepository, jwtSecret string) *AuthService {
	return &AuthService{
		adminRepo: adminRepo,
		jwtSecret: []byte(jwtSecret),
	}
}

func (s *AuthService) Login(ctx context.Context, username, password string) (string, *domain.Admin, error) {
	admin, err := s.adminRepo.GetByUsername(ctx, username)
	if err != nil {
		return "", nil, ErrInvalidCredentials
	}

	if !admin.IsActive {
		return "", nil, ErrAccountInactive
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(password)); err != nil {
		return "", nil, ErrInvalidCredentials
	}

	_ = s.adminRepo.UpdateLastLogin(ctx, admin.ID)

	// Create JWT token (24 hour expiration)
	claims := AdminClaims{
		AdminID:  admin.ID,
		Username: admin.Username,
		Role:     admin.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "comcamp25-backend",
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString(s.jwtSecret)
	if err != nil {
		return "", nil, fmt.Errorf("failed to sign jwt: %w", err)
	}

	return tokenString, admin, nil
}

func (s *AuthService) VerifyToken(tokenString string) (*AdminClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &AdminClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*AdminClaims); ok && token.Valid {
		return claims, nil
	}
	return nil, errors.New("invalid token")
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}
