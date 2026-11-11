-- Reverts 000006: uq_payments_slip_hash goes back to the 000005 definition and the flag is dropped.
-- Since 000006 a slip of a deleted application may share its hash with a live slip (the same image
-- sent again after registering again), or with a slip of another deleted application. The 000005
-- index would reject those rows, so a flagged, non-REJECTED row gives up its hash when another
-- non-REJECTED row with that hash belongs to a live application, or is a newer row. Live rows are
-- never changed. The flagged row itself, its status and its file stay; only the duplicate detection
-- for that old image is lost.

BEGIN;

UPDATE payments p SET slip_hash = NULL
WHERE p.applicant_deleted
  AND p.status <> 'REJECTED'
  AND p.slip_hash IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM payments q
      WHERE q.slip_hash = p.slip_hash
        AND q.id <> p.id
        AND q.status <> 'REJECTED'
        AND (NOT q.applicant_deleted
             OR q.uploaded_at > p.uploaded_at
             OR (q.uploaded_at = p.uploaded_at AND q.id > p.id))
  );

DROP INDEX IF EXISTS uq_payments_slip_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments (slip_hash)
    WHERE slip_hash IS NOT NULL AND status <> 'REJECTED';

ALTER TABLE payments DROP COLUMN IF EXISTS applicant_deleted;

COMMIT;
