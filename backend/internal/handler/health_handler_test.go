package handler_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"comcamp25-backend/internal/handler"
)

func TestHealthHandler_Check(t *testing.T) {
	t.Run("default memory health check", func(t *testing.T) {
		h := handler.NewHealthHandler("comcamp25-backend")

		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		rr := httptest.NewRecorder()

		h.Check(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected status 200 OK, got %d", rr.Code)
		}

		var res handler.HealthResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if res.Status != "healthy" {
			t.Errorf("expected status 'healthy', got '%s'", res.Status)
		}
		if res.Service != "comcamp25-backend" {
			t.Errorf("expected service 'comcamp25-backend', got '%s'", res.Service)
		}
		if res.Mode != "memory" {
			t.Errorf("expected mode 'memory', got '%s'", res.Mode)
		}
		if res.Time == "" {
			t.Errorf("expected non-empty time")
		}
	})

	t.Run("postgres health check healthy 200 and unhealthy 503", func(t *testing.T) {
		okH := handler.NewHealthHandlerWithCheck("comcamp25-backend", "postgres", func(ctx context.Context) error {
			return nil
		})
		rrOK := httptest.NewRecorder()
		okH.Check(rrOK, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if rrOK.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rrOK.Code)
		}

		failH := handler.NewHealthHandlerWithCheck("comcamp25-backend", "postgres", func(ctx context.Context) error {
			return errors.New("connection refused")
		})
		rrFail := httptest.NewRecorder()
		failH.Check(rrFail, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if rrFail.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503 Service Unavailable, got %d", rrFail.Code)
		}

		var failRes handler.HealthResponse
		_ = json.Unmarshal(rrFail.Body.Bytes(), &failRes)
		if failRes.Status != "unhealthy" || failRes.Mode != "postgres" {
			t.Errorf("unexpected unhealthy response: %+v", failRes)
		}
	})
}
