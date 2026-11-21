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
		SponsorDonation: service.NewSponsorDonationService(donationRepo, base.auditRepo, uploadDir),
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

func TestSponsorInquiry_SubmitStoresAndNotifiesWithoutEcho(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["staff@example.com","boss@example.com"]}`), http.StatusOK, "")

	rec := app.postInquiry(t, `{"name":"  ร้านตัวอย่าง ","phone":"๐๘๑-๒๓๔-๕๖๗๘\u200b","email":"Shop@Example.com","kind":"money","details":"ติดต่อช่วงเย็น\r\nขอบคุณ"}`)
	expectCode(t, rec, http.StatusCreated, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", got)
	}

	list, _ := app.inquiryRepo.List(context.Background())
	if len(list) != 1 {
		t.Fatalf("stored inquiries = %d, want 1", len(list))
	}
	got := list[0]
	if got.Name != "ร้านตัวอย่าง" || got.Phone != "0812345678" || got.Email != "shop@example.com" || got.Details != "ติดต่อช่วงเย็น\nขอบคุณ" {
		t.Fatalf("stored inquiry not normalised: %+v", got)
	}
	if app.notifier.count() != 2 {
		t.Fatalf("notifications = %d, want 2", app.notifier.count())
	}
	if app.auditCount(domain.AuditSponsorInquiryCreate) != 1 {
		t.Fatal("missing sponsor.inquiry.create audit row")
	}
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorInquiryCreate {
			if len(e.Details) != 1 || e.Details["kind"] != "money" {
				t.Fatalf("inquiry audit details must hold kind only: %+v", e.Details)
			}
		}
	}

	// Admin list shows it; PATCH handled; DELETE.
	rec = app.authed(t, token, http.MethodGet, "/api/admin/sponsor-inquiries", "")
	expectCode(t, rec, http.StatusOK, "")
	var res struct {
		Inquiries []service.SponsorInquiryEntry `json:"inquiries"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if len(res.Inquiries) != 1 || res.Inquiries[0].Handled {
		t.Fatalf("admin list = %+v", res.Inquiries)
	}
	id := res.Inquiries[0].ID
	rec = app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), `{"handled":true}`)
	expectCode(t, rec, http.StatusOK, "")
	var upd service.SponsorInquiryEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &upd)
	if !upd.Handled || upd.HandledAt == nil {
		t.Fatalf("handled not set: %+v", upd)
	}
	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), ""), http.StatusNoContent, "")
	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", id), ""), http.StatusNotFound, response.CodeNotFound)
}

func TestSponsorInquiry_ValidationFailures(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	long := strings.Repeat("ก", 501)
	for name, body := range map[string]string{
		"bad phone":       `{"name":"ร้าน","phone":"12345","kind":"money"}`,
		"missing name":    `{"name":"  ","phone":"0812345678","kind":"money"}`,
		"bad kind":        `{"name":"ร้าน","phone":"0812345678","kind":"alcohol"}`,
		"long details":    `{"name":"ร้าน","phone":"0812345678","kind":"goods","details":"` + long + `"}`,
		"bad email":       `{"name":"ร้าน","phone":"0812345678","kind":"goods","email":"not-an-email"}`,
		"control in name": `{"name":"ร้าน\u0007","phone":"0812345678","kind":"goods"}`,
	} {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.postInquiry(t, body), http.StatusBadRequest, response.CodeValidation)
		})
	}
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatalf("invalid inquiries were stored: %d", len(list))
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
	rec := app.postInquiry(t, `{"name":"ร้าน","phone":"0812345678","kind":"money","turnstileToken":"bad"}`)
	expectCode(t, rec, http.StatusForbidden, response.CodeCaptchaFailed)
	if list, _ := app.inquiryRepo.List(context.Background()); len(list) != 0 {
		t.Fatal("inquiry stored despite captcha failure")
	}
	expectCode(t, app.postInquiry(t, `{"name":"ร้าน","phone":"0812345678","kind":"money","turnstileToken":"good-1"}`), http.StatusCreated, "")
}

func TestSponsorInquiry_RateLimited(t *testing.T) {
	app := setupSponsorDeskAppWith(t, nil, server.DefaultRateLimits())
	body := `{"name":"ร้าน","phone":"0812345678","kind":"money"}`
	for range server.SponsorInquiryRatePer10Min {
		expectCode(t, app.postInquiry(t, body), http.StatusCreated, "")
	}
	rec := app.postInquiry(t, body)
	expectCode(t, rec, http.StatusTooManyRequests, response.CodeRateLimited)
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 without Retry-After")
	}
	// Sending the filled form instead shares the same per-IP bucket.
	pdf := []byte("%PDF-1.4\n%%EOF\n")
	expectCode(t, app.postInquiryUpload(t, map[string]string{"name": "ร้าน", "phone": "0812345678"}, "form.pdf", pdf), http.StatusTooManyRequests, response.CodeRateLimited)
}

func TestSponsorDesk_AdminRoutesRequireToken(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	routes := []struct{ method, path string }{
		{http.MethodGet, "/api/admin/sponsor-inquiries"},
		{http.MethodPatch, "/api/admin/sponsor-inquiries/1"},
		{http.MethodDelete, "/api/admin/sponsor-inquiries/1"},
		{http.MethodGet, "/api/admin/sponsor-inquiries/1/file"},
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

	d := app.createDonation(t, token, `{"donorName":"บริษัท ก","address":"1 ถ.เชียงใหม่\nแม่โจ้","phone":"053-123456","kind":"money","amount":"1500.50","goodsDescription":"","donatedOn":"2026-11-20","note":"","facultySubmitted":false}`)
	if d.Amount == nil || *d.Amount != "1500.5" || d.Phone != "053123456" || d.DonatedOn != "2026-11-20" || d.FacultySubmitted || d.Files.Signed != nil {
		t.Fatalf("created donation = %+v", d)
	}

	for name, body := range map[string]string{
		"money without amount":     `{"donorName":"ก","kind":"money","amount":null}`,
		"money zero amount":        `{"donorName":"ก","kind":"money","amount":"0"}`,
		"money too many decimals":  `{"donorName":"ก","kind":"money","amount":"1.005"}`,
		"money over cap":           `{"donorName":"ก","kind":"money","amount":"10000000.01"}`,
		"money with goods":         `{"donorName":"ก","kind":"money","amount":"100","goodsDescription":"น้ำดื่ม"}`,
		"goods without desc":       `{"donorName":"ก","kind":"goods","amount":null}`,
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

	rec := app.authed(t, token, http.MethodPatch, fmt.Sprintf("/api/admin/sponsor-donations/%d", d.ID),
		`{"donorName":"บริษัท ก จำกัด","address":"1 ถ.เชียงใหม่\nแม่โจ้","phone":"053123456","kind":"money","amount":"1500.5","goodsDescription":"","donatedOn":"2026-11-20","note":"","facultySubmitted":true}`)
	expectCode(t, rec, http.StatusOK, "")
	var upd service.SponsorDonationEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &upd)
	if upd.DonorName != "บริษัท ก จำกัด" || !upd.FacultySubmitted || upd.FacultySubmittedAt == nil {
		t.Fatalf("updated = %+v", upd)
	}
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorDonationUpdate {
			fields, _ := e.Details["fields"].([]string)
			if strings.Join(fields, ",") != "donorName,facultySubmitted" {
				t.Fatalf("update audit fields = %v", e.Details["fields"])
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

// inquiryUploadBody builds a POST /api/sponsor-inquiries/upload body; a nil file omits the part.
func inquiryUploadBody(t *testing.T, fields map[string]string, fileName string, file []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if file != nil {
		part, err := w.CreateFormFile("file", fileName)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(file)
	}
	_ = w.Close()
	return &buf, w.FormDataContentType()
}

func (a *sponsorDeskApp) postInquiryUpload(t *testing.T, fields map[string]string, fileName string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := inquiryUploadBody(t, fields, fileName, file)
	return a.do(t, http.MethodPost, "/api/sponsor-inquiries/upload", body, map[string]string{"Content-Type": ct})
}

func TestSponsorInquiryUpload_StoresServesAndDeletesForm(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	token := app.login(t)
	expectCode(t, app.authed(t, token, http.MethodPut, "/api/admin/sponsor-notify-emails", `{"emails":["staff@example.com"]}`), http.StatusOK, "")

	pdf := []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
	rec := app.postInquiryUpload(t, map[string]string{"name": " ร้าน ค ", "phone": "081-234-5678"}, "form.pdf", pdf)
	expectCode(t, rec, http.StatusCreated, "")
	if got := strings.TrimSpace(rec.Body.String()); got != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", got)
	}
	// A typed inquiry next to it has no file.
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
		withFile.File.MIME != "application/pdf" || withFile.File.Size != len(pdf) {
		t.Fatalf("uploaded inquiry = %+v (file %+v)", withFile, withFile.File)
	}
	if typed.File != nil {
		t.Fatalf("typed inquiry must have no file: %+v", typed.File)
	}
	if strings.Contains(rec.Body.String(), "sponsor-docs") {
		t.Fatal("admin list leaks the stored file path")
	}
	if files := app.docFiles(t); len(files) != 1 || !strings.HasPrefix(files[0], "inquiry-") || !strings.HasSuffix(files[0], ".pdf") {
		t.Fatalf("files on disk = %v", files)
	}
	app.notifier.mu.Lock()
	sent := append([]service.SponsorInquiryEmailData{}, app.notifier.sent...)
	app.notifier.mu.Unlock()
	if len(sent) != 2 || sent[0].FileMIME != "application/pdf" || sent[1].FileMIME != "" {
		t.Fatalf("notifications = %+v", sent)
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
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", typed.ID), ""), http.StatusNotFound, response.CodeNotFound)

	expectCode(t, app.authed(t, token, http.MethodDelete, fmt.Sprintf("/api/admin/sponsor-inquiries/%d", withFile.ID), ""), http.StatusNoContent, "")
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("inquiry delete must remove its form: %v", files)
	}
	expectCode(t, app.authed(t, token, http.MethodGet, fmt.Sprintf("/api/admin/sponsor-inquiries/%d/file", withFile.ID), ""), http.StatusNotFound, response.CodeNotFound)
}

func TestSponsorInquiryUpload_RejectsWithoutLeavingFiles(t *testing.T) {
	app := setupSponsorDeskApp(t, nil)
	ok := map[string]string{"name": "ร้าน ค", "phone": "0812345678"}
	pdf := []byte("%PDF-1.4\n%%EOF\n")

	for name, tc := range map[string]struct {
		fields   map[string]string
		fileName string
		file     []byte
		status   int
		code     string
	}{
		"svg":        {ok, "evil.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), http.StatusBadRequest, response.CodeValidation},
		"html":       {ok, "evil.html", []byte(`<!DOCTYPE html><html><script>alert(1)</script></html>`), http.StatusBadRequest, response.CodeValidation},
		"gif":        {ok, "anim.gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), http.StatusBadRequest, response.CodeValidation},
		"empty file": {ok, "form.pdf", []byte{}, http.StatusBadRequest, response.CodeValidation},
		"no file":    {ok, "", nil, http.StatusBadRequest, response.CodeValidation},
		"bad phone":  {map[string]string{"name": "ร้าน", "phone": "12345"}, "form.pdf", pdf, http.StatusBadRequest, response.CodeValidation},
		"bad kind":   {map[string]string{"name": "ร้าน", "phone": "0812345678", "kind": "alcohol"}, "form.pdf", pdf, http.StatusBadRequest, response.CodeValidation},
		"goods kind": {map[string]string{"name": "ร้าน", "phone": "0812345678", "kind": "goods"}, "form.pdf", pdf, http.StatusBadRequest, response.CodeValidation},
		"long field": {map[string]string{"name": strings.Repeat("ก", 2000), "phone": "0812345678"}, "form.pdf", pdf, http.StatusBadRequest, response.CodeValidation},
		"too large":  {ok, "big.pdf", append([]byte("%PDF-1.4\n"), bytes.Repeat([]byte("a"), service.MaxSponsorDocBytes)...), http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge},
		"huge image": {ok, "huge.webp", webpVP8XHeader(10001, 10), http.StatusBadRequest, response.CodeInvalidImageDims},
	} {
		t.Run(name, func(t *testing.T) {
			expectCode(t, app.postInquiryUpload(t, tc.fields, tc.fileName, tc.file), tc.status, tc.code)
		})
	}

	// Two file parts are refused.
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for range 2 {
		part, _ := w.CreateFormFile("file", "form.pdf")
		_, _ = part.Write(pdf)
	}
	_ = w.WriteField("name", "ร้าน")
	_ = w.WriteField("phone", "0812345678")
	_ = w.Close()
	expectCode(t, app.do(t, http.MethodPost, "/api/sponsor-inquiries/upload", &buf, map[string]string{"Content-Type": w.FormDataContentType()}), http.StatusBadRequest, response.CodeValidation)
	// JSON is not a multipart form.
	expectCode(t, app.do(t, http.MethodPost, "/api/sponsor-inquiries/upload", bytes.NewBufferString(`{"name":"ร้าน"}`), nil), http.StatusBadRequest, response.CodeValidation)

	// A filled honeypot answers success but stores neither the row nor the file.
	honeypot := map[string]string{"name": "bot", "phone": "0812345678", "website": "http://spam.example"}
	expectCode(t, app.postInquiryUpload(t, honeypot, "form.pdf", pdf), http.StatusCreated, "")

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
	fields := map[string]string{"name": "ร้าน", "phone": "0812345678", "turnstileToken": "bad"}
	expectCode(t, app.postInquiryUpload(t, fields, "form.pdf", pdf), http.StatusForbidden, response.CodeCaptchaFailed)
	if files := app.docFiles(t); len(files) != 0 {
		t.Fatalf("captcha failure left a file: %v", files)
	}
	// An invalid file is refused before Turnstile, so the token is not burnt.
	fields["turnstileToken"] = "good-1"
	expectCode(t, app.postInquiryUpload(t, fields, "x.gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")), http.StatusBadRequest, response.CodeValidation)
	expectCode(t, app.postInquiryUpload(t, fields, "form.pdf", pdf), http.StatusCreated, "")
	if files := app.docFiles(t); len(files) != 1 {
		t.Fatalf("files on disk = %v", files)
	}
}
