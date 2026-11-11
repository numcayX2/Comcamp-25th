package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001–000006 applied.

func statusOf(t *testing.T, repo *postgres.ApplicantPostgresRepo, a *domain.Applicant) domain.ApplicationStatus {
	t.Helper()
	got, err := repo.GetByID(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	return got.Status
}

// Migration 000004: new default, new statuses accepted, anything else still refused, and the
// quota count ignores REJECTED, REFUND_PENDING and REFUNDED.
func TestPostgres_RefundStatusesAndQuotaCount(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "481"
	cleanupApplicants(t, pool, tag)

	var def string
	if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns WHERE table_name = 'applicants' AND column_name = 'status'`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	if def != "'PASSED'::character varying" {
		t.Fatalf("applicants.status default should be PASSED, got %s", def)
	}

	base, err := repo.CountActive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var all []*domain.Applicant
	for i := 1; i <= 4; i++ {
		a := newApplicant(i, tag)
		a.Status = domain.StatusPassed
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
		all = append(all, a)
	}
	if n, _ := repo.CountActive(ctx); n != base+4 {
		t.Fatalf("4 PASSED applicants should count 4, got %d", n-base)
	}

	// Each non-counting status releases its seat immediately, and the row stays.
	for i, st := range []domain.ApplicationStatus{domain.StatusRejected, domain.StatusRefundPending, domain.StatusRefunded} {
		if err := repo.UpdateStatus(ctx, all[i].ID, st, nil, "t", nil); err != nil {
			t.Fatalf("UpdateStatus %s: %v", st, err)
		}
		if n, _ := repo.CountActive(ctx); n != base+4-(i+1) {
			t.Fatalf("after %s the count should be %d, got %d", st, 4-(i+1), n-base)
		}
	}
	if got, _ := repo.ListAll(ctx, ptr(domain.StatusRefundPending)); len(got) == 0 {
		t.Fatal("a REFUND_PENDING row must stay listed for staff")
	}

	// The CHECK constraint still refuses anything that is not a status.
	if _, err := pool.Exec(ctx, `UPDATE applicants SET status = 'BOGUS' WHERE id = $1`, all[3].ID); err == nil {
		t.Fatal("an unknown status must violate applicants_status_check")
	}
}

func ptr[T any](v T) *T { return &v }

// Taking a seat back is checked under the quota lock: refused when full, and two concurrent
// restores for one free seat produce exactly one winner.
func TestPostgres_UpdateStatusWithinCapacity(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "482"
	cleanupApplicants(t, pool, tag)

	base, _ := repo.CountActive(ctx)
	capacity := base + 1 // exactly one free seat

	mk := func(i int, st domain.ApplicationStatus) *domain.Applicant {
		a := newApplicant(i, tag)
		a.Status = st
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	a := mk(1, domain.StatusRefunded)
	b := mk(2, domain.StatusRefundPending)
	c := mk(3, domain.StatusRejected)

	// One free seat and one candidate: allowed.
	if err := repo.UpdateStatusWithinCapacity(ctx, a.ID, domain.StatusPassed, nil, "t", nil, capacity); err != nil {
		t.Fatalf("restore into a free seat: %v", err)
	}
	// Now full: everyone else is refused and keeps their status.
	for _, x := range []*domain.Applicant{b, c} {
		err := repo.UpdateStatusWithinCapacity(ctx, x.ID, domain.StatusPassed, nil, "t", nil, capacity)
		if !errors.Is(err, domain.ErrCapacityReached) {
			t.Fatalf("restore into a full camp: want ErrCapacityReached, got %v", err)
		}
	}
	if statusOf(t, repo, b) != domain.StatusRefundPending || statusOf(t, repo, c) != domain.StatusRejected {
		t.Fatal("a refused restore must not change the status")
	}
	// Active -> active and non-counting -> non-counting never need a seat; capacity <= 0 is unlimited.
	if err := repo.UpdateStatusWithinCapacity(ctx, a.ID, domain.StatusConfirmed, nil, "t", nil, capacity); err != nil {
		t.Fatalf("active to active at full capacity: %v", err)
	}
	if err := repo.UpdateStatusWithinCapacity(ctx, b.ID, domain.StatusRefunded, nil, "t", nil, capacity); err != nil {
		t.Fatalf("non-counting to non-counting at full capacity: %v", err)
	}
	if err := repo.UpdateStatusWithinCapacity(ctx, c.ID, domain.StatusPassed, nil, "t", nil, 0); err != nil {
		t.Fatalf("unlimited capacity: %v", err)
	}

	// Free exactly one seat again, then race two restores for it.
	if err := repo.UpdateStatus(ctx, c.ID, domain.StatusRefunded, nil, "t", nil); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]error, 2)
	for i, x := range []*domain.Applicant{b, c} {
		wg.Add(1)
		go func(i int, x *domain.Applicant) {
			defer wg.Done()
			results[i] = repo.UpdateStatusWithinCapacity(ctx, x.ID, domain.StatusPassed, nil, "t", nil, capacity)
		}(i, x)
	}
	wg.Wait()
	wins, full := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, domain.ErrCapacityReached):
			full++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	// a is CONFIRMED (1 seat); capacity = base+1, so no seat is left for either: both refused.
	if wins != 0 || full != 2 {
		t.Fatalf("with the camp full both restores must be refused, got %v", results)
	}
	// Release a, and now exactly one of the two can win the seat.
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusRefunded, nil, "t", nil); err != nil {
		t.Fatal(err)
	}
	results = make([]error, 2)
	for i, x := range []*domain.Applicant{b, c} {
		wg.Add(1)
		go func(i int, x *domain.Applicant) {
			defer wg.Done()
			results[i] = repo.UpdateStatusWithinCapacity(ctx, x.ID, domain.StatusPassed, nil, "t", nil, capacity)
		}(i, x)
	}
	wg.Wait()
	wins, full = 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, domain.ErrCapacityReached):
			full++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if wins != 1 || full != 1 {
		t.Fatalf("two restores for one seat: want 1 winner and 1 refusal, got %v", results)
	}
	if n, _ := repo.CountActive(ctx); n != capacity {
		t.Fatalf("the camp must hold exactly its quota (%d), got %d", capacity, n)
	}
}

func profileOfRow(a *domain.Applicant) domain.ProfileFields {
	return domain.ProfileFields{
		FirstName: a.FirstName, LastName: a.LastName, Nickname: a.Nickname, NationalID: a.NationalID,
		Phone: a.Phone, Email: a.Email, School: a.School, Province: a.Province, Grade: a.Grade,
		ShirtSize: a.ShirtSize, Motivation: a.Motivation,
	}
}

func TestPostgres_UpdateProfile(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "483"
	cleanupApplicants(t, pool, tag)

	a := newApplicant(1, tag)
	a.Status = domain.StatusPassed
	a.Email = "it-a-" + tag + "@example.com"
	a.EmergencyPhone = a.Phone // the registration form copies the phone here
	b := newApplicant(2, tag)
	b.Status = domain.StatusPassed
	b.Email = "it-b-" + tag + "@example.com"
	for _, x := range []*domain.Applicant{a, b} {
		if err := repo.Create(ctx, x); err != nil {
			t.Fatal(err)
		}
	}
	audit := func(action domain.AuditAction) *domain.AuditEntry {
		return &domain.AuditEntry{Action: action, TargetType: domain.AuditTargetApplicant, TargetID: a.ApplicationNo,
			Details: map[string]any{"changes": map[string]string{"k": "v"}}, IPAddress: "203.0.113.9"}
	}

	// A normal edit: columns, updated_at and the audit row land together.
	p := profileOfRow(a)
	p.Nickname, p.School, p.Grade, p.ShirtSize = "ใหม่", "โรงเรียนใหม่", "ปวส.1", "XL"
	newPhone := "0" + tag + "9999"
	p.Phone = newPhone
	time.Sleep(10 * time.Millisecond)
	if err := repo.UpdateProfile(ctx, a.ID, p, true, audit(domain.AuditProfileUpdateSelf)); err != nil {
		t.Fatalf("update profile: %v", err)
	}
	got, _ := repo.GetByID(ctx, a.ID)
	if got.Nickname != "ใหม่" || got.School != "โรงเรียนใหม่" || got.Grade != "ปวส.1" || got.ShirtSize != "XL" || got.Phone != newPhone {
		t.Fatalf("columns not saved: %+v", got)
	}
	if got.EmergencyPhone != newPhone {
		t.Fatalf("emergency_phone mirrored the old phone and must follow it, got %s", got.EmergencyPhone)
	}
	if !got.UpdatedAt.After(a.UpdatedAt) {
		t.Fatalf("updated_at must move: %v -> %v", a.UpdatedAt, got.UpdatedAt)
	}
	var rows int
	var status, ip string
	if err := pool.QueryRow(ctx, `SELECT count(*), max(details->>'status'), max(ip_address) FROM audit_logs WHERE target_id = $1 AND action = 'application.profile.update.self' AND admin_id IS NULL`,
		a.ApplicationNo).Scan(&rows, &status, &ip); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || status != "PASSED" || ip != "203.0.113.9" {
		t.Fatalf("expected one audit row with no admin, got rows=%d status=%q ip=%q", rows, status, ip)
	}

	// An emergency phone that was changed separately is left alone.
	if _, err := pool.Exec(ctx, `UPDATE applicants SET emergency_phone = '0899999999' WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	p.Phone = "0" + tag + "8888"
	if err := repo.UpdateProfile(ctx, a.ID, p, false, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.GetByID(ctx, a.ID); got.EmergencyPhone != "0899999999" {
		t.Fatalf("a separate emergency phone must not be overwritten, got %s", got.EmergencyPhone)
	}

	// Collisions with another live applicant map to ErrDuplicateApplicant and change nothing.
	before, _ := repo.GetByID(ctx, a.ID)
	for name, mutate := range map[string]func(*domain.ProfileFields){
		"national id": func(f *domain.ProfileFields) { f.NationalID = b.NationalID },
		"phone":       func(f *domain.ProfileFields) { f.Phone = b.Phone },
		"email":       func(f *domain.ProfileFields) { f.Email = b.Email },
	} {
		dup := profileOfRow(before)
		mutate(&dup)
		if err := repo.UpdateProfile(ctx, a.ID, dup, false, nil); !errors.Is(err, domain.ErrDuplicateApplicant) {
			t.Fatalf("%s collision: want ErrDuplicateApplicant, got %v", name, err)
		}
	}
	if after, _ := repo.GetByID(ctx, a.ID); after.NationalID != before.NationalID || after.Phone != before.Phone || after.Email != before.Email {
		t.Fatal("a refused edit must not change the row")
	}
	// Keeping its own identifiers is not a collision.
	if err := repo.UpdateProfile(ctx, a.ID, profileOfRow(before), false, nil); err != nil {
		t.Fatalf("saving unchanged identifiers: %v", err)
	}

	// A deleted applicant releases their identifiers (migration 000003 partial indexes).
	if err := repo.SoftDelete(ctx, b.ID, nil, "t", nil); err != nil {
		t.Fatal(err)
	}
	take := profileOfRow(before)
	take.NationalID, take.Phone, take.Email = b.NationalID, b.Phone, b.Email
	if err := repo.UpdateProfile(ctx, a.ID, take, false, nil); err != nil {
		t.Fatalf("taking a deleted applicant's identifiers: %v", err)
	}

	// requireActive: refused under the row lock once the application has left the camp.
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusRefundPending, nil, "t", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateProfile(ctx, a.ID, profileOfRow(before), true, nil); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("self edit of a REFUND_PENDING row: want ErrStateConflict, got %v", err)
	}
	if err := repo.UpdateProfile(ctx, a.ID, profileOfRow(before), false, nil); err != nil {
		t.Fatalf("staff edit of a REFUND_PENDING row must work: %v", err)
	}
	// Unknown / deleted rows.
	if err := repo.UpdateProfile(ctx, b.ID, profileOfRow(before), false, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("editing a deleted row: want ErrNotFound, got %v", err)
	}
}

// A slip of a refunded or rejected application can no longer be settled.
func TestPostgres_VerifyRefusedForInactiveApplicant(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	payRepo := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag = "484"
	cleanupApplicants(t, pool, tag)
	t.Cleanup(func() { // runs before the applicant cleanup: payments reference applicants
		_, _ = pool.Exec(context.Background(), `DELETE FROM payments WHERE applicant_id IN (SELECT id FROM applicants WHERE application_no LIKE $1)`, "T"+tag+"%")
	})

	var adminID int64
	if err := pool.QueryRow(ctx, `INSERT INTO admins (username, password_hash, full_name) VALUES ($1, 'x', 'it') RETURNING id`, "it-"+tag+fmt.Sprint(time.Now().UnixNano()%100000)).Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { deleteAdmin(pool, adminID) })

	for i, st := range []domain.ApplicationStatus{domain.StatusRefundPending, domain.StatusRefunded, domain.StatusRejected} {
		a := newApplicant(i+1, tag)
		a.Status = domain.StatusPassed
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
		hash := fmt.Sprintf("%064x", time.Now().UnixNano()+int64(i)+10)
		p := &domain.Payment{ApplicantID: a.ID, SlipURL: "slips/r.jpg", Amount: decimal.NewFromInt(1000), Status: domain.PaymentPending, SlipHash: &hash}
		if err := payRepo.Create(ctx, p); err != nil {
			t.Fatal(err)
		}
		if err := repo.UpdateStatus(ctx, a.ID, st, nil, "t", nil); err != nil {
			t.Fatal(err)
		}
		for _, approved := range []bool{true, false} {
			if err := payRepo.Verify(ctx, p.ID, approved, adminID, "n", nil); !errors.Is(err, domain.ErrStateConflict) {
				t.Fatalf("%s approved=%v: want ErrStateConflict, got %v", st, approved, err)
			}
		}
		got, _ := payRepo.GetByID(ctx, p.ID)
		if got.Status != domain.PaymentPending {
			t.Fatalf("%s: the slip must stay PENDING, got %s", st, got.Status)
		}
		if statusOf(t, repo, a) != st {
			t.Fatalf("%s: the applicant status must not change", st)
		}
	}
}

func deleteAdmin(pool *pgxpool.Pool, id int64) {
	bg := context.Background()
	_, _ = pool.Exec(bg, `DELETE FROM audit_logs WHERE admin_id = $1`, id)
	_, _ = pool.Exec(bg, `DELETE FROM admins WHERE id = $1`, id)
}
