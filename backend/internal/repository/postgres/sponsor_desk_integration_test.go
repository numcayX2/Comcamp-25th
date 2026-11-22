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

func setupSponsorDeskRepos(t *testing.T) (*postgres.SponsorInquiryPostgresRepo, *postgres.SponsorDonationPostgresRepo, func(string) int) {
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
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE sponsor_inquiries, sponsor_notify_emails, sponsor_donation_files, sponsor_donations RESTART IDENTITY`); err != nil {
		t.Fatalf("truncate sponsor desk tables (is migration 000015 applied?): %v", err)
	}
	countAudit := func(action string) int {
		var n int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_logs WHERE action = $1`, action).Scan(&n); err != nil {
			t.Fatalf("count audit: %v", err)
		}
		return n
	}
	return postgres.NewSponsorInquiryPostgresRepo(pool), postgres.NewSponsorDonationPostgresRepo(pool), countAudit
}

func TestSponsorDeskPostgres_Inquiries(t *testing.T) {
	inq, _, countAudit := setupSponsorDeskRepos(t)
	ctx := context.Background()
	before := countAudit(string(domain.AuditSponsorInquiryCreate))

	a := &domain.SponsorInquiry{
		Name: "ร้าน ก", Phone: "0812345678", Kind: domain.SponsorKindMoney,
		TaxID: "1101700203450", AddressLine: "63 หมู่ 4", Subdistrict: "หนองหาร",
		District: "สันทราย", Province: "เชียงใหม่", Postcode: "50290",
	}
	if err := inq.Create(ctx, a, &domain.AuditEntry{Action: domain.AuditSponsorInquiryCreate, TargetType: domain.AuditTargetSponsorInquiry, Details: map[string]any{"kind": "money"}}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.ID == 0 || a.CreatedAt.IsZero() {
		t.Fatalf("create did not populate id/createdAt: %+v", a)
	}
	if got, err := inq.GetByID(ctx, a.ID); err != nil ||
		got.TaxID != a.TaxID || got.AddressLine != a.AddressLine || got.Subdistrict != a.Subdistrict ||
		got.District != a.District || got.Province != a.Province || got.Postcode != a.Postcode {
		t.Fatalf("tax/address did not round-trip: %v %+v", err, got)
	}
	if countAudit(string(domain.AuditSponsorInquiryCreate))-before != 1 {
		t.Fatal("create audit row missing")
	}
	if err := inq.Create(ctx, &domain.SponsorInquiry{Name: "x", Phone: "0812345678", Kind: "beer"}, nil); err == nil {
		t.Fatal("kind CHECK constraint must reject beer")
	}

	got, err := inq.SetHandled(ctx, a.ID, true, &domain.AuditEntry{Action: domain.AuditSponsorInquiryUpdate, TargetType: domain.AuditTargetSponsorInquiry})
	if err != nil || got.HandledAt == nil {
		t.Fatalf("set handled: %v %+v", err, got)
	}
	if got, _ = inq.SetHandled(ctx, a.ID, false, nil); got.HandledAt != nil {
		t.Fatal("handled not cleared")
	}
	if _, err := inq.SetHandled(ctx, 9999, true, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing inquiry: want ErrNotFound, got %v", err)
	}

	emails, err := inq.ReplaceNotifyEmails(ctx, []string{"b@example.com", "a@example.com"}, &domain.AuditEntry{Action: domain.AuditSponsorNotifyUpdate, TargetType: domain.AuditTargetSponsorInquiry})
	if err != nil || len(emails) != 2 {
		t.Fatalf("replace emails: %v %v", err, emails)
	}
	if list, _ := inq.ListNotifyEmails(ctx); strings.Join(list, ",") != "b@example.com,a@example.com" {
		t.Fatalf("notify emails order = %v", list)
	}

	// 000016: an attached form round-trips through Create / GetByID / Delete.
	hash := strings.Repeat("ab", 32)
	b := &domain.SponsorInquiry{Name: "ร้าน ข", Phone: "0812345679", Kind: domain.SponsorKindMoney,
		File: &domain.SponsorInquiryFile{Path: "sponsor-docs/inquiry-x.pdf", MIME: "application/pdf", SizeBytes: 1234, SHA256: hash}}
	if err := inq.Create(ctx, b, nil); err != nil {
		t.Fatalf("create with file: %v", err)
	}
	got, err = inq.GetByID(ctx, b.ID)
	if err != nil || got.File == nil || *got.File != *b.File {
		t.Fatalf("get with file: %v %+v", err, got)
	}
	if got, err = inq.GetByID(ctx, a.ID); err != nil || got.File != nil {
		t.Fatalf("typed inquiry must have no file: %v %+v", err, got)
	}
	if err := inq.Create(ctx, &domain.SponsorInquiry{Name: "x", Phone: "0812345678", Kind: domain.SponsorKindMoney,
		File: &domain.SponsorInquiryFile{Path: "sponsor-docs/x.svg", MIME: "image/svg+xml", SizeBytes: 1, SHA256: hash}}, nil); err == nil {
		t.Fatal("file CHECK constraint must reject an SVG")
	}
	if _, err := inq.GetByID(ctx, 9999); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing inquiry: want ErrNotFound, got %v", err)
	}
	deleted, err := inq.Delete(ctx, b.ID, nil)
	if err != nil || deleted.File == nil || deleted.File.Path != b.File.Path {
		t.Fatalf("delete with file must return its path: %v %+v", err, deleted)
	}

	if _, err := inq.Delete(ctx, a.ID, nil); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := inq.Delete(ctx, a.ID, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("second delete: want ErrNotFound, got %v", err)
	}
}

func TestSponsorDeskPostgres_Donations(t *testing.T) {
	_, don, countAudit := setupSponsorDeskRepos(t)
	ctx := context.Background()

	amount := "1500.50"
	d, err := don.Create(ctx, domain.SponsorDonationFields{
		DonorName: "บริษัท ก", Kind: domain.SponsorKindMoney, Amount: &amount, DonatedOn: "2026-11-20",
		TaxID: "1101700203450", AddressLine: "63 หมู่ 4", Subdistrict: "หนองหาร",
		District: "สันทราย", Province: "เชียงใหม่", Postcode: "50290",
	}, &domain.AuditEntry{Action: domain.AuditSponsorDonationCreate, TargetType: domain.AuditTargetSponsorDonation})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if d.Amount == nil || *d.Amount != "1500.5" || d.DonatedOn != "2026-11-20" || d.FacultySubmittedAt != nil ||
		d.TaxID != "1101700203450" || d.Province != "เชียงใหม่" || d.Postcode != "50290" {
		t.Fatalf("created = %+v", d)
	}

	updBefore := countAudit(string(domain.AuditSponsorDonationUpdate))
	upd, err := don.Update(ctx, d.ID, domain.SponsorDonationFields{
		DonorName: "บริษัท ก", Kind: domain.SponsorKindMoney, Amount: d.Amount, DonatedOn: "",
		TaxID: "0105558001231", AddressLine: "99 ถ.ห้วยแก้ว", Subdistrict: "สุเทพ",
		District: "เมืองเชียงใหม่", Province: "เชียงใหม่", Postcode: "50200",
		FacultySubmitted: true,
	}, &domain.AuditEntry{Action: domain.AuditSponsorDonationUpdate, TargetType: domain.AuditTargetSponsorDonation})
	if err != nil || upd.FacultySubmittedAt == nil || upd.DonatedOn != "" ||
		upd.TaxID != "0105558001231" || upd.AddressLine != "99 ถ.ห้วยแก้ว" || upd.Postcode != "50200" {
		t.Fatalf("update: %v %+v", err, upd)
	}
	if countAudit(string(domain.AuditSponsorDonationUpdate))-updBefore != 1 {
		t.Fatal("update audit row missing")
	}

	file := domain.SponsorDonationFile{Kind: domain.SponsorFileSigned, Path: "sponsor-docs/a.pdf", MIME: "application/pdf", SizeBytes: 10, SHA256: strings.Repeat("a", 64)}
	got, old, err := don.PutFile(ctx, d.ID, file, nil)
	if err != nil || old != "" || got.Signed == nil || got.Signed.Path != file.Path {
		t.Fatalf("put file: %v old=%q %+v", err, old, got)
	}
	file.Path = "sponsor-docs/b.pdf"
	if _, old, err = don.PutFile(ctx, d.ID, file, nil); err != nil || old != "sponsor-docs/a.pdf" {
		t.Fatalf("replace file: %v old=%q", err, old)
	}
	bad := file
	bad.Kind, bad.MIME = domain.SponsorFileSlip, "image/svg+xml"
	if _, _, err := don.PutFile(ctx, d.ID, bad, nil); err == nil {
		t.Fatal("mime CHECK constraint must reject svg")
	}
	if _, _, err := don.DeleteFile(ctx, d.ID, domain.SponsorFileSlip, nil); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("delete missing file: want ErrNotFound, got %v", err)
	}

	list, err := don.List(ctx)
	if err != nil || len(list) != 1 || list[0].Signed == nil {
		t.Fatalf("list: %v %+v", err, list)
	}
	deleted, err := don.Delete(ctx, d.ID, nil)
	if err != nil || deleted.Signed == nil || deleted.Signed.Path != "sponsor-docs/b.pdf" {
		t.Fatalf("delete: %v %+v", err, deleted)
	}
	if _, err := don.GetByID(ctx, d.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted donation: want ErrNotFound, got %v", err)
	}
}
