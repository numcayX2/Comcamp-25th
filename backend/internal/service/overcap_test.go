package service_test

import (
	"context"
	"errors"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

func TestApplicantService_OverCapacityRestore(t *testing.T) {
	ctx := context.Background()
	f := newRaceFixture(t)
	settingSvc := service.NewSettingService(f.sets, f.apps, f.apps.Audit())
	f.svc.WithOnSeatChange(settingSvc.InvalidatePublicCache)

	settings, err := f.sets.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cp := *settings
	cp.MaxCapacity = 2
	if err := f.sets.Update(ctx, &cp); err != nil {
		t.Fatal(err)
	}

	appNo1, _ := f.submit(t, 6001)
	_, _ = f.submit(t, 6002)

	admin := int64(1)
	if _, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusForfeited, &admin, "unpaid", "203.0.113.10"); err != nil {
		t.Fatalf("set FORFEITED: %v", err)
	}
	_, _ = f.submit(t, 6003) // camp full (2/2)

	// Without OverCapacity -> ErrQuotaExceeded.
	if _, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusPassed, &admin, "restore", "203.0.113.10"); !errors.Is(err, service.ErrQuotaExceeded) {
		t.Fatalf("without flag: want ErrQuotaExceeded, got %v", err)
	}

	// With OverCapacity and empty reason -> ValidationError.
	var ve *service.ValidationError
	if _, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusPassed, &admin, "   ", "203.0.113.10", service.UpdateStatusOptions{OverCapacity: true}); !errors.Is(err, service.ErrOverCapacityReasonRequired) || !errors.As(err, &ve) {
		t.Fatalf("empty reason: want ErrOverCapacityReasonRequired (ValidationError), got %v", err)
	}

	// With OverCapacity and reason -> succeeds, count = 3, new submit rejected.
	res, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusPassed, &admin, "approved exception", "203.0.113.10", service.UpdateStatusOptions{OverCapacity: true})
	if err != nil {
		t.Fatalf("over-capacity restore: %v", err)
	}
	if res.Status != domain.StatusPassed {
		t.Fatalf("want PASSED, got %s", res.Status)
	}

	pub, err := settingSvc.GetPublicSettings(ctx)
	if err != nil {
		t.Fatalf("GetPublicSettings: %v", err)
	}
	if pub.CurrentCount != 3 || pub.MaxCapacity != 2 {
		t.Fatalf("expected CurrentCount=3 MaxCapacity=2, got %+v", pub)
	}

	if _, err := f.svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName: "สมหญิง ทดสอบ", Nickname: "หญิง", Phone: testPhone(6004), Email: "r6004@example.com",
		School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "M",
	}); !errors.Is(err, service.ErrQuotaExceeded) {
		t.Fatalf("submit while over capacity: want ErrQuotaExceeded, got %v", err)
	}

	// When seats are free, OverCapacity=true behaves like a normal restore with no overCapacity audit detail.
	cp.MaxCapacity = 5
	if err := f.sets.Update(ctx, &cp); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusForfeited, &admin, "unpaid again", "203.0.113.10"); err != nil {
		t.Fatalf("re-forfeit: %v", err)
	}
	if _, err := f.svc.UpdateStatus(ctx, appNo1, domain.StatusPassed, &admin, "seat free", "203.0.113.10", service.UpdateStatusOptions{OverCapacity: true}); err != nil {
		t.Fatalf("restore with free seats: %v", err)
	}
	entries := f.apps.Audit().Entries()
	last := entries[len(entries)-1]
	if _, exists := last.Details["overCapacity"]; exists {
		t.Fatalf("restore with free seats must not set overCapacity in audit: %+v", last.Details)
	}
}

func TestRace_UpdateStatusAfterSeatReleased_WithOverCapacity(t *testing.T) {
	ctx := context.Background()
	admin := int64(1)

	t.Run("with reason proceeds over capacity and audits", func(t *testing.T) {
		f := newRaceFixture(t)
		appNo, a := f.submit(t, 6100)
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
			f.submit(t, 6101)
			f.submit(t, 6102)
		}

		res, err := f.svc.UpdateStatus(ctx, appNo, domain.StatusConfirmed, &admin, "paid cash", "203.0.113.11", service.UpdateStatusOptions{OverCapacity: true})
		if err != nil {
			t.Fatalf("expected over-capacity restore after race to succeed, got %v", err)
		}
		if res.Status != domain.StatusConfirmed {
			t.Fatalf("want CONFIRMED, got %s", res.Status)
		}
		if n, _ := f.apps.CountActive(ctx); n != 3 {
			t.Fatalf("want 3 active seats, got %d", n)
		}
		entries := f.apps.Audit().Entries()
		last := entries[len(entries)-1]
		if last.Action != domain.AuditStatusUpdate || last.Details["overCapacity"] != true || last.Details["currentCount"] != 3 || last.Details["maxCapacity"] != 2 {
			t.Fatalf("unexpected audit row after race restore: %+v", last)
		}
	})

	t.Run("with empty reason refuses when race turns change into seat retake", func(t *testing.T) {
		f := newRaceFixture(t)
		appNo, a := f.submit(t, 6200)
		f.race.beforeUpdateStatus = func() {
			if err := f.apps.UpdateStatus(ctx, a.ID, domain.StatusRejected, nil, "admin 2", nil); err != nil {
				t.Fatal(err)
			}
		}

		_, err := f.svc.UpdateStatus(ctx, appNo, domain.StatusConfirmed, &admin, "", "203.0.113.12", service.UpdateStatusOptions{OverCapacity: true})
		if !errors.Is(err, service.ErrOverCapacityReasonRequired) {
			t.Fatalf("want ErrOverCapacityReasonRequired, got %v", err)
		}
		got, _ := f.apps.GetByApplicationNo(ctx, appNo)
		if got.Status != domain.StatusRejected {
			t.Fatalf("refused race restore must keep REJECTED, got %s", got.Status)
		}
	})
}
