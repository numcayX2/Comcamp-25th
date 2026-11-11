package response

import (
	"encoding/json"
	"log"
	"net/http"

	chimiddleware "github.com/go-chi/chi/v5/middleware"
)

// Machine-readable error codes so the frontend can branch without parsing messages.
const (
	CodeValidation         = "VALIDATION_ERROR"
	CodeRegistrationClosed = "REGISTRATION_CLOSED"
	CodeQuotaFull          = "QUOTA_FULL"
	CodeDuplicateApp       = "DUPLICATE_APPLICATION"
	CodeIdempotencyReuse   = "IDEMPOTENCY_KEY_REUSED"
	CodeDuplicateSlip      = "DUPLICATE_SLIP"
	CodeAlreadyVerified    = "ALREADY_VERIFIED"
	CodeNotFound           = "NOT_FOUND"
	CodeForbidden          = "FORBIDDEN"
	CodeUnauthorized       = "UNAUTHORIZED"
	CodePayloadTooLarge    = "PAYLOAD_TOO_LARGE"
	CodeRateLimited        = "RATE_LIMITED"
	CodeUnavailable        = "SERVICE_UNAVAILABLE"
	CodeInternal           = "INTERNAL_ERROR"
	CodeInvalidImageDims   = "INVALID_IMAGE_DIMENSIONS"
	CodeInvalidVerifyCode  = "INVALID_VERIFY_CODE"
	CodeSlipChanged        = "SLIP_CHANGED"
	CodeCaptchaFailed      = "CAPTCHA_FAILED"
)

type ErrorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code,omitempty"`
}

type MessageResponse struct {
	Message string `json:"message"`
}

func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if data != nil {
		_ = json.NewEncoder(w).Encode(data)
	}
}

func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, ErrorResponse{Error: message})
}

func ErrorCode(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, ErrorResponse{Error: message, Code: code})
}

// Internal logs the real error server-side and returns a generic 500, so database errors,
// constraint names and file paths never reach the client.
func Internal(w http.ResponseWriter, r *http.Request, err error) {
	log.Printf("[%s] internal error on %s %s: %v", chimiddleware.GetReqID(r.Context()), r.Method, r.URL.Path, err)
	ErrorCode(w, http.StatusInternalServerError, CodeInternal, "internal server error")
}

func OK(w http.ResponseWriter, data any) {
	JSON(w, http.StatusOK, data)
}

func Created(w http.ResponseWriter, data any) {
	JSON(w, http.StatusCreated, data)
}
