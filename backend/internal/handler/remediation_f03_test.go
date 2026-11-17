package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

func toThaiDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune('\u0E50' + (r - '0'))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func TestThaiNumeralNormalization_EndToEnd(t *testing.T) {
	app := setupUnlimitedApp(t)
	token := app.login(t)

	phoneASCII := "0895009501"
	phoneThai := toThaiDigits(phoneASCII[:3] + "\u200B-" + phoneASCII[3:6] + "-" + phoneASCII[6:])

	// 1. POST /api/applications normalizes the phone BEFORE validation & idempotency check, while
	// keeping Thai numerals inside free-text fields untouched.
	idempKey := uuid.NewString()
	submitPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมชาย รุ่นที่ ๒๕",
		Nickname:   "ชาย",
		Phone:      phoneThai,
		Email:      "thai95001@example.com",
		School:     "โรงเรียนวิทยาการ ๒๕",
		Grade:      "ม.5",
		ShirtSize:  "L",
		Motivation: "อยากเขียนโค้ด IoT ๑๐๐%",
	})
	rec := app.do(t, http.MethodPost, "/api/applications", bytes.NewReader(submitPayload), map[string]string{
		"X-Idempotency-Key": idempKey,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit with Thai digits: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var created service.ApplicationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	// Retry with same X-Idempotency-Key using the ASCII phone -> must replay cleanly (same normalized phone).
	retryPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมชาย รุ่นที่ ๒๕",
		Nickname:   "ชาย",
		Phone:      phoneASCII,
		Email:      "thai95001@example.com",
		School:     "โรงเรียนวิทยาการ ๒๕",
		Grade:      "ม.5",
		ShirtSize:  "L",
		Motivation: "อยากเขียนโค้ด IoT ๑๐๐%",
	})
	replayRec := app.do(t, http.MethodPost, "/api/applications", bytes.NewReader(retryPayload), map[string]string{
		"X-Idempotency-Key": idempKey,
	})
	if replayRec.Code != http.StatusOK || replayRec.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("idempotent replay ASCII after Thai: expected 200 Idempotent-Replayed=true, got %d (%s)", replayRec.Code, replayRec.Body.String())
	}

	// A different applicant (another phone, in Thai numerals) reusing the same X-Idempotency-Key ->
	// 422 IDEMPOTENCY_KEY_REUSED, and the stored application (and its code) is not handed out.
	conflictPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมหญิง ใจดี",
		Nickname:   "หญิง",
		Phone:      toThaiDigits("0895009502"),
		Email:      "thai95002@example.com",
		School:     "โรงเรียนแม่โจ้",
		Grade:      "ม.5",
		ShirtSize:  "M",
		Motivation: "สนใจ IoT",
	})
	conflictRec := app.do(t, http.MethodPost, "/api/applications", bytes.NewReader(conflictPayload), map[string]string{
		"X-Idempotency-Key": idempKey,
	})
	wantCode(t, conflictRec, http.StatusUnprocessableEntity, response.CodeIdempotencyReuse)
	if strings.Contains(conflictRec.Body.String(), created.ID) {
		t.Fatalf("a reused key must not reveal the stored code: %s", conflictRec.Body.String())
	}

	// Verify admin view stored the ASCII phone and preserved Thai digits in free-text fields.
	stored := app.adminView(t, token, created.ID)
	if stored.Phone != phoneASCII {
		t.Fatalf("stored phone = %q, want %q", stored.Phone, phoneASCII)
	}
	if stored.FullName != "สมชาย รุ่นที่ ๒๕" || stored.School != "โรงเรียนวิทยาการ ๒๕" || stored.Motivation != "อยากเขียนโค้ด IoT ๑๐๐%" {
		t.Fatalf("free-text fields were altered: %+v", stored)
	}

	// 2. GET /api/applications/status?q= with Thai numerals: the phone finds the application (without
	// its code), the code finds the full record.
	phoneRec := app.do(t, http.MethodGet, "/api/applications/status?q="+url.QueryEscape(phoneThai), nil, nil)
	if phoneRec.Code != http.StatusOK || strings.Contains(phoneRec.Body.String(), created.ID) {
		t.Fatalf("phone lookup q=%q: expected 200 without the code, got %d (%s)", phoneThai, phoneRec.Code, phoneRec.Body.String())
	}
	codeThai := toThaiDigits("cc25") + "-" + strings.ToLower(strings.TrimPrefix(created.ID, "CC25-"))
	codeRec := app.do(t, http.MethodGet, "/api/applications/status?q="+url.QueryEscape(codeThai), nil, nil)
	var stRes service.ApplicationResponse
	_ = json.Unmarshal(codeRec.Body.Bytes(), &stRes)
	if codeRec.Code != http.StatusOK || stRes.ID != created.ID {
		t.Fatalf("code lookup q=%q: expected the record of %s, got %d (%s)", codeThai, created.ID, codeRec.Code, codeRec.Body.String())
	}

	// 3. confirm and slip upload with the code written in Thai numerals in the path.
	confirmRec := app.do(t, http.MethodPost, "/api/applications/"+url.PathEscape(codeThai)+"/confirm", bytes.NewBufferString(`{"confirmed":true}`), nil)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("confirm with a Thai-numeral code: expected 200, got %d (%s)", confirmRec.Code, confirmRec.Body.String())
	}

	// The applicant self-edit route is disabled (staff-only): it answers 403 even for a valid code.
	profBody := `{"nickname":"ชาย๒๕","school":"โรงเรียนวิทยาการ ๒๕","province":"เชียงใหม่","grade":"ม.5","shirtSize":"XL"}`
	profRec := app.do(t, http.MethodPatch, "/api/applications/"+created.ID+"/profile", bytes.NewBufferString(profBody), nil)
	if profRec.Code != http.StatusForbidden {
		t.Fatalf("self profile edit must be disabled: expected 403, got %d (%s)", profRec.Code, profRec.Body.String())
	}

	slipRec := app.uploadSlip(t, url.PathEscape(codeThai), "s.jpg", uniqueSlip(950))
	if slipRec.Code != http.StatusOK {
		t.Fatalf("slip upload with a Thai-numeral code: expected 200, got %d (%s)", slipRec.Code, slipRec.Body.String())
	}

	// 4. PATCH /api/admin/applications/{id}/profile with Thai numerals in the phone.
	updatedPhoneASCII := "0895009503"
	adminEditBody := fmt.Sprintf(`{"phone":%q,"reason":"แก้ข้อมูลจากเลขไทย"}`, toThaiDigits(updatedPhoneASCII))
	adminEditRec := app.adminEdit(t, token, created.ID, adminEditBody)
	if adminEditRec.Code != http.StatusOK {
		t.Fatalf("admin profile edit with Thai digits: expected 200, got %d (%s)", adminEditRec.Code, adminEditRec.Body.String())
	}
	edited := app.adminView(t, token, created.ID)
	if edited.Phone != updatedPhoneASCII {
		t.Fatalf("admin edit stored %q, want %q", edited.Phone, updatedPhoneASCII)
	}

	// 5. POST /api/applications/{id}/withdraw with the code in Thai numerals and a BOM (a second,
	// clean applicant without a pending slip).
	wApp := app.submit(t, "0895009504", "thai95004@example.com")
	wCode := "\uFEFF" + toThaiDigits(strings.ToLower(wApp.ID))
	wRec := app.do(t, http.MethodPost, "/api/applications/"+url.PathEscape(wCode)+"/withdraw", bytes.NewBufferString(fmt.Sprintf(`{"phone":%q,"reason":"ถอนตัว"}`, toThaiDigits("089-500-9504"))), nil)
	if wRec.Code != http.StatusOK {
		t.Fatalf("withdraw with a Thai-numeral code and phone: expected 200, got %d (%s)", wRec.Code, wRec.Body.String())
	}
}
