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

	t.Run("ServeSpec returns valid OpenAPI JSON with no-store header", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/docs/openapi.json", nil)
		rec := httptest.NewRecorder()

		h.ServeSpec(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("expected Cache-Control: no-store, got %q", rec.Header().Get("Cache-Control"))
		}

		var parsed map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
			t.Fatalf("failed to parse spec json: %v", err)
		}

		if parsed["openapi"] != "3.0.3" {
			t.Errorf("expected openapi 3.0.3, got %v", parsed["openapi"])
		}
	})

	t.Run("ServeUI returns HTML page with CSP and no-store headers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/swagger", nil)
		rec := httptest.NewRecorder()

		h.ServeUI(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("expected Cache-Control: no-store, got %q", rec.Header().Get("Cache-Control"))
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("expected Content-Security-Policy header on Swagger UI")
		}

		body := rec.Body.String()
		if !strings.Contains(body, "SwaggerUIBundle") {
			t.Errorf("expected HTML to contain SwaggerUIBundle script")
		}
	})
}
