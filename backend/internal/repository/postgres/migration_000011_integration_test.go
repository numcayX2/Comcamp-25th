package postgres_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Migration 000011 (national ID removal) on a schema of its own that already holds applicants:
// up drops the column and its index, keeps the live phone/email uniqueness, moves the stale
// settings row to 19 Nov 09:00 / 40 seats; down brings a nullable column back; a second up after
// staff changed the settings leaves those values alone.
func TestPostgres_Migration000011WithRowsPresent(t *testing.T) {
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
	schema := "mig_011_" + hex.EncodeToString(suffix)
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
	if err != nil || len(files) < 11 {
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
		if strings.HasPrefix(filepath.Base(f), "000011_") {
			break
		}
		run(f)
	}

	// Rows present before 000011, as on a volume created before the change.
	addApplicant := func(id, no, nid, phone, email string, deleted bool) {
		exec(`INSERT INTO applicants (id, application_no, national_id, prefix, first_name, last_name, nickname, birth_date,
			gender, school, grade, phone, email, province, emergency_contact, emergency_phone, shirt_size, status, deleted_at)
			VALUES ($1, $2, $3, '-', 'a', 'b', 'a', '2008-01-01', 'unspecified', 's', 'ม.5', $4, $5, 'p', 'x', $4, 'M', 'PASSED',
			CASE WHEN $6::bool THEN now() END)`, id, no, nid, phone, email, deleted)
	}
	addApplicant("22222222-0000-0000-0000-000000000001", "CC25-M11AA1", "1509900000011", "0800000011", "m11a@example.com", false)
	addApplicant("22222222-0000-0000-0000-000000000002", "CC25-M11AA2", "1509900000012", "0800000012", "", false)
	addApplicant("22222222-0000-0000-0000-000000000003", "CC25-M11AA3", "1509900000013", "0800000013", "m11c@example.com", true)

	queryBool := func(sql string, args ...any) bool {
		t.Helper()
		var v bool
		if err := conn.QueryRow(ctx, sql, args...).Scan(&v); err != nil {
			t.Fatalf("%v\n%s", err, sql)
		}
		return v
	}
	hasColumn := func() bool {
		return queryBool(`SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applicants' AND column_name = 'national_id'`, schema)
	}
	hasIndex := func(name string) bool {
		return queryBool(`SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`, schema, name)
	}
	columnDefault := func(col string) string {
		t.Helper()
		var def string
		if err := conn.QueryRow(ctx, `SELECT coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'settings' AND column_name = $2`, schema, col).Scan(&def); err != nil {
			t.Fatal(err)
		}
		return def
	}
	settingsAre := func(openAt string, capacity int) bool {
		return queryBool(`SELECT registration_open_at = $1::timestamptz AND max_capacity = $2 FROM settings WHERE id = 1`, openAt, capacity)
	}
	untouched := func() bool {
		return queryBool(`SELECT registration_close_at = '2026-12-18 23:59:59+07'::timestamptz AND camp_fee = 1200.00 FROM settings WHERE id = 1`)
	}
	if !hasColumn() || !hasIndex("uq_applicants_national_id_live") || !settingsAre("2026-11-18 00:00:00+07", 30) || !untouched() {
		t.Fatal("unexpected state before 000011 (000001-000010 should leave 18 Nov 00:00 / 30 seats / 18 Dec / 1200)")
	}

	up := filepath.Join(dir, "000011_remove_national_id.up.sql")
	down := filepath.Join(dir, "000011_remove_national_id.down.sql")

	run(up)
	if hasColumn() || hasIndex("uq_applicants_national_id_live") {
		t.Fatal("up must drop national_id and uq_applicants_national_id_live")
	}
	if !hasIndex("uq_applicants_phone_live") || !hasIndex("uq_applicants_email") {
		t.Fatal("up must keep the live phone and email unique indexes")
	}
	if !queryBool(`SELECT count(*) = 3 FROM applicants`) {
		t.Fatal("up must keep every applicant row")
	}
	if !settingsAre("2026-11-19 09:00:00+07", 40) || !untouched() {
		t.Fatal("up must move the stale row to 19 Nov 09:00 / 40 seats and leave close/fee alone")
	}
	if d := columnDefault("max_capacity"); d != "40" {
		t.Fatalf("max_capacity default: want 40, got %q", d)
	}
	if d := columnDefault("registration_open_at"); !strings.Contains(d, "2026-11-19") {
		t.Fatalf("registration_open_at default: want 19 Nov, got %q", d)
	}
	// Live identity still holds: same live phone or same live email is refused, a deleted row's
	// phone and email are free again.
	if _, err := conn.Exec(ctx, `INSERT INTO applicants (application_no, prefix, first_name, last_name, nickname, birth_date,
		gender, school, grade, phone, email, province, emergency_contact, emergency_phone, shirt_size)
		VALUES ('CC25-M11DUP', '-', 'a', 'b', 'a', '2008-01-01', 'unspecified', 's', 'ม.5', '0800000011', '', 'p', 'x', '0800000011', 'M')`); err == nil {
		t.Fatal("a second live row with the same phone must be refused")
	}
	if _, err := conn.Exec(ctx, `INSERT INTO applicants (application_no, prefix, first_name, last_name, nickname, birth_date,
		gender, school, grade, phone, email, province, emergency_contact, emergency_phone, shirt_size)
		VALUES ('CC25-M11DUQ', '-', 'a', 'b', 'a', '2008-01-01', 'unspecified', 's', 'ม.5', '0800000099', 'm11a@example.com', 'p', 'x', '0800000099', 'M')`); err == nil {
		t.Fatal("a second live row with the same email must be refused")
	}
	exec(`INSERT INTO applicants (application_no, prefix, first_name, last_name, nickname, birth_date,
		gender, school, grade, phone, email, province, emergency_contact, emergency_phone, shirt_size)
		VALUES ('CC25-M11NEW', '-', 'a', 'b', 'a', '2008-01-01', 'unspecified', 's', 'ม.5', '0800000013', 'm11c@example.com', 'p', 'x', '0800000013', 'M')`)

	run(down)
	if !hasColumn() || !hasIndex("uq_applicants_national_id_live") {
		t.Fatal("down must bring back national_id and its live-row index")
	}
	if !queryBool(`SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applicants' AND column_name = 'national_id'`, schema) {
		t.Fatal("down must re-add national_id as nullable")
	}
	if !queryBool(`SELECT count(*) = 4 AND count(national_id) = 0 FROM applicants`) {
		t.Fatal("down keeps the rows with a NULL national_id (the IDs are gone for good)")
	}
	if d := columnDefault("max_capacity"); d != "30" {
		t.Fatalf("down: max_capacity default should be 30 again, got %q", d)
	}
	if !settingsAre("2026-11-19 09:00:00+07", 40) {
		t.Fatal("down must leave the settings row alone")
	}

	// Staff changed the settings in /admin; re-applying up must not overwrite them.
	exec(`UPDATE settings SET registration_open_at = '2026-11-20 10:00:00+07', max_capacity = 35 WHERE id = 1`)
	run(up)
	if hasColumn() || !settingsAre("2026-11-20 10:00:00+07", 35) || !untouched() {
		t.Fatal("up after down: column must go again and staff-set settings must stay")
	}
}
