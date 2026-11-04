package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func setupTestApp(t *testing.T) http.Handler {
	t.Helper()

	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	admRepo := memory.NewMemoryAdminRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)

	// Seed admin
	hash, _ := service.HashPassword("admin123")
	_ = admRepo.Create(context.Background(), &domain.Admin{
		Username:     "admin",
		PasswordHash: hash,
		FullName:     "System Admin",
		Role:         domain.RoleSuperadmin,
		IsActive:     true,
	})

	jwtSecret := "test-jwt-secret-key-32-characters-long"
	authService := service.NewAuthService(admRepo, jwtSecret)
	appService := service.NewApplicantService(appRepo, setRepo, payRepo)
	settingService := service.NewSettingService(setRepo, appRepo)
	uploadDir := t.TempDir()
	paymentService := service.NewPaymentService(payRepo, appRepo, setRepo, uploadDir)

	healthH := handler.NewHealthHandler("comcamp25-backend")
	authH := handler.NewAuthHandler(authService)
	appH := handler.NewApplicantHandler(appService)
	setH := handler.NewSettingHandler(settingService)
	payH := handler.NewPaymentHandler(paymentService)

	r := chi.NewRouter()
	r.Handle("/uploads/*", http.StripPrefix("/uploads", http.FileServer(http.Dir(uploadDir))))
	r.Route("/api", func(api chi.Router) {
		api.Get("/health", healthH.Check)
		api.Get("/settings/public", setH.GetPublic)

		api.Post("/applications", appH.Submit)
		api.Get("/applications/status", appH.GetStatus)
		api.Post("/applications/{id}/confirm", appH.ConfirmAttendance)
		api.Post("/applications/{id}/slip", payH.UploadSlip)

		api.Post("/auth/login", authH.Login)

		api.Group(func(admin chi.Router) {
			admin.Use(middleware.RequireAuth(authService))
			admin.Get("/admin/applications", appH.AdminList)
			admin.Patch("/admin/applications/{id}", appH.AdminUpdateStatus)
			admin.Patch("/admin/applications/{id}/verify-slip", payH.VerifySlip)
		})
	})

	return r
}

func TestE2E_FullCampApplicationLifecycle(t *testing.T) {
	app := setupTestApp(t)

	// Step 1: Health Check
	t.Run("1. GET /api/health", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
	})

	// Step 2: Public Settings
	t.Run("2. GET /api/settings/public", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/settings/public", nil)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}

		var settings domain.PublicSettingsResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &settings); err != nil {
			t.Fatalf("failed to parse json: %v", err)
		}
		if !settings.IsOpen {
			t.Errorf("expected camp to be open in test")
		}
		if settings.MaxCapacity != 30 {
			t.Errorf("expected max capacity 30, got %d", settings.MaxCapacity)
		}
	})

	var createdApp service.ApplicationResponse

	// Step 3: Register new applicant
	t.Run("3. POST /api/applications", func(t *testing.T) {
		payload := service.ApplicationCreateRequest{
			FullName:   "สมเกียรติ สุขสมบูรณ์",
			Nickname:   "เกียรติ",
			NationalID: "1509900112233",
			Phone:      "0819876543",
			Email:      "somkiat@school.ac.th",
			School:     "โรงเรียนแม่โจ้วิทยาคม",
			Grade:      "ม.5",
			ShirtSize:  "XL",
			Motivation: "อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard",
		}
		body, _ := json.Marshal(payload)
		req := httptest.NewRequest(http.MethodPost, "/api/applications", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201 Created, got %d (body: %s)", rec.Code, rec.Body.String())
		}

		if err := json.Unmarshal(rec.Body.Bytes(), &createdApp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if createdApp.ID == "" {
			t.Errorf("expected generated Application ID")
		}
		if createdApp.Status != domain.StatusPending {
			t.Errorf("expected status PENDING, got %s", createdApp.Status)
		}
	})

	// Step 4: Query Status by National ID
	t.Run("4. GET /api/applications/status?q={nationalId}", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/applications/status?q=1509900112233", nil)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var queried service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &queried)
		if queried.ID != createdApp.ID {
			t.Errorf("expected ID %s, got %s", createdApp.ID, queried.ID)
		}
	})

	// Step 5: Admin Login
	var token string
	t.Run("5. POST /api/auth/login", func(t *testing.T) {
		loginBody := `{"username":"admin","password":"admin123"}`
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewReader([]byte(loginBody)))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}

		var res struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		token = res.Token
		if token == "" {
			t.Fatalf("expected non-empty JWT token")
		}
	})

	// Step 6: Admin Endpoint Auth Protection Check
	t.Run("6. Protected endpoint check without token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got %d", rec.Code)
		}
	})

	// Step 7: Admin Lists Applications
	t.Run("7. GET /api/admin/applications (with auth)", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}

		var list []service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &list)
		if len(list) != 1 {
			t.Errorf("expected 1 applicant, got %d", len(list))
		}
	})

	// Step 8: Admin updates status to PASSED
	t.Run("8. PATCH /api/admin/applications/{id} -> PASSED", func(t *testing.T) {
		patchBody := `{"status":"PASSED","reason":"คะแนนสัมภาษณ์ผ่านเกณฑ์"}`
		targetURL := fmt.Sprintf("/api/admin/applications/%s", createdApp.ID)
		req := httptest.NewRequest(http.MethodPatch, targetURL, bytes.NewReader([]byte(patchBody)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
		}
		var updated service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &updated)
		if updated.Status != domain.StatusPassed {
			t.Errorf("expected PASSED, got %s", updated.Status)
		}
	})

	// Step 9: Applicant confirms attendance
	t.Run("9. POST /api/applications/{id}/confirm", func(t *testing.T) {
		targetURL := fmt.Sprintf("/api/applications/%s/confirm", createdApp.ID)
		confirmBody := `{"confirmed":true}`
		req := httptest.NewRequest(http.MethodPost, targetURL, bytes.NewReader([]byte(confirmBody)))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if !res.AttendanceConfirmed {
			t.Errorf("expected attendanceConfirmed to be true")
		}
	})

	// Step 10: Upload payment slip
	mockSlipBytes := []byte("SIMULATED_BANK_TRANSFER_SLIP_IMAGE_CONTENT_ABC_123")
	t.Run("10. POST /api/applications/{id}/slip (upload)", func(t *testing.T) {
		targetURL := fmt.Sprintf("/api/applications/%s/slip", createdApp.ID)

		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, _ := writer.CreateFormFile("slip", "slip_transfer_kbank.jpg")
		_, _ = io.Copy(part, bytes.NewReader(mockSlipBytes))
		_ = writer.Close()

		req := httptest.NewRequest(http.MethodPost, targetURL, body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
		}

		var slipRes service.SlipUploadResult
		_ = json.Unmarshal(rec.Body.Bytes(), &slipRes)

		// Test admin fetching the uploaded slip file over HTTP (manual inspection)
		reqFetch := httptest.NewRequest(http.MethodGet, slipRes.SlipURL, nil)
		recFetch := httptest.NewRecorder()
		app.ServeHTTP(recFetch, reqFetch)

		if recFetch.Code != http.StatusOK {
			t.Fatalf("expected 200 OK when admin fetches slip, got %d", recFetch.Code)
		}
		if !bytes.Equal(recFetch.Body.Bytes(), mockSlipBytes) {
			t.Errorf("fetched slip bytes do not match uploaded bytes")
		}
	})

	// Step 11: Anti-fraud duplicate slip detection
	t.Run("11. Upload duplicate slip -> Expect 409 Conflict", func(t *testing.T) {
		targetURL := fmt.Sprintf("/api/applications/%s/slip", createdApp.ID)

		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, _ := writer.CreateFormFile("slip", "same_slip_reused.jpg")
		_, _ = io.Copy(part, bytes.NewReader(mockSlipBytes)) // Same hash
		_ = writer.Close()

		req := httptest.NewRequest(http.MethodPost, targetURL, body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusConflict {
			t.Fatalf("expected 409 Conflict, got %d (body: %s)", rec.Code, rec.Body.String())
		}
	})

	// Step 12: Admin verifies payment slip
	t.Run("12. PATCH /api/admin/applications/{id}/verify-slip -> CONFIRMED", func(t *testing.T) {
		targetURL := fmt.Sprintf("/api/admin/applications/%s/verify-slip", createdApp.ID)
		verifyBody := `{"approved":true,"note":"ยอดเงินเข้าบัญชี 300 บาท ถูกต้องครบถ้วน"}`
		req := httptest.NewRequest(http.MethodPatch, targetURL, bytes.NewReader([]byte(verifyBody)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
		}
	})

	// Step 13: Final Status Check -> CONFIRMED
	t.Run("13. Check final applicant status is CONFIRMED", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/applications/status?q="+createdApp.ID, nil)
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var finalApp service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &finalApp)

		if finalApp.Status != domain.StatusConfirmed {
			t.Errorf("expected final status CONFIRMED, got %s", finalApp.Status)
		}
		if finalApp.SlipURL == nil || *finalApp.SlipURL == "" {
			t.Errorf("expected non-empty slipURL")
		}
	})
}
