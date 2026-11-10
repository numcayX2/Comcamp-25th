package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001–000003 applied.

func openTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if testDSN == "" {
		t.Skip("Skipping: TEST_DATABASE_DSN is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	pool, err := repository.NewPool(ctx, repository.DefaultPoolConfig(testDSN))
	if err != nil {
		t.Skipf("Skipping: PostgreSQL not available (%v)", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func newApplicant(i int, tag string) *domain.Applicant {
	return &domain.Applicant{
		ApplicationNo:    fmt.Sprintf("T%s%04d", tag, i),
		NationalID:       fmt.Sprintf("9%s%07d", tag, i),
		FirstName:        "ทดสอบ",
		Nickname:         "test",
		BirthDate:        time.Date(2008, 1, 1, 0, 0, 0, 0, time.UTC),
		Gender:           "unspecified",
		School:           "integration",
		Grade:            "ม.5",
		Phone:            fmt.Sprintf("0%s%04d", tag, i),
		Email:            "",
		Province:         "เชียงใหม่",
		EmergencyContact: "ผู้ปกครอง",
		EmergencyPhone:   "0800000000",
		ShirtSize:        "M",
		Status:           domain.StatusPending,
	}
}

func cleanupApplicants(t *testing.T, pool *pgxpool.Pool, tag string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE target_id LIKE $1`, "T"+tag+"%")
		_, _ = pool.Exec(ctx, `DELETE FROM applicants WHERE application_no LIKE $1`, "T"+tag+"%")
	})
}

// The advisory-lock transaction must hold the quota under a burst of concurrent inserts.
func TestPostgres_CreateWithinCapacityIsAtomic(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "471"
	cleanupApplicants(t, pool, tag)

	var existing int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM applicants WHERE status != 'REJECTED' AND deleted_at IS NULL`).Scan(&existing); err != nil {
		t.Fatal(err)
	}
	capacity := existing + 5

	var wg sync.WaitGroup
	var mu sync.Mutex
	created, full := 0, 0
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			err := repo.CreateWithinCapacity(ctx, newApplicant(i, tag), capacity)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				created++
			case errors.Is(err, domain.ErrCapacityReached):
				full++
			default:
				t.Errorf("unexpected error: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if created != 5 || full != 25 {
		t.Fatalf("expected 5 created / 25 full, got %d / %d", created, full)
	}
}

func TestPostgres_ConstraintErrorsAreMapped(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	payRepo := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag = "472"
	cleanupApplicants(t, pool, tag)

	key := uuid.New()
	a := newApplicant(1, tag)
	a.IdempotencyKey = &key
	if err := repo.Create(ctx, a); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := repo.GetByIdempotencyKey(ctx, key)
	if err != nil || got.ApplicationNo != a.ApplicationNo {
		t.Fatalf("GetByIdempotencyKey: %v %+v", err, got)
	}

	sameKey := newApplicant(2, tag)
	sameKey.IdempotencyKey = &key
	if err := repo.Create(ctx, sameKey); !errors.Is(err, domain.ErrDuplicateIdempotencyKey) {
		t.Errorf("same idempotency key: want ErrDuplicateIdempotencyKey, got %v", err)
	}

	dupID := newApplicant(3, tag)
	dupID.NationalID = a.NationalID
	if err := repo.Create(ctx, dupID); !errors.Is(err, domain.ErrDuplicateApplicant) {
		t.Errorf("same national ID: want ErrDuplicateApplicant, got %v", err)
	}

	// Two applicants without an email are allowed (000002 replaced the UNIQUE(email) constraint).
	if err := repo.Create(ctx, newApplicant(4, tag)); err != nil {
		t.Errorf("second applicant without email: %v", err)
	}

	if _, err := repo.GetByApplicationNo(ctx, "TNOPE"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("missing applicant: want ErrNotFound, got %v", err)
	}

	hash := fmt.Sprintf("%064x", time.Now().UnixNano())
	pay := func() error {
		return payRepo.Create(ctx, &domain.Payment{
			ApplicantID: a.ID, SlipURL: "slips/x.jpg", Amount: decimal.NewFromInt(1000),
			Status: domain.PaymentPending, SlipHash: &hash,
		})
	}
	if err := pay(); err != nil {
		t.Fatalf("first payment: %v", err)
	}
	if err := pay(); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Errorf("same slip hash: want ErrDuplicateSlipHash, got %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM payments WHERE slip_hash = $1`, hash) })
}

// Status change and slip verification write their audit row in the same transaction, and a slip
// can only be verified once.
func TestPostgres_AuditAndSingleVerification(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	payRepo := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag = "473"
	cleanupApplicants(t, pool, tag)

	var adminID int64
	err := pool.QueryRow(ctx, `INSERT INTO admins (username, password_hash, full_name) VALUES ($1, 'x', 'it') RETURNING id`,
		"it-"+uuid.NewString()[:8]).Scan(&adminID)
	if err != nil {
		t.Fatal(err)
	}

	a := newApplicant(1, tag)
	if err := repo.Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	audit := func(action domain.AuditAction) *domain.AuditEntry {
		return &domain.AuditEntry{AdminID: &adminID, Action: action, TargetType: domain.AuditTargetApplicant,
			TargetID: a.ApplicationNo, Details: map[string]any{"k": "v"}, IPAddress: "203.0.113.7"}
	}

	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusPassed, &adminID, "ok", audit(domain.AuditStatusUpdate)); err != nil {
		t.Fatalf("update status: %v", err)
	}

	hash := fmt.Sprintf("%064x", time.Now().UnixNano()+1)
	p := &domain.Payment{ApplicantID: a.ID, SlipURL: "slips/y.jpg", Amount: decimal.NewFromInt(1000),
		Status: domain.PaymentPending, SlipHash: &hash}
	if err := payRepo.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := payRepo.Verify(ctx, p.ID, true, adminID, "ok", audit(domain.AuditSlipVerify)); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if err := payRepo.Verify(ctx, p.ID, true, adminID, "again", audit(domain.AuditSlipVerify)); !errors.Is(err, domain.ErrPaymentAlreadyVerified) {
		t.Fatalf("second verify: want ErrPaymentAlreadyVerified, got %v", err)
	}

	got, _ := repo.GetByID(ctx, a.ID)
	if got.Status != domain.StatusConfirmed {
		t.Errorf("expected CONFIRMED, got %s", got.Status)
	}

	var n int
	var oldStatus string
	err = pool.QueryRow(ctx, `
		SELECT count(*), max(details->>'oldStatus') FILTER (WHERE action = 'payment.slip.verify')
		FROM audit_logs WHERE target_id = $1 AND admin_id = $2 AND ip_address = '203.0.113.7'`,
		a.ApplicationNo, adminID).Scan(&n, &oldStatus)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || oldStatus != "PASSED" {
		t.Errorf("expected 2 audit rows with oldStatus PASSED on verify, got %d rows, oldStatus %q", n, oldStatus)
	}

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM payments WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM applicant_status_logs WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM audit_logs WHERE admin_id = $1`, adminID)
		_, _ = pool.Exec(bg, `DELETE FROM applicants WHERE id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM admins WHERE id = $1`, adminID)
	})
}

// AGENTS.md §13.7: several staff settling the same PENDING slip at once — exactly one wins, the
// rest get ErrPaymentAlreadyVerified, and only one audit row is written.
func TestPostgres_ConcurrentVerifyOnlyOneWins(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	payRepo := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag = "474"
	cleanupApplicants(t, pool, tag)

	var adminID int64
	if err := pool.QueryRow(ctx, `INSERT INTO admins (username, password_hash, full_name) VALUES ($1, 'x', 'it') RETURNING id`,
		"it-"+uuid.NewString()[:8]).Scan(&adminID); err != nil {
		t.Fatal(err)
	}
	a := newApplicant(1, tag)
	a.Status = domain.StatusPassed
	if err := repo.Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%064x", time.Now().UnixNano()+2)
	p := &domain.Payment{ApplicantID: a.ID, SlipURL: "slips/z.jpg", Amount: decimal.NewFromInt(1000),
		Status: domain.PaymentPending, SlipHash: &hash}
	if err := payRepo.Create(ctx, p); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM payments WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM applicant_status_logs WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM audit_logs WHERE admin_id = $1`, adminID)
		_, _ = pool.Exec(bg, `DELETE FROM applicants WHERE id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM admins WHERE id = $1`, adminID)
	})

	const staff = 8
	var wg sync.WaitGroup
	errs := make(chan error, staff)
	for i := 0; i < staff; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			entry := &domain.AuditEntry{AdminID: &adminID, Action: domain.AuditSlipVerify, TargetType: domain.AuditTargetApplicant,
				TargetID: a.ApplicationNo, Details: map[string]any{"attempt": i}, IPAddress: "203.0.113.8"}
			errs <- payRepo.Verify(ctx, p.ID, i%2 == 0, adminID, fmt.Sprintf("staff %d", i), entry)
		}(i)
	}
	wg.Wait()
	close(errs)

	wins := 0
	for err := range errs {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, domain.ErrPaymentAlreadyVerified):
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("expected exactly 1 successful verification, got %d", wins)
	}
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE target_id = $1 AND action = 'payment.slip.verify'`,
		a.ApplicationNo).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits != 1 {
		t.Errorf("expected 1 verify audit row, got %d", audits)
	}
}

// AGENTS.md §13.7: while another transaction holds the quota lock, a submission gives up after
// lock_timeout (3s) with ErrLockTimeout instead of waiting until the HTTP timeout.
func TestPostgres_QuotaLockTimesOut(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "475"
	cleanupApplicants(t, pool, tag)

	holder, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err := holder.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, postgres.QuotaLockKey); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	err = repo.CreateWithinCapacity(ctx, newApplicant(1, tag), 30)
	elapsed := time.Since(start)
	if !errors.Is(err, domain.ErrLockTimeout) {
		t.Fatalf("expected ErrLockTimeout, got %v", err)
	}
	if elapsed < 2500*time.Millisecond || elapsed > 8*time.Second {
		t.Errorf("expected to give up after ~3s, took %s", elapsed)
	}

	// Once the lock is released the same submission goes through.
	_ = holder.Rollback(ctx)
	if err := repo.CreateWithinCapacity(ctx, newApplicant(2, tag), 30); err != nil {
		t.Fatalf("after lock release: %v", err)
	}
}
