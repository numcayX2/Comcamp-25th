package handler

import (
	"net/http"
	"time"

	"comcamp25-backend/internal/pkg/response"
)

type HealthHandler struct {
	serviceName string
}

func NewHealthHandler(serviceName string) *HealthHandler {
	return &HealthHandler{serviceName: serviceName}
}

type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Time    string `json:"time"`
}

func (h *HealthHandler) Check(w http.ResponseWriter, r *http.Request) {
	res := HealthResponse{
		Status:  "healthy",
		Service: h.serviceName,
		Time:    time.Now().UTC().Format(time.RFC3339),
	}
	response.OK(w, res)
}
