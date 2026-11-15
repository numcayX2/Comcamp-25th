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

	nidASCII := validTestNationalID(95_001)
	nidThai := toThaiDigits(nidASCII[:1] + "-" + nidASCII[1:5] + "-\u200B" + nidASCII[5:10] + "-" + nidASCII[10:12] + "-" + nidASCII[12:])
	phoneASCII := "0895009501"
	phoneThai := toThaiDigits(phoneASCII[:3] + "\u200B-" + phoneASCII[3:6] + "-" + phoneASCII[6:])
	last4Thai := toThaiDigits(nidASCII[len(nidASCII)-4:])

	// 1. POST /api/applications normalizes nationalId & phone BEFORE validation & idempotency check,
	// while keeping Thai numerals inside free-text fields untouched.
	idempKey := uuid.NewString()
	submitPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมชาย รุ่นที่ ๒๕",
		Nickname:   "ชาย",
		NationalID: nidThai,
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

	// Retry with same X-Idempotency-Key using ASCII nationalId -> must replay cleanly (same normalized ID).
	retryPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมชาย รุ่นที่ ๒๕",
		Nickname:   "ชาย",
		NationalID: nidASCII,
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

	// Different applicant in Thai numerals reusing the same X-Idempotency-Key -> 422 IDEMPOTENCY_KEY_REUSED.
	otherNidThai := toThaiDigits(validTestNationalID(95_002))
	conflictPayload, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName:   "สมหญิง ใจดี",
		Nickname:   "หญิง",
		NationalID: otherNidThai,
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

	// Verify admin view stored ASCII nationalId/phone and preserved Thai digits in free-text fields.
	stored := app.adminView(t, token, created.ID)
	if stored.NationalID != nidASCII || stored.Phone != phoneASCII {
		t.Fatalf("stored identifiers = (%q, %q), want (%q, %q)", stored.NationalID, stored.Phone, nidASCII, phoneASCII)
	}
	if stored.FullName != "สมชาย รุ่นที่ ๒๕" || stored.School != "โรงเรียนวิทยาการ ๒๕" || stored.Motivation != "อยากเขียนโค้ด IoT ๑๐๐%" {
		t.Fatalf("free-text fields were altered: %+v", stored)
	}

	// 2. GET /api/applications/status?q= with Thai numerals (13-digit ID, 10-digit phone, and appNo).
	for _, q := range []string{nidThai, phoneThai, toThaiDigits("cc25") + "-" + strings.ToLower(strings.TrimPrefix(created.ID, "CC25-"))} {
		stRec := app.do(t, http.MethodGet, "/api/applications/status?q="+url.QueryEscape(q), nil, nil)
		if stRec.Code != http.StatusOK {
			t.Fatalf("status lookup q=%q: expected 200, got %d (%s)", q, stRec.Code, stRec.Body.String())
		}
		var stRes service.ApplicationResponse
		_ = json.Unmarshal(stRec.Body.Bytes(), &stRes)
		if stRes.ID != created.ID {
			t.Fatalf("status lookup q=%q returned ID %q, want %q", q, stRes.ID, created.ID)
		}
	}

	// 3. confirm, profile edit, and slip upload using Thai-numeral verifyCode (+ zero-width char).
	confirmBody := fmt.Sprintf(`{"confirmed":true,"verifyCode":"%s\u200B"}`, last4Thai)
	confirmRec := app.do(t, http.MethodPost, "/api/applications/"+created.ID+"/confirm", bytes.NewBufferString(confirmBody), nil)
	if confirmRec.Code != http.StatusOK {
		t.Fatalf("confirm with Thai verifyCode: expected 200, got %d (%s)", confirmRec.Code, confirmRec.Body.String())
	}

	profBody := fmt.Sprintf(`{"verifyCode":%q,"nickname":"ชาย๒๕","school":"โรงเรียนวิทยาการ ๒๕","province":"เชียงใหม่","grade":"ม.5","shirtSize":"XL"}`, last4Thai)
	profRec := app.do(t, http.MethodPatch, "/api/applications/"+created.ID+"/profile", bytes.NewBufferString(profBody), nil)
	if profRec.Code != http.StatusOK {
		t.Fatalf("self profile edit with Thai verifyCode: expected 200, got %d (%s)", profRec.Code, profRec.Body.String())
	}

	slipRec := app.uploadSlipWithCode(t, created.ID, "\u200B"+last4Thai, "s.jpg", uniqueSlip(950))
	if slipRec.Code != http.StatusOK {
		t.Fatalf("slip upload with Thai verifyCode: expected 200, got %d (%s)", slipRec.Code, slipRec.Body.String())
	}

	// 4. PATCH /api/admin/applications/{id}/profile with Thai numerals in nationalId & phone.
	updatedNidASCII := validTestNationalID(95_003)
	updatedPhoneASCII := "0895009503"
	adminEditBody := fmt.Sprintf(`{"nationalId":%q,"phone":%q,"reason":"แก้ข้อมูลจากเลขไทย"}`, toThaiDigits(updatedNidASCII), toThaiDigits(updatedPhoneASCII))
	adminEditRec := app.adminEdit(t, token, created.ID, adminEditBody)
	if adminEditRec.Code != http.StatusOK {
		t.Fatalf("admin profile edit with Thai digits: expected 200, got %d (%s)", adminEditRec.Code, adminEditRec.Body.String())
	}
	edited := app.adminView(t, token, created.ID)
	if edited.NationalID != updatedNidASCII || edited.Phone != updatedPhoneASCII {
		t.Fatalf("admin edit stored (%q, %q), want (%q, %q)", edited.NationalID, edited.Phone, updatedNidASCII, updatedPhoneASCII)
	}

	// 5. POST /api/applications/{id}/withdraw with Thai-numeral nationalId (+ second clean applicant without pending slip).
	wNidASCII := validTestNationalID(95_004)
	wApp := app.submit(t, wNidASCII, "0895009504", "thai95004@example.com")
	wNidThai := toThaiDigits("\uFEFF" + wNidASCII[:1] + "-" + wNidASCII[1:5] + "-" + wNidASCII[5:10] + "-" + wNidASCII[10:12] + "-" + wNidASCII[12:])
	withdrawBody := fmt.Sprintf(`{"nationalId":%q,"reason":"ถอนตัว"}`, wNidThai)
	wRec := app.do(t, http.MethodPost, "/api/applications/"+wApp.ID+"/withdraw", bytes.NewBufferString(withdrawBody), nil)
	if wRec.Code != http.StatusOK {
		t.Fatalf("withdraw with Thai nationalId: expected 200, got %d (%s)", wRec.Code, wRec.Body.String())
	}
}
