package handler_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/handler"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/server"
	"comcamp25-backend/internal/service"
)

const publicListPath = "/api/applications/public"

// publicListKeys is the STRICT PDPA allowlist for one row of GET /api/applications/public
// (CLAUDE_REVAMP_HANDOFF.md 5.4). Anything else in a row is a leak.
var publicListKeys = []string{"fullName", "nickname", "no", "province", "school", "status"}

func (a *testApp) getPublicList(t *testing.T) (*bytes.Buffer, http.Header, []map[string]any) {
	t.Helper()
	rec := a.do(t, http.MethodGet, publicListPath, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: expected 200, got %d (%s)", publicListPath, rec.Code, rec.Body.String())
	}
	raw := bytes.NewBuffer(append([]byte(nil), rec.Body.Bytes()...))
	var top map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if len(top) != 1 {
		t.Fatalf("top-level keys must be exactly [applicants], got %v", keysOf(top))
	}
	list, ok := top["applicants"].([]any)
	if !ok {
		t.Fatalf("applicants must be a JSON array (never null), got %T", top["applicants"])
	}
	rows := make([]map[string]any, 0, len(list))
	for i, item := range list {
		row, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("row %d is %T, want object", i, item)
		}
		rows = append(rows, row)
	}
	return raw, rec.Header(), rows
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// submitWithEverySensitiveField registers an applicant whose every private field is filled with a
// distinctive value, so a leak of any of them shows up as a substring of the public body.
func (a *testApp) submitWithEverySensitiveField(t *testing.T) map[string]string {
	t.Helper()
	secret := map[string]string{
		"fullName":          "ลับสุดยอด นามสกุลสาธารณะ",
		"nickname":          "เปิดเผยได้",
		"nationalId":        validTestNationalID(777001),
		"phone":             "0897770011",
		"email":             "secret.leak.probe@example.com",
		"parentName":        "ผู้ปกครองลับเฉพาะ",
		"parentRelation":    "ญาติลับเฉพาะ",
		"parentPhone":       "0867770022",
		"school":            "โรงเรียนสาธารณะทดสอบ",
		"province":          "ลำพูน",
		"grade":             "ม.6",
		"shirtSize":         "L",
		"motivation":        "แรงบันดาลใจลับเฉพาะ-motivation-probe",
		"allergies":         "แพ้ถั่วลับเฉพาะ-allergy-probe",
		"medicalConditions": "หอบหืดลับเฉพาะ-medical-probe",
	}
	body, _ := json.Marshal(secret)
	rec := a.do(t, http.MethodPost, "/api/applications", bytes.NewBuffer(body), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("submit: expected 201, got %d (%s)", rec.Code, rec.Body.String())
	}
	var res struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	secret["applicationNo"] = res.ID
	stored, err := a.appRepo.GetByApplicationNo(context.Background(), res.ID)
	if err != nil {
		t.Fatal(err)
	}
	secret["uuid"] = stored.ID.String()
	return secret
}

func TestPublicList_OnlyAllowlistedKeysAndNoSensitiveValues(t *testing.T) {
	app := setupTestApp(t)
	secret := app.submitWithEverySensitiveField(t)

	raw, headers, rows := app.getPublicList(t)
	if len(rows) != 1 {
		t.Fatalf("expected 1 listed applicant, got %d", len(rows))
	}
	if got := keysOf(rows[0]); strings.Join(got, ",") != strings.Join(publicListKeys, ",") {
		t.Fatalf("row keys = %v, want exactly %v", got, publicListKeys)
	}

	row := rows[0]
	if row["no"] != float64(1) || row["fullName"] != secret["fullName"] || row["nickname"] != secret["nickname"] ||
		row["school"] != secret["school"] || row["province"] != secret["province"] || row["status"] != "รอชำระเงิน" {
		t.Fatalf("unexpected row %v", row)
	}

	body := raw.String()
	for _, field := range []string{
		"nationalId", "phone", "email", "parentName", "parentRelation", "parentPhone",
		"motivation", "allergies", "medicalConditions", "applicationNo", "uuid",
	} {
		v := secret[field]
		if v == "" {
			t.Fatalf("probe %s is empty", field)
		}
		if strings.Contains(body, v) {
			t.Errorf("public list leaks %s (%q)", field, v)
		}
	}
	// Partial identifiers are leaks too (last 4 digits, the CC25 prefix of any code, raw status).
	for _, probe := range []string{secret["nationalId"][9:], secret["phone"][6:], "CC25-", "PASSED", "slip", "@"} {
		if strings.Contains(body, probe) {
			t.Errorf("public list contains %q", probe)
		}
	}

	if cc := headers.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
	if ct := headers.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestPublicList_EmptyBeforeAnyoneRegisters(t *testing.T) {
	app := setupTestApp(t)
	raw, _, rows := app.getPublicList(t)
	if len(rows) != 0 || !strings.Contains(raw.String(), `"applicants":[]`) {
		t.Fatalf("expected an empty array, got %s", raw.String())
	}
}

// The cache must not hide a registration or a staff status change from the next request.
func TestPublicList_ReflectsCreateAndStatusChangeImmediately(t *testing.T) {
	app := setupTestApp(t)
	token := app.login(t)

	if _, _, rows := app.getPublicList(t); len(rows) != 0 {
		t.Fatalf("expected empty list, got %v", rows)
	}

	first := app.submit(t, validTestNationalID(777101), "0817771010", "list1@example.com")
	_, _, rows := app.getPublicList(t)
	if len(rows) != 1 || rows[0]["status"] != "รอชำระเงิน" {
		t.Fatalf("a new registration must appear immediately, got %v", rows)
	}

	// The memory repo stamps created_at with time.Now(), whose Windows resolution is coarse (up to
	// ~15.6ms). Two submits in the same tick tie, and the id tiebreak is a random UUID, so the
	// "registration order" assertion below flaked. Wait out one tick so the order is well defined.
	time.Sleep(20 * time.Millisecond)
	second := app.submit(t, validTestNationalID(777102), "0817771020", "list2@example.com")
	app.setStatus(t, token, first.ID, domain.StatusConfirmed)
	_, _, rows = app.getPublicList(t)
	if len(rows) != 2 || rows[0]["no"] != float64(1) || rows[0]["status"] != "ยืนยันสิทธิ์แล้ว" ||
		rows[1]["no"] != float64(2) || rows[1]["status"] != "รอชำระเงิน" {
		t.Fatalf("status change must show immediately, in registration order, got %v", rows)
	}

	app.setStatus(t, token, second.ID, domain.StatusRejected)
	_, _, rows = app.getPublicList(t)
	if len(rows) != 1 || rows[0]["status"] != "ยืนยันสิทธิ์แล้ว" {
		t.Fatalf("a rejected applicant must leave the list immediately, got %v", rows)
	}
}

func TestPublicList_RateLimitedPerIP(t *testing.T) {
	app := setupTestApp(t) // default limits
	for i := 1; i <= server.PublicListRatePerMinute; i++ {
		if rec := app.do(t, http.MethodGet, publicListPath, nil, nil); rec.Code != http.StatusOK {
			t.Fatalf("request %d within the allowance got %d", i, rec.Code)
		}
	}
	rec := app.do(t, http.MethodGet, publicListPath, nil, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("request over the allowance must be 429, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("429 must carry Retry-After")
	}
	var e struct{ Code string }
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if e.Code != "RATE_LIMITED" {
		t.Errorf("error code = %q, want RATE_LIMITED", e.Code)
	}

	// The list has its own bucket: browsing it does not use up the status lookup allowance.
	if rec := app.do(t, http.MethodGet, "/api/applications/status?q=CC25-NOONE1", nil, nil); rec.Code == http.StatusTooManyRequests {
		t.Fatal("exhausting the public list limit must not rate limit the status lookup")
	}
}

func TestDefaultRateLimits_PublicListHasItsOwnLimiter(t *testing.T) {
	l := server.DefaultRateLimits()
	if l.PublicList == nil {
		t.Fatal("public list limiter is missing")
	}
	for name, other := range map[string]any{"status": l.StatusQuery, "submit": l.Submit, "login": l.Login} {
		if other == any(l.PublicList) {
			t.Fatalf("public list shares a limiter with %s", name)
		}
	}
}

// blockingPublicRepo holds every ListPublic call until release is closed (or fails with err).
type blockingPublicRepo struct {
	*memory.MemoryApplicantRepo
	release chan struct{}
	err     error
}

func (r *blockingPublicRepo) ListPublic(ctx context.Context) ([]domain.PublicApplicant, error) {
	if r.release != nil {
		<-r.release
	}
	if r.err != nil {
		return nil, r.err
	}
	return r.MemoryApplicantRepo.ListPublic(ctx)
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

// A visitor who leaves while the list is loading is not a server error: no 500, no error log.
func TestPublicList_ClientDisconnectIsNotAnInternalError(t *testing.T) {
	apps := memory.NewMemoryApplicantRepo()
	repo := &blockingPublicRepo{MemoryApplicantRepo: apps, release: make(chan struct{})}
	t.Cleanup(func() { close(repo.release) })
	h := handler.NewApplicantHandler(service.NewApplicantService(repo, memory.NewMemorySettingRepo(), memory.NewMemoryPaymentRepo(apps)))
	logs := captureLog(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	h.ListPublic(rec, httptest.NewRequest(http.MethodGet, publicListPath, nil).WithContext(ctx))

	if rec.Body.Len() != 0 || rec.Code == http.StatusInternalServerError {
		t.Fatalf("a disconnected client must get no answer, got %d %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(logs.String(), "internal error") {
		t.Fatalf("a client disconnect was logged as an internal error: %s", logs.String())
	}
}

// A failure inside the service while the client is still waiting is still a logged 500, even
// when it is a deadline (for example a slow database query).
func TestPublicList_ServerDeadlineIsStillAnInternalError(t *testing.T) {
	apps := memory.NewMemoryApplicantRepo()
	repo := &blockingPublicRepo{MemoryApplicantRepo: apps, err: context.DeadlineExceeded}
	h := handler.NewApplicantHandler(service.NewApplicantService(repo, memory.NewMemorySettingRepo(), memory.NewMemoryPaymentRepo(apps)))
	logs := captureLog(t)

	rec := httptest.NewRecorder()
	h.ListPublic(rec, httptest.NewRequest(http.MethodGet, publicListPath, nil))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "INTERNAL_ERROR") {
		t.Fatalf("expected a generic 500, got %d %q", rec.Code, rec.Body.String())
	}
	if !strings.Contains(logs.String(), "internal error") {
		t.Fatal("a server-side failure must be logged")
	}
}
