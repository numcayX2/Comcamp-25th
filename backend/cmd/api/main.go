package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/config"
	"comcamp25-backend/internal/docs"
	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/repository/postgres"
	"comcamp25-backend/internal/service"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("Fatal server error: %v", err)
	}
}

func run() error {
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}

	rootCtx, cancelRoot := context.WithCancel(context.Background())
	defer cancelRoot()

	// 1. Initialize Repositories
	var (
		appRepo     domain.ApplicantRepository
		settingRepo domain.SettingRepository
		adminRepo   domain.AdminRepository
		paymentRepo domain.PaymentRepository
		pool        *pgxpool.Pool
		healthH     *handler.HealthHandler
	)

	poolConfig := repository.DefaultPoolConfig(cfg.DSN())
	ctxPing, cancelPing := context.WithTimeout(rootCtx, poolConfig.ConnectTimeout)
	defer cancelPing()

	var err error
	pool, err = repository.NewPool(ctxPing, poolConfig)
	if err == nil {
		log.Println("Database connection established: using PostgreSQL repositories")
		defer pool.Close()

		appRepo = postgres.NewApplicantPostgresRepo(pool)
		settingRepo = postgres.NewSettingPostgresRepo(pool)
		adminRepo = postgres.NewAdminPostgresRepo(pool)
		paymentRepo = postgres.NewPaymentPostgresRepo(pool)

		healthH = handler.NewHealthHandlerWithCheck("comcamp25-backend", "postgres", func(ctx context.Context) error {
			return repository.Ping(ctx, pool)
		})
	} else {
		if !cfg.AllowMemoryFallback {
			return fmt.Errorf("PostgreSQL connection failed and ALLOW_MEMORY_FALLBACK is false: %w", err)
		}
		log.Printf("PostgreSQL not reachable (%v): using In-Memory repositories for development/testing", err)

		memApp := memory.NewMemoryApplicantRepo()
		memSet := memory.NewMemorySettingRepo()
		memAdm := memory.NewMemoryAdminRepo()
		memPay := memory.NewMemoryPaymentRepoWithSettings(memApp, memSet)
		memApp.SetSettingRepo(memSet)

		appRepo = memApp
		settingRepo = memSet
		adminRepo = memAdm
		paymentRepo = memPay

		healthH = handler.NewHealthHandler("comcamp25-backend")
	}

	// 2. Ensure initial admin exists in both PostgreSQL and Memory modes
	if err := ensureInitialAdmin(rootCtx, cfg, adminRepo); err != nil {
		return err
	}

	// 3. Initialize Services
	authService := service.NewAuthService(adminRepo, cfg.JWTSecret)
	appService := service.NewApplicantService(appRepo, settingRepo, paymentRepo)
	settingService := service.NewSettingService(settingRepo, appRepo)
	paymentService := service.NewPaymentService(paymentRepo, appRepo, settingRepo, cfg.UploadDir)

	// 4. Initialize Handlers
	authHandler := handler.NewAuthHandler(authService)
	appHandler := handler.NewApplicantHandler(appService)
	settingHandler := handler.NewSettingHandler(settingService)
	paymentHandler := handler.NewPaymentHandler(paymentService)
	swaggerHandler := handler.NewSwaggerHandler(docs.OpenAPISpec)

	// 5. Rate Limiters
	loginLimiter := middleware.NewRateLimiter(10, time.Minute, cfg.TrustedProxies)
	loginLimiter.StartCleanup(rootCtx)

	publicWriteLimiter := middleware.NewRateLimiter(20, time.Minute, cfg.TrustedProxies)
	publicWriteLimiter.StartCleanup(rootCtx)

	statusLimiter := middleware.NewRateLimiter(30, time.Minute, cfg.TrustedProxies)
	statusLimiter.StartCleanup(rootCtx)

	// 6. Setup Router
	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(middleware.SecurityHeaders)
	r.Use(middleware.SafeLoggerWithProxies(cfg.TrustedProxies))
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(30 * time.Second))
	r.Use(middleware.NewCORS(cfg.CORSAllowedOrigins))

	if cfg.EnableSwagger {
		r.Get("/swagger", swaggerHandler.ServeUI)
		r.Get("/docs", swaggerHandler.ServeUI)
	}

	// Static File Server for uploaded slips with directory listing disabled
	r.Handle("/uploads/*", handler.NewUploadFileHandler(cfg.UploadDir))

	r.Route("/api", func(api chi.Router) {
		api.Get("/health", healthH.Check)
		if cfg.EnableSwagger {
			api.Get("/docs/openapi.json", swaggerHandler.ServeSpec)
		}

		// Public Camp Settings
		api.Get("/settings/public", settingHandler.GetPublic)

		// Public Application Flow
		api.With(publicWriteLimiter.Middleware).Post("/applications", appHandler.Submit)
		api.With(statusLimiter.Middleware).Get("/applications/status", appHandler.GetStatus)
		api.With(publicWriteLimiter.Middleware).Post("/applications/{id}/confirm", appHandler.ConfirmAttendance)
		api.With(publicWriteLimiter.Middleware).Post("/applications/{id}/slip", paymentHandler.UploadSlip)

		// Auth
		api.With(loginLimiter.Middleware).Post("/auth/login", authHandler.Login)

		// Protected Admin Endpoints
		api.Group(func(admin chi.Router) {
			admin.Use(middleware.RequireAuth(authService))
			admin.Post("/auth/logout", authHandler.Logout)
			admin.Get("/admin/applications", appHandler.AdminList)
			admin.Patch("/admin/applications/{id}", appHandler.AdminUpdateStatus)
			admin.Patch("/admin/applications/{id}/verify-slip", paymentHandler.VerifySlip)
			admin.Get("/admin/settings", settingHandler.GetAdmin)
			admin.Patch("/admin/settings", settingHandler.UpdateAdmin)
		})
	})

	server := &http.Server{
		Addr:              fmt.Sprintf(":%s", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      35 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("ComCamp 25 Backend API running on port :%s (env=%s)", cfg.Port, cfg.AppEnv)
		if cfg.EnableSwagger {
			log.Printf("Swagger UI documentation available at: http://localhost:%s/swagger", cfg.Port)
		}
		serverErrors <- server.ListenAndServe()
	}()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(shutdown)

	select {
	case err := <-serverErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case sig := <-shutdown:
		log.Printf("Received signal %v, shutting down gracefully...", sig)
		cancelRoot()

		ctxShutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(ctxShutdown); err != nil {
			log.Printf("Graceful shutdown failed: %v, forcing close", err)
			_ = server.Close()
			return err
		}
		log.Println("Server exited cleanly.")
	}

	return nil
}

func ensureInitialAdmin(ctx context.Context, cfg *config.Config, adminRepo domain.AdminRepository) error {
	ctxCheck, cancel := repository.WithQueryTimeout(ctx, repository.DefaultQueryTimeout)
	defer cancel()

	count, err := adminRepo.Count(ctxCheck)
	if err != nil {
		return fmt.Errorf("failed to count admin accounts: %w", err)
	}
	if count > 0 {
		return nil
	}

	password := cfg.AdminSeedPassword
	if password == "" {
		if cfg.IsProduction() {
			return errors.New("cannot seed initial admin in production: ADMIN_PASSWORD must be set to a strong password (>= 12 chars)")
		}
		password = "strong_password"
	}

	username := cfg.AdminSeedUsername
	if username == "" {
		username = "admin"
	}

	hash, err := service.HashPassword(password)
	if err != nil {
		return fmt.Errorf("failed to hash initial admin password: %w", err)
	}

	err = adminRepo.Create(ctxCheck, &domain.Admin{
		Username:     username,
		PasswordHash: hash,
		FullName:     "System Administrator",
		Role:         domain.RoleAdmin,
		IsActive:     true,
	})
	if err != nil && !errors.Is(err, domain.ErrDuplicateAdmin) {
		return fmt.Errorf("failed to seed initial admin: %w", err)
	}
	log.Printf("Seeded initial admin account %q with role %q", username, domain.RoleAdmin)
	return nil
}
