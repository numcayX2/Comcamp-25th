package service_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

type countingSponsorRepo struct {
	*memory.MemorySponsorRepo
	lists      atomic.Int64
	listHook   func()
	createErr  error
	updateErr  error
	overrideBy map[int64]*domain.Sponsor
}

func (r *countingSponsorRepo) List(ctx context.Context) ([]*domain.Sponsor, error) {
	r.lists.Add(1)
	if r.listHook != nil {
		r.listHook()
	}
	return r.MemorySponsorRepo.List(ctx)
}

func (r *countingSponsorRepo) GetByID(ctx context.Context, id int64) (*domain.Sponsor, error) {
	if r.overrideBy != nil {
		if sp, ok := r.overrideBy[id]; ok {
			clone := *sp
			return &clone, nil
		}
	}
	return r.MemorySponsorRepo.GetByID(ctx, id)
}

func (r *countingSponsorRepo) Create(ctx context.Context, s *domain.Sponsor, audit *domain.AuditEntry) error {
	if r.createErr != nil {
		return r.createErr
	}
	return r.MemorySponsorRepo.Create(ctx, s, audit)
}

func (r *countingSponsorRepo) Update(ctx context.Context, id int64, patch domain.SponsorPatch, audit *domain.AuditEntry) (*domain.Sponsor, string, error) {
	if r.updateErr != nil {
		return nil, "", r.updateErr
	}
	return r.MemorySponsorRepo.Update(ctx, id, patch, audit)
}

func testSponsorPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func testSponsorJPEGWithExif(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	raw := b.Bytes()
	payload := append([]byte("Exif\x00\x00"), []byte("FAKE-GPS-EXIF-DATA")...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:4], uint16(2+len(payload)))
	seg = append(seg, payload...)
	out := make([]byte, 0, len(raw)+len(seg))
	out = append(out, raw[:2]...)
	out = append(out, seg...)
	out = append(out, raw[2:]...)
	return out
}

func testSponsorWebP(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSponsorService_CacheSingleflightAndInvalidation(t *testing.T) {
	mem := memory.NewMemorySponsorRepo(nil)
	repo := &countingSponsorRepo{MemorySponsorRepo: mem}
	svc := service.NewSponsorService(repo, t.TempDir())
	ctx := context.Background()

	first, err := svc.Create(ctx, service.CreateSponsorRequest{
		Name: "Alpha Sponsor", URL: "https://alpha.example.com", ShowName: true, HasLogo: true, LogoData: testSponsorPNG(t, 4, 4),
	}, 1, "127.0.0.1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	repo.listHook = func() { time.Sleep(25 * time.Millisecond) }
	const burst = 30
	var wg sync.WaitGroup
	errs := make(chan error, burst)
	for i := 0; i < burst; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := svc.ListPublic(ctx); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent ListPublic failed: %v", err)
	}
	if got := repo.lists.Load(); got != 1 {
		t.Fatalf("expected 1 repo read for %d concurrent callers, got %d", burst, got)
	}

	// Subsequent reads inside TTL hit cache, and caller mutation cannot corrupt cached rows.
	repo.listHook = nil
	res, err := svc.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	res.Sponsors[0].Name = "tampered"
	again, err := svc.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if again.Sponsors[0].Name != "Alpha Sponsor" {
		t.Fatalf("cache was mutated by caller: %+v", again.Sponsors)
	}
	if got := repo.lists.Load(); got != 1 {
		t.Fatalf("reads inside TTL should use cache, got %d reads", got)
	}

	// Invalidation while a read is in flight must not cache pre-mutation data.
	svc.InvalidatePublicCache()
	entered := make(chan struct{})
	release := make(chan struct{})
	var blocked atomic.Bool
	repo.listHook = func() {
		if blocked.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	}
	inFlightDone := make(chan struct{})
	go func() {
		defer close(inFlightDone)
		_, _ = svc.ListPublic(ctx)
	}()
	<-entered

	newName := "Beta Sponsor"
	if _, err := svc.Update(ctx, first.ID, service.UpdateSponsorRequest{Name: &newName}, 1, "127.0.0.1"); err != nil {
		t.Fatal(err)
	}

	freshCh := make(chan *service.PublicSponsorsResponse, 1)
	go func() {
		r, _ := svc.ListPublic(ctx)
		freshCh <- r
	}()
	select {
	case fresh := <-freshCh:
		if fresh == nil || len(fresh.Sponsors) != 1 || fresh.Sponsors[0].Name != "Beta Sponsor" {
			t.Fatalf("post-mutation read returned stale data: %+v", fresh)
		}
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("post-mutation read joined stale in-flight singleflight")
	}
	close(release)
	<-inFlightDone

	after, err := svc.ListPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Sponsors) != 1 || after.Sponsors[0].Name != "Beta Sponsor" {
		t.Fatalf("stale in-flight read polluted cache: %+v", after.Sponsors)
	}
}

func TestSponsorService_TwoPhaseWriteRollbackRemovesNewFile(t *testing.T) {
	uploadDir := t.TempDir()
	sponsorDir := filepath.Join(uploadDir, "sponsors")

	mem := memory.NewMemorySponsorRepo(nil)
	repo := &countingSponsorRepo{MemorySponsorRepo: mem, createErr: errors.New("db write failed")}
	svc := service.NewSponsorService(repo, uploadDir)
	ctx := context.Background()

	// Create fails in DB -> written logo file must be cleaned up immediately.
	if _, err := svc.Create(ctx, service.CreateSponsorRequest{
		Name: "Fail Co", HasLogo: true, LogoData: testSponsorPNG(t, 4, 4),
	}, 1, "127.0.0.1"); err == nil {
		t.Fatal("expected create error")
	}
	entries, err := os.ReadDir(sponsorDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected 0 orphan files after failed create, got %d", len(entries))
	}

	// Succeed create, then fail update with new logo -> new file deleted, old file kept.
	repo.createErr = nil
	created, err := svc.Create(ctx, service.CreateSponsorRequest{
		Name: "Keep Co", HasLogo: true, LogoData: testSponsorPNG(t, 4, 4),
	}, 1, "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	beforeFiles, _ := os.ReadDir(sponsorDir)
	if len(beforeFiles) != 1 {
		t.Fatalf("expected 1 logo file after create, got %d", len(beforeFiles))
	}

	repo.updateErr = errors.New("db update failed")
	if _, err := svc.Update(ctx, created.ID, service.UpdateSponsorRequest{
		HasLogo: true, LogoData: testSponsorWebP(t),
	}, 1, "127.0.0.1"); err == nil {
		t.Fatal("expected update error")
	}
	afterFiles, _ := os.ReadDir(sponsorDir)
	if len(afterFiles) != 1 || afterFiles[0].Name() != beforeFiles[0].Name() {
		t.Fatalf("failed update must remove only the new file and keep %s, got %v", beforeFiles[0].Name(), afterFiles)
	}
}

func TestSponsorService_JPEGExifStrippedAndFormatsAccepted(t *testing.T) {
	uploadDir := t.TempDir()
	mem := memory.NewMemorySponsorRepo(nil)
	svc := service.NewSponsorService(mem, uploadDir)
	ctx := context.Background()

	jpegWithExif := testSponsorJPEGWithExif(t)
	if !bytes.Contains(jpegWithExif, []byte("FAKE-GPS-EXIF-DATA")) {
		t.Fatal("test fixture missing EXIF marker")
	}

	created, err := svc.Create(ctx, service.CreateSponsorRequest{
		Name: "JPEG Sponsor", HasLogo: true, LogoData: jpegWithExif,
	}, 1, "127.0.0.1")
	if err != nil {
		t.Fatalf("create jpeg: %v", err)
	}
	logo, err := svc.OpenLogo(ctx, created.ID)
	if err != nil {
		t.Fatalf("open logo: %v", err)
	}
	if logo.ContentType != "image/jpeg" {
		t.Fatalf("ContentType = %q, want image/jpeg", logo.ContentType)
	}
	stored, err := os.ReadFile(logo.Path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("FAKE-GPS-EXIF-DATA")) || bytes.Contains(stored, []byte("Exif\x00\x00")) {
		t.Fatal("stored JPEG still contains EXIF payload")
	}
	sum := sha256.Sum256(stored)
	wantPrefix := hex.EncodeToString(sum[:])[:12]
	if !bytes.Contains([]byte(created.LogoURL), []byte("?v="+wantPrefix)) {
		t.Fatalf("logoUrl %q does not match stored SHA-256 prefix %s", created.LogoURL, wantPrefix)
	}

	// WebP is also accepted.
	webpSponsor, err := svc.Create(ctx, service.CreateSponsorRequest{
		Name: "WebP Sponsor", HasLogo: true, LogoData: testSponsorWebP(t),
	}, 1, "127.0.0.1")
	if err != nil {
		t.Fatalf("create webp: %v", err)
	}
	webpLogo, err := svc.OpenLogo(ctx, webpSponsor.ID)
	if err != nil {
		t.Fatalf("open webp logo: %v", err)
	}
	if webpLogo.ContentType != "image/webp" {
		t.Fatalf("webp ContentType = %q, want image/webp", webpLogo.ContentType)
	}
}

func TestSponsorService_OpenLogoRejectsPathTraversal(t *testing.T) {
	uploadDir := t.TempDir()
	mem := memory.NewMemorySponsorRepo(nil)
	repo := &countingSponsorRepo{
		MemorySponsorRepo: mem,
		overrideBy:        map[int64]*domain.Sponsor{},
	}
	svc := service.NewSponsorService(repo, uploadDir)
	ctx := context.Background()

	badPaths := []string{
		"",
		"../slips/secret.jpg",
		"/etc/passwd",
		"sponsors/../secret.jpg",
		"sponsors/../../secret.jpg",
		"sponsors/sub/logo.png",
		"sponsors/..\\secret.jpg",
		"sponsors/.",
		"sponsors/..",
		"sponsors/evil\x00.png",
		"slips/other.png",
	}
	for i, bad := range badPaths {
		id := int64(i + 1)
		repo.overrideBy[id] = &domain.Sponsor{
			ID:       id,
			Name:     "Tampered",
			LogoPath: bad,
			LogoMIME: "image/png",
			LogoHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		}
		if _, err := svc.OpenLogo(ctx, id); !errors.Is(err, service.ErrSponsorNotFound) {
			t.Errorf("path %q: expected ErrSponsorNotFound, got %v", bad, err)
		}
	}
}
