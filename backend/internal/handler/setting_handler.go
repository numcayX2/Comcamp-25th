package handler

import (
	"encoding/json"
	"net/http"

	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

type SettingHandler struct {
	settingService *service.SettingService
}

func NewSettingHandler(settingService *service.SettingService) *SettingHandler {
	return &SettingHandler{settingService: settingService}
}

func (h *SettingHandler) GetPublic(w http.ResponseWriter, r *http.Request) {
	settings, err := h.settingService.GetPublicSettings(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, settings)
}

func (h *SettingHandler) GetAdmin(w http.ResponseWriter, r *http.Request) {
	settings, err := h.settingService.GetAdminSettings(r.Context())
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	response.OK(w, settings)
}

func (h *SettingHandler) UpdateAdmin(w http.ResponseWriter, r *http.Request) {
	var req service.UpdateSettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body")
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	var adminID int64
	if claims != nil {
		adminID = claims.AdminID
	}

	updated, err := h.settingService.UpdateSettings(r.Context(), req, adminID)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	response.OK(w, updated)
}
