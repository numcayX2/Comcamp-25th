package service_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

// These tests run the other party of each race at the exact moment between the service's unlocked
// read and the repository call, which is where the old code went wrong.

type racingApplicants struct {
	*memory.MemoryApplicantRepo
	beforeSoftDelete   func()
	beforeUpdateStatus func()
}

func (r *racingApplicants) SoftDelete(ctx context.Context, id uuid.UUID, adminID *int64, reason string, audit *domain.AuditEntry) error {
	if f := r.beforeSoftDelete; f != nil {
		r.beforeSoftDelete = nil
		f()
	}
	return r.MemoryApplicantRepo.SoftDelete(ctx, id, adminID, reason, audit)
}

func (r *racingApplicants) UpdateStatus(ctx context.Context, id uuid.UUID, s domain.ApplicationStatus, adminID *int64, reason string, audit *domain.AuditEntry) error {
	if f := r.beforeUpdateStatus; f != nil {
		r.beforeUpdateStatus = nil
		f()
	}
	return r.MemoryApplicantRepo.UpdateStatus(ctx, id, s, adminID, reason, audit)
}

type racingPayments struct {
	*memory.MemoryPaymentRepo
	beforeVerify func()
}

func (r *racingPayments) Verify(ctx context.Context, id uuid.UUID, approved bool, adminID int64, note string, audit *domain.AuditEntry) error {
	if f := r.beforeVerify; f != nil {
		r.beforeVerify = nil
		f()
	}
	return r.MemoryPaymentRepo.Verify(ctx, id, approved, adminID, note, audit)
}

type raceFixture struct {
	apps  *memory.MemoryApplicantRepo
	race  *racingApplicants
	pays  *memory.MemoryPaymentRepo
	rpays *racingPayments
	sets  *memory.MemorySettingRepo
	svc   *service.ApplicantService
	psvc  *service.PaymentService
}

func newRaceFixture(t *testing.T) *raceFixture {
	t.Helper()
	f := &raceFixture{apps: memory.NewMemoryApplicantRepo(), sets: memory.NewMemorySettingRepo()}
	f.pays = memory.NewMemoryPaymentRepo(f.apps)
	f.race = &racingApplicants{MemoryApplicantRepo: f.apps}
	f.rpays = &racingPayments{MemoryPaymentRepo: f.pays}
	f.svc = service.NewApplicantService(f.race, f.sets, f.pays)
	f.psvc = service.NewPaymentService(f.rpays, f.apps, f.sets, f.apps.Audit(), t.TempDir())
	return f
}

func (f *raceFixture) submit(t *testing.T, seq int) (appNo string, a *domain.Applicant, nid string) {
	t.Helper()
	nid = validTestNationalID(seq)
	res, err := f.svc.Submit(context.Background(), service.ApplicationCreateRequest{
		FullName: "สมชาย ใจดี", Nickname: "ชาย", NationalID: nid, Phone: "08" + nid[5:13], Email: "r" + nid + "@example.com",
		School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "L",
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err = f.apps.GetByApplicationNo(context.Background(), res.ID)
	if err != nil {
		t.Fatal(err)
	}
	return res.ID, a, nid
}

func (f *raceFixture) addSlip(t *testing.T, a *domain.Applicant, hash string) *domain.Payment {
	t.Helper()
	h := fullHash64(hash)
	p := &domain.Payment{ApplicantID: a.ID, SlipURL: "slips/" + hash + ".jpg", Amount: decimal.NewFromInt(1000), Status: domain.PaymentPending, SlipHash: &h}
	if _, err := f.pays.CreateReplacingPending(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	return p
}

func fullHash64(s string) string {
	for len(s) < 64 {
		s = "0" + s
	}
	return s
}

// MEDIUM-03 A: the applicant is deleted between VerifySlip's lookup and the repository call.
func TestRace_VerifySlipAfterApplicantDeleted(t *testing.T) {
	for _, approved := range []bool{true, false} {
		f := newRaceFixture(t)
		ctx := context.Background()
		appNo, a, _ := f.submit(t, 4001)
		p := f.addSlip(t, a, "e1")
		admin := int64(9)
		f.rpays.beforeVerify = func() {
			if err := f.apps.SoftDelete(ctx, a.ID, &admin, "duplicate", nil); err != nil {
				t.Fatal(err)
			}
		}
		err := f.psvc.VerifySlip(ctx, appNo, "", approved, 1, "ok", "203.0.113.1")
		if !errors.Is(err, service.ErrSlipLocked) {
			t.Fatalf("approved=%v: want ErrSlipLocked, got %v", approved, err)
		}
		if got, _ := f.pays.GetByID(ctx, p.ID); got.Status != domain.PaymentPending {
			t.Fatalf("approved=%v: the slip must stay PENDING, got %s", approved, got.Status)
		}
	}
}

// MEDIUM-03 B: a slip is uploaded, or approved, between Withdraw's checks and the delete.
func TestRace_WithdrawWhileSlipArrives(t *testing.T) {
	cases := map[string]func(f *raceFixture, t *testing.T, a *domain.Applicant){
		"slip uploaded": func(f *raceFixture, t *testing.T, a *domain.Applicant) { f.addSlip(t, a, "f1") },
		"slip approved": func(f *raceFixture, t *testing.T, a *domain.Applicant) {
			// A slip that was already PENDING would have stopped the early check, so this one
			// arrives and is approved in the window.
			p := f.addSlip(t, a, "f2")
			if err := f.pays.Verify(context.Background(), p.ID, true, 1, "ok", nil); err != nil {
				t.Fatal(err)
			}
		},
		"confirmed by staff": func(f *raceFixture, t *testing.T, a *domain.Applicant) {
			if err := f.apps.UpdateStatus(context.Background(), a.ID, domain.StatusConfirmed, nil, "paid cash", nil); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, meanwhile := range cases {
		t.Run(name, func(t *testing.T) {
			f := newRaceFixture(t)
			ctx := context.Background()
			appNo, a, nid := f.submit(t, 4100)
			f.race.beforeSoftDelete = func() { meanwhile(f, t, a) }
			if err := f.svc.Withdraw(ctx, appNo, nid, "เปลี่ยนใจ", "203.0.113.2"); !errors.Is(err, service.ErrCannotWithdraw) {
				t.Fatalf("want ErrCannotWithdraw, got %v", err)
			}
			if _, err := f.apps.GetByApplicationNo(ctx, appNo); err != nil {
				t.Fatalf("the application must survive: %v", err)
			}
		})
	}
}

// MEDIUM-03 C: admin 1 reads PASSED and sets CONFIRMED; meanwhile admin 2 sets REJECTED and the
// released seat is taken by a new registrant. Admin 1's change would take the seat back.
func TestRace_UpdateStatusAfterSeatReleased(t *testing.T) {
	ctx := context.Background()
	for _, full := range []bool{true, false} {
		f := newRaceFixture(t)
		appNo, a, _ := f.submit(t, 4200)
		settings, _ := f.sets.Get(ctx)
		cp := *settings
		cp.MaxCapacity = 2
		if err := f.sets.Update(ctx, &cp); err != nil {
			t.Fatal(err)
		}
		f.race.beforeUpdateStatus = func() {
			if err := f.apps.UpdateStatus(ctx, a.ID, domain.StatusRejected, nil, "admin 2", nil); err != nil {
				t.Fatal(err)
			}
			f.submit(t, 4201) // takes the released seat: 1 of 2 used
			if full {
				f.submit(t, 4202) // and the last one: 2 of 2
			}
		}
		admin := int64(1)
		_, err := f.svc.UpdateStatus(ctx, appNo, domain.StatusConfirmed, &admin, "paid", "203.0.113.3")
		got, _ := f.apps.GetByApplicationNo(ctx, appNo)
		if full {
			if !errors.Is(err, service.ErrQuotaExceeded) {
				t.Fatalf("camp full: want ErrQuotaExceeded, got %v", err)
			}
			if got.Status != domain.StatusRejected {
				t.Fatalf("camp full: the applicant must stay REJECTED, got %s", got.Status)
			}
			if n, _ := f.apps.CountActive(ctx); n != 2 {
				t.Fatalf("the quota must hold: %d active", n)
			}
			continue
		}
		if err != nil {
			t.Fatalf("a seat is free: the change must go through under the quota lock, got %v", err)
		}
		if got.Status != domain.StatusConfirmed {
			t.Fatalf("want CONFIRMED, got %s", got.Status)
		}
	}
}

// MEDIUM-04 case B with MEDIUM-03 A: staff delete an applicant whose slip is being settled. The
// verdict is refused with ErrSlipLocked, the slip stays PENDING with its hash, and the hash no
// longer blocks a new registration sending the same image.
func TestRace_AdminDeleteDuringVerifyKeepsSlipAndReleasesHash(t *testing.T) {
	f := newRaceFixture(t)
	ctx := context.Background()
	appNo, a, _ := f.submit(t, 4300)
	p := f.addSlip(t, a, "h1")
	admin := int64(9)
	f.rpays.beforeVerify = func() {
		if err := f.apps.SoftDelete(ctx, a.ID, &admin, "duplicate", nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.psvc.VerifySlip(ctx, appNo, p.ID.String(), true, 1, "ok", "203.0.113.4"); !errors.Is(err, service.ErrSlipLocked) {
		t.Fatalf("want ErrSlipLocked, got %v", err)
	}
	got, _ := f.pays.GetByID(ctx, p.ID)
	if got.Status != domain.PaymentPending || got.SlipHash == nil || *got.SlipHash != *p.SlipHash {
		t.Fatalf("the slip must stay PENDING with its hash, got %+v", got)
	}
	if dup, _ := f.pays.CheckDuplicateSlipHash(ctx, *p.SlipHash); dup {
		t.Fatal("the deleted applicant's slip must not hold its hash")
	}
	_, again, _ := f.submit(t, 4301)
	f.addSlip(t, again, "h1")
}
