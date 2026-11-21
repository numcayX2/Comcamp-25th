-- ComCamp 25th - A sponsor may send the filled faculty donation form (PDF or a photo/scan) from
-- /sponsor instead of typing the inquiry. The file lives in UPLOAD_DIR/sponsor-docs (never public,
-- streamed to staff only through GET /api/admin/sponsor-inquiries/{id}/file); this row keeps its
-- relative path and metadata. All four columns are NULL together (no file) or set together.
-- Additive only and safe with the previous backend running (it never selects these columns).
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000016_sponsor_inquiry_file.up.sql

BEGIN;

ALTER TABLE sponsor_inquiries
    ADD COLUMN IF NOT EXISTS file_path VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS file_mime VARCHAR(30) NULL,
    ADD COLUMN IF NOT EXISTS file_size INT NULL,
    ADD COLUMN IF NOT EXISTS file_sha256 CHAR(64) NULL;

ALTER TABLE sponsor_inquiries DROP CONSTRAINT IF EXISTS sponsor_inquiries_file_check;
ALTER TABLE sponsor_inquiries ADD CONSTRAINT sponsor_inquiries_file_check CHECK (
    (file_path IS NULL AND file_mime IS NULL AND file_size IS NULL AND file_sha256 IS NULL)
    OR (
        file_path IS NOT NULL
        AND file_mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
        AND file_size > 0
        AND file_sha256 IS NOT NULL
    )
);

COMMIT;
