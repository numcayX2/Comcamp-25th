package handler

import (
	"context"
	"errors"
	"net/http"

	"comcamp25-backend/internal/pkg/response"
)

// ListPublic handles GET /api/applications/public: the public applicants list shown on
// /applicants. The body is service.PublicApplicantsResponse, the PDPA allowlist only (no code,
// phone, email, parent, health, motivation, slip or id). The router puts it behind its own
// per-IP limiter; /api already answers with Cache-Control: no-store. The list names minors, so the
// JSON is kept out of search indexes like the /applicants page itself (X-Robots-Tag).
func (h *ApplicantHandler) ListPublic(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	list, err := h.appService.ListPublicApplicants(r.Context())
	if err != nil {
		if clientGone(r, err) {
			// The visitor closed the page or the request timed out: nobody is waiting for an
			// answer and it is not a server fault, so it is neither logged nor answered as a 500.
			return
		}
		response.Internal(w, r, err)
		return
	}
	response.OK(w, list)
}

// clientGone reports whether err only means that this request's own context ended (client
// disconnect or the router timeout). A deadline inside the service, such as a slow database query
// while the client is still connected, is a real failure and still reaches response.Internal.
func clientGone(r *http.Request, err error) bool {
	return r.Context().Err() != nil &&
		(errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded))
}
