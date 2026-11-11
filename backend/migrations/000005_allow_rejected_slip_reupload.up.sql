-- ComCamp 25th - A rejected slip no longer blocks its own image.
-- uq_payments_slip_hash (000002) covered every row, so a genuine slip that staff rejected by
-- mistake could never be sent again: the student got 409 DUPLICATE_SLIP for the same bank slip.
-- The index now covers only slips that still count (PENDING, APPROVED). Two live slips with one
-- hash are still impossible, and the REJECTED row stays in the ledger with its hash.
-- Deploy together with (or before) the matching backend build, whose duplicate pre-check ignores
-- REJECTED rows in the same way.

BEGIN;

DROP INDEX IF EXISTS uq_payments_slip_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments (slip_hash)
    WHERE slip_hash IS NOT NULL AND status <> 'REJECTED';

COMMIT;
