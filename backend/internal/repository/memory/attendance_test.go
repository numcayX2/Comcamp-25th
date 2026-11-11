package memory_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
)

func attendanceAudit(appNo string, confirmed bool) *domain.AuditEntry {
	return &domain.AuditEntry{
		Action: domain.AuditAttendanceConfirm, TargetType: domain.AuditTargetApplicant, TargetID: appNo,
		Details: map[string]any{"confirmed": confirmed}, IPAddress: "203.0.113.7",
	}
}

func countAttendanceAudits(repo *memory.MemoryApplicantRepo) int {
	n := 0
	for _, e := range repo.Audit().Entries() {
		if e.Action == domain.AuditAttendanceConfirm {
			n++
		}
	}
	return n
}

// LOW-04: only a live PASSED or CONFIRMED application records an answer, and the audit entry is
// stored with it.
func TestMemory_UpdateAttendanceGuardsStatusAndAudits(t *testing.T) {
	ctx := context.Background()
	repo := memory.NewMemoryApplicantRepo()

	a := &domain.Applicant{ID: uuid.New(), ApplicationNo: "CC25-ATT001", NationalID: "1100000000001", Phone: "0800000001", Status: domain.StatusPassed}
	if err := repo.Create(ctx, a); err != nil {
		t.Fatal(err)
	}

	for _, confirmed := range []bool{true, false} {
		if err := repo.UpdateAttendance(ctx, a.ID, confirmed, attendanceAudit(a.ApplicationNo, confirmed)); err != nil {
			t.Fatalf("PASSED, confirmed=%v: %v", confirmed, err)
		}
		got, _ := repo.GetByID(ctx, a.ID)
		if got.AttendanceConfirmed != confirmed {
			t.Fatalf("attendance = %v, want %v", got.AttendanceConfirmed, confirmed)
		}
		entries := repo.Audit().Entries()
		last := entries[len(entries)-1]
		if last.Action != domain.AuditAttendanceConfirm || last.TargetID != a.ApplicationNo || last.IPAddress != "203.0.113.7" ||
			last.Details["confirmed"] != confirmed || last.Details["status"] != domain.StatusPassed {
			t.Fatalf("unexpected audit entry %+v", last)
		}
	}

	// CONFIRMED may still answer.
	if err := repo.UpdateStatus(ctx, a.ID, domain.StatusConfirmed, nil, "", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateAttendance(ctx, a.ID, true, attendanceAudit(a.ApplicationNo, true)); err != nil {
		t.Fatalf("CONFIRMED: %v", err)
	}

	// Every other status is refused and nothing changes.
	before := countAttendanceAudits(repo)
	for _, s := range []domain.ApplicationStatus{domain.StatusPending, domain.StatusRejected, domain.StatusRefundPending, domain.StatusRefunded} {
		b := &domain.Applicant{ID: uuid.New(), ApplicationNo: "CC25-ATT-" + string(s), NationalID: "12" + uuid.NewString()[:11], Phone: "08" + uuid.NewString()[:8], Status: s}
		if err := repo.Create(ctx, b); err != nil {
			t.Fatal(err)
		}
		err := repo.UpdateAttendance(ctx, b.ID, true, attendanceAudit(b.ApplicationNo, true))
		if !errors.Is(err, domain.ErrStateConflict) {
			t.Fatalf("%s: expected ErrStateConflict, got %v", s, err)
		}
		if got, _ := repo.GetByID(ctx, b.ID); got.AttendanceConfirmed {
			t.Fatalf("%s: attendance was written", s)
		}
	}
	if n := countAttendanceAudits(repo); n != before {
		t.Fatalf("refused writes left %d audit entries", n-before)
	}

	// Missing and deleted applications are not found.
	if err := repo.UpdateAttendance(ctx, uuid.New(), true, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing: expected ErrNotFound, got %v", err)
	}
	staff := int64(1) // a staff delete: the applicant could not withdraw a CONFIRMED place
	if err := repo.SoftDelete(ctx, a.ID, &staff, "test", nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateAttendance(ctx, a.ID, true, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted: expected ErrNotFound, got %v", err)
	}
}
