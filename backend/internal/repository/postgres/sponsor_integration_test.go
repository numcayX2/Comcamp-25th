package postgres_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository"
	"comcamp25-backend/internal/repository/postgres"
)

func setupSponsorRepo(t *testing.T) (*postgres.SponsorPostgresRepo, func(string) int) {
	t.Helper()
	if testDSN == "" {
		t.Skip("Skipping integration test: TEST_DATABASE_DSN is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := repository.NewPool(ctx, repository.DefaultPoolConfig(testDSN))
	if err != nil {
		t.Skipf("Skipping integration test: PostgreSQL is not reachable (%v)", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(), `TRUNCATE sponsors RESTART IDENTITY`); err != nil {
		t.Fatalf("truncate sponsors (is migration 000014 applied?): %v", err)
	}
	countAudit := func(action string) int {
		var n int
		if err := pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM audit_logs WHERE action = $1`, action).Scan(&n); err != nil {
			t.Fatalf("count audit: %v", err)
		}
		return n
	}
	return postgres.NewSponsorPostgresRepo(pool), countAudit
}

func newSponsor(name string) *domain.Sponsor {
	return &domain.Sponsor{
		Name:     name,
		LogoPath: "sponsors/" + strings.ToLower(name) + ".png",
		LogoMIME: "image/png",
		LogoHash: strings.Repeat("a", 64),
	}
}

// Create / Update / Reorder / Delete against the real schema (CHECK constraints, audit rows in
// the same transaction, sort_order rewrite, old logo path handed back on replace).
func TestSponsorPostgres_Lifecycle(t *testing.T) {
	repo, countAudit := setupSponsorRepo(t)
	ctx := context.Background()
	createdBefore := countAudit(string(domain.AuditSponsorCreate))

	var ids []int64
	for _, name := range []string{"Alpha", "Beta", "Gamma"} {
		s := newSponsor(name)
		if err := repo.Create(ctx, s, &domain.AuditEntry{Action: domain.AuditSponsorCreate, TargetType: domain.AuditTargetSponsor}); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		ids = append(ids, s.ID)
	}
	if got := countAudit(string(domain.AuditSponsorCreate)) - createdBefore; got != 3 {
		t.Fatalf("create audit rows = %d, want 3", got)
	}

	// The url CHECK constraint backs up the service validation.
	bad := newSponsor("Bad")
	bad.URL = "javascript:alert(1)"
	if err := repo.Create(ctx, bad, nil); err == nil {
		t.Fatal("javascript: url must be rejected by the schema")
	}

	newPath, newMime, newHash := "sponsors/beta2.webp", "image/webp", strings.Repeat("b", 64)
	link, show := "https://example.com", true
	updated, oldPath, err := repo.Update(ctx, ids[1], domain.SponsorPatch{URL: &link, ShowName: &show, LogoPath: &newPath, LogoMIME: &newMime, LogoHash: &newHash},
		&domain.AuditEntry{Action: domain.AuditSponsorUpdate, TargetType: domain.AuditTargetSponsor})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if oldPath != "sponsors/beta.png" || updated.LogoPath != newPath || updated.URL != link || !updated.ShowName || updated.Name != "Beta" {
		t.Fatalf("update result = %+v old=%q", updated, oldPath)
	}

	if _, err := repo.Reorder(ctx, []int64{ids[0], ids[1]}, nil); !errors.Is(err, domain.ErrSponsorOrderMismatch) {
		t.Fatalf("partial reorder: want ErrSponsorOrderMismatch, got %v", err)
	}
	if _, err := repo.Reorder(ctx, []int64{ids[0], ids[0], ids[1]}, nil); !errors.Is(err, domain.ErrSponsorOrderMismatch) {
		t.Fatalf("duplicate reorder: want ErrSponsorOrderMismatch, got %v", err)
	}
	list, err := repo.Reorder(ctx, []int64{ids[2], ids[0], ids[1]}, &domain.AuditEntry{Action: domain.AuditSponsorReorder, TargetType: domain.AuditTargetSponsor})
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if len(list) != 3 || list[0].ID != ids[2] || list[1].ID != ids[0] || list[2].ID != ids[1] {
		t.Fatalf("reorder order wrong: %+v", list)
	}

	deleted, err := repo.Delete(ctx, ids[0], &domain.AuditEntry{Action: domain.AuditSponsorDelete, TargetType: domain.AuditTargetSponsor})
	if err != nil || deleted.LogoPath != "sponsors/alpha.png" {
		t.Fatalf("delete: %v %+v", err, deleted)
	}
	if _, err := repo.GetByID(ctx, ids[0]); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted sponsor: want ErrNotFound, got %v", err)
	}
	rest, err := repo.List(ctx)
	if err != nil || len(rest) != 2 || rest[0].ID != ids[2] || rest[1].ID != ids[1] {
		t.Fatalf("list after delete: %v %+v", err, rest)
	}
}
