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

	if res.Time == "" {
		t.Errorf("expected non-empty time")
	}
}

func TestHealthHandler_CheckWithProbe(t *testing.T) {
	t.Run("returns 200 when ping succeeds", func(t *testing.T) {
		h := handler.NewHealthHandlerWithCheck("comcamp25-backend", func(ctx context.Context) error {
			if _, ok := ctx.Deadline(); !ok {
				t.Error("expected ping context to carry a deadline")
			}
			return nil
		})
		rr := httptest.NewRecorder()
		h.Check(rr, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rr.Code)
		}
		var res handler.HealthResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if res.Status != "healthy" {
			t.Errorf("expected healthy status, got %q", res.Status)
		}
	})

	t.Run("returns 503 when ping fails", func(t *testing.T) {
		h := handler.NewHealthHandlerWithCheck("comcamp25-backend", func(context.Context) error {
			return errors.New("connection refused")
		})
		rr := httptest.NewRecorder()
		h.Check(rr, httptest.NewRequest(http.MethodGet, "/api/health", nil))
		if rr.Code != http.StatusServiceUnavailable {
			t.Fatalf("expected 503, got %d", rr.Code)
		}
		var res handler.HealthResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &res); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		if res.Status != "unhealthy" {
			t.Errorf("expected unhealthy status, got %q", res.Status)
		}
		if res.Service != "comcamp25-backend" {
			t.Errorf("expected service 'comcamp25-backend', got %q", res.Service)
		}
		if res.Time == "" {
			t.Errorf("expected non-empty time")
		}
	})
}
