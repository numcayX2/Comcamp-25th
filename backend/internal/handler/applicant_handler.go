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

	// The client IP goes into the verify guard and the attendance audit row.
	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	app, err := h.appService.ConfirmAttendance(ctx, id, body.VerifyCode, body.Confirmed)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, app)
}

// Withdraw is the applicant's own cancellation: POST /api/applications/{id}/withdraw with
// { nationalId, reason }. It needs the full 13-digit national ID (a 4-digit verifyCode is not
// accepted here): missing or malformed 400, wrong 403 INVALID_VERIFY_CODE, too many wrong answers
// 429 RATE_LIMITED + Retry-After, confirmed place 409.
func (h *ApplicantHandler) Withdraw(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		// NationalID is the applicant's full 13-digit national ID. It is compared and dropped,
		// never logged or echoed.
		NationalID string `json:"nationalId"`
		Reason     string `json:"reason,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	if err := h.appService.Withdraw(r.Context(), id, body.NationalID, body.Reason, middleware.RemoteIP(r)); err != nil {
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

	// The caller's role decides whether national IDs come back in full: only admin gets
	// them unmasked (see service.CanSeeFullNationalID). No identity at all is treated as no role.
	var role domain.AdminRole
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		role = claims.Role
	}

	apps, err := h.appService.ListAll(r.Context(), statusFilter, role)
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

// AdminExportAudit records a CSV export of the applicant list before the dashboard builds the file:
// POST /api/admin/applications/export-audit with { applicationIds, statusFilter, searchFiltered }.
// admin only (the role that sees full national IDs). Answers { count }.
func (h *ApplicantHandler) AdminExportAudit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ApplicationIDs []string `json:"applicationIds"`
		StatusFilter   string   `json:"statusFilter,omitempty"`
		SearchFiltered bool     `json:"searchFiltered,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	var adminID int64
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		adminID = claims.AdminID
	}

	count, err := h.appService.RecordExport(r.Context(), adminID, service.ExportRecord{
		ApplicationIDs: body.ApplicationIDs,
		StatusFilter:   body.StatusFilter,
		SearchFiltered: body.SearchFiltered,
	}, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response.OK(w, map[string]int{"count": count})
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
