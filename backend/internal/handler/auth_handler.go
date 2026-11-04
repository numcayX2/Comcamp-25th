package handler

import (
	"encoding/json"
	"net/http"

	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

type AuthHandler struct {
	authService *service.AuthService
}

func NewAuthHandler(authService *service.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginResponse struct {
	Token string `json:"token"`
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body")
		return
	}

	token, _, err := h.authService.Login(r.Context(), req.Username, req.Password)
	if err != nil {
		if err == service.ErrInvalidCredentials || err == service.ErrAccountInactive {
			response.Error(w, http.StatusUnauthorized, err.Error())
			return
		}
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	response.OK(w, LoginResponse{Token: token})
}
