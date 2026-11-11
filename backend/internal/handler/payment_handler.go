package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// MaxSlipRequestBytes is the whole multipart request: the 5 MB file plus form overhead.
const MaxSlipRequestBytes = service.MaxSlipBytes + 512<<10

type PaymentHandler struct {
	paymentService *service.PaymentService
}

func NewPaymentHandler(paymentService *service.PaymentService) *PaymentHandler {
	return &PaymentHandler{paymentService: paymentService}
}

// UploadSlip handles POST /api/applications/{id}/slip. The body is capped while it streams
// (http.MaxBytesReader), so an oversized upload is cut off at ~5.5 MB instead of being read
// into memory (AGENTS.md §13.3).
func (h *PaymentHandler) UploadSlip(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	if r.ContentLength > MaxSlipRequestBytes {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSlipTooLarge.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSlipRequestBytes)

	// 1 MB in memory; the remainder (still bounded by MaxBytesReader) spools to a temp file.
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSlipTooLarge.Error())
			return
		}
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid multipart form")
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()

	file, header, err := r.FormFile("slip")
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "slip file is required in 'slip' field")
		return
	}
	defer file.Close()

	if header.Size > service.MaxSlipBytes {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSlipTooLarge.Error())
		return
	}

	fileBytes, err := io.ReadAll(io.LimitReader(file, service.MaxSlipBytes+1))
	if err != nil {
		response.Internal(w, r, fmt.Errorf("read slip: %w", err))
		return
	}

	// verifyCode: last 4 digits of the applicant's national ID, sent as a multipart field.
	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	res, err := h.paymentService.UploadSlip(ctx, id, r.FormValue("verifyCode"), fileBytes)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, res)
}

// GetSlip handles GET /api/admin/applications/{id}/slip: streams the latest slip image to an
// authenticated admin. Slips are never served as public static files.
func (h *PaymentHandler) GetSlip(w http.ResponseWriter, r *http.Request) {
	var adminID *int64
	if claims := middleware.GetAdminClaims(r.Context()); claims != nil {
		adminID = &claims.AdminID
	}

	slip, err := h.paymentService.OpenLatestSlip(r.Context(), chi.URLParam(r, "id"), adminID, middleware.RemoteIP(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	f, err := os.Open(slip.Path)
	if errors.Is(err, os.ErrNotExist) {
		writeServiceError(w, r, service.ErrNoSlip)
		return
	}
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		response.Internal(w, r, err)
		return
	}

	w.Header().Set("Content-Type", slip.ContentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", slip.Name))
	w.Header().Set("Cache-Control", "private, no-store")
	// The slip being shown: sent back as paymentId with the verdict (PATCH .../verify-slip).
	w.Header().Set("X-Slip-Payment-Id", slip.PaymentID)
	http.ServeContent(w, r, slip.Name, stat.ModTime(), f)
}

func (h *PaymentHandler) VerifySlip(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "application id is required")
		return
	}

	var body struct {
		Approved bool   `json:"approved"`
		Note     string `json:"note"`
		// PaymentID is the slip the admin inspected (slipPaymentId / X-Slip-Payment-Id). Optional;
		// when set and no longer the latest slip the answer is 409 SLIP_CHANGED.
		PaymentID string `json:"paymentId,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	if err := h.paymentService.VerifySlip(r.Context(), id, body.PaymentID, body.Approved, claims.AdminID, body.Note, middleware.RemoteIP(r)); err != nil {
		writeServiceError(w, r, err)
		return
	}

	response.OK(w, response.MessageResponse{Message: "Slip verified successfully"})
}
