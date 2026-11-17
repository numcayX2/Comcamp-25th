package handler

import (
	"net/http"

	"comcamp25-backend/internal/pkg/response"
)

// ListPublic handles GET /api/applications/public: the public applicants list shown on
// /applicants. The body is service.PublicApplicantsResponse, the PDPA allowlist only (no code,
// phone, email, parent, health, motivation, slip or id). The router puts it behind its own
// per-IP limiter; /api already answers with Cache-Control: no-store.
func (h *ApplicantHandler) ListPublic(w http.ResponseWriter, r *http.Request) {
	list, err := h.appService.ListPublicApplicants(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, list)
}
