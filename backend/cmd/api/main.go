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
	cfg := config.Load()

	// 1. Initialize Repositories (Postgres with Memory Fallback)
	var (
		appRepo     domain.ApplicantRepository
		settingRepo domain.SettingRepository
		adminRepo   domain.AdminRepository
		paymentRepo domain.PaymentRepository
	)

	poolConfig := repository.DefaultPoolConfig(cfg.DSN())
	ctxPing, cancelPing := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelPing()

	pool, err := repository.NewPool(ctxPing, poolConfig)
	if err == nil {
		log.Println("Database connection established: using PostgreSQL repositories")
		appRepo = postgres.NewApplicantPostgresRepo(pool)
		settingRepo = postgres.NewSettingPostgresRepo(pool)
		adminRepo = postgres.NewAdminPostgresRepo(pool)
		paymentRepo = postgres.NewPaymentPostgresRepo(pool)
		defer pool.Close()
	} else {
		log.Printf("PostgreSQL not reachable (%v): using In-Memory repositories for development/testing", err)
		memApp := memory.NewMemoryApplicantRepo()
		memSet := memory.NewMemorySettingRepo()
		memAdm := memory.NewMemoryAdminRepo()
		memPay := memory.NewMemoryPaymentRepo(memApp)

		// Seed a default admin for dev/testing
		hash, _ := service.HashPassword("strong_password")
		_ = memAdm.Create(context.Background(), &domain.Admin{
			Username:     "admin",
			PasswordHash: hash,
			FullName:     "System Administrator",
			Role:         domain.RoleSuperadmin,
			IsActive:     true,
		})

		appRepo = memApp
		settingRepo = memSet
		adminRepo = memAdm
		paymentRepo = memPay
	}

	// 2. Initialize Services
	authService := service.NewAuthService(adminRepo, cfg.JWTSecret)
	appService := service.NewApplicantService(appRepo, settingRepo, paymentRepo)
	settingService := service.NewSettingService(settingRepo, appRepo)
	paymentService := service.NewPaymentService(paymentRepo, appRepo, settingRepo, cfg.UploadDir)

	// 3. Initialize Handlers
	healthHandler := handler.NewHealthHandler("comcamp25-backend")
	authHandler := handler.NewAuthHandler(authService)
	appHandler := handler.NewApplicantHandler(appService)
	settingHandler := handler.NewSettingHandler(settingService)
	paymentHandler := handler.NewPaymentHandler(paymentService)
	swaggerHandler := handler.NewSwaggerHandler(docs.OpenAPISpec)

	// 4. Setup Router
	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(60 * time.Second))
	r.Use(middleware.NewCORS(cfg.FrontendURL))

	// Interactive Swagger UI
	r.Get("/swagger", swaggerHandler.ServeUI)
	r.Get("/docs", swaggerHandler.ServeUI)

	// Static File Server for uploaded slips and assets (enables admin manual inspection)
	r.Handle("/uploads/*", http.StripPrefix("/uploads", http.FileServer(http.Dir(cfg.UploadDir))))

	r.Route("/api", func(api chi.Router) {
		// Health & Docs
		api.Get("/health", healthHandler.Check)
		api.Get("/docs/openapi.json", swaggerHandler.ServeSpec)

		// Public Camp Settings
		api.Get("/settings/public", settingHandler.GetPublic)

		// Public Application Flow
		api.Post("/applications", appHandler.Submit)
		api.Get("/applications/status", appHandler.GetStatus)
		api.Post("/applications/{id}/confirm", appHandler.ConfirmAttendance)
		api.Post("/applications/{id}/slip", paymentHandler.UploadSlip)

		// Auth
		api.Post("/auth/login", authHandler.Login)

		// Protected Admin Endpoints
		api.Group(func(admin chi.Router) {
			admin.Use(middleware.RequireAuth(authService))
			admin.Get("/admin/applications", appHandler.AdminList)
			admin.Patch("/admin/applications/{id}", appHandler.AdminUpdateStatus)
			admin.Patch("/admin/applications/{id}/verify-slip", paymentHandler.VerifySlip)
		})
	})

	server := &http.Server{
		Addr:         fmt.Sprintf(":%s", cfg.Port),
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("ComCamp 25 Backend API running on port :%s", cfg.Port)
		log.Printf("Swagger UI documentation available at: http://localhost:%s/swagger", cfg.Port)
		serverErrors <- server.ListenAndServe()
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

		if err := server.Shutdown(ctxShutdown); err != nil {
			log.Printf("Graceful shutdown failed: %v, forcing close", err)
			_ = server.Close()
		}
		log.Println("Server exited cleanly.")
	}
}
