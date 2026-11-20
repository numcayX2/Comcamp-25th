package handler

import (
	"context"
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

// clientContext carries the client IP (audit rows, Turnstile) and the rate-limit key (the
// application-code guard counts unknown codes per client under the same key as the per-IP limiters).
func clientContext(r *http.Request) context.Context {
	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	return service.WithClientKey(ctx, middleware.RateLimitKey(r))
}

// GetStatus handles the public lookup by phone number or application code; the response is masked
// (AGENTS.md §13.5). A lookup by phone never carries the application code (codeRequired: true);
// only a lookup by code returns it, with the full masked record.
func (h *ApplicantHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "query parameter 'q' is required")
		return
	}

	res, err := h.appService.QueryStatus(clientContext(r), q)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, res.Body())
}

func (h *ApplicantHandler) ConfirmAttendance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	// The application code in the path is the proof; there is no second factor any more.
	var body struct {
		Confirmed bool `json:"confirmed"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	// The client IP goes into the attendance audit row, the client key into the code guard.
	app, err := h.appService.ConfirmAttendance(clientContext(r), id, body.Confirmed)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, app)
}

// Withdraw is the applicant's own cancellation: POST /api/applications/{id}/withdraw with an
// { phone, reason? }. The application code in the path plus the full registered phone are the proof
// (R24): an unknown code or a missing/wrong phone is the same 404, a client refused by the code guard
// 429 RATE_LIMITED + Retry-After, nothing left to cancel online 409.
func (h *ApplicantHandler) Withdraw(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	// The code in the path plus the full registered phone are the proof (R24). A missing body or
	// phone is not a 400: it goes through the same path as a wrong phone, so every failure looks
	// like an unknown code.
	var body struct {
		Phone  string `json:"phone,omitempty"`
		Reason string `json:"reason,omitempty"`
	}
	if !decodeOptionalJSON(w, r, &body) {
		return
	}

	if err := h.appService.Withdraw(clientContext(r), id, body.Phone, body.Reason, middleware.RemoteIP(r)); err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, map[string]string{"message": "withdrawn successfully", "id": id})
}

// UpdateOwnProfile handles PATCH /api/applications/{id}/profile. Applicant self-edit is disabled:
// corrections go through staff (PATCH /api/admin/applications/{id}/profile). The route stays
// registered behind its rate limiter so old clients get a clear 403 instead of a 404/405. It
// answers before touching the body, the service or the database, so it never counts towards the
// application-code guard, writes no audit row and cannot be used to probe whether an application
// exists.
func (h *ApplicantHandler) UpdateOwnProfile(w http.ResponseWriter, r *http.Request) {
	response.ErrorCode(w, http.StatusForbidden, response.CodeForbidden, selfProfileEditDisabledMessage)
}

// selfProfileEditDisabledMessage is the Thai notice returned by the disabled self-edit route.
const selfProfileEditDisabledMessage = "ปิดการแก้ไขข้อมูลด้วยตนเองแล้ว กรุณาติดต่อทีมงานเพื่อขอแก้ไขข้อมูล"

// AdminUpdateProfile handles PATCH /api/admin/applications/{id}/profile: the staff edit of any
// field of an application, including the phone number and email.
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

// AdminListWithdrawn answers GET /api/admin/applications/withdrawn: the read-only list of
// applications their applicants withdrew, most recent first.
func (h *ApplicantHandler) AdminListWithdrawn(w http.ResponseWriter, r *http.Request) {
	list, err := h.appService.ListWithdrawn(r.Context())
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	response.OK(w, list)
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
// admin only. Answers { count }.
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
