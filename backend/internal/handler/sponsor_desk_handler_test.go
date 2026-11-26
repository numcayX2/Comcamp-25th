package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

type recordingInquiryNotifier struct {
	mu   sync.Mutex
	sent []service.SponsorInquiryEmailData
}

func (n *recordingInquiryNotifier) EnqueueSponsorInquiry(d service.SponsorInquiryEmailData) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, d)
}

func (n *recordingInquiryNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sent)
}

type sponsorDeskApp struct {
	*sponsorTestApp
	inquiryRepo  *memory.MemorySponsorInquiryRepo
	donationRepo *memory.MemorySponsorDonationRepo
	notifier     *recordingInquiryNotifier
	docsDir      string
}

func setupSponsorDeskApp(t *testing.T, captcha service.TurnstileVerifier) *sponsorDeskApp {
	t.Helper()
	limits := server.DefaultRateLimits()
	limits.SponsorInquiry = middleware.NewRateLimiter(10_000, time.Minute)
	return setupSponsorDeskAppWith(t, captcha, limits)
}

func setupSponsorDeskAppWith(t *testing.T, captcha service.TurnstileVerifier, limits server.RateLimits) *sponsorDeskApp {
	t.Helper()
	base := setupSponsorTestApp(t)

	// Rebuild the router with the sponsor desk services on top of the same repositories.
	uploadDir := filepath.Dir(base.sponsorDir)
	inquiryRepo := memory.NewMemorySponsorInquiryRepo(base.auditRepo)
	donationRepo := memory.NewMemorySponsorDonationRepo(base.auditRepo)
	notifier := &recordingInquiryNotifier{}
	inquirySvc := service.NewSponsorInquiryService(inquiryRepo, base.auditRepo, uploadDir).WithNotifier(notifier)
	if captcha != nil {
		inquirySvc.WithTurnstile(captcha)
	}
	base.Handler = server.NewRouter(server.Services{
		Auth:            service.NewAuthService(sponsorAdminRepo(t, base), base.auditRepo, "test-jwt-secret-key-32-characters-long"),
		Sponsor:         service.NewSponsorService(base.sponsorRepo, uploadDir),
		SponsorInquiry:  inquirySvc,
		SponsorDonation: service.NewSponsorDonationService(donationRepo, base.auditRepo, uploadDir).WithInquiries(inquiryRepo),
	}, server.Options{RateLimits: limits})
	return &sponsorDeskApp{
		sponsorTestApp: base, inquiryRepo: inquiryRepo, donationRepo: donationRepo,
		notifier: notifier, docsDir: filepath.Join(uploadDir, "sponsor-docs"),
	}
}

// sponsorAdminRepo creates a fresh admin store holding the test admin (the base app's store is
// not exported), so login works against the rebuilt router.
func sponsorAdminRepo(t *testing.T, base *sponsorTestApp) *memory.MemoryAdminRepo {
	t.Helper()
	repo := memory.NewMemoryAdminRepo()
	hash, err := service.HashPassword(testAdminPass)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(context.Background(), &domain.Admin{
		Username: testAdminUser, PasswordHash: hash, FullName: "Sponsor Admin", Role: domain.RoleAdmin, IsActive: true,
	}); err != nil {
		t.Fatal(err)
	}
	return repo
}

func (a *sponsorDeskApp) auditCount(action domain.AuditAction) int {
	n := 0
	for _, e := range a.auditRepo.Entries() {
		if e.Action == action {
			n++
		}
	}
	return n
}

func (a *sponsorDeskApp) postInquiry(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return a.do(t, http.MethodPost, "/api/sponsor-inquiries", bytes.NewBufferString(body), nil)
}

func (a *sponsorDeskApp) authed(t *testing.T, token, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *bytes.Buffer
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	if r == nil {
		return a.do(t, method, target, nil, bearer(token))
	}
	return a.do(t, method, target, r, bearer(token))
}

func expectCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("expected %d, got %d (%s)", status, rec.Code, rec.Body.String())
	}
	if code != "" {
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != code {
			t.Fatalf("expected code %s, got %q", code, e.Code)
		}
	}
}

const validMoneyTaxAddrJSON = `"taxId":"๑-๑๐๑๗-๐๐๒๐๓-๔๕-๐\u200b","addressLine":" 63 หมู่ 4 ถ.เชียงใหม่-พร้าว ","subdistrict":"หนองหาร","district":"สันทราย","province":"จ. เชียงใหม่","postcode":"๕๐๒๙๐"`

// validMoneyJSON is a complete valid money inquiry tail: amount plus tax ID and address.
const validMoneyJSON = `"amount":"1500",` + validMoneyTaxAddrJSON

func TestSponsorInquiry_JSONMoneyNeedsSlip(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	rec := app.postInquiry(t, `{"name":"ร้าน","phone":"0812345678","kind":"money",`+validMoneyJSON+`}`)
	expectCode(t, rec, http.StatusBadRequest, response.CodeValidation)
	if e := decodeErr(t, rec.Body.Bytes()); e.Error != "slip is required for money donations" {
		t.Fatalf("error = %q", e.Error)
	}
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatal("JSON money inquiry was stored")
	}
}

func TestSponsorInquiry_SubmitStoresAndNotifiesWithoutEcho(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["staff@example.com","boss@example.com"]}`), http.StatusOK, "")

	// Web mode: typed tax ID + address with the transfer slip, no filled form.
	slip := encodePNG(20, 10)
	var fields map[string]string
	_ = json.Unmarshal([]byte(`{"name":"  ร้านตัวอย่าง ","phone":"๐๘๑-๒๓๔-๕๖๗๘\u200b","email":"Shop@Example.com","kind":"money","details":"ติดต่อช่วงเย็น\r\nขอบคุณ","amount":"๑,๕๐๐.50",`+validMoneyTaxAddrJSON+`}`), &fields)
	rec := app.postInquiryUpload(t, fields, slipPart("slip.png", slip))
	expectCode(t, rec, http.StatusCreated, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", got)
	}

	list, _ := app.inquiryRepo.List(context.Background())
	if len(list) != 1 {
		t.Fatalf("stored inquiries = %d, want 1", len(list))
	}
	if list[0].Slip == nil || list[0].File != nil {
		t.Fatalf("web-mode inquiry must have a slip and no form: slip %+v file %+v", list[0].Slip, list[0].File)
	}
	got := list[0]
	if got.Name != "ร้านตัวอย่าง" || got.Phone != "0812345678" || got.Email != "shop@example.com" || got.Details != "ติดต่อช่วงเย็น\nขอบคุณ" ||
		got.TaxID != "1101700203450" || got.AddressLine != "63 หมู่ 4 ถ.เชียงใหม่-พร้าว" || got.Subdistrict != "หนองหาร" ||
		got.District != "สันทราย" || got.Province != "เชียงใหม่" || got.Postcode != "50290" || got.Amount == nil || *got.Amount != "1500.5" {
		t.Fatalf("stored inquiry not normalised: %+v", got)
	}
	if app.notifier.count() != 2 {
		t.Fatalf("notifications = %d, want 2", app.notifier.count())
	}
	// Notification emails must never carry taxId or address fields.
	app.notifier.mu.Lock()
	for _, n := range app.notifier.sent {
		rawMail, _ := json.Marshal(n)
		s := string(rawMail)
		for _, secret := range []string{"1101700203450", "63 หมู่ 4", "หนองหาร", "สันทราย", "50290"} {
			if strings.Contains(s, secret) {
				t.Fatalf("notification payload leaked %q: %s", secret, s)
			}
		}
	}
	app.notifier.mu.Unlock()
	app.notifier.mu.Lock()
	for _, n := range app.notifier.sent {
		if n.Amount == nil || *n.Amount != "1500.5" || !n.HasSlip || n.FileMIME != "" {
			t.Fatalf("notification = %+v, want amount 1500.5 with slip", n)
		}
	}
	app.notifier.mu.Unlock()
	if app.auditCount(domain.AuditSponsorInquiryCreate) != 1 {
		t.Fatal("missing sponsor.inquiry.create audit row")
	}
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorInquiryCreate {
			if len(e.Details) != 3 || e.Details["kind"] != "money" || e.Details["slipMime"] != "image/png" || e.Details["slipSize"] == nil {
				t.Fatalf("inquiry audit details must hold kind and slip mime/size only: %+v", e.Details)
			}
		}
	}

	// Admin list returns full unmasked taxId + address; PATCH handled; DELETE.
	rec = app.authed(t, token, http.MethodGet, "/api/admin/sponsor-inquiries", "")
	expectCode(t, rec, http.StatusOK, "")
	var res struct {
		Inquiries []service.SponsorInquiryEntry `json:"inquiries"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if len(res.Inquiries) != 1 || res.Inquiries[0].Handled ||
		res.Inquiries[0].TaxID != "1101700203450" ||
		res.Inquiries[0].AddressLine != "63 หมู่ 4 ถ.เชียงใหม่-พร้าว" ||
		res.Inquiries[0].Subdistrict != "หนองหาร" ||
		res.Inquiries[0].District != "สันทราย" ||
		res.Inquiries[0].Province != "เชียงใหม่" ||
		res.Inquiries[0].Postcode != "50290" ||
		res.Inquiries[0].Amount == nil || *res.Inquiries[0].Amount != "1500.5" ||
		res.Inquiries[0].File != nil || res.Inquiries[0].Slip == nil ||
		res.Inquiries[0].Slip.MIME != "image/png" || res.Inquiries[0].Slip.Size != len(slip) ||
		!res.Inquiries[0].Slip.UploadedAt.Equal(res.Inquiries[0].CreatedAt) {
		t.Fatalf("admin list = %+v", res.Inquiries)
	}
	if strings.Contains(rec.Body.String(), "sponsor-docs") || strings.Contains(rec.Body.String(), "inquiry-slip-") {
		t.Fatal("admin list leaks the stored slip path")
	}
	id := res.Inquiries[0].ID
	rec = app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", id), "")
	expectCode(t, rec, http.StatusOK, "")
	if !bytes.Equal(rec.Body.Bytes(), slip) {
		t.Fatal("served slip differs from upload")
	}
	for h, want := range map[string]string{
		"Content-Type":           "image/png",
		"Cache-Control":          "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Disposition":    fmt.Sprintf(`inline; filename="sponsor-inquiry-slip-%d.png"`, id),
	} {
		if got := rec.Header().Get(h); got != want {
			t.Fatalf("%s = %q, want %q", h, got, want)
		}
	}
	if app.auditCount(domain.AuditSponsorInquirySlipView) != 1 {
		t.Fatal("slip view not audited")
	}
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", id), ""), http.StatusNotFound, response.CodeNotFound)
	rec = app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), `{"handled":true}`)
	expectCode(t, rec, http.StatusOK, "")
	var upd service.SponsorInquiryEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &upd)
	if !upd.Handled || upd.HandledAt == nil {
		t.Fatalf("handled not set: %+v", upd)
	}
	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), ""), http.StatusNoContent, "")
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("inquiry delete must remove its slip: %v", files)
	}
	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), ""), http.StatusNotFound, response.CodeNotFound)
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", id), ""), http.StatusNotFound, response.CodeNotFound)
}

func TestSponsorInquiry_ValidationFailures(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	long := strings.Repeat("ก", 501)
	longAddr := strings.Repeat("ก", 201)
	longArea := strings.Repeat("ก", 101)
	goods := map[string]string{
		"bad phone":         `{"name":"ร้าน","phone":"12345","kind":"goods"}`,
		"phone no lead 0":   `{"name":"ร้าน","phone":"812345678","kind":"goods"}`,
		"phone 11 digits":   `{"name":"ร้าน","phone":"08123456789","kind":"goods"}`,
		"missing name":      `{"name":"  ","phone":"0812345678","kind":"goods"}`,
		"bad kind":          `{"name":"ร้าน","phone":"0812345678","kind":"alcohol"}`,
		"long details":      `{"name":"ร้าน","phone":"0812345678","kind":"goods","details":"` + long + `"}`,
		"bad email":         `{"name":"ร้าน","phone":"0812345678","kind":"goods","email":"not-an-email"}`,
		"control in name":   `{"name":"ร้าน\u0007","phone":"0812345678","kind":"goods"}`,
		"goods with taxId":  `{"name":"ร้าน","phone":"0812345678","kind":"goods","taxId":"1101700203450"}`,
		"goods with addr":   `{"name":"ร้าน","phone":"0812345678","kind":"goods","addressLine":"1"}`,
		"goods with sub":    `{"name":"ร้าน","phone":"0812345678","kind":"goods","subdistrict":"หนองหาร"}`,
		"goods with dist":   `{"name":"ร้าน","phone":"0812345678","kind":"goods","district":"สันทราย"}`,
		"goods with prov":   `{"name":"ร้าน","phone":"0812345678","kind":"goods","province":"เชียงใหม่"}`,
		"goods with post":   `{"name":"ร้าน","phone":"0812345678","kind":"goods","postcode":"50290"}`,
		"goods with amount": `{"name":"ร้าน","phone":"0812345678","kind":"goods","amount":"500"}`,
	}
	// Money goes through the upload route in web mode (valid slip attached): tax ID and address are
	// validated exactly like the old JSON route.
	money := map[string]string{
		"money missing all":  `{"name":"ร้าน","phone":"0812345678","kind":"money"}`,
		"money missing tax":  `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money bad checksum": `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203451","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money short tax":    `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"110170020345","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money alpha tax":    `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"110170020345a","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money missing addr": `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money long addr":    `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"` + longAddr + `","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money ctrl addr":    `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1\n2","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money missing sub":  `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money long sub":     `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","subdistrict":"` + longArea + `","district":"สันทราย","province":"เชียงใหม่","postcode":"50290"}`,
		"money missing dist": `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","subdistrict":"หนองหาร","province":"เชียงใหม่","postcode":"50290"}`,
		"money bad province": `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"ดาวอังคาร","postcode":"50290"}`,
		"money bad postcode": `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"5029"}`,
		"money dash post":    `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203450","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50-290"}`,
		"money no amount":    `{"name":"ร้าน","phone":"0812345678","kind":"money",` + validMoneyTaxAddrJSON + `}`,
		"money amount 0":     `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"0",` + validMoneyTaxAddrJSON + `}`,
		"money amount neg":   `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"-5",` + validMoneyTaxAddrJSON + `}`,
		"money amount 3dp":   `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1.234",` + validMoneyTaxAddrJSON + `}`,
		"money amount abc":   `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"abc",` + validMoneyTaxAddrJSON + `}`,
		"money amount cap":   `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"10000000.01",` + validMoneyTaxAddrJSON + `}`,
	}
	for name, body := range goods {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.postInquiry(t, body), http.StatusBadRequest, response.CodeValidation)
		})
	}
	for name, body := range money {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.postMoneyWeb(t, body), http.StatusBadRequest, response.CodeValidation)
		})
	}
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatalf("invalid inquiries were stored: %d", len(list))
	}
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("invalid inquiries left files: %v", files)
	}
}

func TestSponsorInquiry_AcceptsLandline(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	expectCode(t, app.postInquiry(t, `{"name":"ร้าน","phone":"053-123-456","kind":"goods"}`), http.StatusCreated, "")
	list, _ := app.inquiryRepo.List(context.Background())
	if len(list) != 1 || list[0].Phone != "053123456" {
		t.Fatalf("landline inquiry not stored as digits: %+v", list)
	}
}

func TestSponsorInquiry_HoneypotStoresNothing(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["staff@example.com"]}`), http.StatusOK, "")

	rec := app.postInquiry(t, `{"name":"bot","phone":"0812345678","kind":"money","website":"http://spam.example"}`)
	expectCode(t, rec, http.StatusCreated, "")
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatal("honeypot submission was stored")
	}
	if app.notifier.count() != 0 {
		t.Fatal("honeypot submission sent email")
	}
}

func TestSponsorInquiry_TurnstileFailureIs403(t *testing.T) {
	captcha := &cloudflareLike{used: map[string]bool{}}
	app := setupSponsorDeskApp(t, captcha)
	// Invalid taxId fails validation before Turnstile, so the single-use token is not burnt.
	expectCode(t, app.postMoneyWeb(t, `{"name":"ร้าน","phone":"0812345678","kind":"money","amount":"1","taxId":"1101700203451","addressLine":"1","subdistrict":"หนองหาร","district":"สันทราย","province":"เชียงใหม่","postcode":"50290","turnstileToken":"good-1"}`), http.StatusBadRequest, response.CodeValidation)
	rec := app.postMoneyWeb(t, `{"name":"ร้าน","phone":"0812345678","kind":"money",`+validMoneyJSON+`,"turnstileToken":"bad"}`)
	expectCode(t, rec, http.StatusForbidden, response.CodeCaptchaFailed)
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatal("inquiry stored despite captcha failure")
	}
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("captcha failure left a slip: %v", files)
	}
	expectCode(t, app.postMoneyWeb(t, `{"name":"ร้าน","phone":"0812345678","kind":"money",`+validMoneyJSON+`,"turnstileToken":"good-1"}`), http.StatusCreated, "")
	expectCode(t, app.postInquiry(t, `{"name":"ร้าน","phone":"0812345678","kind":"goods","turnstileToken":"bad"}`), http.StatusForbidden, response.CodeCaptchaFailed)
}

func TestSponsorInquiry_RateLimited(t *testing.T) {
	app := setupSponsorDeskAppWith(t, nil, server.DefaultRateLimits())
	body := `{"name":"ร้าน","phone":"0812345678","kind":"goods"}`
	for range server.SponsorInquiryRatePer10Min {
		expectCode(t, app.postInquiry(t, body), http.StatusCreated, "")
	}
	rec := app.postInquiry(t, body)
	expectCode(t, rec, http.StatusTooManyRequests, response.CodeRateLimited)
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	// Sending the money form (slip upload) shares the same per-IP bucket.
	pdf := []byte("%PDF-1.4\n%%EOF\n")
	expectCode(t, app.postInquiryUpload(t, map[string]string{"name": "ร้าน", "phone": "0812345678", "amount": "1200"}, formPart("form.pdf", pdf), validSlip()), http.StatusTooManyRequests, response.CodeRateLimited)
}

func TestSponsorDesk_AdminRoutesRequireToken(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/sponsor-inquiries"},
		{http.MethodPatch, "/api/admin/sponsor-inquiries/1"},
		{http.MethodDelete, "/api/admin/sponsor-inquiries/1"},
		{http.MethodGet, "/api/admin/sponsor-inquiries/1/file"},
		{http.MethodGet, "/api/admin/sponsor-inquiries/1/slip"},
		{http.MethodGet, "/api/admin/sponsor-notify-emails"},
		{http.MethodPut, "/api/admin/sponsor-notify-emails"},
		{http.MethodGet, "/api/admin/sponsor-donations"},
		{http.MethodPost, "/api/admin/sponsor-donations"},
		{http.MethodPatch, "/api/admin/sponsor-donations/1"},
		{http.MethodDelete, "/api/admin/sponsor-donations/1"},
		{http.MethodPut, "/api/admin/sponsor-donations/1/files/signed"},
		{http.MethodGet, "/api/admin/sponsor-donations/1/files/signed"},
		{http.MethodDelete, "/api/admin/sponsor-donations/1/files/signed"},
	}
	for _, rt := range routes {
		if rec := app.do(t, rt.method, rt.path, nil, nil); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without token: expected 401, got %d", rt.method, rt.path, rec.Code)
		}
		if rec := app.do(t, rt.method, rt.path, nil, bearer("not-a-jwt")); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with invalid token: expected 401, got %d", rt.method, rt.path, rec.Code)
		}
	}
}

func TestSponsorNotifyEmails_NormaliseDedupeAndLimits(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)

	rec := app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":[" B@Example.com ","a@example.com","b@example.com"]}`)
	expectCode(t, rec, http.StatusOK, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"emails":["b@example.com","a@example.com"]}` {
		t.Fatalf("normalised emails = %s", got)
	}
	rec = app.authed(t, token, http.MethodGet, "/api/admin/sponsor-notify-emails", "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"emails":["b@example.com","a@example.com"]}` {
		t.Fatalf("GET emails = %s", got)
	}

	eleven := make([]string, 11)
	for i := range eleven {
		eleven[i] = fmt.Sprintf("%q", fmt.Sprintf("s%d@example.com", i))
	}
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":[`+strings.Join(eleven, ",")+`]}`), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["Name <x@example.com>"]}`), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["nope"]}`), http.StatusBadRequest, response.CodeValidation)

	rec = app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":[]}`)
	expectCode(t, rec, http.StatusOK, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"emails":[]}` {
		t.Fatalf("empty list = %s", got)
	}
}

func (a *sponsorDeskApp) createDonation(t *testing.T, token, body string) service.SponsorDonationEntry {
	t.Helper()
	rec := a.authed(t, token, http.MethodPost, "/api/admin/sponsor-donations", body)
	expectCode(t, rec, http.StatusCreated, "")
	var d service.SponsorDonationEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestSponsorDonation_CreateUpdateAndValidation(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)

	d := app.createDonation(t, token, `{"donorName":"บริษัท ก","address":"1 ถ.เชียงใหม่\nแม่โจ้","phone":"053-123456","kind":"money","amount":"1500.50","goodsDescription":"","donatedOn":"2026-11-20","note":"","taxId":"0-1055-58001-23-1","addressLine":"63 หมู่ 4","subdistrict":"หนองหาร","district":"สันทราย","province":"กทม","postcode":"10110","facultySubmitted":false}`)
	if d.Amount == nil || *d.Amount != "1500.5" || d.Phone != "053123456" || d.DonatedOn != "2026-11-20" || d.FacultySubmitted || d.Files.Signed != nil ||
		d.TaxID != "0105558001231" || d.AddressLine != "63 หมู่ 4" || d.Province != "กรุงเทพมหานคร" || d.Postcode != "10110" {
		t.Fatalf("created donation = %+v", d)
	}

	for name, body := range map[string]string{
		"money without amount":     `{"donorName":"ก","kind":"money","amount":null}`,
		"money zero amount":        `{"donorName":"ก","kind":"money","amount":"0"}`,
		"money too many decimals":  `{"donorName":"ก","kind":"money","amount":"1.005"}`,
		"money over cap":           `{"donorName":"ก","kind":"money","amount":"10000000.01"}`,
		"money with goods":         `{"donorName":"ก","kind":"money","amount":"100","goodsDescription":"น้ำดื่ม"}`,
		"money bad taxId":          `{"donorName":"ก","kind":"money","amount":"100","taxId":"1101700203451"}`,
		"money bad province":       `{"donorName":"ก","kind":"money","amount":"100","province":"ดาวอังคาร"}`,
		"money bad postcode":       `{"donorName":"ก","kind":"money","amount":"100","postcode":"5029"}`,
		"money ctrl addressLine":   `{"donorName":"ก","kind":"money","amount":"100","addressLine":"1\n2"}`,
		"goods without desc":       `{"donorName":"ก","kind":"goods","amount":null}`,
		"goods with taxId":         `{"donorName":"ก","kind":"goods","goodsDescription":"น้ำดื่ม","taxId":"1101700203450"}`,
		"goods with addressLine":   `{"donorName":"ก","kind":"goods","goodsDescription":"น้ำดื่ม","addressLine":"1"}`,
		"goods with province":      `{"donorName":"ก","kind":"goods","goodsDescription":"น้ำดื่ม","province":"เชียงใหม่"}`,
		"goods with postcode":      `{"donorName":"ก","kind":"goods","goodsDescription":"น้ำดื่ม","postcode":"50290"}`,
		"bad date":                 `{"donorName":"ก","kind":"money","amount":"100","donatedOn":"2026-02-30"}`,
		"bad phone":                `{"donorName":"ก","kind":"money","amount":"100","phone":"12345"}`,
		"missing donor":            `{"donorName":"","kind":"money","amount":"100"}`,
		"bad kind":                 `{"donorName":"ก","kind":"beer","amount":"100"}`,
		"exponent amount rejected": `{"donorName":"ก","kind":"money","amount":"1e3"}`,
	} {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.authed(t, token, http.MethodPost, "/api/admin/sponsor-donations", body), http.StatusBadRequest, response.CodeValidation)
		})
	}

	g := app.createDonation(t, token, `{"donorName":"ร้าน ข","kind":"goods","amount":null,"goodsDescription":"น้ำดื่ม 10 แพ็ค"}`)
	if g.Amount != nil || g.GoodsDescription != "น้ำดื่ม 10 แพ็ค" {
		t.Fatalf("goods donation = %+v", g)
	}

	// PATCH rejects bad taxId or goods with tax/address.
	expectCode(t, app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-donations/%d", d.ID),
		`{"donorName":"บริษัท ก","kind":"money","amount":"1500.5","taxId":"1101700203451"}`), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-donations/%d", g.ID),
		`{"donorName":"ร้าน ข","kind":"goods","goodsDescription":"น้ำดื่ม","postcode":"50290"}`), http.StatusBadRequest, response.CodeValidation)

	rec := app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-donations/%d", d.ID),
		`{"donorName":"บริษัท ก จำกัด","address":"1 ถ.เชียงใหม่\nแม่โจ้","phone":"053123456","kind":"money","amount":"1500.5","goodsDescription":"","donatedOn":"2026-11-20","note":"","taxId":"1101700203450","addressLine":"63 หมู่ 4","subdistrict":"หนองหาร","district":"สันทราย","province":"กรุงเทพมหานคร","postcode":"10110","facultySubmitted":true}`)
	expectCode(t, rec, http.StatusOK, "")
	var upd service.SponsorDonationEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &upd)
	if upd.DonorName != "บริษัท ก จำกัด" || !upd.FacultySubmitted || upd.FacultySubmittedAt == nil || upd.TaxID != "1101700203450" {
		t.Fatalf("updated = %+v", upd)
	}
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorDonationUpdate {
			fields, _ := e.Details["fields"].([]string)
			if strings.Join(fields, ",") != "donorName,taxId,facultySubmitted" {
				t.Fatalf("update audit fields = %v", e.Details["fields"])
			}
			// Audit details must carry field names only, never sensitive values.
			rawAudit, _ := json.Marshal(e.Details)
			if strings.Contains(string(rawAudit), "1101700203450") || strings.Contains(string(rawAudit), "63 หมู่ 4") {
				t.Fatalf("donation audit leaked values: %s", string(rawAudit))
			}
		}
	}

	rec = app.authed(t, token, http.MethodGet, "/api/admin/sponsor-donations", "")
	var list struct {
		Donations []service.SponsorDonationEntry `json:"donations"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list.Donations) != 2 || list.Donations[0].ID != g.ID {
		t.Fatalf("list must be newest first: %+v", list.Donations)
	}
	expectCode(t, app.authed(t, token, http.MethodPatch, "/api/admin/sponsor-donations/999", `{"donorName":"ก","kind":"money","amount":"1"}`), http.StatusNotFound, response.CodeNotFound)
}

func donationFileBody(t *testing.T, name string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	_ = w.Close()
	return &buf, w.FormDataContentType()
}

func (a *sponsorDeskApp) putFile(t *testing.T, token string, id int64, kind, name string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := donationFileBody(t, name, data)
	h := bearer(token)
	h["Content-Type"] = ct
	return a.do(t, http.MethodPut, fmt.Sprintf("/api/admin/sponsor-donations/%d/files/%s", id, kind), body, h)
}

func (a *sponsorDeskApp) docFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(a.docsDir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestSponsorDonation_FileUploadServeDelete(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	d := app.createDonation(t, token, `{"donorName":"บริษัท ก","kind":"money","amount":"1200"}`)

	pdf := []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
	for _, tc := range []struct {
		kind, name, mime string
		data             []byte
	}{
		{"signed", "form.pdf", "application/pdf", pdf},
		{"slip", "slip.jpg", "image/jpeg", encodeJPEG(20, 10)},
		{"slip", "slip.png", "image/png", encodePNG(20, 10)},
		{"signed", "scan.webp", "image/webp", webpVP8XHeader(30, 40)},
	} {
		rec := app.putFile(t, token, d.ID, tc.kind, tc.name, tc.data)
		expectCode(t, rec, http.StatusOK, "")
		var got service.SponsorDonationEntry
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		f := got.Files.Signed
		if tc.kind == "slip" {
			f = got.Files.Slip
		}
		if f == nil || f.MIME != tc.mime {
			t.Fatalf("%s: file entry = %+v", tc.name, f)
		}
	}
	// Replacements removed the old files: one signed + one slip on disk.
	if files := app.docFiles(t); len(files) != 2 {
		t.Fatalf("files on disk after replacements = %v", files)
	}

	for name, data := range map[string][]byte{
		"evil.svg":  []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`),
		"evil.html": []byte(`<!DOCTYPE html><html><script>alert(1)</script></html>`),
		"anim.gif":  []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
	} {
		expectCode(t, app.putFile(t, token, d.ID, "slip", name, data), http.StatusBadRequest, response.CodeValidation)
	}
	big := append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("a"), service.MaxSponsorDocBytes)...)
	expectCode(t, app.putFile(t, token, d.ID, "slip", "big.pdf", big), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge)
	expectCode(t, app.putFile(t, token, d.ID, "receipt", "x.pdf", pdf), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.putFile(t, token, 999, "slip", "x.pdf", pdf), http.StatusNotFound, response.CodeNotFound)
	if files := app.docFiles(t); len(files) != 2 {
		t.Fatalf("rejected uploads left files on disk: %v", files)
	}

	rec := app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-donations/%d/files/signed", d.ID), "")
	expectCode(t, rec, http.StatusOK, "")
	if !bytes.Equal(rec.Body.Bytes(), webpVP8XHeader(30, 40)) {
		t.Fatal("served bytes differ from upload")
	}
	for h, want := range map[string]string{
		"Content-Type":           "image/webp",
		"Cache-Control":          "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Disposition":    fmt.Sprintf(`inline; filename="sponsor-%d-signed.webp"`, d.ID),
	} {
		if got := rec.Header().Get(h); got != want {
			t.Fatalf("%s = %q, want %q", h, got, want)
		}
	}
	if app.auditCount(domain.AuditSponsorDonationFileView) != 1 {
		t.Fatal("file view not audited")
	}

	rec = app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-donations/%d/files/signed", d.ID), "")
	expectCode(t, rec, http.StatusOK, "")
	if files := app.docFiles(t); len(files) != 1 || !strings.Contains(files[0], "-slip-") {
		t.Fatalf("file delete must remove the signed file: %v", files)
	}
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-donations/%d/files/signed", d.ID), ""), http.StatusNotFound, response.CodeNotFound)

	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-donations/%d", d.ID), ""), http.StatusNoContent, "")
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("donation delete must remove its files: %v", files)
	}
}

func TestSponsorDonation_OversizedImageDimensions(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	d := app.createDonation(t, token, `{"donorName":"ก","kind":"money","amount":"1"}`)
	expectCode(t, app.putFile(t, token, d.ID, "signed", "huge.webp", webpVP8XHeader(10001, 10)), http.StatusBadRequest, response.CodeInvalidImageDims)
}

// uploadPart is one file part of a POST /api/sponsor-inquiries/upload body.
type uploadPart struct {
	field, name string
	data        []byte
}

func formPart(name string, data []byte) uploadPart { return uploadPart{"file", name, data} }

func slipPart(name string, data []byte) uploadPart { return uploadPart{"slip", name, data} }

// validSlip is a small PNG transfer slip (PNG is stored byte for byte).
func validSlip() uploadPart { return slipPart("slip.png", encodePNG(20, 10)) }

// moneyWebFields is a complete valid web-mode (no form attached) money inquiry.
func moneyWebFields() map[string]string {
	return map[string]string{
		"name": "ร้าน", "phone": "0812345678", "amount": "1500", "taxId": "1101700203450", "addressLine": "63 หมู่ 4",
		"subdistrict": "หนองหาร", "district": "สันทราย", "province": "เชียงใหม่", "postcode": "50290",
	}
}

// inquiryUploadBody builds a POST /api/sponsor-inquiries/upload body from text fields and file parts.
func inquiryUploadBody(t *testing.T, fields map[string]string, parts ...uploadPart) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range parts {
		part, err := w.CreateFormFile(p.field, p.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(p.data)
	}
	_ = w.Close()
	return &buf, w.FormDataContentType()
}

func (a *sponsorDeskApp) postInquiryUpload(t *testing.T, fields map[string]string, parts ...uploadPart) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := inquiryUploadBody(t, fields, parts...)
	return a.do(t, http.MethodPost, "/api/sponsor-inquiries/upload", body, map[string]string{"Content-Type": ct})
}

// postMoneyWeb sends a JSON-shaped money inquiry through the upload route in web mode (no form)
// with a valid slip.
func (a *sponsorDeskApp) postMoneyWeb(t *testing.T, jsonBody string) *httptest.ResponseRecorder {
	t.Helper()
	var fields map[string]string
	if err := json.Unmarshal([]byte(jsonBody), &fields); err != nil {
		t.Fatalf("bad test body %s: %v", jsonBody, err)
	}
	return a.postInquiryUpload(t, fields, validSlip())
}

func (a *sponsorDeskApp) listInquiries(t *testing.T, token string) []service.SponsorInquiryEntry {
	t.Helper()
	rec := a.authed(t, token, http.MethodGet, "/api/admin/sponsor-inquiries", "")
	expectCode(t, rec, http.StatusOK, "")
	var res struct {
		Inquiries []service.SponsorInquiryEntry `json:"inquiries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	return res.Inquiries
}

func countPrefix(names []string, prefix string) int {
	n := 0
	for _, name := range names {
		if strings.HasPrefix(name, prefix) {
			n++
		}
	}
	return n
}

func TestSponsorInquiryUpload_StoresServesAndDeletesForm(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["staff@example.com"]}`), http.StatusOK, "")

	pdf := []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
	slip := encodeJPEG(20, 10)
	// With the form attached, taxId/address fields are neither required nor accepted (even invalid values sent alongside are ignored).
	rec := app.postInquiryUpload(t, map[string]string{
		"name": " ร้าน ค ", "phone": "081-234-5678", "amount": "๑,๒๐๐",
		"taxId": "not-a-tax-id", "addressLine": "should be ignored", "province": "ดาวอังคาร", "postcode": "abc",
	}, formPart("form.pdf", pdf), slipPart("slip.jpg", slip))
	expectCode(t, rec, http.StatusCreated, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", got)
	}
	// A typed goods inquiry next to it has no file.
	expectCode(t, app.postInquiry(t, `{"name":"ร้าน ง","phone":"0812345679","kind":"goods"}`), http.StatusCreated, "")

	rec = app.authed(t, token, http.MethodGet, "/api/admin/sponsor-inquiries", "")
	expectCode(t, rec, http.StatusOK, "")
	var res struct {
		Inquiries []service.SponsorInquiryEntry `json:"inquiries"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if len(res.Inquiries) != 2 {
		t.Fatalf("admin list = %+v", res.Inquiries)
	}
	var withFile, typed service.SponsorInquiryEntry
	for _, e := range res.Inquiries {
		if e.Name == "ร้าน ค" {
			withFile = e
		} else {
			typed = e
		}
	}
	if withFile.Kind != "money" || withFile.Phone != "0812345678" || withFile.File == nil ||
		withFile.File.MIME != "application/pdf" || withFile.File.Size != len(pdf) ||
		withFile.Slip == nil || withFile.Slip.MIME != "image/jpeg" || withFile.Slip.Size <= 0 ||
		withFile.TaxID != "" || withFile.AddressLine != "" || withFile.Province != "" || withFile.Postcode != "" ||
		withFile.Amount == nil || *withFile.Amount != "1200" || typed.Amount != nil {
		t.Fatalf("uploaded inquiry = %+v (file %+v, slip %+v)", withFile, withFile.File, withFile.Slip)
	}
	if typed.File != nil || typed.Slip != nil {
		t.Fatalf("typed inquiry must have no file or slip: %+v %+v", typed.File, typed.Slip)
	}
	if strings.Contains(rec.Body.String(), "sponsor-docs") {
		t.Fatal("admin list leaks the stored file path")
	}
	files := app.docFiles(t)
	if len(files) != 2 || countPrefix(files, "inquiry-slip-") != 1 {
		t.Fatalf("files on disk = %v", files)
	}
	for _, f := range files {
		if strings.HasPrefix(f, "inquiry-slip-") && !strings.HasSuffix(f, ".jpg") || !strings.HasPrefix(f, "inquiry-slip-") && !strings.HasSuffix(f, ".pdf") {
			t.Fatalf("unexpected stored name %q", f)
		}
	}
	app.notifier.mu.Lock()
	sent := append([]service.SponsorInquiryEmailData{}, app.notifier.sent...)
	app.notifier.mu.Unlock()
	if len(sent) != 2 || sent[0].FileMIME != "application/pdf" || !sent[0].HasSlip || sent[1].FileMIME != "" || sent[1].HasSlip {
		t.Fatalf("notifications = %+v", sent)
	}
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorInquiryCreate && e.Details["kind"] == "money" {
			if len(e.Details) != 5 || e.Details["mime"] != "application/pdf" || e.Details["slipMime"] != "image/jpeg" {
				t.Fatalf("upload audit details = %+v", e.Details)
			}
		}
	}

	rec = app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", withFile.ID), "")
	expectCode(t, rec, http.StatusOK, "")
	if !bytes.Equal(rec.Body.Bytes(), pdf) {
		t.Fatal("served bytes differ from upload")
	}
	for h, want := range map[string]string{
		"Content-Type":           "application/pdf",
		"Cache-Control":          "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Disposition":    fmt.Sprintf(`inline; filename="sponsor-inquiry-%d.pdf"`, withFile.ID),
	} {
		if got := rec.Header().Get(h); got != want {
			t.Fatalf("%s = %q, want %q", h, got, want)
		}
	}
	if app.auditCount(domain.AuditSponsorInquiryFileView) != 1 {
		t.Fatal("file view not audited")
	}
	rec = app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", withFile.ID), "")
	expectCode(t, rec, http.StatusOK, "")
	if rec.Header().Get("Content-Type") != "image/jpeg" || rec.Header().Get("Cache-Control") != "private, no-store" ||
		rec.Header().Get("Content-Disposition") != fmt.Sprintf(`inline; filename="sponsor-inquiry-slip-%d.jpg"`, withFile.ID) {
		t.Fatalf("slip headers = %v", rec.Header())
	}
	if app.auditCount(domain.AuditSponsorInquirySlipView) != 1 {
		t.Fatal("slip view not audited")
	}
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", typed.ID), ""), http.StatusNotFound, response.CodeNotFound)
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", typed.ID), ""), http.StatusNotFound, response.CodeNotFound)

	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", withFile.ID), ""), http.StatusNoContent, "")
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("inquiry delete must remove its form and slip: %v", files)
	}
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", withFile.ID), ""), http.StatusNotFound, response.CodeNotFound)
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", withFile.ID), ""), http.StatusNotFound, response.CodeNotFound)
}

func TestSponsorInquiryUpload_RejectsWithoutLeavingFiles(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	ok := map[string]string{"name": "ร้าน ค", "phone": "0812345678", "amount": "1200"}
	noTax := moneyWebFields()
	delete(noTax, "taxId")
	badTax := moneyWebFields()
	badTax["taxId"] = "1101700203451"
	pdf := []byte("%PDF-1.4\n%%EOF\n")
	form := formPart("form.pdf", pdf)
	gif := []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
	bigSlip := append(encodePNG(20, 10), bytes.Repeat([]byte{0}, service.MaxSponsorSlipBytes)...)

	for name, tc := range map[string]struct {
		fields map[string]string
		parts  []uploadPart
		status int
		code   string
	}{
		"svg":             {ok, []uploadPart{formPart("evil.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)), validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"html":            {ok, []uploadPart{formPart("evil.html", []byte(`<!DOCTYPE html><html><script>alert(1)</script></html>`)), validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"gif":             {ok, []uploadPart{formPart("anim.gif", gif), validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"empty file":      {ok, []uploadPart{formPart("form.pdf", []byte{}), validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"no slip":         {ok, []uploadPart{form}, http.StatusBadRequest, response.CodeValidation},
		"no slip web":     {moneyWebFields(), nil, http.StatusBadRequest, response.CodeValidation},
		"empty slip":      {ok, []uploadPart{form, slipPart("slip.png", []byte{})}, http.StatusBadRequest, response.CodeValidation},
		"slip pdf":        {ok, []uploadPart{form, slipPart("slip.pdf", pdf)}, http.StatusBadRequest, response.CodeValidation},
		"slip gif":        {ok, []uploadPart{form, slipPart("slip.gif", gif)}, http.StatusBadRequest, response.CodeValidation},
		"slip svg":        {ok, []uploadPart{form, slipPart("slip.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))}, http.StatusBadRequest, response.CodeValidation},
		"slip too large":  {ok, []uploadPart{form, slipPart("slip.png", bigSlip)}, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge},
		"slip huge image": {ok, []uploadPart{form, slipPart("slip.webp", webpVP8XHeader(10001, 10))}, http.StatusBadRequest, response.CodeInvalidImageDims},
		"two slips":       {ok, []uploadPart{form, validSlip(), validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"web no taxId":    {noTax, []uploadPart{validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"web bad taxId":   {badTax, []uploadPart{validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"web no address":  {ok, []uploadPart{validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"bad phone":       {map[string]string{"name": "ร้าน", "phone": "12345", "amount": "1200"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"bad kind":        {map[string]string{"name": "ร้าน", "phone": "0812345678", "kind": "alcohol"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"goods kind":      {map[string]string{"name": "ร้าน", "phone": "0812345678", "kind": "goods"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"goods kind slip": {map[string]string{"name": "ร้าน", "phone": "0812345678", "kind": "goods"}, []uploadPart{validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"no amount":       {map[string]string{"name": "ร้าน", "phone": "0812345678"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"bad amount":      {map[string]string{"name": "ร้าน", "phone": "0812345678", "amount": "1.234"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"long field":      {map[string]string{"name": strings.Repeat("ก", 2000), "phone": "0812345678"}, []uploadPart{form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
		"form too large":  {ok, []uploadPart{formPart("big.pdf", append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("a"), service.MaxSponsorDocBytes)...)), validSlip()}, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge},
		"form huge image": {ok, []uploadPart{formPart("huge.webp", webpVP8XHeader(10001, 10)), validSlip()}, http.StatusBadRequest, response.CodeInvalidImageDims},
		"two forms":       {ok, []uploadPart{form, form, validSlip()}, http.StatusBadRequest, response.CodeValidation},
	} {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.postInquiryUpload(t, tc.fields, tc.parts...), tc.status, tc.code)
		})
	}
	rec := app.postInquiryUpload(t, ok, form)
	if e := decodeErr(t, rec.Body.Bytes()); e.Error != "slip is required for money donations" {
		t.Fatalf("missing slip error = %q", e.Error)
	}
	// JSON is not a multipart form.
	expectCode(t, app.do(t, http.MethodPost, "/api/sponsor-inquiries/upload", bytes.NewBufferString(`{"name":"ร้าน"}`), nil), http.StatusBadRequest, response.CodeValidation)

	// A filled honeypot answers success but stores neither the row nor the files.
	honeypot := map[string]string{"name": "bot", "phone": "0812345678", "website": "http://spam.example"}
	expectCode(t, app.postInquiryUpload(t, honeypot, form, validSlip()), http.StatusCreated, "")

	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatalf("rejected uploads were stored: %d", len(list))
	}
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("rejected uploads left files on disk: %v", files)
	}
	if app.notifier.count() != 0 {
		t.Fatal("rejected uploads sent email")
	}
}

func TestSponsorInquiryUpload_TurnstileFailureKeepsNoFile(t *testing.T) {
	captcha := &cloudflareLike{used: map[string]bool{}}
	app := setupSponsorDeskApp(t, captcha)
	pdf := []byte("%PDF-1.4\n%%EOF\n")
	fields := map[string]string{"name": "ร้าน", "phone": "0812345678", "amount": "1200", "turnstileToken": "bad"}
	expectCode(t, app.postInquiryUpload(t, fields, formPart("form.pdf", pdf), validSlip()), http.StatusForbidden, response.CodeCaptchaFailed)
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("captcha failure left a file: %v", files)
	}
	// An invalid form or slip is refused before Turnstile, so the token is not burnt.
	fields["turnstileToken"] = "good-1"
	gif := []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")
	expectCode(t, app.postInquiryUpload(t, fields, formPart("x.gif", gif), validSlip()), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.postInquiryUpload(t, fields, formPart("form.pdf", pdf), slipPart("x.gif", gif)), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.postInquiryUpload(t, fields, formPart("form.pdf", pdf), validSlip()), http.StatusCreated, "")
	if files := app.docFiles(t); len(files) != 2 {
		t.Fatalf("files on disk = %v", files)
	}
}

func TestSponsorDonation_CreateFromInquiryCopiesSlip(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	slip := encodePNG(20, 10)
	expectCode(t, app.postInquiryUpload(t, moneyWebFields(), slipPart("slip.png", slip)), http.StatusCreated, "")
	expectCode(t, app.postInquiry(t, `{"name":"ร้าน ง","phone":"0812345679","kind":"goods"}`), http.StatusCreated, "")
	var money, goods service.SponsorInquiryEntry
	for _, e := range app.listInquiries(t, token) {
		if e.Kind == "money" {
			money = e
		} else {
			goods = e
		}
	}
	if money.Slip == nil {
		t.Fatalf("money inquiry has no slip: %+v", money)
	}

	d := app.createDonation(t, token, fmt.Sprintf(`{"donorName":"ร้าน","kind":"money","amount":"1500","fromInquiryId":%d}`, money.ID))
	if d.Files.Slip == nil || d.Files.Slip.MIME != "image/png" || d.Files.Slip.Size != len(slip) || d.Files.Signed != nil {
		t.Fatalf("donation files = %+v", d.Files)
	}
	files := app.docFiles(t)
	if len(files) != 2 || countPrefix(files, "inquiry-slip-") != 1 || countPrefix(files, fmt.Sprintf("%d-slip-", d.ID)) != 1 {
		t.Fatalf("files on disk = %v", files)
	}
	rec := app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-donations/%d/files/slip", d.ID), "")
	expectCode(t, rec, http.StatusOK, "")
	if !bytes.Equal(rec.Body.Bytes(), slip) {
		t.Fatal("copied slip differs from the inquiry slip")
	}
	var copyAudits int
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorDonationFileUp {
			copyAudits++
			if e.Details["kind"] != "slip" || e.Details["source"] != "inquiry" {
				t.Fatalf("copy audit details = %+v", e.Details)
			}
		}
	}
	if copyAudits != 1 {
		t.Fatalf("copy audits = %d, want 1", copyAudits)
	}
	// The inquiry keeps its own slip, also after the donation (and its copy) is deleted.
	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-donations/%d", d.ID), ""), http.StatusNoContent, "")
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/slip", money.ID), ""), http.StatusOK, "")
	if files := app.docFiles(t); len(files) != 1 || countPrefix(files, "inquiry-slip-") != 1 {
		t.Fatalf("files on disk after donation delete = %v", files)
	}

	// No slip to copy: goods inquiry, unknown inquiry, goods donation. Each is still created.
	for _, body := range []string{
		fmt.Sprintf(`{"donorName":"ร้าน ง","kind":"money","amount":"100","fromInquiryId":%d}`, goods.ID),
		`{"donorName":"ร้าน จ","kind":"money","amount":"100","fromInquiryId":999}`,
		fmt.Sprintf(`{"donorName":"ร้าน ฉ","kind":"goods","goodsDescription":"น้ำดื่ม","fromInquiryId":%d}`, money.ID),
	} {
		if got := app.createDonation(t, token, body); got.Files.Slip != nil {
			t.Fatalf("%s: donation got a slip %+v", body, got.Files.Slip)
		}
	}
	if files := app.docFiles(t); len(files) != 1 {
		t.Fatalf("files on disk = %v", files)
	}
}
