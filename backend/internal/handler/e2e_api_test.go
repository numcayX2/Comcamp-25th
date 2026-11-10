package handler_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

const (
	testAdminUser = "admin"
	testAdminPass = "admin123-test-only"
)

type testApp struct {
	http.Handler
	appRepo   *memory.MemoryApplicantRepo
	adminRepo *memory.MemoryAdminRepo
	setRepo   *memory.MemorySettingRepo
	adminID   int64
	// verifyCodes maps application ID → last 4 national-ID digits, filled by submit, so the
	// public confirm / slip helpers can pass the /status second factor (AGENTS.md §13.5).
	verifyCodes map[string]string
}

// setupTestApp builds the production router (server.NewRouter) over in-memory repositories, so
// these tests run through the same security middleware as the deployed API.
func setupTestApp(t *testing.T) *testApp {
	t.Helper()

	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	admRepo := memory.NewMemoryAdminRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)

	hash, _ := service.HashPassword(testAdminPass)
	admin := &domain.Admin{
		Username:     testAdminUser,
		PasswordHash: hash,
		FullName:     "System Admin",
		Role:         domain.RoleSuperadmin,
		IsActive:     true,
	}
	_ = admRepo.Create(context.Background(), admin)

	jwtSecret := "test-jwt-secret-key-32-characters-long"
	services := server.Services{
		Auth:      service.NewAuthService(admRepo, appRepo.Audit(), jwtSecret),
		Applicant: service.NewApplicantService(appRepo, setRepo, payRepo),
		Setting:   service.NewSettingService(setRepo, appRepo),
		Payment:   service.NewPaymentService(payRepo, appRepo, setRepo, appRepo.Audit(), t.TempDir()),
	}

	router := server.NewRouter(services, server.Options{
		AllowedOrigins: []string{"http://localhost:4321"},
		RateLimits:     server.DefaultRateLimits(),
	})

	return &testApp{
		Handler: router, appRepo: appRepo, adminRepo: admRepo, setRepo: setRepo, adminID: admin.ID,
		verifyCodes: map[string]string{},
	}
}

func (a *testApp) do(t *testing.T, method, target string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if body != nil && headers["Content-Type"] == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, req)
	return rec
}

func (a *testApp) login(t *testing.T) string {
	t.Helper()
	body := fmt.Sprintf(`{"username":%q,"password":%q}`, testAdminUser, testAdminPass)
	rec := a.do(t, http.MethodPost, "/api/auth/login", bytes.NewBufferString(body), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	var res struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Token == "" {
		t.Fatal("login: empty token")
	}
	return res.Token
}

func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

func applicationJSON(nationalID, phone, email string) *bytes.Buffer {
	body, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมเกียรติ สุขสมบูรณ์",
		Nickname:   "เกียรติ",
		NationalID: nationalID,
		Phone:      phone,
		Email:      email,
		School:     "โรงเรียนแม่โจ้วิทยาคม",
		Grade:      "ม.5",
		ShirtSize:  "XL",
		Motivation: "อยากเรียนรู้การต่อวงจรเซนเซอร์และบอร์ด ESP8266 ทำ AI Dashboard",
	})
	return bytes.NewBuffer(body)
}

func (a *testApp) submit(t *testing.T, nationalID, phone, email string) service.ApplicationResponse {
	t.Helper()
	rec := a.do(t, http.MethodPost, "/api/applications", applicationJSON(nationalID, phone, email), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var app service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &app)
	a.verifyCodes[app.ID] = nationalID[len(nationalID)-4:]
	return app
}

func (a *testApp) setStatus(t *testing.T, token, appID string, status domain.ApplicationStatus) {
	t.Helper()
	body := fmt.Sprintf(`{"status":%q,"reason":"test"}`, status)
	rec := a.do(t, http.MethodPatch, "/api/admin/applications/"+appID, bytes.NewBufferString(body), bearer(token))
	if rec.Code != http.StatusOK {
		t.Fatalf("set status: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// Real 1×1 images: the upload path sniffs the magic bytes and then parses the header for the
// dimension check (AGENTS.md §13.4), so a bare magic-byte prefix is no longer accepted.
var (
	jpegBytes = encodeJPEG(1, 1)
	pngBytes  = encodePNG(1, 1)
	// 1×1 lossless WebP (VP8L chunk).
	webpBytes = mustBase64("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
	gifBytes  = []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00")
	pdfBytes  = []byte("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")
	binBytes  = []byte{0x00, 0x01, 0x02, 0x03, 0xFE, 0xFD, 0x7F, 0x10}
)

func encodeJPEG(w, h int) []byte {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, w, h)), nil); err != nil {
		panic(err)
	}
	return b.Bytes()
}

func encodePNG(w, h int) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, w, h))); err != nil {
		panic(err)
	}
	return b.Bytes()
}

func mustBase64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func slipForm(t *testing.T, filename, verifyCode string, data []byte) (*bytes.Buffer, map[string]string) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if verifyCode != "" {
		_ = writer.WriteField("verifyCode", verifyCode)
	}
	part, _ := writer.CreateFormFile("slip", filename)
	_, _ = part.Write(data)
	_ = writer.Close()
	return body, map[string]string{"Content-Type": writer.FormDataContentType()}
}

// uploadSlip posts a slip with the applicant's correct verifyCode.
func (a *testApp) uploadSlip(t *testing.T, appID, filename string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	return a.uploadSlipWithCode(t, appID, a.verifyCodes[appID], filename, data)
}

func (a *testApp) uploadSlipWithCode(t *testing.T, appID, verifyCode, filename string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, headers := slipForm(t, filename, verifyCode, data)
	return a.do(t, http.MethodPost, "/api/applications/"+appID+"/slip", body, headers)
}

func TestE2E_FullCampApplicationLifecycle(t *testing.T) {
	app := setupTestApp(t)

	t.Run("1. GET /api/health", func(t *testing.T) {
		if rec := app.do(t, http.MethodGet, "/api/health", nil, nil); rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
	})

	t.Run("2. GET /api/settings/public", func(t *testing.T) {
		rec := app.do(t, http.MethodGet, "/api/settings/public", nil, nil)
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

	var created service.ApplicationResponse
	t.Run("3. POST /api/applications", func(t *testing.T) {
		created = app.submit(t, "1509900112233", "0819876543", "somkiat@school.ac.th")
		if created.ID == "" {
			t.Errorf("expected generated Application ID")
		}
		if created.Status != domain.StatusPending {
			t.Errorf("expected status PENDING, got %s", created.Status)
		}
	})

	t.Run("4. GET /api/applications/status?q={nationalId}", func(t *testing.T) {
		rec := app.do(t, http.MethodGet, "/api/applications/status?q=1509900112233", nil, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var queried service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &queried)
		if queried.ID != created.ID {
			t.Errorf("expected ID %s, got %s", created.ID, queried.ID)
		}
	})

	var token string
	t.Run("5. POST /api/auth/login", func(t *testing.T) {
		token = app.login(t)
	})

	t.Run("6. Protected endpoint check without token", func(t *testing.T) {
		if rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, nil); rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 Unauthorized, got %d", rec.Code)
		}
	})

	t.Run("7. GET /api/admin/applications (with auth)", func(t *testing.T) {
		rec := app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token))
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var list []service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &list)
		if len(list) != 1 {
			t.Fatalf("expected 1 applicant, got %d", len(list))
		}
		if list[0].NationalID != "1509900112233" {
			t.Errorf("admin list should return the full national ID, got %q", list[0].NationalID)
		}
	})

	t.Run("8. PATCH /api/admin/applications/{id} -> PASSED", func(t *testing.T) {
		app.setStatus(t, token, created.ID, domain.StatusPassed)
	})

	t.Run("9. POST /api/applications/{id}/confirm", func(t *testing.T) {
		// verifyCode = last 4 digits of the national ID 1509900112233 (AGENTS.md §13.5).
		rec := app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/confirm", bytes.NewBufferString(`{"confirmed":true,"verifyCode":"2233"}`), nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if !res.AttendanceConfirmed {
			t.Errorf("expected attendanceConfirmed to be true")
		}
	})

	t.Run("10. Upload slip, then admin fetches it through the authenticated endpoint", func(t *testing.T) {
		rec := app.uploadSlip(t, created.ID, "slip_transfer_kbank.jpg", jpegBytes)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
		}
		var slipRes service.SlipUploadResult
		_ = json.Unmarshal(rec.Body.Bytes(), &slipRes)
		if !slipRes.HasSlip || slipRes.SlipStatus != domain.PaymentPending {
			t.Errorf("unexpected upload result: %+v", slipRes)
		}

		fetch := app.do(t, http.MethodGet, service.AdminSlipPath(created.ID), nil, bearer(token))
		if fetch.Code != http.StatusOK {
			t.Fatalf("expected 200 when admin fetches slip, got %d", fetch.Code)
		}
		if ct := fetch.Header().Get("Content-Type"); ct != "image/jpeg" {
			t.Errorf("expected image/jpeg, got %q", ct)
		}
		if !bytes.Equal(fetch.Body.Bytes(), jpegBytes) {
			t.Errorf("fetched slip bytes do not match uploaded bytes")
		}
	})

	t.Run("11. Upload duplicate slip -> 409 Conflict", func(t *testing.T) {
		rec := app.uploadSlip(t, created.ID, "same_slip_reused.jpg", jpegBytes)
		if rec.Code != http.StatusConflict {
			t.Fatalf("expected 409 Conflict, got %d (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("12. PATCH verify-slip -> CONFIRMED", func(t *testing.T) {
		body := bytes.NewBufferString(`{"approved":true,"note":"ยอดเงินเข้าบัญชีถูกต้องครบถ้วน"}`)
		rec := app.do(t, http.MethodPatch, "/api/admin/applications/"+created.ID+"/verify-slip", body, bearer(token))
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("13. Final public status is CONFIRMED with an approved slip", func(t *testing.T) {
		rec := app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		var final service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &final)
		if final.Status != domain.StatusConfirmed {
			t.Errorf("expected final status CONFIRMED, got %s", final.Status)
		}
		if !final.HasSlip || final.SlipStatus == nil || *final.SlipStatus != domain.PaymentApproved {
			t.Errorf("expected an approved slip, got hasSlip=%v slipStatus=%v", final.HasSlip, final.SlipStatus)
		}
	})
}
