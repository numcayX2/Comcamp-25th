package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

const maxJSONBodyBytes int64 = 1 << 20 // 1MB

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
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONDecodeError(w, err, "invalid request body")
		return
	}

	token, _, err := h.authService.Login(r.Context(), req.Username, req.Password)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) || errors.Is(err, service.ErrAccountInactive) {
			response.Error(w, http.StatusUnauthorized, service.ErrInvalidCredentials.Error())
			return
		}
		response.Error(w, http.StatusInternalServerError, "authentication service unavailable")
		return
	}

	response.OK(w, LoginResponse{Token: token})
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil || claims.TokenID == "" {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	h.authService.Logout(claims)
	response.OK(w, response.MessageResponse{Message: "logged out successfully"})
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	dec := json.NewDecoder(r.Body)
	return dec.Decode(dst)
}

func writeJSONDecodeError(w http.ResponseWriter, err error, fallbackMsg string) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		response.Error(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	response.Error(w, http.StatusBadRequest, fallbackMsg)
}
