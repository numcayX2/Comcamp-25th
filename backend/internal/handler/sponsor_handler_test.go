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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

type sponsorTestApp struct {
	http.Handler
	sponsorRepo *memory.MemorySponsorRepo
	auditRepo   *memory.MemoryAuditRepo
	sponsorDir  string
	adminID     int64
}

func setupSponsorTestApp(t *testing.T) *sponsorTestApp {
	t.Helper()

	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	admRepo := memory.NewMemoryAdminRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	sponsorRepo := memory.NewMemorySponsorRepo(appRepo.Audit())

	hash, err := service.HashPassword(testAdminPass)
	if err != nil {
		t.Fatal(err)
	}
	admin := &domain.Admin{
		Username:     testAdminUser,
		PasswordHash: hash,
		FullName:     "Sponsor Admin",
		Role:         domain.RoleAdmin,
		IsActive:     true,
	}
	if err := admRepo.Create(context.Background(), admin); err != nil {
		t.Fatal(err)
	}

	uploadDir := t.TempDir()
	jwtSecret := "test-jwt-secret-key-32-characters-long"
	settingSvc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())
	applicantSvc := service.NewApplicantService(appRepo, setRepo, payRepo).
		WithAudit(appRepo.Audit()).
		WithOnSeatChange(settingSvc.InvalidatePublicCache)
	paymentSvc := service.NewPaymentService(payRepo, appRepo, setRepo, appRepo.Audit(), uploadDir).
		WithOnStatusChange(applicantSvc.InvalidatePublicList)
	sponsorSvc := service.NewSponsorService(sponsorRepo, uploadDir)

	router := server.NewRouter(server.Services{
		Auth:      service.NewAuthService(admRepo, appRepo.Audit(), jwtSecret),
		Applicant: applicantSvc,
		Setting:   settingSvc,
		Payment:   paymentSvc,
		Sponsor:   sponsorSvc,
	}, server.Options{
		AllowedOrigins: []string{"http://localhost:4321"},
		RateLimits:     server.DefaultRateLimits(),
	})

	return &sponsorTestApp{
		Handler:     router,
		sponsorRepo: sponsorRepo,
		auditRepo:   appRepo.Audit(),
		sponsorDir:  filepath.Join(uploadDir, "sponsors"),
		adminID:     admin.ID,
	}
}

func (a *sponsorTestApp) do(t *testing.T, method, target string, body io.Reader, headers map[string]string) *httptest.ResponseRecorder {
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

func (a *sponsorTestApp) login(t *testing.T) string {
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

func sponsorMultipart(t *testing.T, fields map[string]string, fileName string, fileData []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := w.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if fileName != "" {
		part, err := w.CreateFormFile("logo", fileName)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(fileData); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, w.FormDataContentType()
}

func (a *sponsorTestApp) createSponsor(t *testing.T, token string, fields map[string]string, fileName string, fileData []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := sponsorMultipart(t, fields, fileName, fileData)
	headers := map[string]string{"Content-Type": ct}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	return a.do(t, http.MethodPost, "/api/admin/sponsors", body, headers)
}

func (a *sponsorTestApp) patchSponsor(t *testing.T, token string, id int64, fields map[string]string, fileName string, fileData []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := sponsorMultipart(t, fields, fileName, fileData)
	headers := map[string]string{"Content-Type": ct}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	return a.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/sponsors/%d", id), body, headers)
}

func TestSponsors_PublicListEmpty(t *testing.T) {
	app := setupSponsorTestApp(t)
	rec := app.do(t, http.MethodGet, "/api/sponsors", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/sponsors: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"sponsors":[]}` {
		t.Fatalf("empty sponsors body = %q, want %q", got, `{"sponsors":[]}`)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
}

func TestSponsors_CreatePNGLogoRouteAndAudit(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	logoPNG := encodePNG(16, 12)
	rec := app.createSponsor(t, token, map[string]string{
		"name":     "  Maejo Tech  ",
		"url":      "https://example.com/maejo",
		"showName": "true",
	}, "logo.png", logoPNG)
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /api/admin/sponsors: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}

	var created service.AdminSponsorEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID != 1 || created.Name != "Maejo Tech" || created.URL != "https://example.com/maejo" || !created.ShowName || created.SortOrder != 0 {
		t.Fatalf("unexpected created sponsor: %+v", created)
	}
	if !strings.HasPrefix(created.LogoURL, "/api/sponsors/1/logo?v=") || len(strings.TrimPrefix(created.LogoURL, "/api/sponsors/1/logo?v=")) != 12 {
		t.Fatalf("unexpected logoUrl: %q", created.LogoURL)
	}

	// Logo route returns exact bytes and required security + caching headers.
	logoRec := app.do(t, http.MethodGet, created.LogoURL, nil, nil)
	if logoRec.Code != http.StatusOK {
		t.Fatalf("GET logo: expected 200, got %d (%s)", logoRec.Code, logoRec.Body.String())
	}
	if !bytes.Equal(logoRec.Body.Bytes(), logoPNG) {
		t.Fatalf("logo bytes mismatch: got %d bytes, want %d bytes", logoRec.Body.Len(), len(logoPNG))
	}
	if ct := logoRec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	if cc := logoRec.Header().Get("Cache-Control"); cc != "public, max-age=86400" {
		t.Errorf("Cache-Control = %q, want public, max-age=86400", cc)
	}
	if nosniff := logoRec.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", nosniff)
	}
	if disp := logoRec.Header().Get("Content-Disposition"); disp != "inline" {
		t.Errorf("Content-Disposition = %q, want inline", disp)
	}

	// Audit row written for create.
	var foundCreateAudit bool
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorCreate && e.TargetType == domain.AuditTargetSponsor && e.TargetID == "1" {
			foundCreateAudit = true
			if e.AdminID == nil || *e.AdminID != app.adminID {
				t.Errorf("audit AdminID = %v, want %d", e.AdminID, app.adminID)
			}
		}
	}
	if !foundCreateAudit {
		t.Fatalf("expected sponsor.create audit row, got %+v", app.auditRepo.Entries())
	}
}

func TestSponsors_PublicJSONKeySetIsExact(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	// Omit url and showName so even default/empty values stay present in the exact key set.
	rec := app.createSponsor(t, token, map[string]string{"name": "Key Check Co"}, "logo.png", pngBytes)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}

	pub := app.do(t, http.MethodGet, "/api/sponsors", nil, nil)
	if pub.Code != http.StatusOK {
		t.Fatalf("GET /api/sponsors: expected 200, got %d", pub.Code)
	}

	var top map[string]any
	if err := json.Unmarshal(pub.Body.Bytes(), &top); err != nil {
		t.Fatalf("decode public list: %v", err)
	}
	if got := keysOf(top); strings.Join(got, ",") != "sponsors" {
		t.Fatalf("top-level keys = %v, want [sponsors]", got)
	}
	list, ok := top["sponsors"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("expected 1 sponsor, got %v", top["sponsors"])
	}
	row, ok := list[0].(map[string]any)
	if !ok {
		t.Fatalf("row is %T, want object", list[0])
	}
	wantKeys := "id,logoUrl,name,showName,url"
	if got := strings.Join(keysOf(row), ","); got != wantKeys {
		t.Fatalf("public sponsor keys = %q, want exact %q", got, wantKeys)
	}
	if row["url"] != "" || row["showName"] != false {
		t.Fatalf("unexpected default public values: %+v", row)
	}

	// Ensure internal storage fields never appear anywhere in the public response body.
	raw := pub.Body.String()
	// `"sponsors/` would be the start of a stored logo_path value ("sponsors/<uuid>.png"); the public
	// logoUrl is "/api/sponsors/<id>/logo?v=..." and is allowed.
	for _, forbidden := range []string{"logoPath", "logoHash", "logoMime", "sortOrder", "createdAt", "updatedAt", `"sponsors/`, ".png", ".jpg", ".webp"} {
		if strings.Contains(raw, forbidden) {
			t.Errorf("public sponsors response leaks %q: %s", forbidden, raw)
		}
	}
}

func TestSponsors_RejectsSVGAndGIF(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	for name, data := range map[string][]byte{
		"svg":             svg,
		"svg-as-png-name": svg,
		"gif":             gifBytes,
	} {
		fname := "logo.svg"
		if name == "svg-as-png-name" {
			fname = "logo.png"
		}
		rec := app.createSponsor(t, token, map[string]string{"name": "Bad Logo"}, fname, data)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d (%s)", name, rec.Code, rec.Body.String())
			continue
		}
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeValidation {
			t.Errorf("%s: code = %q, want %s", name, e.Code, response.CodeValidation)
		}
	}
}

func TestSponsors_RejectsOver2MB(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	// Just over 2 MB (caught by file size cap) and well over 2 MB (caught by MaxBytesReader).
	for _, size := range []int{(2 << 20) + 1, (2 << 20) + (256 << 10)} {
		big := make([]byte, size)
		copy(big, pngBytes)
		rec := app.createSponsor(t, token, map[string]string{"name": "Huge Logo"}, "big.png", big)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("size=%d: expected 413, got %d (%s)", size, rec.Code, rec.Body.String())
		}
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodePayloadTooLarge {
			t.Fatalf("size=%d: code = %q, want %s", size, e.Code, response.CodePayloadTooLarge)
		}
	}

	// Chunked request with unknown ContentLength (-1) over MaxBytesReader cap.
	huge := make([]byte, (2<<20)+(256<<10))
	copy(huge, pngBytes)
	body, ct := sponsorMultipart(t, map[string]string{"name": "Chunked Huge"}, "big.png", huge)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/sponsors", io.NopCloser(body))
	req.ContentLength = -1
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked >2MB: expected 413, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestSponsors_RejectsOversizedDimensions(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	widePNG := encodePNG(5000, 10)
	rec := app.createSponsor(t, token, map[string]string{"name": "Pixel Bomb"}, "wide.png", widePNG)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("5000x10 PNG: expected 400, got %d (%s)", rec.Code, rec.Body.String())
	}
	if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeInvalidImageDims {
		t.Fatalf("5000x10 PNG: code = %q, want %s", e.Code, response.CodeInvalidImageDims)
	}
}

func TestSponsors_RejectsBadURLAndName(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	for _, badURL := range []string{
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"ftp://example.com",
		"http://",
		"https:///only-path",
		"//evil.example.com",
		"https://example.com/" + strings.Repeat("a", 500),
		"https://example.com/\nfoo",
	} {
		rec := app.createSponsor(t, token, map[string]string{"name": "Valid Name", "url": badURL}, "logo.png", pngBytes)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("url %q: expected 400, got %d (%s)", badURL, rec.Code, rec.Body.String())
		}
	}

	for _, badName := range []string{"", "   ", strings.Repeat("ก", 121), "Line1\nLine2", "Tab\tName"} {
		rec := app.createSponsor(t, token, map[string]string{"name": badName}, "logo.png", pngBytes)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("name %q: expected 400, got %d (%s)", badName, rec.Code, rec.Body.String())
		}
	}
}

func TestSponsors_PatchReplaceLogoAndAudit(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	rec := app.createSponsor(t, token, map[string]string{
		"name":     "Old Name",
		"url":      "https://old.example.com",
		"showName": "true",
	}, "old.png", pngBytes)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d", rec.Code)
	}
	var created service.AdminSponsorEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	filesBefore, _ := os.ReadDir(app.sponsorDir)
	if len(filesBefore) != 1 {
		t.Fatalf("expected 1 file before patch, got %d", len(filesBefore))
	}
	oldFile := filesBefore[0].Name()

	// Patch name only (showName omitted -> unchanged true; url omitted -> unchanged).
	p1 := app.patchSponsor(t, token, created.ID, map[string]string{"name": "New Name"}, "", nil)
	if p1.Code != http.StatusOK {
		t.Fatalf("patch 1: expected 200, got %d (%s)", p1.Code, p1.Body.String())
	}
	var after1 service.AdminSponsorEntry
	_ = json.Unmarshal(p1.Body.Bytes(), &after1)
	if after1.Name != "New Name" || after1.URL != "https://old.example.com" || !after1.ShowName {
		t.Fatalf("patch 1 unexpected state: %+v", after1)
	}

	// Patch logo replacement and clear URL.
	p2 := app.patchSponsor(t, token, created.ID, map[string]string{"url": "", "showName": "false"}, "new.webp", webpBytes)
	if p2.Code != http.StatusOK {
		t.Fatalf("patch 2: expected 200, got %d (%s)", p2.Code, p2.Body.String())
	}
	var after2 service.AdminSponsorEntry
	_ = json.Unmarshal(p2.Body.Bytes(), &after2)
	if after2.URL != "" || after2.ShowName || after2.LogoURL == created.LogoURL {
		t.Fatalf("patch 2 unexpected state: %+v", after2)
	}

	// Old file was deleted after commit; only new file remains and logo route serves WebP bytes.
	filesAfter, _ := os.ReadDir(app.sponsorDir)
	if len(filesAfter) != 1 || filesAfter[0].Name() == oldFile {
		t.Fatalf("expected old file %s replaced, got %v", oldFile, filesAfter)
	}
	logoRec := app.do(t, http.MethodGet, after2.LogoURL, nil, nil)
	if logoRec.Code != http.StatusOK || logoRec.Header().Get("Content-Type") != "image/webp" || !bytes.Equal(logoRec.Body.Bytes(), webpBytes) {
		t.Fatalf("replaced logo mismatch: code=%d ct=%q len=%d", logoRec.Code, logoRec.Header().Get("Content-Type"), logoRec.Body.Len())
	}

	// Verify both sponsor.update audit entries recorded old->new and logoReplaced.
	var updates []domain.AuditEntry
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorUpdate && e.TargetID == "1" {
			updates = append(updates, e)
		}
	}
	if len(updates) != 2 {
		t.Fatalf("expected 2 sponsor.update audit entries, got %d", len(updates))
	}
	if updates[0].Details["logoReplaced"] != false {
		t.Errorf("first update logoReplaced = %v, want false", updates[0].Details["logoReplaced"])
	}
	if nameDiff, ok := updates[0].Details["name"].(map[string]any); !ok || nameDiff["old"] != "Old Name" || nameDiff["new"] != "New Name" {
		t.Errorf("first update name diff = %v", updates[0].Details["name"])
	}
	if updates[1].Details["logoReplaced"] != true {
		t.Errorf("second update logoReplaced = %v, want true", updates[1].Details["logoReplaced"])
	}
}

func TestSponsors_ReorderValidAndMissingID(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	for _, name := range []string{"First", "Second", "Third"} {
		rec := app.createSponsor(t, token, map[string]string{"name": name}, "logo.png", pngBytes)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create %s: %d", name, rec.Code)
		}
	}

	// Missing id -> 400.
	badMissing := app.do(t, http.MethodPut, "/api/admin/sponsors/order", bytes.NewBufferString(`{"ids":[1,2]}`), bearer(token))
	if badMissing.Code != http.StatusBadRequest {
		t.Fatalf("reorder missing id: expected 400, got %d (%s)", badMissing.Code, badMissing.Body.String())
	}
	// Duplicate id -> 400.
	badDup := app.do(t, http.MethodPut, "/api/admin/sponsors/order", bytes.NewBufferString(`{"ids":[1,1,2]}`), bearer(token))
	if badDup.Code != http.StatusBadRequest {
		t.Fatalf("reorder duplicate id: expected 400, got %d (%s)", badDup.Code, badDup.Body.String())
	}
	// Unknown id -> 400.
	badUnknown := app.do(t, http.MethodPut, "/api/admin/sponsors/order", bytes.NewBufferString(`{"ids":[1,2,99]}`), bearer(token))
	if badUnknown.Code != http.StatusBadRequest {
		t.Fatalf("reorder unknown id: expected 400, got %d (%s)", badUnknown.Code, badUnknown.Body.String())
	}

	// Valid reorder -> 200 and public list reflects new order.
	okRec := app.do(t, http.MethodPut, "/api/admin/sponsors/order", bytes.NewBufferString(`{"ids":[3,1,2]}`), bearer(token))
	if okRec.Code != http.StatusOK {
		t.Fatalf("reorder valid: expected 200, got %d (%s)", okRec.Code, okRec.Body.String())
	}
	var reordered service.AdminSponsorsResponse
	_ = json.Unmarshal(okRec.Body.Bytes(), &reordered)
	if len(reordered.Sponsors) != 3 || reordered.Sponsors[0].ID != 3 || reordered.Sponsors[1].ID != 1 || reordered.Sponsors[2].ID != 2 {
		t.Fatalf("unexpected reordered list: %+v", reordered.Sponsors)
	}

	pubRec := app.do(t, http.MethodGet, "/api/sponsors", nil, nil)
	var pub service.PublicSponsorsResponse
	_ = json.Unmarshal(pubRec.Body.Bytes(), &pub)
	if len(pub.Sponsors) != 3 || pub.Sponsors[0].Name != "Third" || pub.Sponsors[1].Name != "First" || pub.Sponsors[2].Name != "Second" {
		t.Fatalf("public list did not reflect reorder: %+v", pub.Sponsors)
	}

	var foundReorderAudit bool
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorReorder {
			foundReorderAudit = true
		}
	}
	if !foundReorderAudit {
		t.Fatal("expected sponsor.reorder audit entry")
	}
}

func TestSponsors_DeleteReturns204AndLogoReturns404(t *testing.T) {
	app := setupSponsorTestApp(t)
	token := app.login(t)

	rec := app.createSponsor(t, token, map[string]string{"name": "Delete Me"}, "logo.png", pngBytes)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d", rec.Code)
	}
	var created service.AdminSponsorEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	del := app.do(t, http.MethodDelete, fmt.Sprintf("/api/admin/sponsors/%d", created.ID), nil, bearer(token))
	if del.Code != http.StatusNoContent {
		t.Fatalf("DELETE: expected 204, got %d (%s)", del.Code, del.Body.String())
	}

	logoRec := app.do(t, http.MethodGet, created.LogoURL, nil, nil)
	if logoRec.Code != http.StatusNotFound {
		t.Fatalf("GET deleted logo: expected 404, got %d (%s)", logoRec.Code, logoRec.Body.String())
	}
	if cc := logoRec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("404 logo Cache-Control = %q, want no-store", cc)
	}

	files, _ := os.ReadDir(app.sponsorDir)
	if len(files) != 0 {
		t.Fatalf("expected logo file removed after delete, got %v", files)
	}

	pubRec := app.do(t, http.MethodGet, "/api/sponsors", nil, nil)
	if got := strings.TrimSpace(pubRec.Body.String()); got != `{"sponsors":[]}` {
		t.Fatalf("public list after delete = %q, want empty", got)
	}

	var foundDeleteAudit bool
	for _, e := range app.auditRepo.Entries() {
		if e.Action == domain.AuditSponsorDelete && e.TargetID == "1" {
			foundDeleteAudit = true
		}
	}
	if !foundDeleteAudit {
		t.Fatal("expected sponsor.delete audit entry")
	}
}

func TestSponsors_NonAdminGets401(t *testing.T) {
	app := setupSponsorTestApp(t)

	cases := []struct {
		method, path string
		body         io.Reader
	}{
		{http.MethodGet, "/api/admin/sponsors", nil},
		{http.MethodPost, "/api/admin/sponsors", bytes.NewBufferString("")},
		{http.MethodPatch, "/api/admin/sponsors/1", bytes.NewBufferString("")},
		{http.MethodDelete, "/api/admin/sponsors/1", nil},
		{http.MethodPut, "/api/admin/sponsors/order", bytes.NewBufferString(`{"ids":[]}`)},
	}
	for _, tc := range cases {
		rec := app.do(t, tc.method, tc.path, tc.body, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without auth: expected 401, got %d (%s)", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestDefaultRateLimits_SponsorBucketsAreIndependent(t *testing.T) {
	l := server.DefaultRateLimits()
	if l.SponsorsPublic == nil || l.SponsorLogo == nil {
		t.Fatal("sponsor rate limiters must not be nil")
	}
	if l.SponsorsPublic == l.SponsorLogo {
		t.Fatal("SponsorsPublic and SponsorLogo must not share a limiter")
	}
	for name, other := range map[string]any{
		"publicList": l.PublicList, "status": l.StatusQuery, "submit": l.Submit, "login": l.Login,
	} {
		if other == any(l.SponsorsPublic) || other == any(l.SponsorLogo) {
			t.Fatalf("sponsor limiter shares bucket with %s", name)
		}
	}
}
