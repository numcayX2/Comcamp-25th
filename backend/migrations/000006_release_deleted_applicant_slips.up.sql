-- ComCamp 25th - A deleted or withdrawn application no longer blocks its slip image.
-- Since 000005, uq_payments_slip_hash covers every slip that is not REJECTED. A slip of an
-- application that staff deleted (or the applicant withdrew) kept its PENDING / APPROVED status, and
-- with it the hash, forever: a student who registered again (000003 allows the same national ID)
-- and sent the same genuine bank slip got 409 DUPLICATE_SLIP from an application nobody can see.
--
-- payments.status and payments.slip_hash are not changed (the ledger keeps what happened). A flag
-- set together with applicants.deleted_at takes those rows out of the index instead.
-- Deploy together with (or before) the matching backend build, which sets the flag in SoftDelete
-- and ignores flagged rows in its duplicate pre-check.

BEGIN;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS applicant_deleted BOOLEAN NOT NULL DEFAULT false;

UPDATE payments p SET applicant_deleted = true
FROM applicants a
WHERE a.id = p.applicant_id AND a.deleted_at IS NOT NULL AND NOT p.applicant_deleted;

DROP INDEX IF EXISTS uq_payments_slip_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments (slip_hash)
    WHERE slip_hash IS NOT NULL AND status <> 'REJECTED' AND NOT applicant_deleted;

COMMIT;
