-- ComCamp 25th - Withdrawn applications release the person's identity.
-- Self-service withdrawal (POST /api/applications/{id}/withdraw) and admin delete both soft-delete
-- the row (deleted_at). The original UNIQUE constraints still counted those rows, so a student who
-- withdrew could never register again with the same national ID, phone or email. Uniqueness now
-- applies to live rows only. application_no and idempotency_key stay globally unique on purpose.

BEGIN;

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_national_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_national_id_live ON applicants (national_id) WHERE deleted_at IS NULL;

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_phone_live ON applicants (phone) WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS uq_applicants_email;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_email ON applicants (email) WHERE email <> '' AND deleted_at IS NULL;

COMMIT;
