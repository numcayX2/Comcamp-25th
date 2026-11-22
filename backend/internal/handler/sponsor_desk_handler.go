package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// MaxSponsorDocRequestBytes caps a donation file upload: the 8 MB file plus 64 KB of multipart framing.
const MaxSponsorDocRequestBytes = service.MaxSponsorDocBytes + 64<<10

// MaxSponsorInquiryUploadBytes caps POST /api/sponsor-inquiries/upload: the 8 MB form plus 64 KB
// for the text fields and multipart framing.
const MaxSponsorInquiryUploadBytes = service.MaxSponsorDocBytes + 64<<10

// maxInquiryFieldBytes bounds one text part of the upload form; the service enforces the real
// per-field limits.
const maxInquiryFieldBytes = 4 << 10

// SponsorDeskHandler serves the public sponsor inquiry form and the admin inquiry / donation desk.
type SponsorDeskHandler struct {
	inquiries *service.SponsorInquiryService
	donations *service.SponsorDonationService
}

func NewSponsorDeskHandler(inquiries *service.SponsorInquiryService, donations *service.SponsorDonationService) *SponsorDeskHandler {
	return &SponsorDeskHandler{inquiries: inquiries, donations: donations}
}

func writeSponsorDeskError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrSponsorRecordNotFound):
		response.ErrorCode(w, http.StatusNotFound, response.CodeNotFound, "Not found")
	case errors.Is(err, service.ErrSponsorDocTooLarge):
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, err.Error())
	case errors.Is(err, service.ErrSponsorDocDimensions):
		response.ErrorCode(w, http.StatusBadRequest, response.CodeInvalidImageDims, err.Error())
	default:
		writeServiceError(w, r, err)
	}
}

// adminIdentity returns the admin id and client IP, answering 401 when the claims are missing.
func adminIdentity(w http.ResponseWriter, r *http.Request) (int64, string, bool) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return 0, "", false
	}
	return claims.AdminID, middleware.RemoteIP(r), true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid id")
		return 0, false
	}
	return id, true
}

func fileKind(w http.ResponseWriter, r *http.Request) (string, bool) {
	kind := chi.URLParam(r, "kind")
	if kind != domain.SponsorFileSigned && kind != domain.SponsorFileSlip {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "file kind must be signed or slip")
		return "", false
	}
	return kind, true
}

// SubmitInquiry handles POST /api/sponsor-inquiries: 201 {"ok":true}, nothing echoed back.
func (h *SponsorDeskHandler) SubmitInquiry(w http.ResponseWriter, r *http.Request) {
	var req service.SponsorInquiryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	if err := h.inquiries.Submit(ctx, req, nil); err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.Created(w, map[string]bool{"ok": true})
}

// SubmitInquiryUpload handles POST /api/sponsor-inquiries/upload: the sponsor sends the filled
// donation form instead of typing the inquiry. multipart/form-data with the basic SubmitInquiry
// fields (name, phone, email, kind, details, turnstileToken, website) plus "file" (PDF/JPG/PNG/WebP
// ≤ 8 MB); taxId and address fields are neither required nor accepted (the attached form already
// contains them, so any extra parts are discarded); 201 {"ok":true}, nothing echoed back. Parts are
// read in memory under hard caps, so a public upload never spills multipart temp files onto the
// small /tmp tmpfs.
func (h *SponsorDeskHandler) SubmitInquiryUpload(w http.ResponseWriter, r *http.Request) {
	tooLarge := func() {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorDocTooLarge.Error())
	}
	invalid := func(msg string) {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, msg)
	}
	isTooLarge := func(err error) bool {
		var maxErr *http.MaxBytesError
		return errors.As(err, &maxErr)
	}
	if r.ContentLength > MaxSponsorInquiryUploadBytes {
		tooLarge()
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSponsorInquiryUploadBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		invalid("invalid multipart form")
		return
	}

	var req service.SponsorInquiryRequest
	fields := map[string]*string{
		"name": &req.Name, "phone": &req.Phone, "email": &req.Email, "kind": &req.Kind,
		"details": &req.Details, "turnstileToken": &req.TurnstileToken, "website": &req.Website,
	}
	var file []byte
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if isTooLarge(err) {
				tooLarge()
			} else {
				invalid("invalid multipart form")
			}
			return
		}
		name := part.FormName()
		var data []byte
		switch {
		case name == "file":
			if file != nil {
				part.Close()
				invalid("only one file is allowed")
				return
			}
			// One byte over the limit is enough for the service to answer 413.
			data, err = io.ReadAll(io.LimitReader(part, service.MaxSponsorDocBytes+1))
			file = data
		case fields[name] != nil:
			data, err = io.ReadAll(io.LimitReader(part, maxInquiryFieldBytes+1))
			if err == nil && len(data) > maxInquiryFieldBytes {
				part.Close()
				invalid(name + " is too long")
				return
			}
			*fields[name] = string(data)
		default:
			_, err = io.Copy(io.Discard, part)
		}
		part.Close()
		if err != nil {
			if isTooLarge(err) {
				tooLarge()
			} else {
				invalid("cannot read form")
			}
			return
		}
	}
	if file == nil {
		invalid("file is required")
		return
	}

	ctx := service.WithRemoteIP(r.Context(), middleware.RemoteIP(r))
	if err := h.inquiries.Submit(ctx, req, file); err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.Created(w, map[string]bool{"ok": true})
}

// GetInquiryFile handles GET /api/admin/sponsor-inquiries/{id}/file: streams the attached form
// (path from the DB only) privately and uncached.
func (h *SponsorDeskHandler) GetInquiryFile(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	doc, err := h.inquiries.OpenFile(r.Context(), id, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	serveSponsorDoc(w, r, doc)
}

// ListInquiries handles GET /api/admin/sponsor-inquiries.
func (h *SponsorDeskHandler) ListInquiries(w http.ResponseWriter, r *http.Request) {
	list, err := h.inquiries.List(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, map[string]any{"inquiries": list})
}

// UpdateInquiry handles PATCH /api/admin/sponsor-inquiries/{id} {"handled": bool}.
func (h *SponsorDeskHandler) UpdateInquiry(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var body struct {
		Handled *bool `json:"handled"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Handled == nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "handled is required")
		return
	}
	res, err := h.inquiries.SetHandled(r.Context(), id, *body.Handled, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.OK(w, res)
}

// DeleteInquiry handles DELETE /api/admin/sponsor-inquiries/{id}.
func (h *SponsorDeskHandler) DeleteInquiry(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.inquiries.Delete(r.Context(), id, adminID, ip); err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// GetNotifyEmails handles GET /api/admin/sponsor-notify-emails.
func (h *SponsorDeskHandler) GetNotifyEmails(w http.ResponseWriter, r *http.Request) {
	emails, err := h.inquiries.NotifyEmails(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, map[string]any{"emails": emails})
}

// PutNotifyEmails handles PUT /api/admin/sponsor-notify-emails {"emails": [...]}.
func (h *SponsorDeskHandler) PutNotifyEmails(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	var body struct {
		Emails []string `json:"emails"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	emails, err := h.inquiries.ReplaceNotifyEmails(r.Context(), body.Emails, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.OK(w, map[string]any{"emails": emails})
}

// ListDonations handles GET /api/admin/sponsor-donations.
func (h *SponsorDeskHandler) ListDonations(w http.ResponseWriter, r *http.Request) {
	list, err := h.donations.List(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, map[string]any{"donations": list})
}

// CreateDonation handles POST /api/admin/sponsor-donations.
func (h *SponsorDeskHandler) CreateDonation(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	var in service.SponsorDonationInput
	if !decodeJSON(w, r, &in) {
		return
	}
	res, err := h.donations.Create(r.Context(), in, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.Created(w, res)
}

// UpdateDonation handles PATCH /api/admin/sponsor-donations/{id} (full replacement of editable fields).
func (h *SponsorDeskHandler) UpdateDonation(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var in service.SponsorDonationInput
	if !decodeJSON(w, r, &in) {
		return
	}
	res, err := h.donations.Update(r.Context(), id, in, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.OK(w, res)
}

// DeleteDonation handles DELETE /api/admin/sponsor-donations/{id}.
func (h *SponsorDeskHandler) DeleteDonation(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.donations.Delete(r.Context(), id, adminID, ip); err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PutDonationFile handles PUT /api/admin/sponsor-donations/{id}/files/{kind} (multipart field "file", ≤ 8 MB).
func (h *SponsorDeskHandler) PutDonationFile(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	kind, ok := fileKind(w, r)
	if !ok {
		return
	}
	if r.ContentLength > MaxSponsorDocRequestBytes {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorDocTooLarge.Error())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSponsorDocRequestBytes)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorDocTooLarge.Error())
			return
		}
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid multipart form")
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	file, _, err := r.FormFile("file")
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "file is required")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, service.MaxSponsorDocBytes+1))
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "cannot read file")
		return
	}
	res, err := h.donations.PutFile(r.Context(), id, kind, data, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.OK(w, res)
}

// GetDonationFile handles GET /api/admin/sponsor-donations/{id}/files/{kind}: streams the stored
// file (path from the DB only) privately and uncached.
func (h *SponsorDeskHandler) GetDonationFile(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	kind, ok := fileKind(w, r)
	if !ok {
		return
	}
	doc, err := h.donations.OpenFile(r.Context(), id, kind, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	serveSponsorDoc(w, r, doc)
}

// serveSponsorDoc streams a resolved sponsor document privately and uncached.
func serveSponsorDoc(w http.ResponseWriter, r *http.Request, doc *service.SponsorDocFile) {
	f, err := os.Open(doc.Path)
	if errors.Is(err, os.ErrNotExist) {
		writeSponsorDeskError(w, r, service.ErrSponsorRecordNotFound)
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
	if stat.IsDir() {
		writeSponsorDeskError(w, r, service.ErrSponsorRecordNotFound)
		return
	}
	w.Header().Set("Content-Type", doc.ContentType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", doc.FileName))
	http.ServeContent(w, r, doc.FileName, stat.ModTime(), f)
}

// DeleteDonationFile handles DELETE /api/admin/sponsor-donations/{id}/files/{kind}.
func (h *SponsorDeskHandler) DeleteDonationFile(w http.ResponseWriter, r *http.Request) {
	adminID, ip, ok := adminIdentity(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	kind, ok := fileKind(w, r)
	if !ok {
		return
	}
	res, err := h.donations.DeleteFile(r.Context(), id, kind, adminID, ip)
	if err != nil {
		writeSponsorDeskError(w, r, err)
		return
	}
	response.OK(w, res)
}
