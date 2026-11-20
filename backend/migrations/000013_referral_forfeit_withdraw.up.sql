-- ComCamp 25th - referral sources, FORFEITED status and the reason a row was deleted.
--  * applicants.referral_sources / referral_other: where the applicant heard about the camp
--    (allowlisted codes, validated by the backend: service/referral.go). Optional, so rows from
--    older clients keep the empty defaults.
--  * FORFEITED: an application whose seat was released automatically because it was not paid within
--    the deadline. Unlike REJECTED (a staff decision) it is the system's verdict; the row stays live,
--    so the phone and email stay taken and a new registration with either is answered with
--    409 FORFEITED_APPLICATION ("contact staff"). Staff may restore it under the quota lock.
--    Earlier automatic expiries were written as REJECTED; they are converted here (identified by a
--    latest status log with no admin and the automatic-expiry reason) and a status log row records
--    the conversion.
--  * applicants.deleted_reason: why a soft-deleted row was deleted: 'SELF_WITHDRAWN' (the applicant
--    withdrew on /register or /status; may register again) or 'ADMIN_DELETED' (staff delete).
--    Existing deleted rows are backfilled from audit_logs.
-- Additive and safe with the previous backend running: it never writes the new columns and only
-- reads explicit column lists. While it still runs it would count FORFEITED rows as holding a seat
-- (the safe direction: fewer free seats, never more), so deploy the new backend right after.
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000013_referral_forfeit_withdraw.up.sql

BEGIN;

ALTER TABLE applicants ADD COLUMN IF NOT EXISTS referral_sources TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS referral_other VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(20) NOT NULL DEFAULT '';

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_deleted_reason_check;
ALTER TABLE applicants ADD CONSTRAINT applicants_deleted_reason_check
    CHECK (deleted_reason IN ('', 'SELF_WITHDRAWN', 'ADMIN_DELETED'));

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_status_check;
ALTER TABLE applicants ADD CONSTRAINT applicants_status_check
    CHECK (status IN ('PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED', 'FORFEITED'));

-- Backfill deleted_reason: a self-service withdrawal left an application.withdraw.self audit row
-- without an admin; every other deleted row was a staff delete.
UPDATE applicants a
SET deleted_reason = CASE
        WHEN EXISTS (
            SELECT 1 FROM audit_logs l
            WHERE l.action = 'application.withdraw.self'
              AND l.target_type = 'applicant'
              AND l.target_id = a.application_no
              AND l.admin_id IS NULL
        ) THEN 'SELF_WITHDRAWN'
        ELSE 'ADMIN_DELETED'
    END
WHERE a.deleted_at IS NOT NULL AND a.deleted_reason = '';

-- Convert automatic expiries recorded as REJECTED. Only rows whose latest status change is that
-- expiry (or this migration's own down step folding FORFEITED back) are touched: a staff rejection
-- (admin set) or any later change keeps its status. Re-running this file is safe; run it once more
-- right after the new backend is up to convert expiries the previous backend wrote meanwhile.
WITH latest AS (
    SELECT DISTINCT ON (s.applicant_id) s.applicant_id, s.new_status, s.changed_by_admin_id, s.reason
    FROM applicant_status_logs s
    ORDER BY s.applicant_id, s.created_at DESC, s.id DESC
),
expired AS (
    SELECT a.id
    FROM applicants a
    JOIN latest l ON l.applicant_id = a.id
    WHERE a.status = 'REJECTED'
      AND l.new_status = 'REJECTED'
      AND l.changed_by_admin_id IS NULL
      AND (l.reason LIKE 'ตัดสิทธิ์อัตโนมัติ%' OR l.reason LIKE 'migration 000013 down:%')
),
converted AS (
    UPDATE applicants a
    SET status = 'FORFEITED'
    FROM expired e
    WHERE a.id = e.id
    RETURNING a.id
)
INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason)
SELECT id, NULL, 'REJECTED', 'FORFEITED', 'migration 000013: automatic unpaid expiry is now FORFEITED'
FROM converted;

COMMIT;
