package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

// setupUnlimitedApp lifts the per-IP limits: the RBAC matrix registers, uploads and logs in far
// more often from one test IP than production allows.
func setupUnlimitedApp(t *testing.T) *testApp {
	t.Helper()
	limits := server.DefaultRateLimits()
	limits.Submit = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Slip = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Confirm = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Withdraw = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Profile = middleware.NewRateLimiter(10_000, time.Minute)
	limits.Login = middleware.NewRateLimiter(10_000, time.Minute)
	return setupTestAppWith(t, limits)
}

const rbacPassword = "rbac-test-password-only"

// loginAs creates an active admin with the given role and logs in through the API. It checks that
// the login response reports the role (a UI hint for the dashboard).
func (a *testApp) loginAs(t *testing.T, username string, role domain.AdminRole) (token string, adminID int64) {
	t.Helper()
	hash, err := service.HashPassword(rbacPassword)
	if err != nil {
		t.Fatal(err)
	}
	adm := &domain.Admin{Username: username, PasswordHash: hash, FullName: username, Role: role, IsActive: true}
	if err := a.adminRepo.Create(context.Background(), adm); err != nil {
		t.Fatalf("create admin %s: %v", username, err)
	}
	body := fmt.Sprintf(`{"username":%q,"password":%q}`, username, rbacPassword)
	rec := a.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(body), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login %s: expected 200, got %d (%s)", username, rec.Code, rec.Body.String())
	}
	var res struct {
		Token string `json:"token"`
		Role  string `json:"role"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Token == "" {
		t.Fatalf("login %s: empty token", username)
	}
	if res.Role != string(role) {
		t.Fatalf("login %s: expected role %q in the response, got %q", username, role, res.Role)
	}
	return res.Token, adm.ID
}

func (a *testApp) applicant(t *testing.T, id string) (*domain.Applicant, error) {
	t.Helper()
	return a.appRepo.GetByApplicationNo(context.Background(), id)
}

func roleIn(r domain.AdminRole, set []domain.AdminRole) bool {
	for _, x := range set {
		if x == r {
			return true
		}
	}
	return false
}

// Every /api/admin/* route against every role: allowed roles get 200 and the change happens,
// everyone else gets 403 FORBIDDEN and nothing changes.
func TestRBAC_EveryAdminRouteForEveryRole(t *testing.T) {
	app := setupUnlimitedApp(t)
	ctx := context.Background()

	tokens := map[domain.AdminRole]string{}
	for _, role := range domain.AllAdminRoles {
		tokens[role], _ = app.loginAs(t, "rbac-"+string(role), role)
	}

	all := domain.AllAdminRoles
	payments := []domain.AdminRole{domain.RoleSuperadmin, domain.RoleFinance, domain.RoleStaff}
	editors := []domain.AdminRole{domain.RoleSuperadmin, domain.RoleStaff}
	super := []domain.AdminRole{domain.RoleSuperadmin}

	seq := 0
	newApplication := func(t *testing.T) string {
		t.Helper()
		seq++
		created := app.submit(t, validTestNationalID(70_000+seq), fmt.Sprintf("08%08d", 70_000+seq), fmt.Sprintf("rbac%d@example.com", seq))
		return created.ID
	}
	newApplicationWithSlip := func(t *testing.T) string {
		t.Helper()
		id := newApplication(t)
		if rec := app.uploadSlip(t, id, "slip.jpg", uniqueSlip(seq)); rec.Code != http.StatusOK {
			t.Fatalf("seed slip: expected 200, got %d (%s)", rec.Code, rec.Body.String())
		}
		return id
	}
	status := func(t *testing.T, id string) domain.ApplicationStatus {
		t.Helper()
		a, err := app.applicant(t, id)
		if err != nil {
			t.Fatalf("load %s: %v", id, err)
		}
		return a.Status
	}

	routes := []struct {
		name    string
		allowed []domain.AdminRole
		// setup returns the fixture the call works on (an application ID, or a settings marker).
		setup func(t *testing.T) string
		call  func(t *testing.T, token, fixture string) *httptest.ResponseRecorder
		// changed reports whether the call took effect; nil for read-only routes.
		changed func(t *testing.T, fixture string) bool
	}{
		{
			name: "GET /api/admin/applications", allowed: all,
			call: func(t *testing.T, token, _ string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
			},
		},
		{
			name: "GET /api/admin/settings", allowed: all,
			call: func(t *testing.T, token, _ string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodGet, "/api/admin/settings", nil, bearer(token))
			},
		},
		{
			name: "GET /api/admin/applications/{id}/slip", allowed: payments, setup: newApplicationWithSlip,
			call: func(t *testing.T, token, id string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodGet, service.AdminSlipPath(id), nil, bearer(token))
			},
		},
		{
			name: "PATCH /api/admin/applications/{id}/verify-slip", allowed: payments, setup: newApplicationWithSlip,
			call: func(t *testing.T, token, id string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodPatch, "/api/admin/applications/"+id+"/verify-slip",
					bytes.NewBufferString(`{"approved":true,"note":"rbac"}`), bearer(token))
			},
			changed: func(t *testing.T, id string) bool { return status(t, id) == domain.StatusConfirmed },
		},
		{
			name: "PATCH /api/admin/applications/{id}", allowed: editors, setup: newApplication,
			call: func(t *testing.T, token, id string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodPatch, "/api/admin/applications/"+id,
					bytes.NewBufferString(`{"status":"REJECTED","reason":"rbac"}`), bearer(token))
			},
			changed: func(t *testing.T, id string) bool { return status(t, id) == domain.StatusRejected },
		},
		{
			name: "PATCH /api/admin/applications/{id}/profile", allowed: editors, setup: newApplication,
			call: func(t *testing.T, token, id string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodPatch, "/api/admin/applications/"+id+"/profile",
					bytes.NewBufferString(`{"nickname":"อาร์บี","reason":"rbac"}`), bearer(token))
			},
			changed: func(t *testing.T, id string) bool {
				a, err := app.applicant(t, id)
				if err != nil {
					t.Fatalf("load %s: %v", id, err)
				}
				return a.Nickname == "อาร์บี"
			},
		},
		{
			name: "DELETE /api/admin/applications/{id}", allowed: super, setup: newApplication,
			call: func(t *testing.T, token, id string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodDelete, "/api/admin/applications/"+id,
					bytes.NewBufferString(`{"reason":"rbac"}`), bearer(token))
			},
			changed: func(t *testing.T, id string) bool {
				_, err := app.applicant(t, id)
				return err != nil
			},
		},
		{
			name: "PATCH /api/admin/settings", allowed: super,
			setup: func(t *testing.T) string { seq++; return fmt.Sprintf("ComCamp #25 RBAC %d", seq) },
			call: func(t *testing.T, token, marker string) *httptest.ResponseRecorder {
				return app.do(t, http.MethodPatch, "/api/admin/settings",
					bytes.NewBufferString(fmt.Sprintf(`{"campName":%q}`, marker)), bearer(token))
			},
			changed: func(t *testing.T, marker string) bool {
				s, err := app.setRepo.Get(ctx)
				if err != nil {
					t.Fatal(err)
				}
				return s.CampName == marker
			},
		},
	}

	for _, rt := range routes {
		for _, role := range domain.AllAdminRoles {
			allowed := roleIn(role, rt.allowed)
			t.Run(fmt.Sprintf("%s as %s", rt.name, role), func(t *testing.T) {
				fixture := ""
				if rt.setup != nil {
					fixture = rt.setup(t)
				}
				rec := rt.call(t, tokens[role], fixture)
				if allowed {
					if rec.Code != http.StatusOK {
						t.Fatalf("%s is allowed: expected 200, got %d (%s)", role, rec.Code, rec.Body.String())
					}
					if rt.changed != nil && !rt.changed(t, fixture) {
						t.Fatalf("%s got 200 but the change did not happen", role)
					}
					return
				}
				if rec.Code != http.StatusForbidden {
					t.Fatalf("%s is not allowed: expected 403, got %d (%s)", role, rec.Code, rec.Body.String())
				}
				if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeForbidden {
					t.Fatalf("expected code %s, got %q", response.CodeForbidden, e.Code)
				}
				if rt.changed != nil && rt.changed(t, fixture) {
					t.Fatalf("%s was refused with 403 but the change happened anyway", role)
				}
			})
		}
	}
}

// The role is re-read from the database on every request, so demoting an account takes effect on
// its very next request, with the same token.
func TestRBAC_DemotionTakesEffectImmediately(t *testing.T) {
	app := setupUnlimitedApp(t)
	token, id := app.loginAs(t, "rbac-demoted", domain.RoleSuperadmin)
	patch := func() int {
		return app.do(t, http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(`{"campName":"ComCamp #25"}`), bearer(token)).Code
	}

	if code := patch(); code != http.StatusOK {
		t.Fatalf("superadmin: expected 200, got %d", code)
	}
	if err := app.adminRepo.SetRole(id, domain.RoleReviewer); err != nil {
		t.Fatal(err)
	}
	if code := patch(); code != http.StatusForbidden {
		t.Fatalf("after demotion to reviewer the old token must get 403, got %d", code)
	}
	if code := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token)).Code; code != http.StatusOK {
		t.Fatalf("a reviewer can still read the list, got %d", code)
	}
	if err := app.adminRepo.SetRole(id, domain.RoleSuperadmin); err != nil {
		t.Fatal(err)
	}
	if code := patch(); code != http.StatusOK {
		t.Fatalf("after promotion back: expected 200, got %d", code)
	}
}

// A role this build does not know (a typo in the database, a future role) gets nothing, not even
// the read-only routes: access is an allow-list.
func TestRBAC_UnknownRoleIsDeniedEverywhere(t *testing.T) {
	app := setupUnlimitedApp(t)
	token, _ := app.loginAs(t, "rbac-intern", domain.AdminRole("intern"))
	for _, rt := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/applications"},
		{http.MethodGet, "/api/admin/settings"},
		{http.MethodPatch, "/api/admin/settings"},
		{http.MethodGet, "/api/admin/applications/CC25-000000/slip"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000/profile"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000/verify-slip"},
		{http.MethodDelete, "/api/admin/applications/CC25-000000"},
	} {
		rec := app.do(t, rt.method, rt.path, bytes.NewBufferString(`{}`), bearer(token))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s with an unknown role: expected 403, got %d", rt.method, rt.path, rec.Code)
		}
	}
}

// Without a token every admin route is still 401 (RequireAuth runs before RequireRoles).
func TestRBAC_NoTokenIs401OnEveryAdminRoute(t *testing.T) {
	app := setupTestApp(t)
	for _, rt := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/applications"},
		{http.MethodGet, "/api/admin/settings"},
		{http.MethodPatch, "/api/admin/settings"},
		{http.MethodGet, "/api/admin/applications/CC25-000000/slip"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000/profile"},
		{http.MethodPatch, "/api/admin/applications/CC25-000000/verify-slip"},
		{http.MethodDelete, "/api/admin/applications/CC25-000000"},
	} {
		if rec := app.do(t, rt.method, rt.path, nil, nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without a token: expected 401, got %d", rt.method, rt.path, rec.Code)
		}
	}
}
