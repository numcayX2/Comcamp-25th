-- ComCamp 25th - Money sponsors transfer first, then send the /sponsor form with the transfer slip
-- (JPEG/PNG/WebP, re-encoded in the browser, at most 1.5 MB). The file lives in
-- UPLOAD_DIR/sponsor-docs (never public, streamed to staff only through
-- GET /api/admin/sponsor-inquiries/{id}/slip); this row keeps its relative path and metadata.
-- All four columns are NULL together (goods inquiries and older rows) or set together.
-- Additive only and safe with the previous backend running (it never selects these columns).
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000019_sponsor_inquiry_slip.up.sql

BEGIN;

ALTER TABLE sponsor_inquiries
    ADD COLUMN IF NOT EXISTS slip_path VARCHAR(255) NULL,
    ADD COLUMN IF NOT EXISTS slip_mime VARCHAR(30) NULL,
    ADD COLUMN IF NOT EXISTS slip_size INTEGER NULL,
    ADD COLUMN IF NOT EXISTS slip_sha256 CHAR(64) NULL;

ALTER TABLE sponsor_inquiries DROP CONSTRAINT IF EXISTS sponsor_inquiries_slip_check;
ALTER TABLE sponsor_inquiries ADD CONSTRAINT sponsor_inquiries_slip_check CHECK (
    (slip_path IS NULL AND slip_mime IS NULL AND slip_size IS NULL AND slip_sha256 IS NULL)
    OR (
        slip_path IS NOT NULL
        AND slip_mime IN ('image/jpeg', 'image/png', 'image/webp')
        AND slip_size > 0
        AND slip_sha256 IS NOT NULL
    )
);

COMMIT;
