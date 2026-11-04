package handler

import (
	"net/http"

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
