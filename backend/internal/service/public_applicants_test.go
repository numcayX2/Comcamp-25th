package service_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

// countingListRepo counts ListPublic calls and can hold a call open, to observe the cache.
type countingListRepo struct {
	*memory.MemoryApplicantRepo
	lists atomic.Int64
	hook  func()
}

func (r *countingListRepo) ListPublic(ctx context.Context) ([]domain.PublicApplicant, error) {
	r.lists.Add(1)
	if r.hook != nil {
		r.hook()
	}
	return r.MemoryApplicantRepo.ListPublic(ctx)
}

type publicListFixture struct {
	apps *memory.MemoryApplicantRepo
	repo *countingListRepo
	pays *memory.MemoryPaymentRepo
	svc  *service.ApplicantService
	psvc *service.PaymentService
}

// newPublicListFixture wires the services like main: the payment service reports status changes
// to the applicant service so slip approvals refresh the public list.
func newPublicListFixture(t *testing.T) *publicListFixture {
	t.Helper()
	apps := memory.NewMemoryApplicantRepo()
	repo := &countingListRepo{MemoryApplicantRepo: apps}
	pays := memory.NewMemoryPaymentRepo(apps)
	svc := service.NewApplicantService(repo, memory.NewMemorySettingRepo(), pays).WithAudit(apps.Audit())
	psvc := service.NewPaymentService(pays, repo, memory.NewMemorySettingRepo(), apps.Audit(), t.TempDir()).
		WithOnStatusChange(svc.InvalidatePublicList)
	return &publicListFixture{apps: apps, repo: repo, pays: pays, svc: svc, psvc: psvc}
}

func (f *publicListFixture) list(t *testing.T) []service.PublicApplicantEntry {
	t.Helper()
	res, err := f.svc.ListPublicApplicants(context.Background())
	if err != nil {
		t.Fatalf("ListPublicApplicants: %v", err)
	}
	return res.Applicants
}

func TestListPublicApplicants_FiltersOrdersAndLabels(t *testing.T) {
	f := newPublicListFixture(t)
	ctx := context.Background()

	base := time.Now().UTC().Add(-time.Hour)
	seed := func(idx int, status domain.ApplicationStatus, minutes int) *domain.Applicant {
		a := auditApplicant(t, f.apps, idx, status)
		if err := f.apps.SetTimestampsForTest(a.ID, base.Add(time.Duration(minutes)*time.Minute), base); err != nil {
			t.Fatal(err)
		}
		return a
	}
	// Inserted out of order: the list follows created_at, not insertion order.
	confirmed := seed(11, domain.StatusConfirmed, 20)
	passed := seed(12, domain.StatusPassed, 10)
	seed(13, domain.StatusPending, 5)
	seed(14, domain.StatusReserve, 6)
	seed(15, domain.StatusRejected, 7)
	seed(16, domain.StatusRefundPending, 8)
	seed(17, domain.StatusRefunded, 9)
	deleted := seed(18, domain.StatusPassed, 1)
	if err := f.apps.SoftDelete(ctx, deleted.ID, nil, "test", nil); err != nil {
		t.Fatal(err)
	}

	got := f.list(t)
	if len(got) != 2 {
		t.Fatalf("expected only the live PASSED and CONFIRMED applicants, got %d: %+v", len(got), got)
	}
	want := []service.PublicApplicantEntry{
		{No: 1, Prefix: passed.Prefix, FullName: passed.FirstName + " " + passed.LastName, School: passed.School, Province: passed.Province, Status: "รอชำระเงิน"},
		{No: 2, Prefix: confirmed.Prefix, FullName: confirmed.FirstName + " " + confirmed.LastName, School: confirmed.School, Province: confirmed.Province, Status: "ยืนยันสิทธิ์แล้ว"},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestListPublicApplicants_EmptyIsEmptySliceNotNil(t *testing.T) {
	f := newPublicListFixture(t)
	if got := f.list(t); got == nil || len(got) != 0 {
		t.Fatalf("an empty camp must list [] (not null), got %#v", got)
	}
}

func TestListPublicApplicants_CoalescesAndCaches(t *testing.T) {
	f := newPublicListFixture(t)
	auditApplicant(t, f.apps, 21, domain.StatusPassed)
	f.repo.hook = func() { time.Sleep(25 * time.Millisecond) }

	const burst = 40
	var wg sync.WaitGroup
	errs := make(chan error, burst)
	for i := 0; i < burst; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.svc.ListPublicApplicants(context.Background()); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent ListPublicApplicants failed: %v", err)
	}
	if got := f.repo.lists.Load(); got != 1 {
		t.Fatalf("expected 1 repository read for %d concurrent callers, got %d", burst, got)
	}

	f.repo.hook = nil
	for i := 0; i < 5; i++ {
		f.list(t)
	}
	if got := f.repo.lists.Load(); got != 1 {
		t.Fatalf("reads inside the TTL must come from the cache, got %d repository reads", got)
	}

	// A caller mutating its copy must not corrupt the cache for the next caller.
	res, _ := f.svc.ListPublicApplicants(context.Background())
	res.Applicants[0].FullName = "tampered"
	if again := f.list(t); again[0].FullName == "tampered" {
		t.Fatal("cached list was mutated through a caller's response")
	}
}

// An invalidation while a read is in flight must stop that read from caching pre-change data.
func TestListPublicApplicants_InvalidationDuringInFlightReadIsNotCached(t *testing.T) {
	f := newPublicListFixture(t)
	a := auditApplicant(t, f.apps, 31, domain.StatusPassed)

	entered := make(chan struct{})
	release := make(chan struct{})
	// Only the first read blocks (not sync.Once: its Do would also block every later caller).
	var first atomic.Bool
	f.repo.hook = func() {
		if first.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = f.svc.ListPublicApplicants(context.Background())
	}()
	<-entered
	// Staff change the status while the read above is still running.
	if _, err := f.svc.UpdateStatus(context.Background(), a.ApplicationNo, domain.StatusConfirmed, nil, "test", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	// A caller arriving after the change must not join the read that started before it (that read
	// is still blocked here, so joining it would hang).
	fresh := make(chan *service.PublicApplicantsResponse, 1)
	go func() {
		res, _ := f.svc.ListPublicApplicants(context.Background())
		fresh <- res
	}()
	select {
	case res := <-fresh:
		if res == nil || len(res.Applicants) != 1 || res.Applicants[0].Status != "ยืนยันสิทธิ์แล้ว" {
			t.Errorf("a read started after the change returned stale rows: %+v", res)
		}
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("a read started after the change joined the stale in-flight read")
	}
	close(release)
	<-done

	got := f.list(t)
	if len(got) != 1 || got[0].Status != "ยืนยันสิทธิ์แล้ว" {
		t.Fatalf("a read that raced an invalidation must not be served from cache, got %+v", got)
	}
}

// Every mutation that changes who is listed, or what is shown about them, drops the cache.
func TestListPublicApplicants_InvalidatedByEveryMutation(t *testing.T) {
	ctx := context.Background()
	const ip = "127.0.0.1"

	cases := []struct {
		name   string
		status domain.ApplicationStatus
		mutate func(t *testing.T, f *publicListFixture, a *domain.Applicant)
		check  func(t *testing.T, rows []service.PublicApplicantEntry)
	}{
		{
			name:   "status change between listed statuses",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				if _, err := f.svc.UpdateStatus(ctx, a.ApplicationNo, domain.StatusConfirmed, nil, "paid in cash", ip); err != nil {
					t.Fatal(err)
				}
			},
			check: wantOneRowWithStatus("ยืนยันสิทธิ์แล้ว"),
		},
		{
			name:   "status change into the list (PENDING to PASSED)",
			status: domain.StatusPending,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				if _, err := f.svc.UpdateStatus(ctx, a.ApplicationNo, domain.StatusPassed, nil, "", ip); err != nil {
					t.Fatal(err)
				}
			},
			check: wantOneRowWithStatus("รอชำระเงิน"),
		},
		{
			name:   "status change out of the list (REJECTED)",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				if _, err := f.svc.UpdateStatus(ctx, a.ApplicationNo, domain.StatusRejected, nil, "", ip); err != nil {
					t.Fatal(err)
				}
			},
			check: wantNoRows,
		},
		{
			name:   "admin delete",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				if err := f.svc.Delete(ctx, a.ApplicationNo, 1, "duplicate", ip); err != nil {
					t.Fatal(err)
				}
			},
			check: wantNoRows,
		},
		{
			name:   "unpaid auto-expiry",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				old := time.Now().UTC().Add(-service.UnpaidExpiryWindow - service.UnpaidGraceWindow - time.Hour)
				if err := f.apps.SetTimestampsForTest(a.ID, old, old); err != nil {
					t.Fatal(err)
				}
				expired, err := f.svc.ExpireOverdueUnpaid(ctx, time.Now().UTC())
				if err != nil || len(expired) != 1 {
					t.Fatalf("expected one expiry, got %v (%v)", expired, err)
				}
			},
			check: wantNoRows,
		},
		{
			name:   "slip approval confirms the seat",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				p := &domain.Payment{ID: uuid.New(), ApplicantID: a.ID, SlipURL: "slips/x.jpg", Amount: decimal.NewFromInt(1200), Status: domain.PaymentPending}
				if _, err := f.pays.CreateReplacingPending(ctx, p); err != nil {
					t.Fatal(err)
				}
				if err := f.psvc.VerifySlip(ctx, a.ApplicationNo, p.ID.String(), true, 1, "ok", ip); err != nil {
					t.Fatal(err)
				}
			},
			check: wantOneRowWithStatus("ยืนยันสิทธิ์แล้ว"),
		},
		{
			name:   "staff profile edit of a listed field",
			status: domain.StatusPassed,
			mutate: func(t *testing.T, f *publicListFixture, a *domain.Applicant) {
				school := "โรงเรียนใหม่"
				if _, err := f.svc.AdminUpdateProfile(ctx, a.ApplicationNo, service.AdminProfileRequest{School: &school}, nil, ip); err != nil {
					t.Fatal(err)
				}
			},
			check: func(t *testing.T, rows []service.PublicApplicantEntry) {
				t.Helper()
				if len(rows) != 1 || rows[0].School != "โรงเรียนใหม่" {
					t.Fatalf("expected the edited school, got %+v", rows)
				}
			},
		},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newPublicListFixture(t)
			a := auditApplicant(t, f.apps, 40+i, tc.status)
			f.list(t) // warm the cache
			before := f.repo.lists.Load()
			tc.mutate(t, f, a)
			tc.check(t, f.list(t))
			if f.repo.lists.Load() == before {
				t.Fatal("the mutation did not invalidate the cached list")
			}
		})
	}
}

func wantOneRowWithStatus(status string) func(t *testing.T, rows []service.PublicApplicantEntry) {
	return func(t *testing.T, rows []service.PublicApplicantEntry) {
		t.Helper()
		if len(rows) != 1 || rows[0].Status != status {
			t.Fatalf("expected one row with status %q, got %+v", status, rows)
		}
	}
}

func wantNoRows(t *testing.T, rows []service.PublicApplicantEntry) {
	t.Helper()
	if len(rows) != 0 {
		t.Fatalf("expected no rows, got %+v", rows)
	}
}

// The public list runs the same lazy unpaid expiry as /status, so an overdue seat is never
// listed there while /status already reports it as expired; the post-expiry read is cached.
func TestListPublicApplicants_ReleasesOverdueUnpaidBeforeReading(t *testing.T) {
	f := newPublicListFixture(t)
	ctx := context.Background()
	kept := auditApplicant(t, f.apps, 61, domain.StatusPassed)
	overdue := auditApplicant(t, f.apps, 62, domain.StatusPassed)
	old := time.Now().UTC().Add(-service.UnpaidExpiryWindow - service.UnpaidGraceWindow - time.Hour)
	if err := f.apps.SetTimestampsForTest(overdue.ID, old, old); err != nil {
		t.Fatal(err)
	}

	got := f.list(t)
	if len(got) != 1 || got[0].No != 1 || got[0].FullName != kept.FirstName+" "+kept.LastName {
		t.Fatalf("expected only the paid-up seat, got %+v", got)
	}
	if a, _ := f.apps.GetByID(ctx, overdue.ID); a.Status != domain.StatusForfeited {
		t.Fatalf("the overdue seat must be released by the list read, status = %s", a.Status)
	}

	f.list(t)
	if n := f.repo.lists.Load(); n != 1 {
		t.Fatalf("the read after the expiry must be cached, got %d repository reads", n)
	}
}
