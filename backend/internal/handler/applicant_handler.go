package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

type ApplicantHandler struct {
	appService *service.ApplicantService
}

func NewApplicantHandler(appService *service.ApplicantService) *ApplicantHandler {
	return &ApplicantHandler{appService: appService}
}

func (h *ApplicantHandler) Submit(w http.ResponseWriter, r *http.Request) {
	var req service.ApplicationCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body payload")
		return
	}

	app, err := h.appService.Submit(r.Context(), req)
	if err != nil {
		switch err {
		case service.ErrRegistrationClosed:
			response.Error(w, http.StatusForbidden, err.Error())
		case service.ErrQuotaExceeded:
			response.Error(w, http.StatusConflict, err.Error())
		case service.ErrInvalidNationalID, service.ErrInvalidPhone, service.ErrInvalidShirtSize:
			response.Error(w, http.StatusBadRequest, err.Error())
		default:
			response.Error(w, http.StatusBadRequest, err.Error())
		}
		return
	}

	response.Created(w, app)
}

func (h *ApplicantHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		response.Error(w, http.StatusBadRequest, "query parameter 'q' is required")
		return
	}

	app, err := h.appService.QueryStatus(r.Context(), q)
	if err != nil {
		response.Error(w, http.StatusNotFound, "Application not found")
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) ConfirmAttendance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	var body struct {
		Confirmed bool `json:"confirmed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid json payload")
		return
	}

	app, err := h.appService.ConfirmAttendance(r.Context(), id, body.Confirmed)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) AdminList(w http.ResponseWriter, r *http.Request) {
	var statusFilter *domain.ApplicationStatus
	statusParam := r.URL.Query().Get("status")
	if statusParam != "" {
		st := domain.ApplicationStatus(statusParam)
		statusFilter = &st
	}

	apps, err := h.appService.ListAll(r.Context(), statusFilter)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	if apps == nil {
		apps = []*service.ApplicationResponse{}
	}

	response.OK(w, apps)
}

func (h *ApplicantHandler) AdminUpdateStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	var body struct {
		Status string `json:"status"`
		Reason string `json:"reason,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid json payload")
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	var adminID *int64
	if claims != nil {
		adminID = &claims.AdminID
	}

	app, err := h.appService.UpdateStatus(r.Context(), id, domain.ApplicationStatus(body.Status), adminID, body.Reason)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	response.OK(w, app)
}
