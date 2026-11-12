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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

func loginTestAdmin(t *testing.T, app http.Handler) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"admin123"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin login failed: %d %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	return res.Token
}

func submitApplicationViaHTTP(t *testing.T, app http.Handler, payload service.ApplicationCreateRequest) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/applications", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec
}

func TestApplicantHandler_NegativeAndEdgeCases(t *testing.T) {
	deps := setupTestAppWithDeps(t)
	app := deps.router
	token := loginTestAdmin(t, app)

	// 1. Optional blank email for 2+ applicants succeeds (201)
	rec1 := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "คนที่หนึ่ง ไม่มีเมล",
		Nickname:   "หนึ่ง",
		NationalID: "1100000000001",
		Phone:      "0810000001",
		Email:      "",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.4",
		ShirtSize:  "M",
	})
	if rec1.Code != http.StatusCreated {
		t.Fatalf("expected 201 for first blank email, got %d: %s", rec1.Code, rec1.Body.String())
	}
	var app1 service.ApplicationResponse
	_ = json.Unmarshal(rec1.Body.Bytes(), &app1)

	rec2 := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "คนที่สอง ไม่มีเมล",
		Nickname:   "สอง",
		NationalID: "1100000000002",
		Phone:      "0810000002",
		Email:      "",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.5",
		ShirtSize:  "L",
	})
	if rec2.Code != http.StatusCreated {
		t.Fatalf("expected 201 for second blank email, got %d: %s", rec2.Code, rec2.Body.String())
	}
	var app2 service.ApplicationResponse
	_ = json.Unmarshal(rec2.Body.Bytes(), &app2)

	// 2. Duplicate registration returns 409
	dupRec := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "ซ้ำ",
		Nickname:   "ซ้ำ",
		NationalID: "1100000000001",
		Phone:      "0810000099",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.5",
		ShirtSize:  "L",
	})
	if dupRec.Code != http.StatusConflict {
		t.Errorf("expected 409 for duplicate nationalId, got %d", dupRec.Code)
	}

	// 3. Invalid email (400) & invalid grade (400)
	badEmailRec := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "เมลผิด",
		Nickname:   "ผิด",
		NationalID: "1100000000003",
		Phone:      "0810000003",
		Email:      "bad-email",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.4",
		ShirtSize:  "M",
	})
	if badEmailRec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid email, got %d", badEmailRec.Code)
	}

	badGradeRec := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "ชั้นผิด",
		Nickname:   "ผิด",
		NationalID: "1100000000004",
		Phone:      "0810000004",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.1",
		ShirtSize:  "M",
	})
	if badGradeRec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid grade, got %d", badGradeRec.Code)
	}

	// 4. Oversized JSON payload > 1MB returns 413
	hugeJSON := fmt.Sprintf(`{"fullName":"%s"}`, strings.Repeat("a", (1<<20)+1024))
	reqHuge := httptest.NewRequest(http.MethodPost, "/api/applications", strings.NewReader(hugeJSON))
	reqHuge.Header.Set("Content-Type", "application/json")
	recHuge := httptest.NewRecorder()
	app.ServeHTTP(recHuge, reqHuge)
	if recHuge.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for >1MB JSON body, got %d", recHuge.Code)
	}

	// 5. GetStatus missing ?q= -> 400, unknown -> 404
	recMissingQ := httptest.NewRecorder()
	app.ServeHTTP(recMissingQ, httptest.NewRequest(http.MethodGet, "/api/applications/status", nil))
	if recMissingQ.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing ?q=, got %d", recMissingQ.Code)
	}
	recNotFound := httptest.NewRecorder()
	app.ServeHTTP(recNotFound, httptest.NewRequest(http.MethodGet, "/api/applications/status?q=NOPE", nil))
	if recNotFound.Code != http.StatusNotFound {
		t.Errorf("expected 404 for unknown query, got %d", recNotFound.Code)
	}

	// 6. ConfirmAttendance missing 'confirmed' -> 400; non-PASSED -> 409; lowercase cc25-... -> 200 after PASSED
	reqNoConf := httptest.NewRequest(http.MethodPost, "/api/applications/"+app1.ID+"/confirm", bytes.NewBufferString(`{}`))
	reqNoConf.Header.Set("Content-Type", "application/json")
	recNoConf := httptest.NewRecorder()
	app.ServeHTTP(recNoConf, reqNoConf)
	if recNoConf.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when confirmed field missing, got %d", recNoConf.Code)
	}

	reqConfPending := httptest.NewRequest(http.MethodPost, "/api/applications/"+app1.ID+"/confirm", bytes.NewBufferString(`{"confirmed":false}`))
	reqConfPending.Header.Set("Content-Type", "application/json")
	recConfPending := httptest.NewRecorder()
	app.ServeHTTP(recConfPending, reqConfPending)
	if recConfPending.Code != http.StatusConflict {
		t.Errorf("expected 409 when confirming PENDING applicant, got %d", recConfPending.Code)
	}

	// Admin updates app1 to PASSED, then applicant confirms false using lowercase cc25-...
	patchPass := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+strings.ToLower(app1.ID), bytes.NewBufferString(`{"status":"PASSED"}`))
	patchPass.Header.Set("Authorization", "Bearer "+token)
	patchPass.Header.Set("Content-Type", "application/json")
	recPass := httptest.NewRecorder()
	app.ServeHTTP(recPass, patchPass)
	if recPass.Code != http.StatusOK {
		t.Fatalf("expected 200 updating to PASSED via lowercase appNo, got %d", recPass.Code)
	}

	reqConfFalse := httptest.NewRequest(http.MethodPost, "/api/applications/"+strings.ToLower(app1.ID)+"/confirm", bytes.NewBufferString(`{"confirmed":false}`))
	reqConfFalse.Header.Set("Content-Type", "application/json")
	recConfFalse := httptest.NewRecorder()
	app.ServeHTTP(recConfFalse, reqConfFalse)
	if recConfFalse.Code != http.StatusOK {
		t.Fatalf("expected 200 for confirmed=false on PASSED applicant, got %d (%s)", recConfFalse.Code, recConfFalse.Body.String())
	}

	// 7. AdminList ?status= validation, pagination, and X-Total-Count
	reqBadStatus := httptest.NewRequest(http.MethodGet, "/api/admin/applications?status=INVALID", nil)
	reqBadStatus.Header.Set("Authorization", "Bearer "+token)
	recBadStatus := httptest.NewRecorder()
	app.ServeHTTP(recBadStatus, reqBadStatus)
	if recBadStatus.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid ?status=, got %d", recBadStatus.Code)
	}

	reqBadPage := httptest.NewRequest(http.MethodGet, "/api/admin/applications?page=0&limit=10", nil)
	reqBadPage.Header.Set("Authorization", "Bearer "+token)
	recBadPage := httptest.NewRecorder()
	app.ServeHTTP(recBadPage, reqBadPage)
	if recBadPage.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for page=0, got %d", recBadPage.Code)
	}

	reqPaged := httptest.NewRequest(http.MethodGet, "/api/admin/applications?page=1&limit=1", nil)
	reqPaged.Header.Set("Authorization", "Bearer "+token)
	recPaged := httptest.NewRecorder()
	app.ServeHTTP(recPaged, reqPaged)
	if recPaged.Code != http.StatusOK {
		t.Fatalf("expected 200 for paginated admin list, got %d", recPaged.Code)
	}
	if recPaged.Header().Get("X-Total-Count") != "2" {
		t.Errorf("expected X-Total-Count=2, got %q", recPaged.Header().Get("X-Total-Count"))
	}
	var paged service.PaginatedApplicationsResponse
	_ = json.Unmarshal(recPaged.Body.Bytes(), &paged)
	if len(paged.Items) != 1 || paged.Total != 2 || paged.TotalPages != 2 {
		t.Errorf("unexpected paginated response: %+v", paged)
	}

	// 8. Invalid transition PENDING -> CONFIRMED returns 409
	reqBadTrans := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+app2.ID, bytes.NewBufferString(`{"status":"CONFIRMED"}`))
	reqBadTrans.Header.Set("Authorization", "Bearer "+token)
	reqBadTrans.Header.Set("Content-Type", "application/json")
	recBadTrans := httptest.NewRecorder()
	app.ServeHTTP(recBadTrans, reqBadTrans)
	if recBadTrans.Code != http.StatusConflict {
		t.Errorf("expected 409 for PENDING->CONFIRMED transition, got %d", recBadTrans.Code)
	}
}

func TestPaymentHandler_SecurityAndCapacityGuards(t *testing.T) {
	deps := setupTestAppWithDeps(t)
	app := deps.router
	token := loginTestAdmin(t, app)

	// Set MaxCapacity = 1
	_ = deps.setRepo.Update(context.Background(), &domain.Settings{
		ID:                  1,
		CampName:            "ComCamp 25th",
		RegistrationOpenAt:  time.Now().Add(-time.Hour),
		RegistrationCloseAt: time.Now().Add(time.Hour),
		MaxCapacity:         1,
		CampFee:             decimal.NewFromInt(300),
	})

	createAndPass := func(nid, phone string) string {
		rec := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
			FullName:   "ผู้สมัคร " + nid[len(nid)-2:],
			Nickname:   "ทดสอบ",
			NationalID: nid,
			Phone:      phone,
			School:     "โรงเรียนทดสอบ",
			Grade:      "ม.5",
			ShirtSize:  "L",
		})
		var created service.ApplicationResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &created)

		patch := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+created.ID, bytes.NewBufferString(`{"status":"PASSED"}`))
		patch.Header.Set("Authorization", "Bearer "+token)
		patch.Header.Set("Content-Type", "application/json")
		app.ServeHTTP(httptest.NewRecorder(), patch)
		return created.ID
	}

	idPendingRec := submitApplicationViaHTTP(t, app, service.ApplicationCreateRequest{
		FullName:   "ยังไม่ผ่าน",
		Nickname:   "รอ",
		NationalID: "1200000000000",
		Phone:      "0820000000",
		School:     "โรงเรียนทดสอบ",
		Grade:      "ม.5",
		ShirtSize:  "M",
	})
	var pendingApp service.ApplicationResponse
	_ = json.Unmarshal(idPendingRec.Body.Bytes(), &pendingApp)

	id1 := createAndPass("1200000000001", "0820000001")
	id2 := createAndPass("1200000000002", "0820000002")

	upload := func(targetID, filename string, data []byte) *httptest.ResponseRecorder {
		body := &bytes.Buffer{}
		w := multipart.NewWriter(body)
		part, _ := w.CreateFormFile("slip", filename)
		_, _ = io.Copy(part, bytes.NewReader(data))
		_ = w.Close()

		req := httptest.NewRequest(http.MethodPost, "/api/applications/"+targetID+"/slip", body)
		req.Header.Set("Content-Type", w.FormDataContentType())
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
		return rec
	}

	// 1. MaxBytesReader 413 for > 5MB + 4096 bytes
	oversized := bytes.Repeat([]byte("A"), (5<<20)+8192)
	if rec := upload(id1, "huge.jpg", oversized); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for >5MB slip upload, got %d (%s)", rec.Code, rec.Body.String())
	}

	// 2. Non-PASSED applicant upload -> 409
	validImg1 := generateValidJPEGBytes(t, 10, 20, 30)
	if rec := upload(pendingApp.ID, "slip.jpg", validImg1); rec.Code != http.StatusConflict {
		t.Errorf("expected 409 uploading slip for PENDING applicant, got %d", rec.Code)
	}

	// 3. Fake/octet-stream image -> 400
	if rec := upload(id1, "evil.jpg", []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05}); rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for octet-stream fake jpg, got %d", rec.Code)
	}

	// 4. Valid uploads for id1 & id2
	if rec := upload(id1, "s1.jpg", validImg1); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 uploading valid slip for id1, got %d (%s)", rec.Code, rec.Body.String())
	}
	validImg2 := generateValidJPEGBytes(t, 40, 50, 60)
	if rec := upload(id2, "s2.jpg", validImg2); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 uploading valid slip for id2, got %d (%s)", rec.Code, rec.Body.String())
	}

	// 5. VerifySlip missing 'approved' -> 400
	reqMissingApproved := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+id1+"/verify-slip", bytes.NewBufferString(`{"note":"missing"}`))
	reqMissingApproved.Header.Set("Authorization", "Bearer "+token)
	reqMissingApproved.Header.Set("Content-Type", "application/json")
	recMissingApproved := httptest.NewRecorder()
	app.ServeHTTP(recMissingApproved, reqMissingApproved)
	if recMissingApproved.Code != http.StatusBadRequest {
		t.Errorf("expected 400 when approved field missing, got %d", recMissingApproved.Code)
	}

	// 6. VerifySlip approved=false -> 200, then re-verify -> 409
	reqReject := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+id1+"/verify-slip", bytes.NewBufferString(`{"approved":false,"note":"blurry"}`))
	reqReject.Header.Set("Authorization", "Bearer "+token)
	reqReject.Header.Set("Content-Type", "application/json")
	recReject := httptest.NewRecorder()
	app.ServeHTTP(recReject, reqReject)
	if recReject.Code != http.StatusOK {
		t.Fatalf("expected 200 on VerifySlip approved=false, got %d", recReject.Code)
	}

	reqReverify := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+id1+"/verify-slip", bytes.NewBufferString(`{"approved":true}`))
	reqReverify.Header.Set("Authorization", "Bearer "+token)
	reqReverify.Header.Set("Content-Type", "application/json")
	recReverify := httptest.NewRecorder()
	app.ServeHTTP(recReverify, reqReverify)
	if recReverify.Code != http.StatusConflict {
		t.Errorf("expected 409 on re-verifying already verified slip, got %d", recReverify.Code)
	}

	// 7. Verify id2 approved=true -> 200 (fills capacity=1), then id1 re-uploads and approves -> 409 capacity full!
	reqApprove2 := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+id2+"/verify-slip", bytes.NewBufferString(`{"approved":true,"note":"ok"}`))
	reqApprove2.Header.Set("Authorization", "Bearer "+token)
	reqApprove2.Header.Set("Content-Type", "application/json")
	recApprove2 := httptest.NewRecorder()
	app.ServeHTTP(recApprove2, reqApprove2)
	if recApprove2.Code != http.StatusOK {
		t.Fatalf("expected 200 approving id2, got %d", recApprove2.Code)
	}

	time.Sleep(2 * time.Millisecond)
	validImg3 := generateValidJPEGBytes(t, 70, 80, 90)
	if rec := upload(id1, "s1_retry.jpg", validImg3); rec.Code != http.StatusOK {
		t.Fatalf("expected 200 re-uploading slip for id1, got %d", rec.Code)
	}
	reqApproveOverCap := httptest.NewRequest(http.MethodPatch, "/api/admin/applications/"+id1+"/verify-slip", bytes.NewBufferString(`{"approved":true}`))
	reqApproveOverCap.Header.Set("Authorization", "Bearer "+token)
	reqApproveOverCap.Header.Set("Content-Type", "application/json")
	recApproveOverCap := httptest.NewRecorder()
	app.ServeHTTP(recApproveOverCap, reqApproveOverCap)
	if recApproveOverCap.Code != http.StatusConflict {
		t.Errorf("expected 409 when maxCapacity=1 is reached on VerifySlip, got %d (%s)", recApproveOverCap.Code, recApproveOverCap.Body.String())
	}
}

func TestSettingAndAuthHandler_NegativeCases(t *testing.T) {
	deps := setupTestAppWithDeps(t)
	app := deps.router
	token := loginTestAdmin(t, app)

	// AuthHandler: invalid JSON (400), wrong credentials (401), oversized JSON (413)
	recBadJSON := httptest.NewRecorder()
	reqBadJSON := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{invalid`))
	reqBadJSON.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(recBadJSON, reqBadJSON)
	if recBadJSON.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid login JSON, got %d", recBadJSON.Code)
	}

	recWrongCreds := httptest.NewRecorder()
	reqWrongCreds := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"wrong"}`))
	reqWrongCreds.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(recWrongCreds, reqWrongCreds)
	if recWrongCreds.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for wrong password, got %d", recWrongCreds.Code)
	}

	// SettingHandler: validation errors -> 400
	badSettingPayloads := []string{
		`{"registrationOpenAt":"not-a-date"}`,
		`{"registrationOpenAt":"2026-12-10T00:00:00Z","registrationCloseAt":"2026-12-01T00:00:00Z"}`,
		`{"maxCapacity":0}`,
		`{"campFee":-50}`,
		`{"campName":"   "}`,
	}
	for i, body := range badSettingPayloads {
		req := httptest.NewRequest(http.MethodPatch, "/api/admin/settings", bytes.NewBufferString(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("payload #%d (%s): expected 400, got %d (%s)", i, strconv.Quote(body), rec.Code, rec.Body.String())
		}
	}
}
