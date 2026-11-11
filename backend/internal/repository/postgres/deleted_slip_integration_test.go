package postgres_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001-000006 applied.

func applicantDeletedFlags(t *testing.T, pool *pgxpool.Pool, applicantID any) []bool {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT applicant_deleted FROM payments WHERE applicant_id = $1 ORDER BY id`, applicantID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []bool
	for rows.Next() {
		var b bool
		if err := rows.Scan(&b); err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

func TestPostgres_AdminDeleteReleasesSlipHashKeepsLedger(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "521", "c1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)
	hp, ha := hashOf(ht, 1), hashOf(ht, 2)

	pa := seedApplicant(t, pool, repo, 1, tag)
	pending := slipFor(pa.ID, hp)
	if _, err := pay.CreateReplacingPending(ctx, pending); err != nil {
		t.Fatal(err)
	}
	aa := seedApplicant(t, pool, repo, 2, tag)
	approved := slipFor(aa.ID, ha)
	if _, err := pay.CreateReplacingPending(ctx, approved); err != nil {
		t.Fatal(err)
	}
	if err := pay.Verify(ctx, approved.ID, true, admin.ID, "ok", nil); err != nil {
		t.Fatal(err)
	}
	for _, a := range []*domain.Applicant{pa, aa} {
		if err := repo.SoftDelete(ctx, a.ID, &admin.ID, "duplicate", nil); err != nil {
			t.Fatal(err)
		}
		if flags := applicantDeletedFlags(t, pool, a.ID); len(flags) != 1 || !flags[0] {
			t.Fatalf("the deleted applicant's payment must be flagged, got %v", flags)
		}
	}
	for _, p := range []*domain.Payment{pending, approved} {
		got, err := pay.GetByID(ctx, p.ID)
		if err != nil || got.SlipHash == nil || *got.SlipHash != *p.SlipHash {
			t.Fatalf("status and hash stay in the ledger, got %+v (%v)", got, err)
		}
		if dup, _ := pay.CheckDuplicateSlipHash(ctx, *p.SlipHash); dup {
			t.Fatalf("hash %s of a deleted application must not count as a duplicate", (*p.SlipHash)[:4])
		}
	}
	if got := payStatuses(t, pool, pa.ID); got[domain.PaymentPending] != 1 {
		t.Fatalf("the deleted applicant's slip stays PENDING, got %v", got)
	}
	if got := payStatuses(t, pool, aa.ID); got[domain.PaymentApproved] != 1 {
		t.Fatalf("the deleted applicant's slip stays APPROVED, got %v", got)
	}
	if err := pay.Verify(ctx, pending.ID, true, admin.ID, "ok", nil); !errors.Is(err, domain.ErrStateConflict) {
		t.Fatalf("Verify on a deleted applicant must stay a state conflict, got %v", err)
	}

	// Registering again and sending the same slips: the unique index lets them through.
	again := seedApplicant(t, pool, repo, 3, tag)
	if _, err := pay.CreateReplacingPending(ctx, slipFor(again.ID, hp)); err != nil {
		t.Fatalf("same image as a deleted PENDING slip: %v", err)
	}
	other := seedApplicant(t, pool, repo, 4, tag)
	if _, err := pay.CreateReplacingPending(ctx, slipFor(other.ID, ha)); err != nil {
		t.Fatalf("same image as a deleted APPROVED slip: %v", err)
	}
	if _, err := pay.CreateReplacingPending(ctx, slipFor(other.ID, hp)); !errors.Is(err, domain.ErrDuplicateSlipHash) {
		t.Fatalf("the live re-sent slip holds the hash again, got %v", err)
	}

	// A withdrawal flags its (rejected) slips too, so the flag always matches deleted_at.
	wa := seedApplicant(t, pool, repo, 5, tag)
	wp := slipFor(wa.ID, hashOf(ht, 5))
	if _, err := pay.CreateReplacingPending(ctx, wp); err != nil {
		t.Fatal(err)
	}
	if err := pay.Verify(ctx, wp.ID, false, admin.ID, "no", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.SoftDelete(ctx, wa.ID, nil, "เปลี่ยนใจ", nil); err != nil {
		t.Fatal(err)
	}
	if flags := applicantDeletedFlags(t, pool, wa.ID); len(flags) != 1 || !flags[0] {
		t.Fatalf("a withdrawn applicant's payment must be flagged, got %v", flags)
	}
}

// Staff delete an applicant while another admin settles its PENDING slip. Verify locks the payment
// row then the applicant row; SoftDelete locks the payment rows first too. No deadlock, and every
// round ends in one of two consistent states.
func TestPostgres_AdminDeleteRacesWithVerify(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "522", "c2"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	wins := map[string]int{}
	for round := 0; round < 40; round++ {
		a := seedApplicant(t, pool, repo, round, tag)
		p := slipFor(a.ID, hashOf(ht, round))
		if _, err := pay.CreateReplacingPending(ctx, p); err != nil {
			t.Fatal(err)
		}
		approve := round%2 == 0
		var wg sync.WaitGroup
		var dErr, vErr error
		wg.Add(2)
		go func() { defer wg.Done(); dErr = repo.SoftDelete(ctx, a.ID, &admin.ID, "duplicate", nil) }()
		go func() {
			defer wg.Done()
			// A little jitter so both orders occur (the delete does more work before its first lock).
			time.Sleep(time.Duration(round%5) * time.Millisecond)
			vErr = pay.Verify(ctx, p.ID, approve, admin.ID, "x", nil)
		}()
		wg.Wait()
		if dErr != nil {
			t.Fatalf("round %d: the staff delete must always succeed (a deadlock would show here), got %v", round, dErr)
		}

		var appStatus domain.ApplicationStatus
		if err := pool.QueryRow(ctx, `SELECT status FROM applicants WHERE id = $1 AND deleted_at IS NOT NULL`, a.ID).Scan(&appStatus); err != nil {
			t.Fatalf("round %d: the applicant must be deleted: %v", round, err)
		}
		got := payStatuses(t, pool, a.ID)
		switch {
		case vErr == nil: // Verify first, then the delete
			wins["verify"]++
			wantPay, wantApp := domain.PaymentRejected, domain.StatusPassed
			if approve {
				wantPay, wantApp = domain.PaymentApproved, domain.StatusConfirmed
			}
			if got[wantPay] != 1 || len(got) != 1 || appStatus != wantApp {
				t.Fatalf("round %d: verify won, want %s/%s, got %v/%s", round, wantPay, wantApp, got, appStatus)
			}
		case errors.Is(vErr, domain.ErrStateConflict): // the delete first
			wins["delete"]++
			if got[domain.PaymentPending] != 1 || len(got) != 1 || appStatus != domain.StatusPassed {
				t.Fatalf("round %d: delete won, want an untouched PENDING slip, got %v/%s", round, got, appStatus)
			}
		default:
			t.Fatalf("round %d: unexpected verify error (deadlock?): %v", round, vErr)
		}
		if flags := applicantDeletedFlags(t, pool, a.ID); len(flags) != 1 || !flags[0] {
			t.Fatalf("round %d: the payment must be flagged, got %v", round, flags)
		}
		if dup, _ := pay.CheckDuplicateSlipHash(ctx, *p.SlipHash); dup {
			t.Fatalf("round %d: the deleted applicant's hash must be released", round)
		}
	}
	t.Logf("winners over 40 rounds: %v", wins)
}

// Migration 000006 down -> up on a schema of its own, with a deleted applicant's slip sharing its
// hash with a live applicant's slip and with another deleted slip.
func TestPostgres_Migration000006RoundTrip(t *testing.T) {
	pool := openTestPool(t)
	ctx := context.Background()
	pc, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	conn := pc.Hijack() // search_path changes below must never go back into the pool
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	schema := "mig_rt_" + hex.EncodeToString(suffix)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
	}
	exec(`CREATE SCHEMA ` + schema)
	t.Cleanup(func() { _, _ = conn.Exec(context.Background(), `DROP SCHEMA `+schema+` CASCADE`) })
	exec(`SET search_path TO ` + schema + `, public`)

	dir := filepath.Join("..", "..", "..", "migrations")
	files, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil || len(files) < 6 {
		t.Fatalf("migrations not found in %s: %v", dir, err)
	}
	sort.Strings(files)
	run := func(path string) {
		t.Helper()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, string(b), pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("%s: %v", filepath.Base(path), err)
		}
	}
	for _, f := range files {
		run(f)
	}

	addApplicant := func(id, no, nid, phone string, deleted bool) {
		exec(`INSERT INTO applicants (id, application_no, national_id, prefix, first_name, last_name, nickname, birth_date,
			gender, school, grade, phone, email, province, emergency_contact, emergency_phone, shirt_size, status, deleted_at)
			VALUES ($1, $2, $3, '-', 'a', 'b', 'a', '2008-01-01', 'unspecified', 's', 'ม.5', $4, '', 'p', 'x', $4, 'M', 'PASSED',
			CASE WHEN $5::bool THEN now() END)`, id, no, nid, phone, deleted)
	}
	live, dead1, dead2 := "11111111-0000-0000-0000-000000000001", "11111111-0000-0000-0000-000000000002", "11111111-0000-0000-0000-000000000003"
	addApplicant(live, "CC25-RTLIVE", "1509900000001", "0800000001", false)
	addApplicant(dead1, "CC25-RTDEL1", "1509900000002", "0800000002", true)
	addApplicant(dead2, "CC25-RTDEL2", "1509900000003", "0800000003", true)

	h := func(c string) string { return strings.Repeat(c, 64) }
	addPay := func(id, applicant, status, hash, age string, deleted bool) {
		exec(`INSERT INTO payments (id, applicant_id, slip_url, amount, status, slip_hash, uploaded_at, applicant_deleted)
			VALUES ($1, $2, 'x', 1000, $3, $4, now() - $5::interval, $6)`, id, applicant, status, hash, age, deleted)
	}
	addPay("00000000-0000-0000-0000-00000000000a", dead1, "PENDING", h("a"), "3 hours", true) // collides with the live slip below
	addPay("00000000-0000-0000-0000-00000000000b", live, "PENDING", h("a"), "1 hour", false)
	addPay("00000000-0000-0000-0000-00000000000c", dead1, "APPROVED", h("b"), "2 hours", true) // older of two deleted
	addPay("00000000-0000-0000-0000-00000000000d", dead2, "PENDING", h("b"), "1 hour", true)   // newer: keeps its hash
	addPay("00000000-0000-0000-0000-00000000000e", dead2, "REJECTED", h("a"), "5 hours", true) // REJECTED: never touched
	addPay("00000000-0000-0000-0000-00000000000f", dead2, "APPROVED", h("f"), "4 hours", true) // no collision: kept

	// 000006 is in force: a second live slip with the live hash is still refused.
	if _, err := conn.Exec(ctx, `INSERT INTO payments (applicant_id, slip_url, amount, status, slip_hash) VALUES ($1, 'x', 1000, 'PENDING', $2)`, live, h("a")); err == nil {
		t.Fatal("two live slips with one hash must be refused under 000006")
	}

	hashes := func() map[string]string {
		t.Helper()
		rows, err := conn.Query(ctx, `SELECT right(id::text, 1), coalesce(left(slip_hash, 1), '-') FROM payments`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var k, v string
			if err := rows.Scan(&k, &v); err != nil {
				t.Fatal(err)
			}
			out[k] = v
		}
		return out
	}
	indexDef := func() string {
		t.Helper()
		var def string
		if err := conn.QueryRow(ctx, `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'uq_payments_slip_hash'`, schema).Scan(&def); err != nil {
			t.Fatal(err)
		}
		return def
	}
	hasFlag := func() bool {
		t.Helper()
		var n int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'payments' AND column_name = 'applicant_deleted'`, schema).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}

	run(filepath.Join(dir, "000006_release_deleted_applicant_slips.down.sql"))
	want := map[string]string{"a": "-", "b": "a", "c": "-", "d": "b", "e": "a", "f": "f"}
	if got := hashes(); !mapsEqual(got, want) {
		t.Fatalf("down: want hashes %v, got %v", want, got)
	}
	if def := indexDef(); strings.Contains(def, "applicant_deleted") || !strings.Contains(def, "REJECTED") {
		t.Fatalf("down must restore the 000005 index, got %s", def)
	}
	if hasFlag() {
		t.Fatal("down must drop applicant_deleted")
	}
	var statuses string
	if err := conn.QueryRow(ctx, `SELECT string_agg(status, ',' ORDER BY id) FROM payments`).Scan(&statuses); err != nil || statuses != "PENDING,PENDING,APPROVED,PENDING,REJECTED,APPROVED" {
		t.Fatalf("down must not change any status, got %q (%v)", statuses, err)
	}

	run(filepath.Join(dir, "000006_release_deleted_applicant_slips.up.sql"))
	if !hasFlag() || !strings.Contains(indexDef(), "applicant_deleted") {
		t.Fatalf("up must restore the flag and the 000006 index, got %s", indexDef())
	}
	var wrong int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM payments p JOIN applicants a ON a.id = p.applicant_id
		WHERE p.applicant_deleted <> (a.deleted_at IS NOT NULL)`).Scan(&wrong); err != nil || wrong != 0 {
		t.Fatalf("up must backfill the flag from applicants.deleted_at: %d wrong (%v)", wrong, err)
	}
	// The released hash "b" is free for a live slip again.
	exec(`INSERT INTO payments (applicant_id, slip_url, amount, status, slip_hash) VALUES ($1, 'x', 1000, 'PENDING', $2)`, live, h("b"))
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// waitForLockWaiters blocks until n sessions of this database wait on a lock.
func waitForLockWaiters(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d lock waiters", n)
}

// The same race with the queue order forced. A third transaction holds the payment row; one party
// queues on it first, the other second; then it lets go. With the delete locking the applicant row
// before the payment rows, "Verify first" is a lock cycle (Verify holds the payment and waits for
// the applicant, the delete holds the applicant and waits for the payment) and PostgreSQL aborts
// one of them with a deadlock error. With payment rows first, both orders finish cleanly.
func TestPostgres_AdminDeleteAndVerifyForcedOrder(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "523", "c3"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	for i, verifyFirst := range []bool{true, false, true, false} {
		a := seedApplicant(t, pool, repo, i, tag)
		p := slipFor(a.ID, hashOf(ht, i))
		if _, err := pay.CreateReplacingPending(ctx, p); err != nil {
			t.Fatal(err)
		}
		gate, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := gate.Exec(ctx, `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE`, p.ID); err != nil {
			t.Fatal(err)
		}

		var wg sync.WaitGroup
		var dErr, vErr error
		verify := func() { defer wg.Done(); vErr = pay.Verify(ctx, p.ID, true, admin.ID, "ok", nil) }
		del := func() { defer wg.Done(); dErr = repo.SoftDelete(ctx, a.ID, &admin.ID, "duplicate", nil) }
		first, second := verify, del
		if !verifyFirst {
			first, second = del, verify
		}
		wg.Add(2)
		go first()
		waitForLockWaiters(t, pool, 1)
		go second()
		waitForLockWaiters(t, pool, 2)
		if err := gate.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		wg.Wait()

		if dErr != nil {
			t.Fatalf("verifyFirst=%v: the delete failed (deadlock?): %v", verifyFirst, dErr)
		}
		got := payStatuses(t, pool, a.ID)
		if verifyFirst {
			if vErr != nil || got[domain.PaymentApproved] != 1 {
				t.Fatalf("verify queued first must approve, then the delete runs: verify=%v rows=%v", vErr, got)
			}
		} else if !errors.Is(vErr, domain.ErrStateConflict) || got[domain.PaymentPending] != 1 {
			t.Fatalf("delete queued first: verify must find the applicant gone and change nothing: verify=%v rows=%v", vErr, got)
		}
		if flags := applicantDeletedFlags(t, pool, a.ID); len(flags) != 1 || !flags[0] {
			t.Fatalf("verifyFirst=%v: the payment must be flagged, got %v", verifyFirst, flags)
		}
	}
}
