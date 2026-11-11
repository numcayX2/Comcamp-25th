-- ComCamp 25th - First-come-first-served flow + refund statuses.
--  * New applications start as PASSED (the seat is theirs the moment the quota check succeeds),
--    so the column default changes from PENDING to PASSED.
--  * REFUND_PENDING / REFUNDED track an applicant who paid and then cancelled. They are NOT
--    counted against the quota (the backend's countActiveSQL excludes them), but the rows stay
--    for the accounting ledger.
-- Deploy this migration before (or together with) the matching backend build: the new build
-- writes PASSED / REFUND_PENDING / REFUNDED, which the old CHECK constraint would reject.

BEGIN;

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_status_check;
ALTER TABLE applicants ADD CONSTRAINT applicants_status_check
    CHECK (status IN ('PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED', 'REFUND_PENDING', 'REFUNDED'));

ALTER TABLE applicants ALTER COLUMN status SET DEFAULT 'PASSED';

COMMIT;
