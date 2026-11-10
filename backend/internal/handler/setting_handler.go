package handler

import (
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
		response.Internal(w, r, err)
		return
	}
	response.OK(w, settings)
}

// GetAdmin handles GET /api/admin/settings (full settings, admin only).
func (h *SettingHandler) GetAdmin(w http.ResponseWriter, r *http.Request) {
	settings, err := h.settingService.GetAdminSettings(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, settings)
}

// UpdateAdmin handles PATCH /api/admin/settings: a partial update of the schedule, seat quota
// (maxCapacity), fee and emergency close. Validation errors are 400; the change is audited.
func (h *SettingHandler) UpdateAdmin(w http.ResponseWriter, r *http.Request) {
	var req service.UpdateSettingsRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	updated, err := h.settingService.UpdateSettings(r.Context(), req, claims.AdminID, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response.OK(w, updated)
}
