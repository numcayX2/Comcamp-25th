package middleware

import (
	"context"
	"net/http"
	"strings"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
)

type contextKey string

const AdminContextKey contextKey = "admin_claims"

type AdminClaims = domain.AdminClaims

// TokenVerifier verifies a bearer token and ensures the admin is still active and not revoked.
type TokenVerifier interface {
	VerifyToken(ctx context.Context, tokenString string) (*AdminClaims, error)
}

func RequireAuth(verifier TokenVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if verifier == nil {
				response.Error(w, http.StatusInternalServerError, "authentication service unavailable")
				return
			}

			authHeader := r.Header.Get("Authorization")
			if strings.TrimSpace(authHeader) == "" {
				response.Error(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				response.Error(w, http.StatusUnauthorized, "invalid authorization format (expected Bearer <token>)")
				return
			}

			token := strings.TrimSpace(parts[1])
			if token == "" {
				response.Error(w, http.StatusUnauthorized, "missing bearer token")
				return
			}

			claims, err := verifier.VerifyToken(r.Context(), token)
			if err != nil || claims == nil {
				response.Error(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}

			if claims.Role != domain.RoleAdmin {
				response.Error(w, http.StatusForbidden, "insufficient permissions")
				return
			}

			ctx := WithAdminClaims(r.Context(), claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func WithAdminClaims(ctx context.Context, claims *AdminClaims) context.Context {
	return context.WithValue(ctx, AdminContextKey, claims)
}

func GetAdminClaims(ctx context.Context) *AdminClaims {
	claims, ok := ctx.Value(AdminContextKey).(*AdminClaims)
	if !ok {
		return nil
	}
	return claims
}
