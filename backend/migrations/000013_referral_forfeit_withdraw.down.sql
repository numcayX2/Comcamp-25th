-- Reverts 000013. FORFEITED rows would violate the old CHECK, so they go back to REJECTED (both
-- release the seat); the status log keeps what happened. The referral answers and the deleted reason
-- are dropped with their columns. Deploy the previous backend before running this.

BEGIN;

INSERT INTO applicant_status_logs (applicant_id, changed_by_admin_id, old_status, new_status, reason)
SELECT id, NULL, 'FORFEITED', 'REJECTED', 'migration 000013 down: FORFEITED folded into REJECTED'
FROM applicants
WHERE status = 'FORFEITED';

UPDATE applicants SET status = 'REJECTED' WHERE status = 'FORFEITED';

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_status_check;
ALTER TABLE applicants ADD CONSTRAINT applicants_status_check
    CHECK (status IN ('PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'));

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_deleted_reason_check;
ALTER TABLE applicants DROP COLUMN IF EXISTS deleted_reason;
ALTER TABLE applicants DROP COLUMN IF EXISTS referral_other;
ALTER TABLE applicants DROP COLUMN IF EXISTS referral_sources;

COMMIT;
