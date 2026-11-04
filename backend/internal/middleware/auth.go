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

func RequireAuth(authService *service.AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				response.Error(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
				response.Error(w, http.StatusUnauthorized, "invalid authorization format (expected Bearer <token>)")
				return
			}

			claims, err := authService.VerifyToken(parts[1])
			if err != nil {
				response.Error(w, http.StatusUnauthorized, "invalid or expired token")
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
