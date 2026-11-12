package handler

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

const (
	maxSlipSizeBytes       int64 = 5 << 20        // 5MB
	maxSlipUploadBodyBytes int64 = (5 << 20) + 4096 // 5MB + multipart overhead
)

type PaymentHandler struct {
	paymentService *service.PaymentService
}

func NewPaymentHandler(paymentService *service.PaymentService) *PaymentHandler {
	return &PaymentHandler{paymentService: paymentService}
}

func (h *PaymentHandler) UploadSlip(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxSlipUploadBodyBytes)
	if err := r.ParseMultipartForm(maxSlipSizeBytes); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			response.Error(w, http.StatusRequestEntityTooLarge, "uploaded file exceeds 5MB limit")
			return
		}
		response.Error(w, http.StatusBadRequest, "invalid multipart form data")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	file, header, err := r.FormFile("slip")
	if err != nil {
		response.Error(w, http.StatusBadRequest, "slip file is required in 'slip' field")
		return
	}
	defer file.Close()

	fileBytes, err := io.ReadAll(io.LimitReader(file, maxSlipSizeBytes+1))
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to read uploaded file")
		return
	}
	if int64(len(fileBytes)) > maxSlipSizeBytes {
		response.Error(w, http.StatusRequestEntityTooLarge, "uploaded file exceeds 5MB limit")
		return
	}

	res, err := h.paymentService.UploadSlip(r.Context(), id, fileBytes, header.Filename)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSlipTooLarge):
			response.Error(w, http.StatusRequestEntityTooLarge, err.Error())
		case errors.Is(err, service.ErrDuplicateSlip) || errors.Is(err, domain.ErrDuplicateSlip):
			response.Error(w, http.StatusConflict, err.Error())
		case errors.Is(err, service.ErrApplicantRejected):
			response.Error(w, http.StatusForbidden, err.Error())
		case errors.Is(err, service.ErrCannotUploadSlip):
			response.Error(w, http.StatusConflict, err.Error())
		case errors.Is(err, service.ErrApplicantNotFound) || errors.Is(err, domain.ErrApplicantNotFound):
			response.Error(w, http.StatusNotFound, "applicant not found")
		case errors.Is(err, service.ErrInvalidFileType):
			response.Error(w, http.StatusBadRequest, err.Error())
		default:
			response.Error(w, http.StatusInternalServerError, "failed to upload payment slip")
		}
		return
	}

	response.OK(w, res)
}

func (h *PaymentHandler) VerifySlip(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil || claims.AdminID <= 0 {
		response.Error(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var body struct {
		Approved *bool  `json:"approved"`
		Note     string `json:"note"`
	}
	if err := decodeJSONBody(w, r, &body); err != nil {
		writeJSONDecodeError(w, err, "invalid request body")
		return
	}
	if body.Approved == nil {
		response.Error(w, http.StatusBadRequest, "field 'approved' is required")
		return
	}

	if err := h.paymentService.VerifySlip(r.Context(), id, *body.Approved, claims.AdminID, body.Note); err != nil {
		switch {
		case errors.Is(err, service.ErrApplicantNotFound) || errors.Is(err, domain.ErrApplicantNotFound):
			response.Error(w, http.StatusNotFound, "applicant not found")
		case errors.Is(err, service.ErrPaymentNotFound) || errors.Is(err, domain.ErrPaymentNotFound):
			response.Error(w, http.StatusNotFound, "payment slip not found")
		case errors.Is(err, service.ErrPaymentAlreadyVerified) || errors.Is(err, domain.ErrPaymentAlreadyVerified):
			response.Error(w, http.StatusConflict, err.Error())
		case errors.Is(err, service.ErrQuotaExceeded) || errors.Is(err, domain.ErrQuotaExceeded):
			response.Error(w, http.StatusConflict, err.Error())
		default:
			response.Error(w, http.StatusInternalServerError, "failed to verify payment slip")
		}
		return
	}

	response.OK(w, response.MessageResponse{Message: "Slip verified successfully"})
}

type noDirListingFS struct {
	fs http.FileSystem
}

func (n noDirListingFS) Open(name string) (http.File, error) {
	f, err := n.fs.Open(name)
	if err != nil {
		return nil, err
	}
	stat, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	if stat.IsDir() {
		_ = f.Close()
		return nil, os.ErrNotExist
	}
	return f, nil
}

// NewUploadFileHandler serves uploaded files with directory listing disabled and protective headers.
func NewUploadFileHandler(uploadDir string) http.Handler {
	fileServer := http.StripPrefix("/uploads", http.FileServer(noDirListingFS{fs: http.Dir(uploadDir)}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, no-store")
		fileServer.ServeHTTP(w, r)
	})
}
