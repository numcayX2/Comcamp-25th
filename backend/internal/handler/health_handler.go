package handler

import (
	"context"
	"net/http"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

type HealthHandler struct {
	serviceName string
	mode        string
	pingFn      func(context.Context) error
}

func NewHealthHandler(serviceName string) *HealthHandler {
	return &HealthHandler{
		serviceName: serviceName,
		mode:        "memory",
	}
}

func NewHealthHandlerWithCheck(serviceName, mode string, pingFn func(context.Context) error) *HealthHandler {
	return &HealthHandler{
		serviceName: serviceName,
		mode:        mode,
		pingFn:      pingFn,
	}
}

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Mode    string `json:"mode,omitempty"`
	Time    string `json:"time"`
}

func (h *HealthHandler) Check(w http.ResponseWriter, r *http.Request) {
	status := "healthy"
	code := http.StatusOK

	if h.pingFn != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := h.pingFn(ctx); err != nil {
			status = "unhealthy"
			code = http.StatusServiceUnavailable
		}
	}

	res := HealthResponse{
		Status:  status,
		Service: h.serviceName,
		Mode:    h.mode,
		Time:    time.Now().UTC().Format(time.RFC3339),
	}
	response.JSON(w, code, res)
}
