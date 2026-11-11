package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"

	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// writeServiceError maps service errors to HTTP responses. Anything unrecognised is logged and
// returned as a generic 500, so SQL errors and file paths never reach clients.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var ve *service.ValidationError
	var locked *service.VerifyLockedError
	switch {
	case errors.As(err, &locked):
		// Too many wrong verifyCode / nationalId answers for this application (AGENTS.md §13.5).
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(locked.RetryAfter.Seconds())))))
		response.ErrorCode(w, http.StatusTooManyRequests, response.CodeRateLimited, locked.Error())
	case errors.As(err, &ve):
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, ve.Error())
	case errors.Is(err, service.ErrApplicantNotFound):
		response.ErrorCode(w, http.StatusNotFound, response.CodeNotFound, "Application not found")
	case errors.Is(err, service.ErrRegistrationClosed):
		response.ErrorCode(w, http.StatusForbidden, response.CodeRegistrationClosed, err.Error())
	case errors.Is(err, service.ErrQuotaExceeded):
		response.ErrorCode(w, http.StatusConflict, response.CodeQuotaFull, err.Error())
	case errors.Is(err, service.ErrDuplicateApplicant):
		response.ErrorCode(w, http.StatusConflict, response.CodeDuplicateApp, err.Error())
	case errors.Is(err, service.ErrIdempotencyKeyReused):
		response.ErrorCode(w, http.StatusUnprocessableEntity, response.CodeIdempotencyReuse, err.Error())
	case errors.Is(err, service.ErrSettingsUnavailable):
		log.Printf("[%s] %v", chimiddleware.GetReqID(r.Context()), err)
		response.ErrorCode(w, http.StatusServiceUnavailable, response.CodeUnavailable, "service temporarily unavailable, please try again")
	case errors.Is(err, service.ErrRegistrationBusy):
		// Quota lock wait hit lock_timeout: nothing was saved, a retry with the same key is safe.
		w.Header().Set("Retry-After", "2")
		response.ErrorCode(w, http.StatusServiceUnavailable, response.CodeUnavailable, err.Error())
	case errors.Is(err, service.ErrCaptchaFailed):
		response.ErrorCode(w, http.StatusForbidden, response.CodeCaptchaFailed, err.Error())
	case errors.Is(err, service.ErrCaptchaUnavailable):
		// Cloudflare unreachable / timed out: fail closed, nothing was saved, a retry is safe.
		log.Printf("[%s] %v", chimiddleware.GetReqID(r.Context()), err)
		w.Header().Set("Retry-After", "3")
		response.ErrorCode(w, http.StatusServiceUnavailable, response.CodeUnavailable, "captcha verification is temporarily unavailable, please try again")
	case errors.Is(err, service.ErrInvalidVerifyCode), errors.Is(err, service.ErrNationalIDMismatch):
		response.ErrorCode(w, http.StatusForbidden, response.CodeInvalidVerifyCode, err.Error())
	case errors.Is(err, service.ErrInvalidImageDimensions):
		response.ErrorCode(w, http.StatusBadRequest, response.CodeInvalidImageDims, err.Error())
	case errors.Is(err, service.ErrCannotWithdraw):
		response.ErrorCode(w, http.StatusConflict, response.CodeForbidden, err.Error())
	case errors.Is(err, service.ErrProfileLocked), errors.Is(err, service.ErrSlipLocked):
		response.ErrorCode(w, http.StatusConflict, response.CodeForbidden, err.Error())
	case errors.Is(err, service.ErrCannotConfirm):
		response.ErrorCode(w, http.StatusConflict, response.CodeForbidden, err.Error())
	case errors.Is(err, service.ErrNotPassed):
		response.ErrorCode(w, http.StatusForbidden, response.CodeForbidden, err.Error())
	case errors.Is(err, service.ErrDuplicateSlip):
		response.ErrorCode(w, http.StatusConflict, response.CodeDuplicateSlip, err.Error())
	case errors.Is(err, service.ErrSlipTooLarge):
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, err.Error())
	case errors.Is(err, service.ErrSlipAlreadyApproved), errors.Is(err, service.ErrSlipAlreadyVerified):
		response.ErrorCode(w, http.StatusConflict, response.CodeAlreadyVerified, err.Error())
	case errors.Is(err, service.ErrSlipChanged):
		response.ErrorCode(w, http.StatusConflict, response.CodeSlipChanged, err.Error())
	case errors.Is(err, service.ErrNoSlip):
		response.ErrorCode(w, http.StatusNotFound, response.CodeNotFound, err.Error())
	default:
		response.Internal(w, r, err)
	}
}

// decodeJSON decodes a request body, answering 413 for bodies over the LimitBody cap and 400
// for malformed JSON. It reports whether decoding succeeded.
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, "request body too large")
		} else {
			response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid json payload")
		}
		return false
	}
	return true
}

// decodeOptionalJSON decodes an optional request body. If the body is empty (e.g. io.EOF or ContentLength == 0),
// it succeeds without writing an error. Malformed JSON or oversized payload still answers 400 or 413.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Body == nil || r.ContentLength == 0 {
		return true
	}
	err := json.NewDecoder(r.Body).Decode(dst)
	if err == nil || errors.Is(err, io.EOF) {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, "request body too large")
	} else {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid json payload")
	}
	return false
}
