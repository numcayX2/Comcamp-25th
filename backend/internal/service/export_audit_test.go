package service_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func TestRecordExport(t *testing.T) {
	ctx := context.Background()
	apps := memory.NewMemoryApplicantRepo()
	svc := service.NewApplicantService(apps, memory.NewMemorySettingRepo(), memory.NewMemoryPaymentRepo(apps))

	// Not wired: refuse rather than let an export go unrecorded.
	if _, err := svc.RecordExport(ctx, 1, service.ExportRecord{}, "127.0.0.1"); !errors.Is(err, service.ErrAuditUnavailable) {
		t.Fatalf("without WithAudit: expected ErrAuditUnavailable, got %v", err)
	}
	svc.WithAudit(apps.Audit())

	n, err := svc.RecordExport(ctx, 7, service.ExportRecord{
		ApplicationIDs: []string{"cc25-8a4b2c", "CC25 9A8B1C"}, StatusFilter: "PASSED", SearchFiltered: true,
	}, "203.0.113.5")
	if err != nil || n != 2 {
		t.Fatalf("RecordExport = %d, %v", n, err)
	}
	entries := apps.Audit().Entries()
	e := entries[len(entries)-1]
	ids, _ := e.Details["applicationIds"].([]string)
	if e.Action != domain.AuditApplicantExportCSV || e.TargetType != domain.AuditTargetApplicant || e.AdminID == nil || *e.AdminID != 7 ||
		e.IPAddress != "203.0.113.5" || e.Details["count"] != 2 || e.Details["statusFilter"] != domain.StatusPassed ||
		e.Details["searchFiltered"] != true || strings.Join(ids, ",") != "CC25-8A4B2C,CC25-9A8B1C" {
		t.Fatalf("unexpected audit entry %+v", e)
	}

	// An empty list is a valid (if odd) export of zero rows.
	if n, err := svc.RecordExport(ctx, 7, service.ExportRecord{ApplicationIDs: []string{}}, ""); err != nil || n != 0 {
		t.Fatalf("empty export = %d, %v", n, err)
	}

	before := len(apps.Audit().Entries())
	tooMany := make([]string, service.MaxExportAuditIDs+1)
	for i := range tooMany {
		tooMany[i] = "CC25-000000"
	}
	for name, rec := range map[string]service.ExportRecord{
		"bad id":     {ApplicationIDs: []string{"CC25-8A4B2C", "0812345678"}},
		"bad status": {ApplicationIDs: []string{"CC25-8A4B2C"}, StatusFilter: "WHATEVER"},
		"too many":   {ApplicationIDs: tooMany},
	} {
		if _, err := svc.RecordExport(ctx, 7, rec, ""); err == nil {
			t.Errorf("%s: expected a validation error", name)
		}
	}
	if after := len(apps.Audit().Entries()); after != before {
		t.Fatalf("refused exports were recorded (%d entries)", after-before)
	}
}
