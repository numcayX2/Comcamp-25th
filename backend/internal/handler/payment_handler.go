package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

type PaymentHandler struct {
	paymentService *service.PaymentService
}

func NewPaymentHandler(paymentService *service.PaymentService) *PaymentHandler {
	return &PaymentHandler{paymentService: paymentService}
}

func (h *PaymentHandler) UploadSlip(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	// Limit upload size to 5MB
	_ = r.ParseMultipartForm(5 << 20)

	file, header, err := r.FormFile("slip")
	if err != nil {
		response.Error(w, http.StatusBadRequest, "slip file is required in 'slip' field")
		return
	}
	defer file.Close()

	fileBytes, err := io.ReadAll(file)
	if err != nil {
		response.Error(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	res, err := h.paymentService.UploadSlip(r.Context(), id, fileBytes, header.Filename)
	if err != nil {
		switch err {
		case service.ErrDuplicateSlip:
			response.Error(w, http.StatusConflict, err.Error())
		case service.ErrNotPassed:
			response.Error(w, http.StatusForbidden, err.Error())
		case service.ErrApplicantNotFound:
			response.Error(w, http.StatusNotFound, err.Error())
		default:
			response.Error(w, http.StatusBadRequest, err.Error())
		}
		return
	}

	response.OK(w, res)
}

func (h *PaymentHandler) VerifySlip(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		response.Error(w, http.StatusBadRequest, "application id is required")
		return
	}

	var body struct {
		Approved bool   `json:"approved"`
		Note     string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body")
		return
	}

	claims := middleware.GetAdminClaims(r.Context())
	var adminID int64
	if claims != nil {
		adminID = claims.AdminID
	}

	if err := h.paymentService.VerifySlip(r.Context(), id, body.Approved, adminID, body.Note); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	response.OK(w, response.MessageResponse{Message: "Slip verified successfully"})
}
