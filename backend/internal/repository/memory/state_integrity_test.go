package memory_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
)

func newRepos() (*memory.MemoryApplicantRepo, *memory.MemoryPaymentRepo) {
	apps := memory.NewMemoryApplicantRepo()
	return apps, memory.NewMemoryPaymentRepo(apps)
}

func addApplicant(t *testing.T, apps *memory.MemoryApplicantRepo, n int, status domain.ApplicationStatus) *domain.Applicant {
	t.Helper()
	a := &domain.Applicant{
		ApplicationNo: fmt.Sprintf("CC25-M%05d", n), FirstName: "ทดสอบ", LastName: "ระบบ",
		NationalID: fmt.Sprintf("15099%08d", n), Phone: fmt.Sprintf("08%08d", n), Status: status,
	}
	if err := apps.Create(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	return a
}

func slip(applicantID uuid.UUID, hash string) *domain.Payment {
	h := strings.Repeat("0", 64-len(hash)) + hash
	return &domain.Payment{ApplicantID: applicantID, SlipURL: "slips/" + hash + ".jpg", Amount: decimal.NewFromInt(1000), Status: domain.PaymentPending, SlipHash: &h}
}

func fullHash(hash string) string { return strings.Repeat("0", 64-len(hash)) + hash }

// ── MEDIUM-04 ──

func TestMemorySlipHash_OnlyLiveSlipsHoldTheirHash(t *testing.T) {
	apps, pays := newRepos()
	ctx := context.Background()
	a1 := addApplicant(t, apps, 1, domain.StatusPassed)
	a2 := addApplicant(t, apps, 2, domain.StatusPassed)
	dup := func(h string) bool {
		t.Helper()
		d, err := pays.CheckDuplicateSlipHash(ctx, fullHash(h))
		if err != nil {
			t.Fatal(err)
		}
		return d
	}

	first := slip(a1.ID, "aa")
	if _, err := pays.CreateReplacingPending(ctx, first); err != nil {
		t.Fatal(err)
	}
	if !dup("aa") {
		t.Fatal("a PENDING slip must hold its hash")
	}
	if _, err := pays.CreateReplacingPending(ctx, slip(a2.ID, "aa")); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("another applicant sending a PENDING slip's image must be refused, got %v", err)
	}

	if err := pays.Verify(ctx, first.ID, false, 1, "blurry", nil); err != nil {
		t.Fatal(err)
	}
	if dup("aa") {
		t.Fatal("a REJECTED slip must not hold its hash")
	}
	again := slip(a1.ID, "aa")
	if _, err := pays.CreateReplacingPending(ctx, again); err != nil {
		t.Fatalf("the same image after a rejection must be accepted, got %v", err)
	}
	if !dup("aa") {
		t.Fatal("the re-sent slip is PENDING and holds the hash again")
	}
	if _, err := pays.CreateReplacingPending(ctx, slip(a2.ID, "aa")); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("the re-sent slip blocks other applicants again, got %v", err)
	}

	if err := pays.Verify(ctx, again.ID, true, 1, "ok", nil); err != nil {
		t.Fatal(err)
	}
	if !dup("aa") {
		t.Fatal("an APPROVED slip must hold its hash")
	}
	if _, err := pays.CreateReplacingPending(ctx, slip(a2.ID, "aa")); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("an approved slip's image must be refused, got %v", err)
	}
	if got, _ := pays.GetByApplicantID(ctx, a1.ID); len(got) != 2 {
		t.Fatalf("the rejected row stays in the ledger next to the approved one, have %d rows", len(got))
	}
}

// ── MEDIUM-03 A ──

func TestMemoryVerify_RefusesDeletedApplicant(t *testing.T) {
	apps, pays := newRepos()
	ctx := context.Background()
	a := addApplicant(t, apps, 10, domain.StatusPassed)
	p := slip(a.ID, "b1")
	if _, err := pays.CreateReplacingPending(ctx, p); err != nil {
		t.Fatal(err)
	}
	admin := int64(1)
	if err := apps.SoftDelete(ctx, a.ID, &admin, "duplicate", nil); err != nil {
		t.Fatal(err)
	}
	for _, approved := range []bool{true, false} {
		if err := pays.Verify(ctx, p.ID, approved, 1, "x", nil); !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("approved=%v: settling a deleted applicant's slip must be a state conflict, got %v", approved, err)
		}
	}
	if got, _ := pays.GetByID(ctx, p.ID); got.Status != domain.PaymentPending {
		t.Fatalf("the refused verdict must leave the slip PENDING, got %s", got.Status)
	}
	if n := len(apps.StatusLogs()); n != 0 {
		t.Fatalf("no status change may be logged, have %d", n)
	}
}

// ── MEDIUM-03 B ──

func TestMemorySelfWithdraw_RechecksUnderTheLock(t *testing.T) {
	apps, pays := newRepos()
	ctx := context.Background()
	admin := int64(1)

	pending := addApplicant(t, apps, 20, domain.StatusPassed)
	if _, err := pays.CreateReplacingPending(ctx, slip(pending.ID, "c1")); err != nil {
		t.Fatal(err)
	}
	approved := addApplicant(t, apps, 21, domain.StatusPassed)
	ap := slip(approved.ID, "c2")
	if _, err := pays.CreateReplacingPending(ctx, ap); err != nil {
		t.Fatal(err)
	}
	if err := pays.Verify(ctx, ap.ID, true, 1, "ok", nil); err != nil {
		t.Fatal(err)
	}
	confirmed := addApplicant(t, apps, 22, domain.StatusConfirmed)
	rejected := addApplicant(t, apps, 23, domain.StatusRejected)

	for name, a := range map[string]*domain.Applicant{"pending slip": pending, "approved slip": approved, "confirmed": confirmed, "rejected": rejected} {
		if err := apps.SoftDelete(ctx, a.ID, nil, "เปลี่ยนใจ", nil); !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("%s: self-service withdrawal must be refused, got %v", name, err)
		}
		if _, err := apps.GetByApplicationNo(ctx, a.ApplicationNo); err != nil {
			t.Fatalf("%s: a refused withdrawal must keep the application: %v", name, err)
		}
	}

	// A rejected slip is not money held: withdrawal goes through.
	rs := addApplicant(t, apps, 24, domain.StatusPassed)
	rp := slip(rs.ID, "c3")
	if _, err := pays.CreateReplacingPending(ctx, rp); err != nil {
		t.Fatal(err)
	}
	if err := pays.Verify(ctx, rp.ID, false, 1, "no", nil); err != nil {
		t.Fatal(err)
	}
	if err := apps.SoftDelete(ctx, rs.ID, nil, "เปลี่ยนใจ", nil); err != nil {
		t.Fatalf("an applicant whose only slip was rejected may withdraw: %v", err)
	}
	// Staff can still delete an application that holds a slip.
	if err := apps.SoftDelete(ctx, pending.ID, &admin, "duplicate", nil); err != nil {
		t.Fatalf("a staff delete is not a self-service withdrawal: %v", err)
	}
}

// A slip can never land on a withdrawn application, and a withdrawal never removes an application
// with a fresh slip: the two serialise.
func TestMemoryWithdrawRacesWithUpload(t *testing.T) {
	apps, pays := newRepos()
	ctx := context.Background()
	for round := 0; round < 200; round++ {
		a := addApplicant(t, apps, 1000+round, domain.StatusPassed)
		var wg sync.WaitGroup
		var wErr, uErr error
		wg.Add(2)
		go func() { defer wg.Done(); wErr = apps.SoftDelete(ctx, a.ID, nil, "x", nil) }()
		go func() {
			defer wg.Done()
			_, uErr = pays.CreateReplacingPending(ctx, slip(a.ID, fmt.Sprintf("d%d", round)))
		}()
		wg.Wait()
		switch {
		case wErr == nil && errors.Is(uErr, domain.ErrNotFound):
		case errors.Is(wErr, domain.ErrStateConflict) && uErr == nil:
		default:
			t.Fatalf("round %d: withdraw=%v upload=%v", round, wErr, uErr)
		}
	}
}

// ── MEDIUM-03 C ──

func TestMemoryUpdateStatus_PlainPathRefusesToRetakeASeat(t *testing.T) {
	apps, _ := newRepos()
	ctx := context.Background()
	a := addApplicant(t, apps, 30, domain.StatusRejected)
	if err := apps.UpdateStatus(ctx, a.ID, domain.StatusPassed, nil, "x", nil); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("REJECTED -> PASSED without the quota check must be refused, got %v", err)
	}
	if err := apps.UpdateStatus(ctx, a.ID, domain.StatusRefunded, nil, "x", nil); err != nil {
		t.Fatalf("moving between seatless statuses needs no quota: %v", err)
	}
	if err := apps.UpdateStatusWithinCapacity(ctx, a.ID, domain.StatusPassed, nil, "x", nil, 30); err != nil {
		t.Fatalf("the quota-checked path may take the seat back: %v", err)
	}
	if err := apps.UpdateStatus(ctx, a.ID, domain.StatusConfirmed, nil, "x", nil); err != nil {
		t.Fatalf("active -> active needs no quota: %v", err)
	}
}

// MEDIUM-04 case B: a staff delete releases the hashes of the deleted applicant's slips, while the
// payment rows keep their status and hash for the ledger.
func TestMemoryAdminDelete_ReleasesSlipHashesKeepsLedger(t *testing.T) {
	apps, pays := newRepos()
	ctx := context.Background()
	admin := int64(1)

	pendingApp := addApplicant(t, apps, 40, domain.StatusPassed)
	pending := slip(pendingApp.ID, "g1")
	if _, err := pays.CreateReplacingPending(ctx, pending); err != nil {
		t.Fatal(err)
	}
	approvedApp := addApplicant(t, apps, 41, domain.StatusPassed)
	approved := slip(approvedApp.ID, "g2")
	if _, err := pays.CreateReplacingPending(ctx, approved); err != nil {
		t.Fatal(err)
	}
	if err := pays.Verify(ctx, approved.ID, true, 1, "ok", nil); err != nil {
		t.Fatal(err)
	}
	// A rejected slip of a third applicant whose image a live applicant sent again: the delete of
	// the third applicant must not free the live applicant's hash.
	rejectedApp := addApplicant(t, apps, 42, domain.StatusPassed)
	rejected := slip(rejectedApp.ID, "g3")
	if _, err := pays.CreateReplacingPending(ctx, rejected); err != nil {
		t.Fatal(err)
	}
	if err := pays.Verify(ctx, rejected.ID, false, 1, "no", nil); err != nil {
		t.Fatal(err)
	}
	liveApp := addApplicant(t, apps, 43, domain.StatusPassed)
	if _, err := pays.CreateReplacingPending(ctx, slip(liveApp.ID, "g3")); err != nil {
		t.Fatal(err)
	}

	for _, a := range []*domain.Applicant{pendingApp, approvedApp, rejectedApp} {
		if err := apps.SoftDelete(ctx, a.ID, &admin, "duplicate", nil); err != nil {
			t.Fatal(err)
		}
	}

	for h, want := range map[string]bool{"g1": false, "g2": false, "g3": true} {
		if got, _ := pays.CheckDuplicateSlipHash(ctx, fullHash(h)); got != want {
			t.Fatalf("hash %s: duplicate=%v, want %v", h, got, want)
		}
	}
	for p, want := range map[*domain.Payment]domain.PaymentStatus{pending: domain.PaymentPending, approved: domain.PaymentApproved, rejected: domain.PaymentRejected} {
		got, err := pays.GetByID(ctx, p.ID)
		if err != nil || got.Status != want || got.SlipHash == nil || *got.SlipHash != *p.SlipHash {
			t.Fatalf("the deleted applicant's slip must keep status %s and its hash, got %+v (%v)", want, got, err)
		}
	}
	if err := pays.Verify(ctx, pending.ID, true, 1, "ok", nil); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("Verify on a deleted applicant must stay a state conflict, got %v", err)
	}

	// The same student registers again and sends the same slips.
	again := addApplicant(t, apps, 44, domain.StatusPassed)
	if _, err := pays.CreateReplacingPending(ctx, slip(again.ID, "g1")); err != nil {
		t.Fatalf("the PENDING slip of a deleted application must not block its image: %v", err)
	}
	other := addApplicant(t, apps, 45, domain.StatusPassed)
	if _, err := pays.CreateReplacingPending(ctx, slip(other.ID, "g2")); err != nil {
		t.Fatalf("the APPROVED slip of a deleted application must not block its image: %v", err)
	}
	// And the new live slips hold the hashes again.
	if _, err := pays.CreateReplacingPending(ctx, slip(other.ID, "g1")); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("the re-sent live slip holds its hash, got %v", err)
	}
	if _, err := pays.CreateReplacingPending(ctx, slip(rejectedApp.ID, "g3")); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("a deleted applicant cannot upload, got %v", err)
	}
}
