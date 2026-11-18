package handler_test

// AGENTS.md v2.4 hardening: image-bomb guard, the application code as the /status proof, and
// copy-paste cleanup.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// pngHeader is a PNG that is only a signature plus an IHDR chunk declaring w×h: a few bytes that
// would need w*h*4 bytes of RAM to decode (the classic decompression bomb).
func pngHeader(w, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], w)
	binary.BigEndian.PutUint32(ihdr[4:8], h)
	ihdr[8], ihdr[9] = 8, 2 // 8-bit RGB
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	_ = binary.Write(&b, binary.BigEndian, uint32(len(ihdr)))
	b.WriteString("IHDR")
	b.Write(ihdr)
	_ = binary.Write(&b, binary.BigEndian, crc32.ChecksumIEEE(append([]byte("IHDR"), ihdr...)))
	return b.Bytes()
}

// webpVP8XHeader is an extended-format WebP header declaring a w×h canvas.
func webpVP8XHeader(w, h int) []byte {
	d := make([]byte, 10)
	w, h = w-1, h-1
	d[4], d[5], d[6] = byte(w), byte(w>>8), byte(w>>16)
	d[7], d[8], d[9] = byte(h), byte(h>>8), byte(h>>16)
	var b bytes.Buffer
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(4+8+len(d)))
	b.WriteString("WEBPVP8X")
	_ = binary.Write(&b, binary.LittleEndian, uint32(len(d)))
	b.Write(d)
	return b.Bytes()
}

// status looks an application up by its code (the full masked record).
func (a *testApp) status(t *testing.T, q string) service.ApplicationResponse {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/applications/status?q="+url.QueryEscape(q), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %q: expected 200, got %d (%s)", q, rec.Code, rec.Body.String())
	}
	var res service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	return res
}

// phoneStatus looks an application up by phone number (masked data, never the code).
func (a *testApp) phoneStatus(t *testing.T, q string) service.PhoneLookupResponse {
	t.Helper()
	rec := a.do(t, http.MethodGet, "/api/applications/status?q="+url.QueryEscape(q), nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %q: expected 200, got %d (%s)", q, rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "CC25-") {
		t.Fatalf("status %q: a phone lookup revealed an application code: %s", q, rec.Body.String())
	}
	var res service.PhoneLookupResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	return res
}

// §13.4 image bomb / pixel flood: the header is checked before the file is hashed or stored.
func TestSecurity_SlipDimensionsLimited(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, "0810000050", "dim@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)

	rejected := map[string][]byte{
		"png header 5000x5000": pngHeader(5000, 5000),
		"png header 100000x1":  pngHeader(100_000, 1),
		"jpeg 4097x8":          encodeJPEG(4097, 8),
		"jpeg 8x4097":          encodeJPEG(8, 4097),
		"webp vp8x 5000x5000":  webpVP8XHeader(5000, 5000),
		"webp vp8x 4097x1":     webpVP8XHeader(4097, 1),
	}
	for name, data := range rejected {
		t.Run(name, func(t *testing.T) {
			rec := app.uploadSlip(t, created.ID, "bomb.png", data)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d (%s)", rec.Code, rec.Body.String())
			}
			if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeInvalidImageDims {
				t.Fatalf("expected code %s, got %+v", response.CodeInvalidImageDims, e)
			}
		})
	}

	// A header that claims PNG but cannot be parsed is not an image.
	truncated := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01")
	if rec := app.uploadSlip(t, created.ID, "cut.png", truncated); rec.Code != http.StatusBadRequest {
		t.Fatalf("truncated png: expected 400, got %d", rec.Code)
	}

	// Nothing was stored for any rejected file.
	if res := app.status(t, created.ID); res.HasSlip {
		t.Fatal("a rejected image created a payment record")
	}

	// The limit is inclusive, and WebP is accepted.
	for name, data := range map[string][]byte{"png 4096x1": encodePNG(4096, 1), "webp 1x1": webpBytes} {
		if rec := app.uploadSlip(t, created.ID, "ok", data); rec.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d (%s)", name, rec.Code, rec.Body.String())
		}
	}
}

// §13.5 since migration 000011: the application code in the path is the proof for confirm and slip
// upload. A verifyCode sent by an outdated page is ignored, an unknown code is 404 and stores
// nothing, and a phone number in place of the code is not an application code at all.
func TestSecurity_StatusActionsNeedTheApplicationCode(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, "0810004321", "vc@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)

	confirm := func(id, body string) *httptest.ResponseRecorder {
		return app.do(t, http.MethodPost, "/api/applications/"+url.PathEscape(id)+"/confirm", bytes.NewBufferString(body), nil)
	}

	for _, id := range []string{"CC25-000000", "0810004321"} {
		wantErrCode(t, confirm(id, `{"confirmed":true}`), http.StatusNotFound, response.CodeNotFound)
		wantErrCode(t, app.uploadSlip(t, url.PathEscape(id), "slip.jpg", jpegBytes), http.StatusNotFound, response.CodeNotFound)
	}
	if res := app.status(t, created.ID); res.AttendanceConfirmed || res.HasSlip {
		t.Fatalf("nothing may change through an unknown code: %+v", res)
	}

	// The code as a student pastes it (lower case, zero-width space) works, and a verifyCode field
	// from an outdated page is ignored.
	pasted := "\u200b" + strings.ToLower(created.ID)
	if rec := confirm(pasted, `{"confirmed":true,"verifyCode":"0000"}`); rec.Code != http.StatusOK {
		t.Fatalf("confirm with the code: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	body, headers := slipForm(t, "slip.jpg", jpegBytes)
	if rec := app.do(t, http.MethodPost, "/api/applications/"+url.PathEscape(pasted)+"/slip", body, headers); rec.Code != http.StatusOK {
		t.Fatalf("slip with the code: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if res := app.status(t, created.ID); !res.AttendanceConfirmed || !res.HasSlip {
		t.Fatalf("expected the confirmation and the slip to be stored: %+v", res)
	}
}

// §9.2.2: phone numbers, emails and codes pasted from chat apps (zero-width characters, hyphens,
// spaces, Thai digits) are cleaned on submit and on lookup.
func TestSecurity_CopyPastedIdentifiersAreCleaned(t *testing.T) {
	app := setupTestApp(t)
	body, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName: "ทดสอบ คัดลอก", Nickname: "ก็อป", School: "โรงเรียนทดสอบ", Grade: "ม.4", ShirtSize: "M",
		Email: "\u200Bcopy60@example.com\uFEFF",
		Phone: "081\u200C-000\u200D-0060",
	})
	rec := app.do(t, http.MethodPost, "/api/applications", bytes.NewBuffer(body), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var created service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	stored, err := app.appRepo.GetByApplicationNo(t.Context(), created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Phone != "0810000060" || stored.Email != "copy60@example.com" {
		t.Fatalf("stored identifiers not cleaned: %q / %q", stored.Phone, stored.Email)
	}

	for _, q := range []string{"081 000 0060", "\u200B0810000060", "๐๘๑-๐๐๐-๐๐๖๐"} {
		if res := app.phoneStatus(t, q); res.Lookup != service.LookupPhone || !res.CodeRequired || res.Phone != "XXX-XXX-XX60" {
			t.Errorf("phone lookup %q: unexpected answer %+v", q, res)
		}
	}
	noHyphen := strings.ToLower(strings.Replace(created.ID, "-", "", 1))
	for _, q := range []string{"\u200B" + created.ID, noHyphen, strings.Replace(created.ID, "-", " ", 1)} {
		if res := app.status(t, q); res.ID != created.ID {
			t.Errorf("code lookup %q: expected %s, got %q", q, created.ID, res.ID)
		}
	}
}

// Admin-adjustable seat quota (default 30): PATCH /api/admin/settings needs a token, rejects
// bad input instead of ignoring it, is audited, and the new limit is enforced at submit.
func TestSecurity_AdminSettingsQuota(t *testing.T) {
	app := setupTestApp(t)
	patch := func(body string, headers map[string]string) *httptest.ResponseRecorder {
		return app.do(t, http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(body), headers)
	}

	if rec := patch(`{"maxCapacity":2}`, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without token: expected 401, got %d", rec.Code)
	}
	token := app.login(t)

	pub := app.do(t, http.MethodGet, "/api/settings/public", nil, nil)
	var before domain.PublicSettingsResponse
	_ = json.Unmarshal(pub.Body.Bytes(), &before)
	if before.MaxCapacity != 40 {
		t.Fatalf("default capacity: expected 40, got %d", before.MaxCapacity)
	}

	for name, body := range map[string]string{
		"zero capacity":     `{"maxCapacity":0}`,
		"huge capacity":     `{"maxCapacity":100000}`,
		"bad date":          `{"registrationOpenAt":"16/11/2026"}`,
		"close before open": `{"registrationCloseAt":"2000-01-01T00:00:00Z"}`,
		"negative fee":      `{"campFee":"-1"}`,
		"empty":             `{}`,
	} {
		if rec := patch(body, bearer(token)); rec.Code != http.StatusBadRequest {
			t.Errorf("%s: expected 400, got %d (%s)", name, rec.Code, rec.Body.String())
		}
	}

	if rec := patch(`{"maxCapacity":1}`, bearer(token)); rec.Code != http.StatusOK {
		t.Fatalf("set capacity 1: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !hasAudit(app, domain.AuditSettingsUpdate, "1") {
		t.Error("expected a settings.update audit entry")
	}

	app.submit(t, "0810000070", "q70@example.com")
	rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON("0810000071", "q71@example.com"), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("capacity 1 full: expected 409, got %d", rec.Code)
	}
	if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeQuotaFull {
		t.Fatalf("expected %s, got %+v", response.CodeQuotaFull, e)
	}
}

// Since migration 000011 there is no national ID. A registration from an outdated form that still
// carries "nationalId" is accepted (so a student whose tab was opened before the deploy is not
// turned away at 09:00) and the value is dropped: it is not stored, echoed or logged anywhere.
func TestSubmit_LegacyNationalIDFieldIsIgnored(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	const nid = "1509900112233"
	body := `{"fullName":"สมชาย ใจดี","nickname":"ชาย","nationalId":"` + nid + `","phone":"0810000901","email":"legacy@example.com","school":"โรงเรียนแม่โจ้","grade":"ม.5","shirtSize":"M"}`
	rec := app.do(t, http.MethodPost, "/api/applications", bytes.NewBufferString(body), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var created service.ApplicationResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	for name, got := range map[string]string{
		"submit response": rec.Body.String(),
		"admin list":      app.do(t, http.MethodGet, "/api/admin/applications", nil, bearer(token)).Body.String(),
		"code lookup":     app.do(t, http.MethodGet, "/api/applications/status?q="+created.ID, nil, nil).Body.String(),
	} {
		if strings.Contains(got, nid) || strings.Contains(got, "nationalId") {
			t.Fatalf("%s carries the dropped national ID: %s", name, got)
		}
	}
	for _, e := range app.appRepo.Audit().Entries() {
		if strings.Contains(fmt.Sprint(e.Details), nid) {
			t.Fatalf("an audit row carries the dropped national ID: %+v", e)
		}
	}
	// It is not a lookup key either.
	if rec := app.do(t, http.MethodGet, "/api/applications/status?q="+nid, nil, nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("a national ID is not a lookup key: expected 400, got %d", rec.Code)
	}
}

// Live phone and live non-empty email are unique (migration 000003, kept by 000011): a second
// registration with either is DUPLICATE_APPLICATION, and a withdrawn application frees both.
func TestSubmit_DuplicateLivePhoneOrEmailIsRejected(t *testing.T) {
	app := setupTestApp(t)
	first := app.submit(t, "0810000911", "dup@example.com")
	for name, body := range map[string]*bytes.Buffer{
		"same phone":         applicationJSON("0810000911", "other@example.com"),
		"same phone, pasted": applicationJSON("081-000-0911", "other2@example.com"),
		"same email":         applicationJSON("0810000912", "dup@example.com"),
		"same email, cased":  applicationJSON("0810000913", "DUP@Example.com"),
	} {
		rec := app.do(t, http.MethodPost, "/api/applications", body, nil)
		wantErrCode(t, rec, http.StatusConflict, response.CodeDuplicateApp)
		if strings.Contains(rec.Body.String(), first.ID) {
			t.Fatalf("%s: a duplicate answer must not reveal the existing code: %s", name, rec.Body.String())
		}
	}
	wantErrCode(t, app.withdrawRec(t, first.ID), http.StatusOK, "")
	again := app.submit(t, "0810000911", "dup@example.com")
	if again.ID == first.ID {
		t.Fatal("re-registering must create a new application")
	}
}
