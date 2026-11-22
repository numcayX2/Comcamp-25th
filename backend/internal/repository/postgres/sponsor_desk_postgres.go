package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"comcamp25-backend/internal/domain"
)

var (
	_ domain.SponsorInquiryRepository  = (*SponsorInquiryPostgresRepo)(nil)
	_ domain.SponsorDonationRepository = (*SponsorDonationPostgresRepo)(nil)
)

// SponsorInquiryPostgresRepo stores public sponsor inquiries and the staff notification list.
type SponsorInquiryPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewSponsorInquiryPostgresRepo(pool *pgxpool.Pool) *SponsorInquiryPostgresRepo {
	return &SponsorInquiryPostgresRepo{pool: pool}
}

const inquiryColumns = `id, name, phone, email, kind, details,
	tax_id, address_line, address_subdistrict, address_district, address_province, address_postcode,
	file_path, file_mime, file_size, file_sha256, handled_at, created_at`

func scanInquiry(s scannable) (*domain.SponsorInquiry, error) {
	var i domain.SponsorInquiry
	var path, mime, hash *string
	var size *int
	if err := s.Scan(
		&i.ID, &i.Name, &i.Phone, &i.Email, &i.Kind, &i.Details,
		&i.TaxID, &i.AddressLine, &i.Subdistrict, &i.District, &i.Province, &i.Postcode,
		&path, &mime, &size, &hash, &i.HandledAt, &i.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	if path != nil && mime != nil && size != nil && hash != nil {
		i.File = &domain.SponsorInquiryFile{Path: *path, MIME: *mime, SizeBytes: *size, SHA256: *hash}
	}
	return &i, nil
}

func auditWithTarget(audit *domain.AuditEntry, id int64) *domain.AuditEntry {
	entry := cloneAuditEntry(audit)
	if entry.TargetID == "" && id > 0 {
		entry.TargetID = strconv.FormatInt(id, 10)
	}
	return entry
}

func (r *SponsorInquiryPostgresRepo) Create(ctx context.Context, inq *domain.SponsorInquiry, audit *domain.AuditEntry) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var path, mime, hash *string
	var size *int
	if f := inq.File; f != nil {
		path, mime, size, hash = &f.Path, &f.MIME, &f.SizeBytes, &f.SHA256
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO sponsor_inquiries (
			name, phone, email, kind, details,
			tax_id, address_line, address_subdistrict, address_district, address_province, address_postcode,
			file_path, file_mime, file_size, file_sha256
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		RETURNING id, created_at
	`, inq.Name, inq.Phone, inq.Email, inq.Kind, inq.Details,
		inq.TaxID, inq.AddressLine, inq.Subdistrict, inq.District, inq.Province, inq.Postcode,
		path, mime, size, hash).Scan(&inq.ID, &inq.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert sponsor inquiry: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, inq.ID)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *SponsorInquiryPostgresRepo) List(ctx context.Context) ([]*domain.SponsorInquiry, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+inquiryColumns+` FROM sponsor_inquiries ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list sponsor inquiries: %w", err)
	}
	defer rows.Close()
	list := make([]*domain.SponsorInquiry, 0)
	for rows.Next() {
		i, err := scanInquiry(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, i)
	}
	return list, rows.Err()
}

func (r *SponsorInquiryPostgresRepo) GetByID(ctx context.Context, id int64) (*domain.SponsorInquiry, error) {
	return scanInquiry(r.pool.QueryRow(ctx, `SELECT `+inquiryColumns+` FROM sponsor_inquiries WHERE id = $1`, id))
}

func (r *SponsorInquiryPostgresRepo) SetHandled(ctx context.Context, id int64, handled bool, audit *domain.AuditEntry) (*domain.SponsorInquiry, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	inq, err := scanInquiry(tx.QueryRow(ctx, `
		UPDATE sponsor_inquiries
		SET handled_at = CASE WHEN $2 THEN COALESCE(handled_at, now()) ELSE NULL END
		WHERE id = $1
		RETURNING `+inquiryColumns, id, handled))
	if err != nil {
		return nil, err
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, id)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return inq, nil
}

func (r *SponsorInquiryPostgresRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.SponsorInquiry, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	inq, err := scanInquiry(tx.QueryRow(ctx, `DELETE FROM sponsor_inquiries WHERE id = $1 RETURNING `+inquiryColumns, id))
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("delete sponsor inquiry: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, id)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return inq, nil
}

func (r *SponsorInquiryPostgresRepo) ListNotifyEmails(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx, `SELECT email FROM sponsor_notify_emails ORDER BY sort_order, email`)
	if err != nil {
		return nil, fmt.Errorf("list sponsor notify emails: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (r *SponsorInquiryPostgresRepo) ReplaceNotifyEmails(ctx context.Context, emails []string, audit *domain.AuditEntry) ([]string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Serialise concurrent replacements so the delete + insert pairs cannot interleave.
	if _, err := tx.Exec(ctx, `LOCK TABLE sponsor_notify_emails IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return nil, fmt.Errorf("lock sponsor notify emails: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sponsor_notify_emails`); err != nil {
		return nil, fmt.Errorf("clear sponsor notify emails: %w", err)
	}
	for i, e := range emails {
		if _, err := tx.Exec(ctx, `INSERT INTO sponsor_notify_emails (email, sort_order) VALUES ($1, $2)`, e, i); err != nil {
			return nil, fmt.Errorf("insert sponsor notify email: %w", err)
		}
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, cloneAuditEntry(audit)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return append([]string{}, emails...), nil
}

// SponsorDonationPostgresRepo stores staff-recorded donations and their file metadata.
type SponsorDonationPostgresRepo struct {
	pool *pgxpool.Pool
}

func NewSponsorDonationPostgresRepo(pool *pgxpool.Pool) *SponsorDonationPostgresRepo {
	return &SponsorDonationPostgresRepo{pool: pool}
}

// amount is read with trailing zeros trimmed ("1200", "1500.5"); donated_on as "YYYY-MM-DD" or "".
const donationColumns = `id, donor_name, address, phone, kind, trim_scale(amount)::text, goods_description,
	COALESCE(to_char(donated_on, 'YYYY-MM-DD'), ''), note,
	tax_id, address_line, address_subdistrict, address_district, address_province, address_postcode,
	faculty_submitted_at, created_at, updated_at`

const donationFileColumns = `donation_id, kind, path, mime, size_bytes, sha256, uploaded_at`

func scanDonation(s scannable) (*domain.SponsorDonation, error) {
	var d domain.SponsorDonation
	err := s.Scan(&d.ID, &d.DonorName, &d.Address, &d.Phone, &d.Kind, &d.Amount, &d.GoodsDescription,
		&d.DonatedOn, &d.Note,
		&d.TaxID, &d.AddressLine, &d.Subdistrict, &d.District, &d.Province, &d.Postcode,
		&d.FacultySubmittedAt, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	return &d, nil
}

func attachDonationFile(d *domain.SponsorDonation, f *domain.SponsorDonationFile) {
	switch f.Kind {
	case domain.SponsorFileSigned:
		d.Signed = f
	case domain.SponsorFileSlip:
		d.Slip = f
	}
}

type queryer interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// loadDonationFiles attaches file rows to the donations (all of them when ids is nil).
func loadDonationFiles(ctx context.Context, q queryer, byID map[int64]*domain.SponsorDonation, ids []int64) error {
	var (
		rows pgx.Rows
		err  error
	)
	if ids == nil {
		rows, err = q.Query(ctx, `SELECT `+donationFileColumns+` FROM sponsor_donation_files`)
	} else {
		rows, err = q.Query(ctx, `SELECT `+donationFileColumns+` FROM sponsor_donation_files WHERE donation_id = ANY($1)`, ids)
	}
	if err != nil {
		return fmt.Errorf("load sponsor donation files: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id int64
			f  domain.SponsorDonationFile
		)
		if err := rows.Scan(&id, &f.Kind, &f.Path, &f.MIME, &f.SizeBytes, &f.SHA256, &f.UploadedAt); err != nil {
			return err
		}
		if d := byID[id]; d != nil {
			attachDonationFile(d, &f)
		}
	}
	return rows.Err()
}

func getDonation(ctx context.Context, q queryer, id int64, forUpdate bool) (*domain.SponsorDonation, error) {
	sql := `SELECT ` + donationColumns + ` FROM sponsor_donations WHERE id = $1`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	d, err := scanDonation(q.QueryRow(ctx, sql, id))
	if err != nil {
		return nil, err
	}
	if err := loadDonationFiles(ctx, q, map[int64]*domain.SponsorDonation{id: d}, []int64{id}); err != nil {
		return nil, err
	}
	return d, nil
}

func (r *SponsorDonationPostgresRepo) List(ctx context.Context) ([]*domain.SponsorDonation, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+donationColumns+` FROM sponsor_donations ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list sponsor donations: %w", err)
	}
	list := make([]*domain.SponsorDonation, 0)
	byID := map[int64]*domain.SponsorDonation{}
	for rows.Next() {
		d, err := scanDonation(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, d)
		byID[d.ID] = d
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return list, nil
	}
	if err := loadDonationFiles(ctx, r.pool, byID, nil); err != nil {
		return nil, err
	}
	return list, nil
}

func (r *SponsorDonationPostgresRepo) GetByID(ctx context.Context, id int64) (*domain.SponsorDonation, error) {
	return getDonation(ctx, r.pool, id, false)
}

func (r *SponsorDonationPostgresRepo) Create(ctx context.Context, f domain.SponsorDonationFields, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	d, err := scanDonation(tx.QueryRow(ctx, `
		INSERT INTO sponsor_donations (
			donor_name, address, phone, kind, amount, goods_description, donated_on, note,
			tax_id, address_line, address_subdistrict, address_district, address_province, address_postcode,
			faculty_submitted_at
		)
		VALUES ($1, $2, $3, $4, $5::text::numeric, $6, NULLIF($7, '')::date, $8,
			$9, $10, $11, $12, $13, $14, CASE WHEN $15 THEN now() ELSE NULL END)
		RETURNING `+donationColumns,
		f.DonorName, f.Address, f.Phone, f.Kind, f.Amount, f.GoodsDescription, f.DonatedOn, f.Note,
		f.TaxID, f.AddressLine, f.Subdistrict, f.District, f.Province, f.Postcode, f.FacultySubmitted))
	if err != nil {
		return nil, fmt.Errorf("insert sponsor donation: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, d.ID)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return d, nil
}

func (r *SponsorDonationPostgresRepo) Update(ctx context.Context, id int64, f domain.SponsorDonationFields, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	before, err := getDonation(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	changed := before.ChangedFields(f)

	if _, err := tx.Exec(ctx, `
		UPDATE sponsor_donations SET
			donor_name = $2, address = $3, phone = $4, kind = $5, amount = $6::text::numeric,
			goods_description = $7, donated_on = NULLIF($8, '')::date, note = $9,
			tax_id = $10, address_line = $11, address_subdistrict = $12, address_district = $13,
			address_province = $14, address_postcode = $15,
			faculty_submitted_at = CASE WHEN $16 THEN COALESCE(faculty_submitted_at, now()) ELSE NULL END,
			updated_at = now()
		WHERE id = $1
	`, id, f.DonorName, f.Address, f.Phone, f.Kind, f.Amount, f.GoodsDescription, f.DonatedOn, f.Note,
		f.TaxID, f.AddressLine, f.Subdistrict, f.District, f.Province, f.Postcode, f.FacultySubmitted); err != nil {
		return nil, fmt.Errorf("update sponsor donation: %w", err)
	}
	if audit != nil {
		entry := auditWithTarget(audit, id)
		entry.Details["fields"] = changed
		if err := insertAudit(ctx, tx, entry); err != nil {
			return nil, err
		}
	}
	updated, err := getDonation(ctx, tx, id, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

func (r *SponsorDonationPostgresRepo) Delete(ctx context.Context, id int64, audit *domain.AuditEntry) (*domain.SponsorDonation, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	existing, err := getDonation(ctx, tx, id, true)
	if err != nil {
		return nil, err
	}
	// sponsor_donation_files rows go with ON DELETE CASCADE.
	if _, err := tx.Exec(ctx, `DELETE FROM sponsor_donations WHERE id = $1`, id); err != nil {
		return nil, fmt.Errorf("delete sponsor donation: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, id)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return existing, nil
}

func (r *SponsorDonationPostgresRepo) PutFile(ctx context.Context, id int64, file domain.SponsorDonationFile, audit *domain.AuditEntry) (*domain.SponsorDonation, string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)

	before, err := getDonation(ctx, tx, id, true)
	if err != nil {
		return nil, "", err
	}
	oldPath := ""
	if old := donationFile(before, file.Kind); old != nil {
		oldPath = old.Path
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sponsor_donation_files (donation_id, kind, path, mime, size_bytes, sha256, uploaded_at)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (donation_id, kind) DO UPDATE SET
			path = EXCLUDED.path, mime = EXCLUDED.mime, size_bytes = EXCLUDED.size_bytes,
			sha256 = EXCLUDED.sha256, uploaded_at = EXCLUDED.uploaded_at
	`, id, file.Kind, file.Path, file.MIME, file.SizeBytes, file.SHA256); err != nil {
		return nil, "", fmt.Errorf("upsert sponsor donation file: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, id)); err != nil {
			return nil, "", err
		}
	}
	updated, err := getDonation(ctx, tx, id, false)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return updated, oldPath, nil
}

func (r *SponsorDonationPostgresRepo) DeleteFile(ctx context.Context, id int64, kind string, audit *domain.AuditEntry) (*domain.SponsorDonation, string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback(ctx)

	if _, err := getDonation(ctx, tx, id, true); err != nil {
		return nil, "", err
	}
	var oldPath string
	err = tx.QueryRow(ctx, `DELETE FROM sponsor_donation_files WHERE donation_id = $1 AND kind = $2 RETURNING path`, id, kind).Scan(&oldPath)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", domain.ErrNotFound
	}
	if err != nil {
		return nil, "", fmt.Errorf("delete sponsor donation file: %w", err)
	}
	if audit != nil {
		if err := insertAudit(ctx, tx, auditWithTarget(audit, id)); err != nil {
			return nil, "", err
		}
	}
	updated, err := getDonation(ctx, tx, id, false)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return updated, oldPath, nil
}

func donationFile(d *domain.SponsorDonation, kind string) *domain.SponsorDonationFile {
	if kind == domain.SponsorFileSigned {
		return d.Signed
	}
	return d.Slip
}
