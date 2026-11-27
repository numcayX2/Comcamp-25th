-- ComCamp 25th - Sponsor logo becomes optional (name-only sponsors, e.g. individual donors).
-- Additive and safe with the previous backend running: existing rows keep their logo, and the old
-- backend only fails to list sponsors once a name-only row exists (created by the new backend).
-- Re-runnable. On an existing volume apply it by hand (see deploy/RUNBOOK.md):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000020_sponsor_logo_optional.up.sql

BEGIN;

ALTER TABLE sponsors
    ALTER COLUMN logo_path DROP NOT NULL,
    ALTER COLUMN logo_mime DROP NOT NULL,
    ALTER COLUMN logo_hash DROP NOT NULL;

-- A sponsor has either a complete logo (path + mime + hash) or none at all.
ALTER TABLE sponsors DROP CONSTRAINT IF EXISTS sponsors_logo_all_or_none;
ALTER TABLE sponsors ADD CONSTRAINT sponsors_logo_all_or_none CHECK (
    (logo_path IS NULL AND logo_mime IS NULL AND logo_hash IS NULL)
    OR (logo_path IS NOT NULL AND logo_mime IS NOT NULL AND logo_hash IS NOT NULL)
);

COMMIT;
