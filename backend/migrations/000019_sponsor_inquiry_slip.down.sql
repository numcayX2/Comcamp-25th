-- Reverts 000019. Deploy the previous backend first. Slips already sent stay in
-- UPLOAD_DIR/sponsor-docs/inquiry-slip-*; remove them by hand if they are no longer needed.

BEGIN;

ALTER TABLE sponsor_inquiries DROP CONSTRAINT IF EXISTS sponsor_inquiries_slip_check;
ALTER TABLE sponsor_inquiries
    DROP COLUMN IF EXISTS slip_path,
    DROP COLUMN IF EXISTS slip_mime,
    DROP COLUMN IF EXISTS slip_size,
    DROP COLUMN IF EXISTS slip_sha256;

COMMIT;
