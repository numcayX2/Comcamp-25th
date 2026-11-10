-- ComCamp 25th - Security hardening (AGENTS.md §13)
-- Apply after 000001_init_schema.up.sql. The API refuses to work against a schema without these
-- columns/tables, so deploy this migration before (or together with) the matching backend build.

BEGIN;

-- §13.4 Slip deduplication enforced by the database, not only by a pre-check that two concurrent
-- uploads could both pass. CHAR(64) = hex SHA-256.
ALTER TABLE payments ALTER COLUMN slip_hash TYPE CHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments (slip_hash) WHERE slip_hash IS NOT NULL;

-- §9.2.4 / §13.4 Idempotent submit: a retried POST with the same X-Idempotency-Key returns the
-- stored application instead of creating a second one.
ALTER TABLE applicants ADD COLUMN IF NOT EXISTS idempotency_key UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_idempotency_key ON applicants (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Email is optional on the registration form, but the original UNIQUE constraint treated ''
-- as a value, so the second applicant without an email was rejected as a duplicate.
ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_email ON applicants (email) WHERE email <> '';

-- §13.6 Audit trail for every staff action (and logins). Written in the same transaction as the
-- change it describes. Treat as append-only: grant the application role INSERT/SELECT only.
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    target_type VARCHAR(30),
    target_id VARCHAR(64),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);

COMMIT;
