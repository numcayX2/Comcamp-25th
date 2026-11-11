-- Reverts 000005: uq_payments_slip_hash covers every row again.
-- Since 000005 a REJECTED slip may share its hash with a later slip (usually the same image sent
-- again). The full index would reject those rows, so a REJECTED row gives up its hash when another
-- row with that hash is live, or is a newer rejection. The row itself, its file and its rejection
-- reason stay; only the duplicate detection for that old image is lost.

BEGIN;

UPDATE payments p SET slip_hash = NULL
WHERE p.status = 'REJECTED'
  AND p.slip_hash IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM payments q
      WHERE q.slip_hash = p.slip_hash
        AND q.id <> p.id
        AND (q.status <> 'REJECTED'
             OR q.uploaded_at > p.uploaded_at
             OR (q.uploaded_at = p.uploaded_at AND q.id > p.id))
  );

DROP INDEX IF EXISTS uq_payments_slip_hash;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments (slip_hash) WHERE slip_hash IS NOT NULL;

COMMIT;
