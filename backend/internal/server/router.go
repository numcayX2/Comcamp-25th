// Package server wires handlers and middleware into the HTTP router. main and the end-to-end
// tests both use NewRouter, so tests exercise the real security middleware chain.
package server

import (
	"net/http"
	"net/netip"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/service"
)

// Admin permissions (AGENTS.md §13.2). Every /api/admin/* route explicitly requires RoleAdmin;
// there is no route that an unauthenticated or unknown-role token can reach by default.
var (
	rolesAnyAdmin = []domain.AdminRole{domain.RoleAdmin}
	rolesPayments = []domain.AdminRole{domain.RoleAdmin}
	rolesEditors  = []domain.AdminRole{domain.RoleAdmin}
	rolesSuper    = []domain.AdminRole{domain.RoleAdmin}
)

// RateLimits are per client IP. They are generous enough for a school computer lab or a mobile
// carrier NAT sharing one address, and tight enough to stop brute force and enumeration.
type RateLimits struct {
	Login       *middleware.RateLimiter
	StatusQuery *middleware.RateLimiter
	Submit      *middleware.RateLimiter

	// The public mutations each count on their own: behind one school or carrier NAT, a class
	// uploading slips or editing profiles must not use up the allowance of classmates confirming
	// attendance or withdrawing.
	Slip     *middleware.RateLimiter
	Confirm  *middleware.RateLimiter
	Withdraw *middleware.RateLimiter
	Profile  *middleware.RateLimiter
}

func DefaultRateLimits() RateLimits {
	return RateLimits{
		Login:       middleware.NewRateLimiter(10, 5*time.Minute),
		StatusQuery: middleware.NewRateLimiter(60, time.Minute),
		// Registration is the one endpoint a bot wants; 8/min per IP still fits a school NAT.
		Submit:   middleware.NewRateLimiter(8, time.Minute),
		Slip:     middleware.NewRateLimiter(20, time.Minute),
		Confirm:  middleware.NewRateLimiter(20, time.Minute),
		Withdraw: middleware.NewRateLimiter(20, time.Minute),
		Profile:  middleware.NewRateLimiter(20, time.Minute),
	}
}

type Options struct {
	AllowedOrigins []string
	TrustedProxies []netip.Prefix
	EnableSwagger  bool
	OpenAPISpec    []byte
	RateLimits     RateLimits
}

type Services struct {
	Auth      *service.AuthService
	Applicant *service.ApplicantService
	Setting   *service.SettingService
	Payment   *service.PaymentService
}

func NewRouter(svc Services, opt Options) http.Handler {
	healthHandler := handler.NewHealthHandler("comcamp25-backend")
	authHandler := handler.NewAuthHandler(svc.Auth)
	appHandler := handler.NewApplicantHandler(svc.Applicant)
	settingHandler := handler.NewSettingHandler(svc.Setting)
	paymentHandler := handler.NewPaymentHandler(svc.Payment)
	swaggerHandler := handler.NewSwaggerHandler(opt.OpenAPISpec)
	limits := opt.RateLimits

	r := chi.NewRouter()
	r.Use(chimiddleware.RequestID)
	r.Use(middleware.ClientIP(opt.TrustedProxies))
	r.Use(middleware.AccessLog)
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(60 * time.Second))
	r.Use(middleware.NewCORS(opt.AllowedOrigins))

	// Interactive API docs: development only unless ENABLE_SWAGGER=true.
	if opt.EnableSwagger {
		r.Get("/swagger", swaggerHandler.ServeUI)
		r.Get("/docs", swaggerHandler.ServeUI)
	}

	// Note: there is deliberately no public /uploads file server. Slips are personal financial
	// documents and are only served through GET /api/admin/applications/{id}/slip.

	r.Route("/api", func(api chi.Router) {
		api.Use(middleware.APIHeaders)

		// Slip upload carries its own 5 MB cap; everything else is small JSON.
		api.With(limits.Slip.Middleware).Post("/applications/{id}/slip", paymentHandler.UploadSlip)

		api.Group(func(json chi.Router) {
			json.Use(middleware.LimitBody(middleware.MaxJSONBodyBytes))

			json.Get("/health", healthHandler.Check)
			if opt.EnableSwagger {
				json.Get("/docs/openapi.json", swaggerHandler.ServeSpec)
			}

			json.Get("/settings/public", settingHandler.GetPublic)

			json.With(limits.Submit.Middleware).Post("/applications", appHandler.Submit)
			json.With(limits.StatusQuery.Middleware).Get("/applications/status", appHandler.GetStatus)
			json.With(limits.Confirm.Middleware).Post("/applications/{id}/confirm", appHandler.ConfirmAttendance)
			json.With(limits.Withdraw.Middleware).Post("/applications/{id}/withdraw", appHandler.Withdraw)
			json.With(limits.Profile.Middleware).Patch("/applications/{id}/profile", appHandler.UpdateOwnProfile)

			json.With(limits.Login.Middleware).Post("/auth/login", authHandler.Login)

			json.Group(func(admin chi.Router) {
				admin.Use(middleware.RequireAuth(svc.Auth))
				anyAdmin := middleware.RequireRoles(rolesAnyAdmin...)
				payments := middleware.RequireRoles(rolesPayments...)
				editors := middleware.RequireRoles(rolesEditors...)
				super := middleware.RequireRoles(rolesSuper...)

				admin.With(anyAdmin).Get("/admin/applications", appHandler.AdminList)
				admin.With(editors).Post("/admin/applications/export-audit", appHandler.AdminExportAudit)
				admin.With(editors).Patch("/admin/applications/{id}", appHandler.AdminUpdateStatus)
				admin.With(editors).Patch("/admin/applications/{id}/profile", appHandler.AdminUpdateProfile)
				admin.With(super).Delete("/admin/applications/{id}", appHandler.AdminDelete)
				admin.With(payments).Get("/admin/applications/{id}/slip", paymentHandler.GetSlip)
				admin.With(payments).Patch("/admin/applications/{id}/verify-slip", paymentHandler.VerifySlip)
				admin.With(anyAdmin).Get("/admin/settings", settingHandler.GetAdmin)
				admin.With(super).Patch("/admin/settings", settingHandler.UpdateAdmin)
			})
		})
	})

	return r
}
