package middleware

import (
	"context"
	"net/http"
	"strings"

	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

type contextKey string

const AdminContextKey contextKey = "admin_claims"

// RequireAuth guards /api/admin/*. Besides checking the JWT signature and expiry it re-loads the
// admin on every request, so a deactivated account (is_active = false) loses access immediately
// instead of when its token expires (AGENTS.md §13.2).
func RequireAuth(authService *service.AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing authorization header")
				return
			}

			scheme, token, found := strings.Cut(authHeader, " ")
			if !found || !strings.EqualFold(scheme, "bearer") || strings.TrimSpace(token) == "" {
				response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "invalid authorization format (expected Bearer <token>)")
				return
			}

			claims, err := authService.Authenticate(r.Context(), strings.TrimSpace(token))
			if err != nil {
				response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "invalid or expired token")
				return
			}

			ctx := context.WithValue(r.Context(), AdminContextKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetAdminClaims(ctx context.Context) *service.AdminClaims {
	claims, ok := ctx.Value(AdminContextKey).(*service.AdminClaims)
	if !ok {
		return nil
	}
	return claims
}
