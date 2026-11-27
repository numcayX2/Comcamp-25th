-- Reverts 000020. Deploy the previous backend first. Name-only sponsors (no logo) cannot exist
-- under the old schema, so they are DELETED here; re-add them with a logo if still needed.

BEGIN;

DELETE FROM sponsors WHERE logo_path IS NULL;

ALTER TABLE sponsors DROP CONSTRAINT IF EXISTS sponsors_logo_all_or_none;
ALTER TABLE sponsors
    ALTER COLUMN logo_path SET NOT NULL,
    ALTER COLUMN logo_mime SET NOT NULL,
    ALTER COLUMN logo_hash SET NOT NULL;

COMMIT;
