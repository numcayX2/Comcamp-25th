package postgres_test

// Run against a database with every migration applied, for example:
//   TEST_DATABASE_DSN="host=127.0.0.1 port=5432 user=comcamp password=... dbname=comcamp_db sslmode=disable" go test ./internal/repository/postgres/

import (
	"context"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// ListPublic returns only live PASSED / CONFIRMED rows, oldest first, with only the allowlisted
// columns filled (GET /api/applications/public, CLAUDE_REVAMP_HANDOFF.md 5.4).
func TestPostgres_ListPublicFiltersAndOrders(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	ctx := context.Background()
	const tag = "554"
	cleanupApplicants(t, pool, tag)
	// Other tests share the database, so this one only looks at rows from its own school.
	school := "public-list-" + tag

	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	seed := func(i int, status domain.ApplicationStatus, minutes int) *domain.Applicant {
		t.Helper()
		a := newApplicant(i, tag)
		a.LastName = "ลำดับ"
		a.Nickname = "n" + tag
		a.School = school
		a.Status = status
		if err := repo.Create(ctx, a); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE applicants SET created_at = $2 WHERE id = $1`, a.ID, base.Add(time.Duration(minutes)*time.Minute)); err != nil {
			t.Fatal(err)
		}
		return a
	}
	confirmed := seed(1, domain.StatusConfirmed, 30)
	passed := seed(2, domain.StatusPassed, 10)
	for i, s := range []domain.ApplicationStatus{
		domain.StatusPending, domain.StatusReserve, domain.StatusRejected, domain.StatusRefundPending, domain.StatusRefunded,
	} {
		seed(10+i, s, 5)
	}
	deleted := seed(20, domain.StatusPassed, 1)
	if _, err := pool.Exec(ctx, `UPDATE applicants SET deleted_at = now() WHERE id = $1`, deleted.ID); err != nil {
		t.Fatal(err)
	}

	all, err := repo.ListPublic(ctx)
	if err != nil {
		t.Fatalf("ListPublic: %v", err)
	}
	var mine []domain.PublicApplicant
	for _, r := range all {
		if r.School == school {
			mine = append(mine, r)
		}
	}
	want := []domain.PublicApplicant{
		{FirstName: passed.FirstName, LastName: "ลำดับ", Nickname: "n" + tag, School: school, Province: passed.Province, Status: domain.StatusPassed},
		{FirstName: confirmed.FirstName, LastName: "ลำดับ", Nickname: "n" + tag, School: school, Province: confirmed.Province, Status: domain.StatusConfirmed},
	}
	if len(mine) != len(want) {
		t.Fatalf("expected %d listed rows (live PASSED + CONFIRMED only), got %d: %+v", len(want), len(mine), mine)
	}
	for i := range want {
		if mine[i] != want[i] {
			t.Errorf("row %d = %+v, want %+v", i, mine[i], want[i])
		}
	}
	for _, r := range all {
		if r.Status != domain.StatusPassed && r.Status != domain.StatusConfirmed {
			t.Errorf("ListPublic returned status %s", r.Status)
		}
	}
}
