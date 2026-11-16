package postgres_test

import (
	"context"
	"testing"

	"comcamp25-backend/internal/domain"
	"comcamp25-backend/internal/repository/postgres"
)

// Requires TEST_DATABASE_DSN pointing at a database with migrations 000001-000008 applied.

func TestPostgres_ReverifySlipAndParentContact(t *testing.T) {
	pool := openTestPool(t)
	repo := postgres.NewApplicantPostgresRepo(pool)
	pay := postgres.NewPaymentPostgresRepo(pool)
	ctx := context.Background()
	const tag, ht = "551", "e1"
	cleanupApplicants(t, pool, tag)
	cleanupSlips(t, pool, ht)
	admin := seedAdmin(t, pool)

	a := newApplicant(1, tag)
	a.Status = domain.StatusPassed
	pName := "สมศรี ทดสอบ"
	pRel := "มารดา"
	pPhone := "0898765432"
	a.ParentName = &pName
	a.ParentRelation = &pRel
	a.ParentPhone = &pPhone
	a.EmergencyContact = pName
	a.EmergencyPhone = pPhone

	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `DELETE FROM payments WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM applicant_status_logs WHERE applicant_id = $1`, a.ID)
		_, _ = pool.Exec(bg, `DELETE FROM audit_logs WHERE target_id = $1 OR admin_id = $2`, a.ApplicationNo, admin.ID)
		_, _ = pool.Exec(bg, `DELETE FROM applicants WHERE id = $1`, a.ID)
	})

	// a) CreateWithinCapacity persists parent contact and emergency columns.
	if err := repo.CreateWithinCapacity(ctx, a, 100_000); err != nil {
		t.Fatalf("CreateWithinCapacity: %v", err)
	}

	// b) GetByID reads back identical parent and emergency fields from PostgreSQL.
	got, err := repo.GetByID(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetByID after create: %v", err)
	}
	if got.ParentName == nil || *got.ParentName != pName ||
		got.ParentRelation == nil || *got.ParentRelation != pRel ||
		got.ParentPhone == nil || *got.ParentPhone != pPhone ||
		got.EmergencyContact != pName || got.EmergencyPhone != pPhone {
		t.Fatalf("persisted parent/emergency mismatch: got %+v", got)
	}

	// c) UpdateProfile updates parent fields and writes an audit_logs row in PostgreSQL.
	newPName := "สมชาย ทดสอบ"
	newPRel := "บิดา"
	newPPhone := "0876543210"
	fields := domain.ProfileFields{
		FirstName:         got.FirstName,
		LastName:          got.LastName,
		Nickname:          got.Nickname,
		NationalID:        got.NationalID,
		Phone:             got.Phone,
		Email:             got.Email,
		School:            got.School,
		Province:          got.Province,
		Grade:             got.Grade,
		ShirtSize:         got.ShirtSize,
		Motivation:        got.Motivation,
		Allergies:         got.Allergies,
		MedicalConditions: got.MedicalConditions,
		ParentName:        &newPName,
		ParentRelation:    &newPRel,
		ParentPhone:       &newPPhone,
		EmergencyContact:  newPName,
		EmergencyPhone:    newPPhone,
	}
	profileAudit := &domain.AuditEntry{
		AdminID:    &admin.ID,
		Action:     domain.AuditProfileUpdate,
		TargetType: domain.AuditTargetApplicant,
		TargetID:   a.ApplicationNo,
		Details: map[string]any{
			"changes": map[string]map[string]string{
				"parentName":     {"old": pName, "new": newPName},
				"parentRelation": {"old": pRel, "new": newPRel},
				"parentPhone":    {"old": pPhone, "new": newPPhone},
			},
			"reason": "อัปเดตผู้ปกครอง",
		},
		IPAddress: "203.0.113.15",
	}
	if err := repo.UpdateProfile(ctx, a.ID, fields, false, profileAudit); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}

	afterProfile, err := repo.GetByID(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetByID after profile update: %v", err)
	}
	if afterProfile.ParentName == nil || *afterProfile.ParentName != newPName ||
		afterProfile.ParentRelation == nil || *afterProfile.ParentRelation != newPRel ||
		afterProfile.ParentPhone == nil || *afterProfile.ParentPhone != newPPhone ||
		afterProfile.EmergencyContact != newPName || afterProfile.EmergencyPhone != newPPhone {
		t.Fatalf("updated parent/emergency mismatch: got %+v", afterProfile)
	}
	var profileAuditCount int
	var newParentLogged string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), max(details->'changes'->'parentName'->>'new')
		FROM audit_logs
		WHERE target_id = $1 AND action = 'application.profile.update' AND admin_id = $2
	`, a.ApplicationNo, admin.ID).Scan(&profileAuditCount, &newParentLogged); err != nil {
		t.Fatalf("query profile audit_logs: %v", err)
	}
	if profileAuditCount != 1 || newParentLogged != newPName {
		t.Fatalf("expected 1 profile audit row with parentName=%q, got count=%d logged=%q", newPName, profileAuditCount, newParentLogged)
	}

	// d) Insert PENDING slip and Verify -> APPROVED / CONFIRMED.
	slipHash := hashOf(ht, 1)
	p := slipFor(a.ID, slipHash)
	if _, err := pay.CreateReplacingPending(ctx, p); err != nil {
		t.Fatalf("CreateReplacingPending: %v", err)
	}
	verifyAudit := func(approved bool, note string) *domain.AuditEntry {
		return &domain.AuditEntry{
			AdminID:    &admin.ID,
			Action:     domain.AuditSlipVerify,
			TargetType: domain.AuditTargetApplicant,
			TargetID:   a.ApplicationNo,
			Details: map[string]any{
				"paymentId": p.ID.String(),
				"approved":  approved,
				"note":      note,
			},
			IPAddress: "203.0.113.15",
		}
	}
	if err := pay.Verify(ctx, p.ID, true, admin.ID, "ok", verifyAudit(true, "ok")); err != nil {
		t.Fatalf("Verify approve: %v", err)
	}
	gotPay, err := pay.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetByID payment after Verify: %v", err)
	}
	gotApp, err := repo.GetByID(ctx, a.ID)
	if err != nil {
		t.Fatalf("GetByID applicant after Verify: %v", err)
	}
	if gotPay.Status != domain.PaymentApproved || gotApp.Status != domain.StatusConfirmed {
		t.Fatalf("after Verify: payment=%s applicant=%s, want APPROVED/CONFIRMED", gotPay.Status, gotApp.Status)
	}
	if dup, err := pay.CheckDuplicateSlipHash(ctx, slipHash); err != nil || !dup {
		t.Fatalf("after Verify approve: expected CheckDuplicateSlipHash=true, got %v (err=%v)", dup, err)
	}

	// e) Reverify APPROVED -> REJECTED releases slip hash and writes status + audit logs.
	if err := pay.Reverify(ctx, p.ID, domain.PaymentApproved, false, admin.ID, "ผิดใบ", verifyAudit(false, "ผิดใบ")); err != nil {
		t.Fatalf("Reverify APPROVED -> REJECTED: %v", err)
	}
	gotPay, _ = pay.GetByID(ctx, p.ID)
	gotApp, _ = repo.GetByID(ctx, a.ID)
	if gotPay.Status != domain.PaymentRejected || gotApp.Status != domain.StatusPassed {
		t.Fatalf("after Reverify reject: payment=%s applicant=%s, want REJECTED/PASSED", gotPay.Status, gotApp.Status)
	}
	if gotPay.RejectionReason == nil || *gotPay.RejectionReason != "ผิดใบ" || gotPay.AdminNote == nil || *gotPay.AdminNote != "ผิดใบ" {
		t.Fatalf("after Reverify reject: note=%v reason=%v", gotPay.AdminNote, gotPay.RejectionReason)
	}
	if dup, err := pay.CheckDuplicateSlipHash(ctx, slipHash); err != nil || dup {
		t.Fatalf("after Reverify reject: expected CheckDuplicateSlipHash=false, got %v (err=%v)", dup, err)
	}

	var statusLogCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM applicant_status_logs
		WHERE applicant_id = $1 AND old_status = 'CONFIRMED' AND new_status = 'PASSED'
	`, a.ID).Scan(&statusLogCount); err != nil || statusLogCount != 1 {
		t.Fatalf("expected 1 CONFIRMED->PASSED status log, got %d (%v)", statusLogCount, err)
	}
	var prevSlipStatus string
	if err := pool.QueryRow(ctx, `
		SELECT details->>'previousSlipStatus'
		FROM audit_logs
		WHERE target_id = $1 AND action = 'payment.slip.verify' AND details->>'approved' = 'false'
		ORDER BY id DESC LIMIT 1
	`, a.ApplicationNo).Scan(&prevSlipStatus); err != nil || prevSlipStatus != string(domain.PaymentApproved) {
		t.Fatalf("expected previousSlipStatus='APPROVED' audit entry, got %q (%v)", prevSlipStatus, err)
	}

	// f) Reverify REJECTED -> APPROVED re-locks slip hash and moves applicant back to CONFIRMED.
	if err := pay.Reverify(ctx, p.ID, domain.PaymentRejected, true, admin.ID, "ตรวจใหม่ผ่าน", verifyAudit(true, "ตรวจใหม่ผ่าน")); err != nil {
		t.Fatalf("Reverify REJECTED -> APPROVED: %v", err)
	}
	gotPay, _ = pay.GetByID(ctx, p.ID)
	gotApp, _ = repo.GetByID(ctx, a.ID)
	if gotPay.Status != domain.PaymentApproved || gotApp.Status != domain.StatusConfirmed {
		t.Fatalf("after Reverify re-approve: payment=%s applicant=%s, want APPROVED/CONFIRMED", gotPay.Status, gotApp.Status)
	}
	if gotPay.RejectionReason != nil || gotPay.AdminNote == nil || *gotPay.AdminNote != "ตรวจใหม่ผ่าน" {
		t.Fatalf("after Reverify re-approve: note=%v reason=%v", gotPay.AdminNote, gotPay.RejectionReason)
	}
	if dup, err := pay.CheckDuplicateSlipHash(ctx, slipHash); err != nil || !dup {
		t.Fatalf("after Reverify re-approve: expected CheckDuplicateSlipHash=true, got %v (err=%v)", dup, err)
	}
}
