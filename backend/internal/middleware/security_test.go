package middleware

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMaskLogPath_HidesApplicationCodes(t *testing.T) {
	for in, want := range map[string]string{
		"/api/applications/CC25-E85B53/slip":              "/api/applications/CC25-******/slip",
		"/api/applications/cc25-e85b53/confirm":           "/api/applications/CC25-******/confirm",
		"/api/applications/CC25E85B53/withdraw":           "/api/applications/CC25-******/withdraw",
		"/api/applications/cc25 e85b53/profile":           "/api/applications/CC25-******/profile",
		"/api/applications/CC\u0e52\u0e55-E85B53/slip":    "/api/applications/CC25-******/slip",
		"/api/applications/\u200bCC25-E85B53/slip":        "/api/applications/CC25-******/slip",
		"/api/admin/applications/CC25-E85B53":             "/api/admin/applications/CC25-******",
		"/api/admin/applications/CC25-E85B53/verify-slip": "/api/admin/applications/CC25-******/verify-slip",
		"/api/other/cc25e85b53":                           "/api/other/CC25-******",
		"/api/applications/status":                        "/api/applications/status",
		"/api/applications/public":                        "/api/applications/public",
		"/api/applications":                               "/api/applications",
		"/api/applications/":                              "/api/applications/",
		"/api/admin/applications/export-audit":            "/api/admin/applications/export-audit",
		"/api/health":                                     "/api/health",
	} {
		if got := MaskLogPath(in); got != want {
			t.Errorf("MaskLogPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAccessLog_DoesNotLogCodeOrQuery(t *testing.T) {
	var buf bytes.Buffer
	prev, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	defer func() { log.SetOutput(prev); log.SetFlags(prevFlags) }()

	h := AccessLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, target := range []string{
		"/api/applications/cc25-e85b53/slip",
		"/api/applications/status?q=CC25-E85B53",
		"/api/applications/status?q=1509912345678",
	} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, target, nil))
	}
	out := buf.String()
	for _, secret := range []string{"e85b53", "E85B53", "1509912345678", "?q="} {
		if strings.Contains(out, secret) {
			t.Fatalf("access log leaks %q:\n%s", secret, out)
		}
	}
	if !strings.Contains(out, "/api/applications/CC25-******/slip") {
		t.Fatalf("access log should show the masked path:\n%s", out)
	}
}
