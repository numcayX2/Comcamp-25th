BEGIN;

DROP TABLE IF EXISTS audit_logs;

DROP INDEX IF EXISTS uq_applicants_email;
ALTER TABLE applicants ADD CONSTRAINT applicants_email_key UNIQUE (email);

DROP INDEX IF EXISTS uq_applicants_idempotency_key;
ALTER TABLE applicants DROP COLUMN IF EXISTS idempotency_key;

DROP INDEX IF EXISTS uq_payments_slip_hash;
ALTER TABLE payments ALTER COLUMN slip_hash TYPE VARCHAR(64);

COMMIT;
