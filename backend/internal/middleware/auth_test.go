package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

func TestRequireRoles(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	guarded := RequireRoles(domain.RoleAdmin)(ok)

	serve := func(claims *service.AdminClaims) int {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/x", nil)
		if claims != nil {
			req = req.WithContext(context.WithValue(req.Context(), AdminContextKey, claims))
		}
		rec := httptest.NewRecorder()
		guarded.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := serve(nil); code != http.StatusUnauthorized {
		t.Fatalf("no claims (RequireAuth missing) must fail closed with 401, got %d", code)
	}
	for role, want := range map[domain.AdminRole]int{
		domain.RoleAdmin:               http.StatusOK,
		domain.AdminRole("superadmin"): http.StatusForbidden,
		domain.AdminRole("staff"):      http.StatusForbidden,
		domain.AdminRole(""):           http.StatusForbidden,
		domain.AdminRole("root"):       http.StatusForbidden,
	} {
		if code := serve(&service.AdminClaims{AdminID: 1, Role: role}); code != want {
			t.Errorf("role %q: expected %d, got %d", role, want, code)
		}
	}

	if code := func() int {
		rec := httptest.NewRecorder()
		RequireRoles()(ok).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil).WithContext(
			context.WithValue(context.Background(), AdminContextKey, &service.AdminClaims{Role: domain.RoleAdmin})))
		return rec.Code
	}(); code != http.StatusForbidden {
		t.Fatalf("an empty allow-list must allow nobody, got %d", code)
	}
}
