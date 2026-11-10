// Package server wires handlers and middleware into the HTTP router. main and the end-to-end
// tests both use NewRouter, so tests exercise the real security middleware chain.
package server

import (
	"net/http"
	"net/netip"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/service"
)

// RateLimits are per client IP. They are generous enough for a school computer lab or a mobile
// carrier NAT sharing one address, and tight enough to stop brute force and enumeration.
type RateLimits struct {
	Login       *middleware.RateLimiter
	StatusQuery *middleware.RateLimiter
	Submit      *middleware.RateLimiter
	Mutations   *middleware.RateLimiter // public confirm + slip upload
}

func DefaultRateLimits() RateLimits {
	return RateLimits{
		Login:       middleware.NewRateLimiter(10, 5*time.Minute),
		StatusQuery: middleware.NewRateLimiter(60, time.Minute),
		Submit:      middleware.NewRateLimiter(20, time.Minute),
		Mutations:   middleware.NewRateLimiter(20, time.Minute),
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
		api.With(limits.Mutations.Middleware).Post("/applications/{id}/slip", paymentHandler.UploadSlip)

		api.Group(func(json chi.Router) {
			json.Use(middleware.LimitBody(middleware.MaxJSONBodyBytes))

			json.Get("/health", healthHandler.Check)
			if opt.EnableSwagger {
				json.Get("/docs/openapi.json", swaggerHandler.ServeSpec)
			}

			json.Get("/settings/public", settingHandler.GetPublic)

			json.With(limits.Submit.Middleware).Post("/applications", appHandler.Submit)
			json.With(limits.StatusQuery.Middleware).Get("/applications/status", appHandler.GetStatus)
			json.With(limits.Mutations.Middleware).Post("/applications/{id}/confirm", appHandler.ConfirmAttendance)

			json.With(limits.Login.Middleware).Post("/auth/login", authHandler.Login)

			json.Group(func(admin chi.Router) {
				admin.Use(middleware.RequireAuth(svc.Auth))
				admin.Get("/admin/applications", appHandler.AdminList)
				admin.Patch("/admin/applications/{id}", appHandler.AdminUpdateStatus)
				admin.Get("/admin/applications/{id}/slip", paymentHandler.GetSlip)
				admin.Patch("/admin/applications/{id}/verify-slip", paymentHandler.VerifySlip)
				admin.Get("/admin/settings", settingHandler.GetAdmin)
				admin.Patch("/admin/settings", settingHandler.UpdateAdmin)
			})
		})
	})

	return r
}
