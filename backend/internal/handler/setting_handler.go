package handler

import (
	"errors"
	"net/http"

	"comcamp25-backend/internal/domain"
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
		response.Error(w, http.StatusInternalServerError, "failed to load public settings")
		return
	}
	response.OK(w, settings)
}

func (h *SettingHandler) GetAdmin(w http.ResponseWriter, r *http.Request) {
	settings, err := h.settingService.GetAdminSettings(r.Context())
	if err != nil {
		if errors.Is(err, domain.ErrSettingsNotFound) {
			response.Error(w, http.StatusNotFound, "settings not found")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to load settings")
		return
	}
	response.OK(w, settings)
}

func (h *SettingHandler) UpdateAdmin(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil || claims.AdminID <= 0 {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req service.UpdateSettingsRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONDecodeError(w, err, "invalid request body")
		return
	}

	updated, err := h.settingService.UpdateSettings(r.Context(), req, claims.AdminID)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrInvalidSettings):
			response.Error(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, domain.ErrSettingsNotFound):
			response.Error(w, http.StatusNotFound, "settings not found")
		default:
			response.Error(w, http.StatusInternalServerError, "failed to update settings")
		}
		return
	}

	response.OK(w, updated)
}
