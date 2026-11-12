package handler

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

const (
	defaultAdminPageLimit = 20
	maxAdminPageLimit     = 100
)

type ApplicantHandler struct {
	appService *service.ApplicantService
}

func NewApplicantHandler(appService *service.ApplicantService) *ApplicantHandler {
	return &ApplicantHandler{appService: appService}
}

func (h *ApplicantHandler) Submit(w http.ResponseWriter, r *http.Request) {
	var req service.ApplicationCreateRequest
	if err := decodeJSONBody(w, r, &req); err != nil {
		writeJSONDecodeError(w, err, "invalid request body payload")
		return
	}

	app, err := h.appService.Submit(r.Context(), req)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrRegistrationClosed):
			response.Error(w, http.StatusForbidden, err.Error())
		case errors.Is(err, service.ErrDuplicateApplicant) || errors.Is(err, domain.ErrDuplicateApplicant):
			response.Error(w, http.StatusConflict, "national ID/phone/email already registered")
		case errors.Is(err, service.ErrQuotaExceeded) || errors.Is(err, domain.ErrQuotaExceeded):
			response.Error(w, http.StatusConflict, err.Error())
		case errors.Is(err, service.ErrInvalidNationalID),
			errors.Is(err, service.ErrInvalidPhone),
			errors.Is(err, service.ErrInvalidShirtSize),
			errors.Is(err, service.ErrInvalidEmail),
			errors.Is(err, service.ErrInvalidGrade),
			errors.Is(err, service.ErrInvalidInput):
			response.Error(w, http.StatusBadRequest, err.Error())
		default:
			response.Error(w, http.StatusInternalServerError, "failed to submit application")
		}
		return
	}

	response.Created(w, app)
}

func (h *ApplicantHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		response.Error(w, http.StatusBadRequest, "query parameter 'q' is required")
		return
	}

	app, err := h.appService.QueryStatus(r.Context(), q)
	if err != nil {
		if errors.Is(err, service.ErrApplicantNotFound) || errors.Is(err, domain.ErrApplicantNotFound) {
			response.Error(w, http.StatusNotFound, "Application not found")
			return
		}
		if errors.Is(err, service.ErrInvalidInput) {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to query application status")
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) ConfirmAttendance(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	var body struct {
		Confirmed *bool `json:"confirmed"`
	}
	if err := decodeJSONBody(w, r, &body); err != nil {
		writeJSONDecodeError(w, err, "invalid json payload")
		return
	}
	if body.Confirmed == nil {
		response.Error(w, http.StatusBadRequest, "field 'confirmed' is required")
		return
	}

	app, err := h.appService.ConfirmAttendance(r.Context(), id, *body.Confirmed)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrApplicantNotFound) || errors.Is(err, domain.ErrApplicantNotFound):
			response.Error(w, http.StatusNotFound, "applicant not found")
		case errors.Is(err, service.ErrCannotConfirm):
			response.Error(w, http.StatusConflict, err.Error())
		default:
			response.Error(w, http.StatusInternalServerError, "failed to confirm attendance")
		}
		return
	}

	response.OK(w, app)
}

func (h *ApplicantHandler) AdminList(w http.ResponseWriter, r *http.Request) {
	var statusFilter *domain.ApplicationStatus
	statusParam := strings.TrimSpace(r.URL.Query().Get("status"))
	if statusParam != "" {
		st := domain.ApplicationStatus(strings.ToUpper(statusParam))
		if !st.IsValid() {
			response.Error(w, http.StatusBadRequest, "invalid status filter")
			return
		}
		statusFilter = &st
	}

	pageParam := strings.TrimSpace(r.URL.Query().Get("page"))
	limitParam := strings.TrimSpace(r.URL.Query().Get("limit"))
	paginate := pageParam != "" || limitParam != ""

	page := 1
	limit := defaultAdminPageLimit
	if paginate {
		if pageParam != "" {
			parsedPage, err := strconv.Atoi(pageParam)
			if err != nil || parsedPage < 1 {
				response.Error(w, http.StatusBadRequest, "invalid 'page' parameter (must be >= 1)")
				return
			}
			page = parsedPage
		}
		if limitParam != "" {
			parsedLimit, err := strconv.Atoi(limitParam)
			if err != nil || parsedLimit < 1 || parsedLimit > maxAdminPageLimit {
				response.Error(w, http.StatusBadRequest, "invalid 'limit' parameter (must be between 1 and 100)")
				return
			}
			limit = parsedLimit
		}
	}

	apps, err := h.appService.ListFiltered(r.Context(), service.AdminListFilter{
		Status: statusFilter,
		Query:  r.URL.Query().Get("q"),
	})
	if err != nil {
		if errors.Is(err, service.ErrInvalidStatus) || errors.Is(err, domain.ErrInvalidStatus) {
			response.Error(w, http.StatusBadRequest, "invalid status filter")
			return
		}
		response.Error(w, http.StatusInternalServerError, "failed to list applications")
		return
	}

	if apps == nil {
		apps = []*service.ApplicationResponse{}
	}

	total := len(apps)
	w.Header().Set("X-Total-Count", strconv.Itoa(total))

	if !paginate {
		response.OK(w, apps)
		return
	}

	totalPages := 0
	if total > 0 {
		totalPages = int(math.Ceil(float64(total) / float64(limit)))
	}

	start := (page - 1) * limit
	var items []*service.ApplicationResponse
	if start >= total {
		items = []*service.ApplicationResponse{}
	} else {
		end := start + limit
		if end > total {
			end = total
		}
		items = apps[start:end]
	}

	response.OK(w, service.PaginatedApplicationsResponse{
		Items:      items,
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
	})
}

func (h *ApplicantHandler) AdminUpdateStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	var body struct {
		Status string `json:"status"`
		Reason string `json:"reason,omitempty"`
	}
	if err := decodeJSONBody(w, r, &body); err != nil {
		writeJSONDecodeError(w, err, "invalid json payload")
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil || claims.AdminID <= 0 {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	adminID := claims.AdminID

	app, err := h.appService.UpdateStatus(r.Context(), id, domain.ApplicationStatus(strings.TrimSpace(body.Status)), &adminID, body.Reason)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrApplicantNotFound) || errors.Is(err, domain.ErrApplicantNotFound):
			response.Error(w, http.StatusNotFound, "applicant not found")
		case errors.Is(err, service.ErrInvalidStatus) || errors.Is(err, domain.ErrInvalidStatus):
			response.Error(w, http.StatusBadRequest, "invalid application status")
		case errors.Is(err, service.ErrInvalidStatusTransition):
			response.Error(w, http.StatusConflict, err.Error())
		case errors.Is(err, service.ErrQuotaExceeded) || errors.Is(err, domain.ErrQuotaExceeded):
			response.Error(w, http.StatusConflict, err.Error())
		default:
			response.Error(w, http.StatusInternalServerError, "failed to update application status")
		}
		return
	}

	response.OK(w, app)
}
