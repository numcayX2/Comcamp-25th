package middleware

import (
	"context"
	"net/http"
	"strings"

	"comcamp25-backend/internal/domain"
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

// RequireRoles lets the request through only when the authenticated admin's role is one of
// allowed. Mount it after RequireAuth, which re-reads the role from the database on every request,
// so a demoted account loses access at once rather than when its token expires. Without claims
// (RequireAuth missing) it fails closed with 401; a role outside allowed, or a role this build
// does not know, gets 403 FORBIDDEN. The frontend hides what a role cannot do, but this is the
// only check that counts.
func RequireRoles(allowed ...domain.AdminRole) func(http.Handler) http.Handler {
	set := make(map[domain.AdminRole]bool, len(allowed))
	for _, role := range allowed {
		set[role] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := GetAdminClaims(r.Context())
			if claims == nil {
				response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "authentication required")
				return
			}
			if !set[claims.Role] {
				response.ErrorCode(w, http.StatusForbidden, response.CodeForbidden, "your admin role is not allowed to perform this action")
				return
			}
			next.ServeHTTP(w, r)
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
