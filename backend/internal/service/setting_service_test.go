package service_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

type countingSettingRepo struct {
	*memory.MemorySettingRepo
	gets atomic.Int64
	hook func(ctx context.Context)
}

func (r *countingSettingRepo) Get(ctx context.Context) (*domain.Settings, error) {
	r.gets.Add(1)
	if r.hook != nil {
		r.hook(ctx)
	}
	return r.MemorySettingRepo.Get(ctx)
}

type countingApplicantRepo struct {
	*memory.MemoryApplicantRepo
	counts atomic.Int64
}

func (r *countingApplicantRepo) CountActive(ctx context.Context) (int, error) {
	r.counts.Add(1)
	return r.MemoryApplicantRepo.CountActive(ctx)
}

func TestSettingService_GetPublicSettings_CoalescesAndCaches(t *testing.T) {
	setRepo := &countingSettingRepo{MemorySettingRepo: memory.NewMemorySettingRepo()}
	appRepo := &countingApplicantRepo{MemoryApplicantRepo: memory.NewMemoryApplicantRepo()}
	svc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())

	setRepo.hook = func(context.Context) {
		time.Sleep(25 * time.Millisecond)
	}

	const burst = 40
	var wg sync.WaitGroup
	errs := make(chan error, burst)
	results := make([]*domain.PublicSettingsResponse, burst)
	for i := 0; i < burst; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := svc.GetPublicSettings(context.Background())
			if err != nil {
				errs <- err
				return
			}
			results[i] = res
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent GetPublicSettings failed: %v", err)
	}

	if got := setRepo.gets.Load(); got != 1 {
		t.Fatalf("expected 1 setting Get for %d concurrent callers, got %d", burst, got)
	}
	if got := appRepo.counts.Load(); got != 1 {
		t.Fatalf("expected 1 CountActive for %d concurrent callers, got %d", burst, got)
	}

	// Sequential reads inside the 1s TTL reuse the cached snapshot with zero DB hits.
	setRepo.hook = nil
	for i := 0; i < 5; i++ {
		if _, err := svc.GetPublicSettings(context.Background()); err != nil {
			t.Fatalf("cached GetPublicSettings failed: %v", err)
		}
	}
	if got := setRepo.gets.Load(); got != 1 {
		t.Fatalf("expected cache hit with 1 total Get, got %d", got)
	}

	// Mutating a caller's response pointer does not corrupt cached data for the next caller.
	*results[0].CampFee = results[0].CampFee.Add(results[0].CampFee.Abs())
	freshCopy, err := svc.GetPublicSettings(context.Background())
	if err != nil {
		t.Fatalf("GetPublicSettings after caller mutation failed: %v", err)
	}
	if !freshCopy.CampFee.Equal(results[1].CampFee.Abs()) {
		t.Fatalf("cached CampFee mutated by caller: got %s, want %s", freshCopy.CampFee, results[1].CampFee)
	}
}

func TestSettingService_GetPublicSettings_InvalidationAndBoundary(t *testing.T) {
	setRepo := &countingSettingRepo{MemorySettingRepo: memory.NewMemorySettingRepo()}
	appRepo := &countingApplicantRepo{MemoryApplicantRepo: memory.NewMemoryApplicantRepo()}
	svc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())

	// Opening boundary 90ms ahead (< 1s cache TTL) must still flip isOpen on time.
	openSoon := time.Now().UTC().Add(90 * time.Millisecond).Format(time.RFC3339Nano)
	closeLater := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := svc.UpdateSettings(context.Background(), service.UpdateSettingsRequest{
		RegistrationOpenAt:  &openSoon,
		RegistrationCloseAt: &closeLater,
	}, 1, "127.0.0.1"); err != nil {
		t.Fatalf("UpdateSettings setup failed: %v", err)
	}
	// Reset counters after UpdateSettings.
	setRepo.gets.Store(0)

	before, err := svc.GetPublicSettings(context.Background())
	if err != nil {
		t.Fatalf("GetPublicSettings before open failed: %v", err)
	}
	if before.IsOpen {
		t.Fatal("expected IsOpen=false before RegistrationOpenAt")
	}

	time.Sleep(110 * time.Millisecond)
	after, err := svc.GetPublicSettings(context.Background())
	if err != nil {
		t.Fatalf("GetPublicSettings after open failed: %v", err)
	}
	if !after.IsOpen {
		t.Fatal("expected cache to expire at RegistrationOpenAt boundary and flip IsOpen=true")
	}

	// An invalidation during an in-flight read must prevent the stale snapshot from being cached.
	queryEntered := make(chan struct{}, 1)
	releaseQuery := make(chan struct{})
	setRepo.hook = func(context.Context) {
		select {
		case queryEntered <- struct{}{}:
		default:
		}
		<-releaseQuery
	}
	svc.InvalidatePublicCache()

	done := make(chan error, 1)
	go func() {
		_, err := svc.GetPublicSettings(context.Background())
		done <- err
	}()
	<-queryEntered
	svc.InvalidatePublicCache()
	close(releaseQuery)
	if err := <-done; err != nil {
		t.Fatalf("in-flight GetPublicSettings failed: %v", err)
	}

	setRepo.hook = nil
	prevGets := setRepo.gets.Load()
	if _, err := svc.GetPublicSettings(context.Background()); err != nil {
		t.Fatalf("post-invalidation GetPublicSettings failed: %v", err)
	}
	if setRepo.gets.Load() != prevGets+1 {
		t.Fatalf("expected stale in-flight snapshot not to populate cache (gets=%d, want %d)", setRepo.gets.Load(), prevGets+1)
	}
}

func TestSettingService_GetPublicSettings_CallerCancelDoesNotAbortPeer(t *testing.T) {
	setRepo := &countingSettingRepo{MemorySettingRepo: memory.NewMemorySettingRepo()}
	appRepo := &countingApplicantRepo{MemoryApplicantRepo: memory.NewMemoryApplicantRepo()}
	svc := service.NewSettingService(setRepo, appRepo, appRepo.Audit())

	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	setRepo.hook = func(context.Context) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}

	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancelledErr := make(chan error, 1)
	go func() {
		_, err := svc.GetPublicSettings(cancelledCtx)
		cancelledErr <- err
	}()
	<-entered

	peerRes := make(chan error, 1)
	go func() {
		_, err := svc.GetPublicSettings(context.Background())
		peerRes <- err
	}()
	time.Sleep(15 * time.Millisecond)

	// Cancel the first caller while the DB lookup is in flight; peer must still succeed.
	cancel()
	if err := <-cancelledErr; err != context.Canceled {
		t.Fatalf("expected context.Canceled for aborted caller, got %v", err)
	}
	close(release)
	if err := <-peerRes; err != nil {
		t.Fatalf("peer caller failed after first caller cancelled: %v", err)
	}
}
