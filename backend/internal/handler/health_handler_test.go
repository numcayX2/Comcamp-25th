package handler_test

import (
	"encoding/json"
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
