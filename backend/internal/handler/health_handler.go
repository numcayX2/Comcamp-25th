package handler

import (
	"context"
	"net/http"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

type HealthHandler struct {
	serviceName string
	ping        func(context.Context) error
}

func NewHealthHandler(serviceName string) *HealthHandler {
	return &HealthHandler{serviceName: serviceName}
}

// NewHealthHandlerWithCheck configures a readiness probe (such as a database ping)
// so /api/health returns 503 Service Unavailable if the dependency check fails.
func NewHealthHandlerWithCheck(serviceName string, ping func(context.Context) error) *HealthHandler {
	return &HealthHandler{serviceName: serviceName, ping: ping}
}

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Time    string `json:"time"`
}

func (h *HealthHandler) Check(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339)
	if h.ping != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := h.ping(ctx); err != nil {
			response.JSON(w, http.StatusServiceUnavailable, HealthResponse{
				Status:  "unhealthy",
				Service: h.serviceName,
				Time:    now,
			})
			return
		}
	}
	response.OK(w, HealthResponse{
		Status:  "healthy",
		Service: h.serviceName,
		Time:    now,
	})
}
