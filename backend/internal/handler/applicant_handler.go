package handler

import (
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

// Submit handles POST /api/applications. With X-Idempotency-Key, a retry of a submission that
// was already stored answers 200 + "Idempotent-Replayed: true" with the original application.
func (h *ApplicantHandler) Submit(w http.ResponseWriter, r *http.Request) {
	var req service.ApplicationCreateRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	app, replayed, err := h.appService.SubmitWithKey(ctx, req, r.Header.Get("X-Idempotency-Key"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	if replayed {
		w.Header().Set("Idempotent-Replayed", "true")
		response.OK(w, app)
		return
	}
	response.Created(w, app)
}

// GetStatus handles the public lookup; the response is masked (AGENTS.md §13.5).
func (h *ApplicantHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "query parameter 'q' is required")
		return
	}

	app, err := h.appService.QueryStatus(r.Context(), q)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) ConfirmAttendance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		Confirmed bool `json:"confirmed"`
		// VerifyCode is the last 4 digits of the applicant's national ID (AGENTS.md §13.5).
		VerifyCode string `json:"verifyCode"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	app, err := h.appService.ConfirmAttendance(r.Context(), id, body.VerifyCode, body.Confirmed)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, app)
}

// Withdraw is the applicant's own cancellation: POST /api/applications/{id}/withdraw with
// { verifyCode, reason }. Wrong code 403 INVALID_VERIFY_CODE, confirmed place 409.
func (h *ApplicantHandler) Withdraw(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		// VerifyCode is the last 4 digits of the applicant's national ID (AGENTS.md §13.5).
		VerifyCode string `json:"verifyCode"`
		Reason     string `json:"reason,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	if err := h.appService.Withdraw(r.Context(), id, body.VerifyCode, body.Reason, middleware.RemoteIP(r)); err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, map[string]string{"message": "withdrawn successfully", "id": id})
}

// UpdateOwnProfile handles PATCH /api/applications/{id}/profile: the applicant own edit of
// nickname, school, province, grade and shirt size, authorised by verifyCode.
func (h *ApplicantHandler) UpdateOwnProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}
	var body service.SelfProfileRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	app, err := h.appService.UpdateOwnProfile(r.Context(), id, body, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response.OK(w, app)
}

// AdminUpdateProfile handles PATCH /api/admin/applications/{id}/profile: the staff edit of any
// field of an application, including identifiers.
func (h *ApplicantHandler) AdminUpdateProfile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}
	var body service.AdminProfileRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	var adminID *int64
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		adminID = &claims.AdminID
	}
	app, err := h.appService.AdminUpdateProfile(r.Context(), id, body, adminID, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response.OK(w, app)
}

func (h *ApplicantHandler) AdminList(w http.ResponseWriter, r *http.Request) {
	var statusFilter *domain.ApplicationStatus
	if statusParam := r.URL.Query().Get("status"); statusParam != "" {
		st := domain.ApplicationStatus(statusParam)
		statusFilter = &st
	}

	apps, err := h.appService.ListAll(r.Context(), statusFilter)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, apps)
}

func (h *ApplicantHandler) AdminUpdateStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		Status string `json:"status"`
		Reason string `json:"reason,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	var adminID *int64
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		adminID = &claims.AdminID
	}

	app, err := h.appService.UpdateStatus(r.Context(), id, domain.ApplicationStatus(body.Status), adminID, body.Reason, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) AdminDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		Reason string `json:"reason,omitempty"`
	}
	if !decodeOptionalJSON(w, r, &body) {
		return
	}

	var adminID int64
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		adminID = claims.AdminID
	}

	if err := h.appService.Delete(r.Context(), id, adminID, body.Reason, middleware.RemoteIP(r)); err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, map[string]string{"message": "deleted successfully"})
}
