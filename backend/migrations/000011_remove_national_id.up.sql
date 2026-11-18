-- ComCamp 25th - PDPA: national ID numbers leave the system.
--  * applicants.national_id and its live-row unique index (000003) are dropped, and national IDs
--    copied into audit_logs.details (top-level "nationalId", changes.nationalId) are scrubbed. The application code
--    (CC25-XXXXXX) is now the applicant's proof on /status (slip upload, confirm, withdraw), so the
--    column has no remaining purpose. Dropping it discards the stored IDs on purpose; the migration
--    works the same with or without applicant rows present.
--  * A live application stays unique by phone (uq_applicants_phone_live) and by non-empty email
--    (uq_applicants_email), both created in 000003 for live rows only. They are checked below and
--    left exactly as they are; the migration refuses to run without them.
--  * settings defaults follow the owner-approved launch: registration opens 19 Nov 2026 09:00 (+07)
--    and the camp has 40 seats. The singleton row is updated only while it still holds a known stale
--    value, so whatever staff already set in /admin is never overwritten. registration_close_at and
--    camp_fee are not touched.
--
-- Deploy order: stop the backend, apply this file, then start the matching backend build. The new
-- build no longer writes national_id (NOT NULL before this migration), and an older build cannot
-- read a table without it.
-- On an existing volume this must be applied by hand (docker-entrypoint-initdb.d only runs on an
-- empty one), e.g. psql ... < backend/migrations/000011_remove_national_id.up.sql

BEGIN;

DO $$
BEGIN
    IF to_regclass('uq_applicants_phone_live') IS NULL THEN
        RAISE EXCEPTION '000011: uq_applicants_phone_live is missing; apply 000003 first (live phone uniqueness)';
    END IF;
    IF to_regclass('uq_applicants_email') IS NULL THEN
        RAISE EXCEPTION '000011: uq_applicants_email is missing; apply 000003 first (live email uniqueness)';
    END IF;
END $$;

DROP INDEX IF EXISTS uq_applicants_national_id_live;
ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_national_id_key;
ALTER TABLE applicants DROP COLUMN IF EXISTS national_id;

-- National IDs that earlier builds copied into audit_logs.details (JSONB, see 000002): the
-- top-level "nationalId" key (e.g. application.delete snapshots) and changes.nationalId (old -> new
-- from application.profile.update). Only that key is removed; the rest of each audit row stays.
UPDATE audit_logs SET details = details - 'nationalId' WHERE details ? 'nationalId';
UPDATE audit_logs SET details = details #- '{changes,nationalId}' WHERE details->'changes' ? 'nationalId';

ALTER TABLE settings
    ALTER COLUMN registration_open_at SET DEFAULT '2026-11-19 09:00:00+07',
    ALTER COLUMN max_capacity SET DEFAULT 40;

UPDATE settings
SET registration_open_at = '2026-11-19 09:00:00+07',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
  AND registration_open_at IN ('2026-11-16 00:00:00+07', '2026-11-18 00:00:00+07');

UPDATE settings
SET max_capacity = 40,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
  AND max_capacity = 30;

COMMIT;
