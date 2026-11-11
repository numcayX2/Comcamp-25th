package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
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
	// Role tells the dashboard which controls to show. It is only a UI hint: every /api/admin/*
	// request re-reads the role from the database (RequireAuth + RequireRoles).
	Role domain.AdminRole `json:"role"`
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid request body")
		return
	}
	// bcrypt only reads the first 72 bytes; refuse absurd inputs before hashing.
	if req.Username == "" || req.Password == "" || len(req.Username) > 100 || len(req.Password) > 72 {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, service.ErrInvalidCredentials.Error())
		return
	}

	token, admin, err := h.authService.Login(r.Context(), req.Username, req.Password, middleware.RemoteIP(r))
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, err.Error())
			return
		}
		response.Internal(w, r, err)
		return
	}

	response.OK(w, LoginResponse{Token: token, Role: admin.Role})
}
