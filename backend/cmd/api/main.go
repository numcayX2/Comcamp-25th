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

	"comcamp25-backend/internal/config"
	"comcamp25-backend/internal/docs"
	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/repository/postgres"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Refusing to start: %v", err)
	}
	log.Printf("Starting ComCamp 25 backend (APP_ENV=%s)", cfg.Env)

	// 1. Initialize Repositories
	var (
		appRepo     domain.ApplicantRepository
		settingRepo domain.SettingRepository
		adminRepo   domain.AdminRepository
		paymentRepo domain.PaymentRepository
		auditRepo   domain.AuditRepository
	)

	ctxPing, cancelPing := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelPing()

	pool, err := repository.NewPool(ctxPing, repository.DefaultPoolConfig(cfg.DSN()))
	switch {
	case err == nil:
		log.Println("Database connection established: using PostgreSQL repositories")
		appRepo = postgres.NewApplicantPostgresRepo(pool)
		settingRepo = postgres.NewSettingPostgresRepo(pool)
		adminRepo = postgres.NewAdminPostgresRepo(pool)
		paymentRepo = postgres.NewPaymentPostgresRepo(pool)
		auditRepo = postgres.NewAuditPostgresRepo(pool)
		defer pool.Close()

	case cfg.IsProduction():
		// Fail closed: silently switching to memory would lose every application submitted
		// during a database outage (AGENTS.md P0).
		log.Fatalf("PostgreSQL not reachable in production, refusing to start: %v", err)

	default:
		log.Printf("PostgreSQL not reachable (%v): using In-Memory repositories (APP_ENV=development only, data is lost on restart)", err)
		memApp := memory.NewMemoryApplicantRepo()
		memAdm := memory.NewMemoryAdminRepo()

		// A dev admin exists only when DEV_ADMIN_PASSWORD is set; there is no built-in password.
		if cfg.DevAdminPassword != "" {
			hash, err := service.HashPassword(cfg.DevAdminPassword)
			if err != nil {
				log.Fatalf("hash dev admin password: %v", err)
			}
			_ = memAdm.Create(context.Background(), &domain.Admin{
				Username:     cfg.DevAdminUsername,
				PasswordHash: hash,
				FullName:     "Development Administrator",
				Role:         domain.RoleSuperadmin,
				IsActive:     true,
			})
			log.Printf("Seeded in-memory dev admin %q from DEV_ADMIN_PASSWORD", cfg.DevAdminUsername)
		} else {
			log.Println("No dev admin seeded: set DEV_ADMIN_PASSWORD in .env to log in to /admin")
		}

		appRepo = memApp
		settingRepo = memory.NewMemorySettingRepo()
		adminRepo = memAdm
		paymentRepo = memory.NewMemoryPaymentRepo(memApp)
		auditRepo = memApp.Audit()
	}

	// 2. Initialize Services
	services := server.Services{
		Auth:      service.NewAuthService(adminRepo, auditRepo, cfg.JWTSecret),
		Applicant: service.NewApplicantService(appRepo, settingRepo, paymentRepo),
		Setting:   service.NewSettingService(settingRepo, appRepo, auditRepo),
		Payment:   service.NewPaymentService(paymentRepo, appRepo, settingRepo, auditRepo, cfg.UploadDir),
	}

	// 3. Router (all security middleware lives in internal/server)
	router := server.NewRouter(services, server.Options{
		AllowedOrigins: cfg.AllowedOrigins,
		TrustedProxies: cfg.TrustedProxies,
		EnableSwagger:  cfg.EnableSwagger,
		OpenAPISpec:    docs.OpenAPISpec,
		RateLimits:     server.DefaultRateLimits(),
	})

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%s", cfg.Port),
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second, // a 5 MB slip over a slow mobile connection
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("ComCamp 25 Backend API running on port :%s", cfg.Port)
		if cfg.EnableSwagger {
			log.Printf("Swagger UI documentation available at: http://localhost:%s/swagger", cfg.Port)
		}
		serverErrors <- httpServer.ListenAndServe()
	}()

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("Fatal server error: %v", err)
		}
	case sig := <-shutdown:
		log.Printf("Received signal %v, shutting down gracefully...", sig)
		ctxShutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := httpServer.Shutdown(ctxShutdown); err != nil {
			log.Printf("Graceful shutdown failed: %v, forcing close", err)
			_ = httpServer.Close()
		}
		log.Println("Server exited cleanly.")
	}
}
