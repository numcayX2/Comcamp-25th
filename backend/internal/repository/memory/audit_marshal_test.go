package memory_test

import (
	"context"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
)

func TestMemoryAuditRepo_RejectsUnmarshalableDetails(t *testing.T) {
	repo := memory.NewMemoryAuditRepo()
	ctx := context.Background()
	name := func() string { return "x" }

	err := repo.Log(ctx, &domain.AuditEntry{Action: domain.AuditApplicantDelete, Details: map[string]any{"fullName": name}})
	if err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("a method value in the details must be refused like Postgres does, got %v", err)
	}
	if n := len(repo.Entries()); n != 0 {
		t.Fatalf("a refused entry must not be stored, have %d", n)
	}
	if err := repo.Log(ctx, &domain.AuditEntry{Action: domain.AuditApplicantDelete, Details: map[string]any{"fullName": name()}}); err != nil {
		t.Fatalf("plain values must be accepted: %v", err)
	}
	if err := repo.Log(ctx, &domain.AuditEntry{Action: domain.AuditApplicantDelete}); err != nil {
		t.Fatalf("an entry without details must be accepted: %v", err)
	}
}

// The applicant repository must pass the refusal on instead of swallowing it, and must not touch
// the record when its audit entry is bad.
func TestMemoryApplicantRepo_SoftDeleteSurfacesBadAuditAndKeepsRecord(t *testing.T) {
	repo := memory.NewMemoryApplicantRepo()
	ctx := context.Background()
	a := &domain.Applicant{ApplicationNo: "CC25-AAAAAA", FirstName: "สมชาย", LastName: "ใจดี", NationalID: "1509900000017", Phone: "0812345678", Status: domain.StatusPassed}
	if err := repo.Create(ctx, a); err != nil {
		t.Fatal(err)
	}
	bad := &domain.AuditEntry{Action: domain.AuditApplicantDelete, Details: map[string]any{"fullName": a.FullName}}
	if err := repo.SoftDelete(ctx, a.ID, nil, "x", bad); err == nil {
		t.Fatal("SoftDelete must return the audit marshal error")
	}
	if _, err := repo.GetByApplicationNo(ctx, "CC25-AAAAAA"); err != nil {
		t.Fatalf("the applicant must still exist after the refused delete: %v", err)
	}
}
