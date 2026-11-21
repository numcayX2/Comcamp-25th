-- Reverts 000016. Deploy the previous backend first. Files already sent stay in
-- UPLOAD_DIR/sponsor-docs/inquiry-*; remove them by hand if they are no longer needed.

BEGIN;

ALTER TABLE sponsor_inquiries DROP CONSTRAINT IF EXISTS sponsor_inquiries_file_check;
ALTER TABLE sponsor_inquiries
    DROP COLUMN IF EXISTS file_path,
    DROP COLUMN IF EXISTS file_mime,
    DROP COLUMN IF EXISTS file_size,
    DROP COLUMN IF EXISTS file_sha256;

COMMIT;
