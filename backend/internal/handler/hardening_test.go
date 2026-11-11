package handler_test

// AGENTS.md v2.4 hardening: image-bomb guard, /status second factor and copy-paste cleanup.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
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

// §13.4 image bomb / pixel flood: the header is checked before the file is hashed or stored.
func TestSecurity_SlipDimensionsLimited(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	created := app.submit(t, validTestNationalID(50), "0810000050", "dim@example.com")
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

// §13.5 anti-impersonation: confirm and slip upload need the last 4 digits of the national ID.
// The phone's last 4 digits are deliberately not accepted — the public status shows them.
func TestSecurity_StatusActionsRequireVerifyCode(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)
	nid := validTestNationalID(40)
	created := app.submit(t, nid, "0810004321", "vc@example.com")
	app.setStatus(t, token, created.ID, domain.StatusPassed)

	confirm := func(code string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"confirmed": true, "verifyCode": code})
		return app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/confirm", bytes.NewBuffer(body), nil)
	}

	if rec := confirm(""); rec.Code != http.StatusBadRequest {
		t.Fatalf("confirm without verifyCode: expected 400, got %d", rec.Code)
	}
	for _, code := range []string{"1234", "4321" /* the phone's last 4 */, "1509"} {
		rec := confirm(code)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("confirm with %s: expected 403, got %d (%s)", code, rec.Code, rec.Body.String())
		}
		if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeInvalidVerifyCode {
			t.Fatalf("confirm with %s: expected code %s, got %+v", code, response.CodeInvalidVerifyCode, e)
		}
	}
	if res := app.status(t, created.ID); res.AttendanceConfirmed {
		t.Fatal("attendance was confirmed with a wrong verifyCode")
	}

	// Copied from a LINE chat: a zero-width space must not break the right code.
	if rec := confirm("\u200B" + nid[9:]); rec.Code != http.StatusOK {
		t.Fatalf("confirm with the right code: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	for code, want := range map[string]int{"": http.StatusBadRequest, "1234": http.StatusForbidden, "4321": http.StatusForbidden} {
		if rec := app.uploadSlipWithCode(t, created.ID, code, "slip.jpg", jpegBytes); rec.Code != want {
			t.Fatalf("slip with verifyCode %q: expected %d, got %d (%s)", code, want, rec.Code, rec.Body.String())
		}
	}
	if res := app.status(t, created.ID); res.HasSlip {
		t.Fatal("a slip was stored with a wrong verifyCode")
	}
	if rec := app.uploadSlipWithCode(t, created.ID, nid[9:], "slip.jpg", jpegBytes); rec.Code != http.StatusOK {
		t.Fatalf("slip with the right code: expected 200, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// §9.2.2: IDs and phone numbers pasted from chat apps (zero-width characters, hyphens, spaces)
// are cleaned on submit and on lookup.
func TestSecurity_CopyPastedIdentifiersAreCleaned(t *testing.T) {
	app := setupTestApp(t)
	nid60 := validTestNationalID(60)
	body, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName: "ทดสอบ คัดลอก", Nickname: "ก็อป", School: "โรงเรียนทดสอบ", Grade: "ม.4", ShirtSize: "M",
		NationalID: "\uFEFF" + nid60[:1] + "-" + nid60[1:5] + "-" + nid60[5:10] + "-" + nid60[10:12] + "-" + nid60[12:] + "\u200B",
		Phone:      "081\u200C-000\u200D-0060",
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
	if stored.NationalID != nid60 || stored.Phone != "0810000060" {
		t.Fatalf("stored identifiers not cleaned: %q / %q", stored.NationalID, stored.Phone)
	}

	noHyphen := strings.ToLower(strings.Replace(created.ID, "-", "", 1))
	for _, q := range []string{nid60[:1] + "-" + nid60[1:5] + "-" + nid60[5:10] + "-" + nid60[10:12] + "-" + nid60[12:], "081 000 0060", "\u200B0810000060", "\u200B" + created.ID, noHyphen} {
		if res := app.status(t, q); res.ID != created.ID {
			t.Errorf("lookup %q: expected %s, got %q", q, created.ID, res.ID)
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
	if before.MaxCapacity != 30 {
		t.Fatalf("default capacity: expected 30, got %d", before.MaxCapacity)
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

	app.submit(t, validTestNationalID(70), "0810000070", "")
	rec := app.do(t, http.MethodPost, "/api/applications", applicationJSON(validTestNationalID(71), "0810000071", ""), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("capacity 1 full: expected 409, got %d", rec.Code)
	}
	if e := decodeErr(t, rec.Body.Bytes()); e.Code != response.CodeQuotaFull {
		t.Fatalf("expected %s, got %+v", response.CodeQuotaFull, e)
	}
}
