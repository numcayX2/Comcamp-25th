// Package server wires handlers and middleware into the HTTP router. main and the end-to-end
// tests both use NewRouter, so tests exercise the real security middleware chain.
package server

import (
	"context"
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

	// PublicList guards GET /api/applications/public (see PublicListRatePerMinute).
	PublicList *middleware.RateLimiter

	// SponsorsPublic guards GET /api/sponsors (see SponsorListRatePerMinute).
	SponsorsPublic *middleware.RateLimiter
	// SponsorLogo guards GET /api/sponsors/{id}/logo (see SponsorLogoRatePerMinute).
	SponsorLogo *middleware.RateLimiter
	// SponsorInquiry guards POST /api/sponsor-inquiries (see SponsorInquiryRatePer10Min).
	SponsorInquiry *middleware.RateLimiter
}

// PublicListRatePerMinute is the per-IP allowance for the public applicants list. The answer is
// cached and identical for everyone, so the limit only stops one client hammering the API: a
// page load costs one request (plus a manual retry), and 60/min still lets a whole classroom
// behind one school or carrier NAT open /applicants at the same moment, while capping a scraper
// at one request a second. It has its own bucket, separate from the status lookup.
const (
	PublicListRatePerMinute  = 60
	SponsorListRatePerMinute = 60
	SponsorLogoRatePerMinute = 300
	// SponsorInquiryRatePer10Min: a sponsor sends one inquiry; 5 per 10 minutes per IP leaves room
	// for a retry or a colleague on the same network while slowing a spammer.
	SponsorInquiryRatePer10Min = 5
)

func DefaultRateLimits() RateLimits {
	return RateLimits{
		Login: middleware.NewRateLimiter(10, 5*time.Minute),
		// 30/min: a student retrying a lookup never gets near it, a small group sharing one school
		// or carrier IP still fits, and a scraper of phone numbers is slowed to one every 2s.
		StatusQuery: middleware.NewRateLimiter(30, time.Minute),
		// Registration is the one endpoint a bot wants; 8/min per IP still fits a school NAT.
		Submit:   middleware.NewRateLimiter(8, time.Minute),
		Slip:     middleware.NewRateLimiter(20, time.Minute),
		Confirm:  middleware.NewRateLimiter(20, time.Minute),
		Withdraw: middleware.NewRateLimiter(20, time.Minute),
		Profile:  middleware.NewRateLimiter(20, time.Minute),

		PublicList:     middleware.NewRateLimiter(PublicListRatePerMinute, time.Minute),
		SponsorsPublic: middleware.NewRateLimiter(SponsorListRatePerMinute, time.Minute),
		SponsorLogo:    middleware.NewRateLimiter(SponsorLogoRatePerMinute, time.Minute),
		SponsorInquiry: middleware.NewRateLimiter(SponsorInquiryRatePer10Min, 10*time.Minute),
	}
}

type Options struct {
	AllowedOrigins []string
	TrustedProxies []netip.Prefix
	EnableSwagger  bool
	OpenAPISpec    []byte
	RateLimits     RateLimits
	HealthCheck    func(context.Context) error
}

type Services struct {
	Auth      *service.AuthService
	Applicant *service.ApplicantService
	Setting   *service.SettingService
	Payment   *service.PaymentService
	Sponsor   *service.SponsorService
	// SponsorInquiry and SponsorDonation back the /sponsor form and the admin sponsor desk.
	SponsorInquiry  *service.SponsorInquiryService
	SponsorDonation *service.SponsorDonationService
}

func NewRouter(svc Services, opt Options) http.Handler {
	healthHandler := handler.NewHealthHandlerWithCheck("comcamp25-backend", opt.HealthCheck)
	authHandler := handler.NewAuthHandler(svc.Auth)
	appHandler := handler.NewApplicantHandler(svc.Applicant)
	settingHandler := handler.NewSettingHandler(svc.Setting)
	paymentHandler := handler.NewPaymentHandler(svc.Payment)
	sponsorHandler := handler.NewSponsorHandler(svc.Sponsor)
	sponsorDesk := handler.NewSponsorDeskHandler(svc.SponsorInquiry, svc.SponsorDonation)
	swaggerHandler := handler.NewSwaggerHandler(opt.OpenAPISpec)
	limits := opt.RateLimits
	if limits.SponsorsPublic == nil {
		limits.SponsorsPublic = middleware.NewRateLimiter(SponsorListRatePerMinute, time.Minute)
	}
	if limits.SponsorLogo == nil {
		limits.SponsorLogo = middleware.NewRateLimiter(SponsorLogoRatePerMinute, time.Minute)
	}
	if limits.SponsorInquiry == nil {
		limits.SponsorInquiry = middleware.NewRateLimiter(SponsorInquiryRatePer10Min, 10*time.Minute)
	}

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
	// documents and are only served through GET /api/admin/applications/{id}/slip. Sponsor logos
	// are served through GET /api/sponsors/{id}/logo with DB-resolved paths only.

	r.Route("/api", func(api chi.Router) {
		api.Use(middleware.APIHeaders)

		// Slip upload carries its own 5 MB cap; everything else is small JSON.
		api.With(limits.Slip.Middleware).Post("/applications/{id}/slip", paymentHandler.UploadSlip)

		// Sponsor logo uploads carry their own 2 MB multipart cap and donation files their own
		// 8 MB cap, outside the 64 KB JSON limit.
		api.Group(func(adminMultipart chi.Router) {
			adminMultipart.Use(middleware.RequireAuth(svc.Auth))
			super := middleware.RequireRoles(rolesSuper...)
			adminMultipart.With(super).Post("/admin/sponsors", sponsorHandler.AdminCreate)
			adminMultipart.With(super).Patch("/admin/sponsors/{id}", sponsorHandler.AdminUpdate)
			adminMultipart.With(super).Put("/admin/sponsor-donations/{id}/files/{kind}", sponsorDesk.PutDonationFile)
		})

		api.Group(func(json chi.Router) {
			json.Use(middleware.LimitBody(middleware.MaxJSONBodyBytes))

			json.Get("/health", healthHandler.Check)
			if opt.EnableSwagger {
				json.Get("/docs/openapi.json", swaggerHandler.ServeSpec)
			}

			json.Get("/settings/public", settingHandler.GetPublic)
			json.With(limits.SponsorsPublic.Middleware).Get("/sponsors", sponsorHandler.ListPublic)
			json.With(limits.SponsorLogo.Middleware).Get("/sponsors/{id}/logo", sponsorHandler.GetLogo)
			json.With(limits.SponsorInquiry.Middleware).Post("/sponsor-inquiries", sponsorDesk.SubmitInquiry)

			json.With(limits.Submit.Middleware).Post("/applications", appHandler.Submit)
			json.With(limits.StatusQuery.Middleware).Get("/applications/status", appHandler.GetStatus)
			json.With(limits.PublicList.Middleware).Get("/applications/public", appHandler.ListPublic)
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
				admin.With(anyAdmin).Get("/admin/applications/withdrawn", appHandler.AdminListWithdrawn)
				admin.With(super).Delete("/admin/applications/withdrawn/{id}", appHandler.AdminPurgeWithdrawn)
				admin.With(editors).Post("/admin/applications/export-audit", appHandler.AdminExportAudit)
				admin.With(editors).Patch("/admin/applications/{id}", appHandler.AdminUpdateStatus)
				admin.With(editors).Patch("/admin/applications/{id}/profile", appHandler.AdminUpdateProfile)
				admin.With(super).Delete("/admin/applications/{id}", appHandler.AdminDelete)
				admin.With(payments).Get("/admin/applications/{id}/slip", paymentHandler.GetSlip)
				admin.With(payments).Patch("/admin/applications/{id}/verify-slip", paymentHandler.VerifySlip)
				admin.With(anyAdmin).Get("/admin/settings", settingHandler.GetAdmin)
				admin.With(super).Patch("/admin/settings", settingHandler.UpdateAdmin)
				admin.With(anyAdmin).Get("/admin/sponsors", sponsorHandler.AdminList)
				admin.With(super).Put("/admin/sponsors/order", sponsorHandler.AdminReorder)
				admin.With(super).Delete("/admin/sponsors/{id}", sponsorHandler.AdminDelete)
				admin.With(anyAdmin).Get("/admin/sponsor-inquiries", sponsorDesk.ListInquiries)
				admin.With(super).Patch("/admin/sponsor-inquiries/{id}", sponsorDesk.UpdateInquiry)
				admin.With(super).Delete("/admin/sponsor-inquiries/{id}", sponsorDesk.DeleteInquiry)
				admin.With(anyAdmin).Get("/admin/sponsor-notify-emails", sponsorDesk.GetNotifyEmails)
				admin.With(super).Put("/admin/sponsor-notify-emails", sponsorDesk.PutNotifyEmails)
				admin.With(anyAdmin).Get("/admin/sponsor-donations", sponsorDesk.ListDonations)
				admin.With(super).Post("/admin/sponsor-donations", sponsorDesk.CreateDonation)
				admin.With(super).Patch("/admin/sponsor-donations/{id}", sponsorDesk.UpdateDonation)
				admin.With(super).Delete("/admin/sponsor-donations/{id}", sponsorDesk.DeleteDonation)
				admin.With(anyAdmin).Get("/admin/sponsor-donations/{id}/files/{kind}", sponsorDesk.GetDonationFile)
				admin.With(super).Delete("/admin/sponsor-donations/{id}/files/{kind}", sponsorDesk.DeleteDonationFile)
			})
		})
	})

	return r
}
