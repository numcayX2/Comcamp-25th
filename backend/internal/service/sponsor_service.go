package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"

	"comcamp25-backend/internal/domain"
)

// Sponsor logo and field bounds (tmp/briefs/sponsor-contract.md).
const (
	MaxSponsorLogoBytes = 2 << 20 // 2 MB
	maxSponsorNameRunes = 120
	maxSponsorURLRunes  = 500
	sponsorListCacheTTL = 5 * time.Second
)

var (
	ErrSponsorNotFound        = errors.New("sponsor not found")
	ErrSponsorLogoTooLarge    = errors.New("sponsor logo must not exceed 2 MB")
	ErrSponsorLogoEmpty       = newValidationError("logo file is required")
	ErrInvalidSponsorLogoType = newValidationError("invalid file type: only JPG, PNG, and WebP images are allowed")
)

// allowedSponsorLogoTypes maps sniffed magic-byte MIME types to stored extensions.
// SVG and GIF are deliberately excluded (XSS / animation).
var allowedSponsorLogoTypes = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

// PublicSponsorEntry is one row of GET /api/sponsors. Its JSON key set is strictly
// id, name, url, showName, logoUrl (no logoPath, logoHash, timestamps or admin fields).
type PublicSponsorEntry struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	ShowName bool   `json:"showName"`
	LogoURL  string `json:"logoUrl"`
}

// PublicSponsorsResponse is the body of GET /api/sponsors. Sponsors is never nil.
type PublicSponsorsResponse struct {
	Sponsors []PublicSponsorEntry `json:"sponsors"`
}

// AdminSponsorEntry is one sponsor returned by /api/admin/sponsors endpoints.
type AdminSponsorEntry struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	ShowName  bool   `json:"showName"`
	LogoURL   string `json:"logoUrl"`
	SortOrder int    `json:"sortOrder"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// AdminSponsorsResponse is the body of GET /api/admin/sponsors and PUT /api/admin/sponsors/order.
type AdminSponsorsResponse struct {
	Sponsors []AdminSponsorEntry `json:"sponsors"`
}

// CreateSponsorRequest is the validated input to SponsorService.Create.
type CreateSponsorRequest struct {
	Name     string
	URL      string
	ShowName bool
	LogoData []byte
}

// UpdateSponsorRequest is the partial input to SponsorService.Update. Nil pointer fields are
// left unchanged; HasLogo distinguishes an omitted logo file from an empty upload.
type UpdateSponsorRequest struct {
	Name     *string
	URL      *string
	ShowName *bool
	HasLogo  bool
	LogoData []byte
}

// SponsorLogoFile describes a validated sponsor logo ready to stream on GET /api/sponsors/{id}/logo.
type SponsorLogoFile struct {
	Path        string
	ContentType string
	Name        string
}

type sponsorListCache struct {
	mu        sync.RWMutex
	rows      []PublicSponsorEntry
	expiresAt time.Time
	ver       atomic.Uint64
	group     singleflight.Group
}

type SponsorService struct {
	repo       domain.SponsorRepository
	sponsorDir string
	publicList sponsorListCache
}

// NewSponsorService stores sponsor logos under uploadDir/sponsors.
func NewSponsorService(repo domain.SponsorRepository, uploadDir string) *SponsorService {
	sponsorDir := filepath.Join(uploadDir, "sponsors")
	if err := os.MkdirAll(sponsorDir, 0o700); err != nil {
		log.Printf("WARNING: cannot create sponsor directory %s: %v", sponsorDir, err)
	}
	return &SponsorService{
		repo:       repo,
		sponsorDir: sponsorDir,
	}
}

// InvalidatePublicCache drops the cached GET /api/sponsors snapshot so the next read queries
// fresh rows. Bumping ver prevents an in-flight read from writing stale rows back into the cache.
func (s *SponsorService) InvalidatePublicCache() {
	c := &s.publicList
	c.ver.Add(1)
	c.mu.Lock()
	c.rows = nil
	c.expiresAt = time.Time{}
	c.mu.Unlock()
}

// ListPublic returns the public sponsor list ordered by sort_order, id. Results are cached for 5s
// with singleflight coalescing and invalidated immediately on every admin mutation.
func (s *SponsorService) ListPublic(ctx context.Context) (*PublicSponsorsResponse, error) {
	c := &s.publicList
	c.mu.RLock()
	if c.rows != nil && time.Now().Before(c.expiresAt) {
		out := copyPublicSponsors(c.rows)
		c.mu.RUnlock()
		return &PublicSponsorsResponse{Sponsors: out}, nil
	}
	c.mu.RUnlock()

	startVer := c.ver.Load()
	ch := c.group.DoChan("sponsors-public-"+strconv.FormatUint(startVer, 10), func() (any, error) {
		qCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		rows, err := s.repo.List(qCtx)
		if err != nil {
			return nil, err
		}
		entries := make([]PublicSponsorEntry, 0, len(rows))
		for _, r := range rows {
			entries = append(entries, toPublicSponsor(r))
		}

		if c.ver.Load() == startVer {
			c.mu.Lock()
			if c.ver.Load() == startVer {
				c.rows = entries
				c.expiresAt = time.Now().Add(sponsorListCacheTTL)
			}
			c.mu.Unlock()
		}
		return entries, nil
	})

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return &PublicSponsorsResponse{Sponsors: copyPublicSponsors(res.Val.([]PublicSponsorEntry))}, nil
	}
}

// ListAdmin returns all sponsors with admin metadata, ordered by sort_order, id.
func (s *SponsorService) ListAdmin(ctx context.Context) (*AdminSponsorsResponse, error) {
	rows, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	entries := make([]AdminSponsorEntry, 0, len(rows))
	for _, r := range rows {
		entries = append(entries, toAdminSponsor(r))
	}
	return &AdminSponsorsResponse{Sponsors: entries}, nil
}

// Create validates input and logo, writes the logo file exclusively and fsyncs it before the DB
// transaction, inserts the sponsor with an audit row in the same transaction, and removes the
// written file if the transaction fails.
func (s *SponsorService) Create(ctx context.Context, req CreateSponsorRequest, adminID int64, ip string) (*AdminSponsorEntry, error) {
	name, err := validateSponsorName(req.Name)
	if err != nil {
		return nil, err
	}
	link, err := validateSponsorURL(req.URL)
	if err != nil {
		return nil, err
	}
	logoBytes, mimeType, ext, logoHash, err := prepareSponsorLogo(req.LogoData)
	if err != nil {
		return nil, err
	}

	fileName := uuid.NewString() + ext
	destPath := filepath.Join(s.sponsorDir, fileName)
	if err := writeFileExclusive(destPath, logoBytes); err != nil {
		return nil, fmt.Errorf("save sponsor logo: %w", err)
	}

	sp := &domain.Sponsor{
		Name:     name,
		URL:      link,
		ShowName: req.ShowName,
		LogoPath: "sponsors/" + fileName,
		LogoMIME: mimeType,
		LogoHash: logoHash,
	}
	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSponsorCreate,
		TargetType: domain.AuditTargetSponsor,
		Details:    map[string]any{},
		IPAddress:  ip,
	}
	if err := s.repo.Create(ctx, sp, audit); err != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("create sponsor: %w", err)
	}

	s.InvalidatePublicCache()
	entry := toAdminSponsor(sp)
	return &entry, nil
}

// Update validates any provided fields (and optional replacement logo), writes a replacement logo
// before the DB transaction, applies the update + audit row atomically, removes the new file on tx
// failure, and deletes the replaced file only after a successful commit.
func (s *SponsorService) Update(ctx context.Context, id int64, req UpdateSponsorRequest, adminID int64, ip string) (*AdminSponsorEntry, error) {
	if id <= 0 {
		return nil, ErrSponsorNotFound
	}

	var patch domain.SponsorPatch
	if req.Name != nil {
		name, err := validateSponsorName(*req.Name)
		if err != nil {
			return nil, err
		}
		patch.Name = &name
	}
	if req.URL != nil {
		link, err := validateSponsorURL(*req.URL)
		if err != nil {
			return nil, err
		}
		patch.URL = &link
	}
	if req.ShowName != nil {
		v := *req.ShowName
		patch.ShowName = &v
	}

	var (
		logoBytes []byte
		mimeType  string
		ext       string
		logoHash  string
	)
	if req.HasLogo {
		var err error
		logoBytes, mimeType, ext, logoHash, err = prepareSponsorLogo(req.LogoData)
		if err != nil {
			return nil, err
		}
	}

	if patch.Name == nil && patch.URL == nil && patch.ShowName == nil && !req.HasLogo {
		existing, err := s.repo.GetByID(ctx, id)
		if err != nil {
			return nil, sponsorNotFoundOr(err)
		}
		entry := toAdminSponsor(existing)
		return &entry, nil
	}

	// Verify existence before writing a replacement file to disk so a missing id never creates an
	// unnecessary file. The repository re-checks under FOR UPDATE inside the transaction.
	if _, err := s.repo.GetByID(ctx, id); err != nil {
		return nil, sponsorNotFoundOr(err)
	}

	newDestPath := ""
	if req.HasLogo {
		fileName := uuid.NewString() + ext
		newDestPath = filepath.Join(s.sponsorDir, fileName)
		if err := writeFileExclusive(newDestPath, logoBytes); err != nil {
			return nil, fmt.Errorf("save sponsor logo: %w", err)
		}
		relPath := "sponsors/" + fileName
		patch.LogoPath = &relPath
		patch.LogoMIME = &mimeType
		patch.LogoHash = &logoHash
	}

	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSponsorUpdate,
		TargetType: domain.AuditTargetSponsor,
		TargetID:   strconv.FormatInt(id, 10),
		Details:    map[string]any{},
		IPAddress:  ip,
	}
	updated, oldLogoPath, err := s.repo.Update(ctx, id, patch, audit)
	if err != nil {
		if newDestPath != "" {
			_ = os.Remove(newDestPath)
		}
		return nil, sponsorNotFoundOr(err)
	}

	s.InvalidatePublicCache()
	if oldLogoPath != "" && oldLogoPath != updated.LogoPath {
		s.removeLogoFile(oldLogoPath)
	}

	entry := toAdminSponsor(updated)
	return &entry, nil
}

// Delete removes sponsor id + writes the audit row atomically, then deletes its logo file only
// after the commit succeeds.
func (s *SponsorService) Delete(ctx context.Context, id int64, adminID int64, ip string) error {
	if id <= 0 {
		return ErrSponsorNotFound
	}
	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSponsorDelete,
		TargetType: domain.AuditTargetSponsor,
		TargetID:   strconv.FormatInt(id, 10),
		Details:    map[string]any{},
		IPAddress:  ip,
	}
	deleted, err := s.repo.Delete(ctx, id, audit)
	if err != nil {
		return sponsorNotFoundOr(err)
	}

	s.InvalidatePublicCache()
	s.removeLogoFile(deleted.LogoPath)
	return nil
}

// Reorder updates sort_order across all sponsors to match ids (which must be the exact set of
// existing ids) and records an audit row in the same transaction.
func (s *SponsorService) Reorder(ctx context.Context, ids []int64, adminID int64, ip string) (*AdminSponsorsResponse, error) {
	if ids == nil {
		return nil, newValidationError("ids is required")
	}
	seen := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, newValidationError("ids must contain positive sponsor ids")
		}
		if seen[id] {
			return nil, newValidationError("ids must not contain duplicates")
		}
		seen[id] = true
	}

	audit := &domain.AuditEntry{
		AdminID:    &adminID,
		Action:     domain.AuditSponsorReorder,
		TargetType: domain.AuditTargetSponsor,
		Details:    map[string]any{},
		IPAddress:  ip,
	}
	rows, err := s.repo.Reorder(ctx, ids, audit)
	if err != nil {
		if errors.Is(err, domain.ErrSponsorOrderMismatch) {
			return nil, newValidationError(domain.ErrSponsorOrderMismatch.Error())
		}
		return nil, err
	}

	s.InvalidatePublicCache()
	entries := make([]AdminSponsorEntry, 0, len(rows))
	for _, r := range rows {
		entries = append(entries, toAdminSponsor(r))
	}
	return &AdminSponsorsResponse{Sponsors: entries}, nil
}

// OpenLogo resolves the sponsor's logo path strictly from the DB logo_path and verifies it stays
// inside UPLOAD_DIR/sponsors/.
func (s *SponsorService) OpenLogo(ctx context.Context, id int64) (*SponsorLogoFile, error) {
	if id <= 0 {
		return nil, ErrSponsorNotFound
	}
	sp, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, sponsorNotFoundOr(err)
	}
	if _, ok := allowedSponsorLogoTypes[sp.LogoMIME]; !ok {
		return nil, ErrSponsorNotFound
	}
	fullPath, name, ok := s.resolveLogoPath(sp.LogoPath)
	if !ok {
		log.Printf("sponsor logo: unusable logo_path %q for sponsor %d", sp.LogoPath, sp.ID)
		return nil, ErrSponsorNotFound
	}
	return &SponsorLogoFile{
		Path:        fullPath,
		ContentType: sp.LogoMIME,
		Name:        name,
	}, nil
}

// resolveLogoPath validates logoPath (from the DB) and guarantees the returned absolute path stays
// directly inside s.sponsorDir (no path traversal, no subdirectories).
func (s *SponsorService) resolveLogoPath(logoPath string) (fullPath, name string, ok bool) {
	if logoPath == "" || strings.ContainsRune(logoPath, '\x00') {
		return "", "", false
	}
	slash := filepath.ToSlash(logoPath)
	if !strings.HasPrefix(slash, "sponsors/") {
		return "", "", false
	}
	name = strings.TrimPrefix(slash, "sponsors/")
	if name == "" || name == "." || name == ".." ||
		strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		return "", "", false
	}

	baseDir, err := filepath.Abs(s.sponsorDir)
	if err != nil {
		return "", "", false
	}
	candidate, err := filepath.Abs(filepath.Join(baseDir, name))
	if err != nil {
		return "", "", false
	}
	rel, err := filepath.Rel(baseDir, candidate)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", "", false
	}
	return candidate, name, true
}

func (s *SponsorService) removeLogoFile(logoPath string) {
	fullPath, name, ok := s.resolveLogoPath(logoPath)
	if !ok {
		log.Printf("sponsor logo: unusable logo_path %q, file not removed", logoPath)
		return
	}
	if err := os.Remove(fullPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("sponsor logo: cannot remove %s: %v", name, err)
	}
}

func prepareSponsorLogo(data []byte) (cleaned []byte, mimeType, ext, hash string, err error) {
	if len(data) == 0 {
		return nil, "", "", "", ErrSponsorLogoEmpty
	}
	if len(data) > MaxSponsorLogoBytes {
		return nil, "", "", "", ErrSponsorLogoTooLarge
	}

	mimeType = http.DetectContentType(data)
	ext, ok := allowedSponsorLogoTypes[mimeType]
	if !ok {
		return nil, "", "", "", ErrInvalidSponsorLogoType
	}

	width, height, dimErr := slipDimensions(data, mimeType)
	if dimErr != nil {
		return nil, "", "", "", ErrInvalidSponsorLogoType
	}
	if !validSlipDimensions(width, height) {
		return nil, "", "", "", ErrInvalidImageDimensions
	}

	cleaned = data
	if mimeType == "image/jpeg" {
		cleaned = stripJPEGExif(data)
	}
	sum := sha256.Sum256(cleaned)
	hash = hex.EncodeToString(sum[:])
	return cleaned, mimeType, ext, hash, nil
}

func validateSponsorName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if !utf8.ValidString(name) {
		return "", newValidationError("name must be valid UTF-8")
	}
	n := utf8.RuneCountInString(name)
	if n < 1 || n > maxSponsorNameRunes {
		return "", newValidationError(fmt.Sprintf("name must be 1-%d characters", maxSponsorNameRunes))
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", newValidationError("name must not contain control characters")
		}
	}
	return name, nil
}

func validateSponsorURL(raw string) (string, error) {
	u := strings.TrimSpace(raw)
	if u == "" {
		return "", nil
	}
	if !utf8.ValidString(u) {
		return "", newValidationError("url must be valid UTF-8")
	}
	if utf8.RuneCountInString(u) > maxSponsorURLRunes {
		return "", newValidationError(fmt.Sprintf("url must not exceed %d characters", maxSponsorURLRunes))
	}
	for _, r := range u {
		if unicode.IsControl(r) {
			return "", newValidationError("url must not contain control characters")
		}
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return "", newValidationError("url must be a valid http or https URL")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", newValidationError("url must use http or https")
	}
	if !strings.HasPrefix(strings.ToLower(u), scheme+"://") || parsed.Host == "" || parsed.Hostname() == "" {
		return "", newValidationError("url must include a valid host")
	}
	u = scheme + u[len(scheme):]
	return u, nil
}

func sponsorLogoURL(id int64, logoHash string) string {
	v := logoHash
	if len(v) > 12 {
		v = v[:12]
	}
	return fmt.Sprintf("/api/sponsors/%d/logo?v=%s", id, v)
}

func toPublicSponsor(s *domain.Sponsor) PublicSponsorEntry {
	return PublicSponsorEntry{
		ID:       s.ID,
		Name:     s.Name,
		URL:      s.URL,
		ShowName: s.ShowName,
		LogoURL:  sponsorLogoURL(s.ID, s.LogoHash),
	}
}

func toAdminSponsor(s *domain.Sponsor) AdminSponsorEntry {
	return AdminSponsorEntry{
		ID:        s.ID,
		Name:      s.Name,
		URL:       s.URL,
		ShowName:  s.ShowName,
		LogoURL:   sponsorLogoURL(s.ID, s.LogoHash),
		SortOrder: s.SortOrder,
		CreatedAt: s.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: s.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func copyPublicSponsors(src []PublicSponsorEntry) []PublicSponsorEntry {
	out := make([]PublicSponsorEntry, len(src))
	copy(out, src)
	return out
}

func sponsorNotFoundOr(err error) error {
	if errors.Is(err, domain.ErrNotFound) {
		return ErrSponsorNotFound
	}
	return err
}
