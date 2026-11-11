-- Reverts 000004. Rows already in REFUND_PENDING / REFUNDED would violate the old CHECK, so they
-- are folded into REJECTED first (both release the seat). The status log keeps the original values.

BEGIN;

UPDATE applicants SET status = 'REJECTED' WHERE status IN ('REFUND_PENDING', 'REFUNDED');

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_status_check;
ALTER TABLE applicants ADD CONSTRAINT applicants_status_check
    CHECK (status IN ('PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED'));

ALTER TABLE applicants ALTER COLUMN status SET DEFAULT 'PENDING';

COMMIT;
