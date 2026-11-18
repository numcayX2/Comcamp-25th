-- Reverts 000011.
-- DATA LOSS: the national IDs dropped by the up migration are gone for good. The column comes back
-- NULLABLE and NULL for every row (the original was CHAR(13) NOT NULL); the restored live-row unique
-- index ignores NULLs, so existing rows do not collide. A backend build from before 000011 scans
-- national_id into a non-null string and cannot read a row whose value is NULL: before rolling the
-- backend back, staff must fill in or delete every live row created without a national ID.
--
-- Only the column defaults go back (open 18 Nov 2026 00:00 +07 from 000008, 30 seats from 000001).
-- The settings row is left as it is: the values it held before 000011 cannot be known, and lowering
-- max_capacity below the seats already taken must never happen silently. Adjust it in /admin.

BEGIN;

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS national_id CHAR(13);
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_national_id_live ON applicants (national_id) WHERE deleted_at IS NULL;

ALTER TABLE settings
    ALTER COLUMN registration_open_at SET DEFAULT '2026-11-18 00:00:00+07',
    ALTER COLUMN max_capacity SET DEFAULT 30;

COMMIT;
