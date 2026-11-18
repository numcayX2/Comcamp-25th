package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

func submitWith(t *testing.T, app *testApp, phone, province, motivation string) *bytes.Buffer {
	t.Helper()
	body, _ := json.Marshal(service.ApplicationCreateRequest{
		FullName: "สมเกียรติ สุขสมบูรณ์", Nickname: "เกียรติ", Phone: phone, Email: "p" + phone + "@example.com",
		School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "XL", Province: province, Motivation: motivation,
	})
	return bytes.NewBuffer(body)
}

// Registration accepts only the 77 official provinces; common spellings are stored as the
// official name, and the motivation note is capped at 1,000 characters.
func TestRegistration_ProvinceAndMotivation(t *testing.T) {
	limits := server.DefaultRateLimits()
	limits.Submit = middleware.NewRateLimiter(10_000, time.Minute)
	app := setupTestAppWith(t, limits)
	token := app.login(t)

	for i, tc := range []struct{ in, want string }{
		{"ลำปาง", "ลำปาง"},
		{"จ. ลำปาง", "ลำปาง"},
		{"จังหวัดเชียงราย", "เชียงราย"},
		{"กทม.", "กรุงเทพมหานคร"},
		{"อยุธยา", "พระนครศรีอยุธยา"},
	} {
		phone := fmt.Sprintf("08100009%02d", i)
		rec := app.do(t, http.MethodPost, "/api/applications", submitWith(t, app, phone, tc.in, ""), nil)
		if rec.Code != http.StatusCreated {
			t.Fatalf("%q: expected 201, got %d (%s)", tc.in, rec.Code, rec.Body.String())
		}
		var res service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &res)
		if got := app.adminView(t, token, res.ID).Province; got != tc.want {
			t.Fatalf("%q: stored %q, want %q", tc.in, got, tc.want)
		}
	}

	for i, bad := range []string{"ดาวอังคาร", "Chiang Mai", "เชียง"} {
		rec := app.do(t, http.MethodPost, "/api/applications", submitWith(t, app, fmt.Sprintf("08100008%02d", i), bad, ""), nil)
		wantErrCode(t, rec, http.StatusBadRequest, response.CodeValidation)
		if !strings.Contains(rec.Body.String(), "province") {
			t.Fatalf("%q: expected a province error, got %s", bad, rec.Body.String())
		}
	}

	wantErrCode(t, app.do(t, http.MethodPost, "/api/applications",
		submitWith(t, app, "0810000870", "ลำพูน", strings.Repeat("ก", 1001)), nil), http.StatusBadRequest, response.CodeValidation)
	if rec := app.do(t, http.MethodPost, "/api/applications",
		submitWith(t, app, "0810000871", "ลำพูน", strings.Repeat("ก", 1000)), nil); rec.Code != http.StatusCreated {
		t.Fatalf("1,000 characters must be accepted, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// A record saved before the province list and the 1,000-character motivation limit can still be
// edited by staff: the old values pass while unchanged, and a new value must follow the rules.
func TestAdminEdit_LegacyProvinceAndMotivation(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	long := strings.Repeat("ข", 1500)
	legacy := &domain.Applicant{
		ID: uuid.New(), ApplicationNo: "CC25-1E6AC1", FirstName: "สมชาย", LastName: "เดิม", Nickname: "ชาย",
		Phone: "0810000880", Email: "legacy880@example.com", School: "โรงเรียนเดิม", Grade: "ม.5",
		Province: "เมืองพิกเซล", ShirtSize: "M", Motivation: &long, Status: domain.StatusPassed,
	}
	if err := app.appRepo.Create(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}

	wantCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"nickname":"ชายใหม่","province":"เมืองพิกเซล","motivation":"`+long+`"}`), http.StatusOK, "")
	if got := app.adminView(t, token, legacy.ApplicationNo); got.Nickname != "ชายใหม่" || got.Province != "เมืองพิกเซล" {
		t.Fatalf("edit with unchanged legacy values did not apply: %+v", got)
	}

	wantErrCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"province":"เมืองใหม่"}`), http.StatusBadRequest, response.CodeValidation)
	wantErrCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"motivation":"`+long+`ค"}`), http.StatusBadRequest, response.CodeValidation)

	wantCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"province":"จ.น่าน"}`), http.StatusOK, "")
	if got := app.adminView(t, token, legacy.ApplicationNo).Province; got != "น่าน" {
		t.Fatalf("province stored as %q, want น่าน", got)
	}
}

// Nicknames are capped at 20 characters on registration; a longer nickname saved earlier stays
// editable by staff as long as it is left unchanged.
func TestNicknameLimit(t *testing.T) {
	limits := server.DefaultRateLimits()
	limits.Submit = middleware.NewRateLimiter(10_000, time.Minute)
	app := setupTestAppWith(t, limits)

	withNickname := func(phone, nickname string) *bytes.Buffer {
		body, _ := json.Marshal(service.ApplicationCreateRequest{
			FullName: "สมเกียรติ สุขสมบูรณ์", Nickname: nickname, Phone: phone, Email: "n" + phone + "@example.com",
			School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "XL", Province: "ลำพูน",
		})
		return bytes.NewBuffer(body)
	}
	wantErrCode(t, app.do(t, http.MethodPost, "/api/applications", withNickname("0810000890", strings.Repeat("ก", 21)), nil),
		http.StatusBadRequest, response.CodeValidation)
	if rec := app.do(t, http.MethodPost, "/api/applications", withNickname("0810000891", strings.Repeat("ก", 20)), nil); rec.Code != http.StatusCreated {
		t.Fatalf("20 characters must be accepted, got %d (%s)", rec.Code, rec.Body.String())
	}

	token := app.login(t)
	oldNick := strings.Repeat("ช", 40)
	legacy := &domain.Applicant{
		ID: uuid.New(), ApplicationNo: "CC25-1E6AC2", FirstName: "สมชาย", LastName: "เดิม", Nickname: oldNick,
		Phone: "0810000892", Email: "legacy892@example.com", School: "โรงเรียนเดิม", Grade: "ม.5",
		Province: "ลำพูน", ShirtSize: "M", Status: domain.StatusPassed,
	}
	if err := app.appRepo.Create(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	wantCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"nickname":"`+oldNick+`","school":"โรงเรียนใหม่"}`), http.StatusOK, "")
	wantErrCode(t, app.adminEdit(t, token, legacy.ApplicationNo, `{"nickname":"`+oldNick+`ช"}`), http.StatusBadRequest, response.CodeValidation)
}
