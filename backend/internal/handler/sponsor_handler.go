package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/go-chi/chi/v5"

	"comcamp25-backend/internal/middleware"
	"comcamp25-backend/internal/pkg/response"
	"comcamp25-backend/internal/service"
)

// MaxSponsorRequestBytes is the whole multipart request cap for sponsor logo uploads:
// the 2 MB logo file plus 64 KB for form fields and multipart framing.
const MaxSponsorRequestBytes = service.MaxSponsorLogoBytes + 64<<10

type SponsorHandler struct {
	sponsorService *service.SponsorService
}

func NewSponsorHandler(sponsorService *service.SponsorService) *SponsorHandler {
	return &SponsorHandler{sponsorService: sponsorService}
}

func writeSponsorError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrSponsorNotFound):
		response.ErrorCode(w, http.StatusNotFound, response.CodeNotFound, "Sponsor not found")
	case errors.Is(err, service.ErrSponsorLogoTooLarge):
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, err.Error())
	default:
		writeServiceError(w, r, err)
	}
}

func parseSponsorID(raw string) (int64, error) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid sponsor id")
	}
	return id, nil
}

func parseShowNameValue(vals []string, required bool) (*bool, error) {
	if len(vals) == 0 || vals[0] == "" {
		if required {
			v := false
			return &v, nil
		}
		return nil, nil
	}
	switch vals[0] {
	case "true":
		v := true
		return &v, nil
	case "false":
		v := false
		return &v, nil
	default:
		return nil, errors.New(`showName must be "true" or "false"`)
	}
}

func (h *SponsorHandler) parseSponsorMultipart(w http.ResponseWriter, r *http.Request) bool {
	if r.ContentLength > MaxSponsorRequestBytes {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSponsorRequestBytes)

	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
			return false
		}
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid multipart form")
		return false
	}
	return true
}

// ListPublic handles GET /api/sponsors: returns the cached public sponsor list.
// Cache-Control: no-store from APIHeaders stays intact.
func (h *SponsorHandler) ListPublic(w http.ResponseWriter, r *http.Request) {
	res, err := h.sponsorService.ListPublic(r.Context())
	if err != nil {
		if clientGone(r, err) {
			return
		}
		response.Internal(w, r, err)
		return
	}
	response.OK(w, res)
}

// GetLogo handles GET /api/sponsors/{id}/logo: streams the stored sponsor logo resolved from the
// DB logo_path only, with public 24h caching (overriding APIHeaders no-store for this route only).
func (h *SponsorHandler) GetLogo(w http.ResponseWriter, r *http.Request) {
	id, err := parseSponsorID(chi.URLParam(r, "id"))
	if err != nil {
		writeSponsorError(w, r, service.ErrSponsorNotFound)
		return
	}

	logo, err := h.sponsorService.OpenLogo(r.Context(), id)
	if err != nil {
		writeSponsorError(w, r, err)
		return
	}

	f, err := os.Open(logo.Path)
	if errors.Is(err, os.ErrNotExist) {
		writeSponsorError(w, r, service.ErrSponsorNotFound)
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
		writeSponsorError(w, r, service.ErrSponsorNotFound)
		return
	}

	w.Header().Set("Content-Type", logo.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, logo.Name, stat.ModTime(), f)
}

// AdminList handles GET /api/admin/sponsors.
func (h *SponsorHandler) AdminList(w http.ResponseWriter, r *http.Request) {
	res, err := h.sponsorService.ListAdmin(r.Context())
	if err != nil {
		response.Internal(w, r, err)
		return
	}
	response.OK(w, res)
}

// AdminCreate handles POST /api/admin/sponsors (multipart/form-data: name, url?, showName?, logo).
func (h *SponsorHandler) AdminCreate(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	if !h.parseSponsorMultipart(w, r) {
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	var formVals map[string][]string
	if r.MultipartForm != nil {
		formVals = r.MultipartForm.Value
	}

	showNamePtr, err := parseShowNameValue(formVals["showName"], true)
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, err.Error())
		return
	}

	file, header, err := r.FormFile("logo")
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "logo file is required in 'logo' field")
		return
	}
	defer file.Close()

	if header.Size > service.MaxSponsorLogoBytes {
		response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
		return
	}
	fileBytes, err := io.ReadAll(io.LimitReader(file, service.MaxSponsorLogoBytes+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
			return
		}
		response.Internal(w, r, fmt.Errorf("read sponsor logo: %w", err))
		return
	}

	created, err := h.sponsorService.Create(r.Context(), service.CreateSponsorRequest{
		Name:     r.FormValue("name"),
		URL:      r.FormValue("url"),
		ShowName: *showNamePtr,
		LogoData: fileBytes,
	}, claims.AdminID, middleware.RemoteIP(r))
	if err != nil {
		writeSponsorError(w, r, err)
		return
	}
	response.Created(w, created)
}

// AdminUpdate handles PATCH /api/admin/sponsors/{id} (multipart/form-data; every field is optional).
func (h *SponsorHandler) AdminUpdate(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	id, err := parseSponsorID(chi.URLParam(r, "id"))
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid sponsor id")
		return
	}

	if !h.parseSponsorMultipart(w, r) {
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()

	var formVals map[string][]string
	if r.MultipartForm != nil {
		formVals = r.MultipartForm.Value
	}

	var req service.UpdateSponsorRequest
	if vals, ok := formVals["name"]; ok && len(vals) > 0 {
		v := vals[0]
		req.Name = &v
	}
	if vals, ok := formVals["url"]; ok && len(vals) > 0 {
		v := vals[0]
		req.URL = &v
	}
	showNamePtr, err := parseShowNameValue(formVals["showName"], false)
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, err.Error())
		return
	}
	req.ShowName = showNamePtr

	file, header, err := r.FormFile("logo")
	if err == nil {
		defer file.Close()
		if header.Size > service.MaxSponsorLogoBytes {
			response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
			return
		}
		fileBytes, readErr := io.ReadAll(io.LimitReader(file, service.MaxSponsorLogoBytes+1))
		if readErr != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(readErr, &tooLarge) {
				response.ErrorCode(w, http.StatusRequestEntityTooLarge, response.CodePayloadTooLarge, service.ErrSponsorLogoTooLarge.Error())
				return
			}
			response.Internal(w, r, fmt.Errorf("read sponsor logo: %w", readErr))
			return
		}
		req.HasLogo = true
		req.LogoData = fileBytes
	} else if !errors.Is(err, http.ErrMissingFile) {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid logo field")
		return
	}

	updated, err := h.sponsorService.Update(r.Context(), id, req, claims.AdminID, middleware.RemoteIP(r))
	if err != nil {
		writeSponsorError(w, r, err)
		return
	}
	response.OK(w, updated)
}

// AdminDelete handles DELETE /api/admin/sponsors/{id}.
func (h *SponsorHandler) AdminDelete(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	id, err := parseSponsorID(chi.URLParam(r, "id"))
	if err != nil {
		response.ErrorCode(w, http.StatusBadRequest, response.CodeValidation, "invalid sponsor id")
		return
	}

	if err := h.sponsorService.Delete(r.Context(), id, claims.AdminID, middleware.RemoteIP(r)); err != nil {
		writeSponsorError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AdminReorder handles PUT /api/admin/sponsors/order (JSON {"ids":[...]}).
func (h *SponsorHandler) AdminReorder(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetAdminClaims(r.Context())
	if claims == nil {
		response.ErrorCode(w, http.StatusUnauthorized, response.CodeUnauthorized, "missing admin identity")
		return
	}

	var body struct {
		IDs []int64 `json:"ids"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}

	res, err := h.sponsorService.Reorder(r.Context(), body.IDs, claims.AdminID, middleware.RemoteIP(r))
	if err != nil {
		writeSponsorError(w, r, err)
		return
	}
	response.OK(w, res)
}
