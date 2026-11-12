package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

type testAppDeps struct {
	router     http.Handler
	appRepo    *memory.MemoryApplicantRepo
	setRepo    *memory.MemorySettingRepo
	admRepo    *memory.MemoryAdminRepo
	payRepo    *memory.MemoryPaymentRepo
	authSvc    *service.AuthService
	appSvc     *service.ApplicantService
	settingSvc *service.SettingService
	paymentSvc *service.PaymentService
	uploadDir  string
}

func setupTestApp(t *testing.T) http.Handler {
	t.Helper()
	return setupTestAppWithDeps(t).router
}

func setupTestAppWithDeps(t *testing.T) *testAppDeps {
	t.Helper()

	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	appRepo.SetSettingRepo(setRepo)
	admRepo := memory.NewMemoryAdminRepo()
	payRepo := memory.NewMemoryPaymentRepoWithSettings(appRepo, setRepo)

	// Seed admin
	hash, _ := service.HashPassword("admin123")
	_ = admRepo.Create(context.Background(), &domain.Admin{
		Username:     "admin",
		PasswordHash: hash,
		FullName:     "System Admin",
		Role:         domain.RoleAdmin,
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

	loginLimiter := middleware.NewRateLimiter(10, time.Minute, nil)
	publicWriteLimiter := middleware.NewRateLimiter(20, time.Minute, nil)
	statusLimiter := middleware.NewRateLimiter(30, time.Minute, nil)

	r := chi.NewRouter()
	r.Use(chimiddleware.RequestID)
	r.Use(middleware.SecurityHeaders)
	r.Use(middleware.SafeLoggerWithProxies(nil))
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.NewCORS([]string{"https://comcamp.csmju.com"}))

	r.Handle("/uploads/*", handler.NewUploadFileHandler(uploadDir))
	r.Route("/api", func(api chi.Router) {
		api.Get("/health", healthH.Check)
		api.Get("/settings/public", setH.GetPublic)

		api.With(publicWriteLimiter.Middleware).Post("/applications", appH.Submit)
		api.With(statusLimiter.Middleware).Get("/applications/status", appH.GetStatus)
		api.With(publicWriteLimiter.Middleware).Post("/applications/{id}/confirm", appH.ConfirmAttendance)
		api.With(publicWriteLimiter.Middleware).Post("/applications/{id}/slip", payH.UploadSlip)

		api.With(loginLimiter.Middleware).Post("/auth/login", authH.Login)

		api.Group(func(admin chi.Router) {
			admin.Use(middleware.RequireAuth(authService))
			admin.Post("/auth/logout", authH.Logout)
			admin.Get("/admin/applications", appH.AdminList)
			admin.Patch("/admin/applications/{id}", appH.AdminUpdateStatus)
			admin.Patch("/admin/applications/{id}/verify-slip", payH.VerifySlip)
			admin.Get("/admin/settings", setH.GetAdmin)
			admin.Patch("/admin/settings", setH.UpdateAdmin)
		})
	})

	return &testAppDeps{
		router:     r,
		appRepo:    appRepo,
		setRepo:    setRepo,
		admRepo:    admRepo,
		payRepo:    payRepo,
		authSvc:    authService,
		appSvc:     appService,
		settingSvc: settingService,
		paymentSvc: paymentService,
		uploadDir:  uploadDir,
	}
}

func generateValidJPEGBytes(t *testing.T, r, g, b uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("failed to encode test jpeg: %v", err)
	}
	return buf.Bytes()
}

func TestE2E_FullCampApplicationLifecycle(t *testing.T) {
	app := setupTestApp(t)

	// Step 1: Health Check + Security Headers
	t.Run("1. GET /api/health", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Origin", "https://comcamp.csmju.com")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("expected X-Content-Type-Options: nosniff")
		}
		if rec.Header().Get("X-Frame-Options") != "DENY" {
			t.Errorf("expected X-Frame-Options: DENY")
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://comcamp.csmju.com" {
			t.Errorf("expected CORS Allow-Origin header, got %q", rec.Header().Get("Access-Control-Allow-Origin"))
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

	// Step 4: Query Status by National ID (expects masked PII)
	t.Run("4. GET /api/applications/status?q={nationalId} returns masked PII", func(t *testing.T) {
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
		if queried.NationalID != "15099******33" {
			t.Errorf("expected masked nationalId 15099******33, got %q", queried.NationalID)
		}
		if queried.Phone != "081****543" {
			t.Errorf("expected masked phone 081****543, got %q", queried.Phone)
		}
		if queried.Email != "s***@school.ac.th" {
			t.Errorf("expected masked email s***@school.ac.th, got %q", queried.Email)
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

	// Step 7: Admin Lists Applications (unmasked)
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
			t.Fatalf("expected 1 applicant, got %d", len(list))
		}
		if list[0].NationalID != "1509900112233" {
			t.Errorf("expected unmasked nationalId in admin list, got %q", list[0].NationalID)
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

	// Step 10: Upload payment slip (valid JPEG) & verify directory listing disabled
	mockSlipBytes := generateValidJPEGBytes(t, 25, 120, 210)
	t.Run("10. POST /api/applications/{id}/slip (upload) and uploads dir listing disabled", func(t *testing.T) {
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

		// Fetch uploaded slip over HTTP
		reqFetch := httptest.NewRequest(http.MethodGet, slipRes.SlipURL, nil)
		recFetch := httptest.NewRecorder()
		app.ServeHTTP(recFetch, reqFetch)

		if recFetch.Code != http.StatusOK {
			t.Fatalf("expected 200 OK when fetching slip, got %d", recFetch.Code)
		}
		if !bytes.Equal(recFetch.Body.Bytes(), mockSlipBytes) {
			t.Errorf("fetched slip bytes do not match uploaded bytes")
		}
		if recFetch.Header().Get("Cache-Control") != "private, no-store" {
			t.Errorf("expected Cache-Control: private, no-store, got %q", recFetch.Header().Get("Cache-Control"))
		}

		// Directory listing must return 404
		for _, dirURL := range []string{"/uploads/", "/uploads/slips/", "/uploads/slips"} {
			reqDir := httptest.NewRequest(http.MethodGet, dirURL, nil)
			recDir := httptest.NewRecorder()
			app.ServeHTTP(recDir, reqDir)
			if recDir.Code != http.StatusNotFound {
				t.Errorf("directory listing %s: expected 404, got %d", dirURL, recDir.Code)
			}
		}
	})

	// Step 11: Anti-fraud duplicate slip detection
	t.Run("11. Upload duplicate slip -> Expect 409 Conflict", func(t *testing.T) {
		targetURL := fmt.Sprintf("/api/applications/%s/slip", createdApp.ID)

		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, _ := writer.CreateFormFile("slip", "same_slip_reused.jpg")
		_, _ = io.Copy(part, bytes.NewReader(mockSlipBytes))
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

	// Step 14: Admin checks and updates dynamic camp settings
	t.Run("14. GET and PATCH /api/admin/settings", func(t *testing.T) {
		getReq := httptest.NewRequest(http.MethodGet, "/api/admin/settings", nil)
		getReq.Header.Set("Authorization", "Bearer "+token)
		getRec := httptest.NewRecorder()
		app.ServeHTTP(getRec, getReq)

		if getRec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for GET /api/admin/settings, got %d", getRec.Code)
		}

		updateBody := `{"maxCapacity": 50, "campName": "ComCamp #25 (Updated)"}`
		patchReq := httptest.NewRequest(http.MethodPatch, "/api/admin/settings", bytes.NewReader([]byte(updateBody)))
		patchReq.Header.Set("Authorization", "Bearer "+token)
		patchReq.Header.Set("Content-Type", "application/json")
		patchRec := httptest.NewRecorder()
		app.ServeHTTP(patchRec, patchReq)

		if patchRec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for PATCH /api/admin/settings, got %d (body: %s)", patchRec.Code, patchRec.Body.String())
		}

		var updatedSettings domain.Settings
		if err := json.Unmarshal(patchRec.Body.Bytes(), &updatedSettings); err != nil {
			t.Fatalf("failed to parse updated settings: %v", err)
		}
		if updatedSettings.MaxCapacity != 50 {
			t.Errorf("expected updated capacity 50, got %d", updatedSettings.MaxCapacity)
		}
		if updatedSettings.CampName != "ComCamp #25 (Updated)" {
			t.Errorf("expected updated camp name, got %s", updatedSettings.CampName)
		}

		pubReq := httptest.NewRequest(http.MethodGet, "/api/settings/public", nil)
		pubRec := httptest.NewRecorder()
		app.ServeHTTP(pubRec, pubReq)

		var pubSettings domain.PublicSettingsResponse
		_ = json.Unmarshal(pubRec.Body.Bytes(), &pubSettings)
		if pubSettings.MaxCapacity != 50 {
			t.Errorf("expected public settings maxCapacity 50, got %d", pubSettings.MaxCapacity)
		}
	})

	// Step 15: Logout revokes token
	t.Run("15. POST /api/auth/logout revokes token", func(t *testing.T) {
		logoutReq := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
		logoutReq.Header.Set("Authorization", "Bearer "+token)
		logoutRec := httptest.NewRecorder()
		app.ServeHTTP(logoutRec, logoutReq)

		if logoutRec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for logout, got %d", logoutRec.Code)
		}

		afterReq := httptest.NewRequest(http.MethodGet, "/api/admin/applications", nil)
		afterReq.Header.Set("Authorization", "Bearer "+token)
		afterRec := httptest.NewRecorder()
		app.ServeHTTP(afterRec, afterReq)

		if afterRec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized after logout, got %d", afterRec.Code)
		}
	})
}

func TestE2E_RateLimitingOnLogin(t *testing.T) {
	app := setupTestApp(t)

	for i := 0; i < 10; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"wrong"}`))
		req.Header.Set("Content-Type", "application/json")
		req.RemoteAddr = "198.51.100.42:10000"
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, rec.Code)
		}
	}

	req11 := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"wrong"}`))
	req11.Header.Set("Content-Type", "application/json")
	req11.RemoteAddr = "198.51.100.42:10000"
	rec11 := httptest.NewRecorder()
	app.ServeHTTP(rec11, req11)
	if rec11.Code != http.StatusTooManyRequests {
		t.Fatalf("attempt 11: expected 429 Too Many Requests, got %d", rec11.Code)
	}
}
