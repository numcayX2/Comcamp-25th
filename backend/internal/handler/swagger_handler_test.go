package handler_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"comcamp25-backend/internal/docs"
	"comcamp25-backend/internal/handler"
)

func TestSwaggerHandler(t *testing.T) {
	h := handler.NewSwaggerHandler(docs.OpenAPISpec)

	t.Run("ServeSpec returns valid OpenAPI JSON", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/docs/openapi.json", nil)
		rec := httptest.NewRecorder()

		h.ServeSpec(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}

		var parsed map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("failed to parse spec json: %v", err)
		}

		if parsed["openapi"] != "3.0.3" {
			t.Errorf("expected openapi 3.0.3, got %v", parsed["openapi"])
		}
	})

	t.Run("ServeUI returns HTML page", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/swagger", nil)
		rec := httptest.NewRecorder()

		h.ServeUI(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}

		body := rec.Body.String()
		if !strings.Contains(body, "SwaggerUIBundle") {
			t.Errorf("expected HTML to contain SwaggerUIBundle script")
		}
		// LOW-05: Swagger UI must not keep an admin Bearer token in localStorage.
		if !strings.Contains(body, "persistAuthorization: false") || strings.Contains(body, "persistAuthorization: true") {
			t.Errorf("expected persistAuthorization: false in the Swagger UI config")
		}
		if !strings.Contains(body, `crossorigin="anonymous"`) {
			t.Errorf("expected CDN assets to specify crossorigin=\"anonymous\"")
		}
		csp := rec.Header().Get("Content-Security-Policy")
		for _, directive := range []string{"default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"} {
			if !strings.Contains(csp, directive) {
				t.Errorf("ServeUI CSP %q missing %q", csp, directive)
			}
		}
	})

	// LOW-05: both docs responses carry the defensive headers.
	for name, serve := range map[string]http.HandlerFunc{"ServeUI": h.ServeUI, "ServeSpec": h.ServeSpec} {
		t.Run(name+" sets defensive headers", func(t *testing.T) {
			rec := httptest.NewRecorder()
			serve(rec, httptest.NewRequest(http.MethodGet, "/", nil))
			for k, want := range map[string]string{
				"X-Content-Type-Options": "nosniff",
				"X-Frame-Options":        "DENY",
				"Referrer-Policy":        "no-referrer",
				"Cache-Control":          "no-store",
			} {
				if got := rec.Header().Get(k); got != want {
					t.Errorf("%s: %s = %q, want %q", name, k, got, want)
				}
			}
		})
	}
}
