package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/service"
)

// Postgres writes audit details with json.Marshal; the in-memory audit store now does the same, so
// a value that cannot be marshalled (a method value instead of its result, as in the old
// "fullName": applicant.FullName) fails here and not first in production as an HTTP 500.
func TestApplicantService_Delete_WritesMarshalableAuditWithFullName(t *testing.T) {
	svc, appRepo, _ := setupTestServices()
	ctx := context.Background()

	created, err := svc.Submit(ctx, service.ApplicationCreateRequest{
		FullName: "สมชาย ใจดี", Nickname: "ชาย", NationalID: validTestNationalID(31), Phone: "0812345631",
		Email: "del31@example.com", School: "โรงเรียนแม่โจ้วิทยาคม", Grade: "ม.5", ShirtSize: "L",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Delete(ctx, created.ID, 7, "ผู้สมัครซ้ำ", "203.0.113.5"); err != nil {
		t.Fatalf("Delete must succeed and write a serialisable audit entry: %v", err)
	}

	var found *domain.AuditEntry
	for _, e := range appRepo.Audit().Entries() {
		e := e
		if e.Action == domain.AuditApplicantDelete {
			found = &e
		}
	}
	if found == nil {
		t.Fatal("Delete must write an application.delete audit entry")
	}
	raw, err := json.Marshal(found.Details)
	if err != nil {
		t.Fatalf("audit details must be JSON-marshalable: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if name, ok := back["fullName"].(string); !ok || name != "สมชาย ใจดี" {
		t.Fatalf("fullName must be the applicant's name as a string, got %#v", back["fullName"])
	}
	if back["reason"] != "ผู้สมัครซ้ำ" {
		t.Fatalf("reason missing from the audit details: %#v", back)
	}
	if found.AdminID == nil || *found.AdminID != 7 || found.TargetID != created.ID {
		t.Fatalf("audit entry must name the admin and the target: %+v", found)
	}
}
