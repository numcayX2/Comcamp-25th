-- Fails if a withdrawn applicant has since registered again (two rows share an identity);
-- remove the soft-deleted duplicates first.
BEGIN;

DROP INDEX IF EXISTS uq_applicants_email;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_email ON applicants (email) WHERE email <> '';

DROP INDEX IF EXISTS uq_applicants_phone_live;
ALTER TABLE applicants ADD CONSTRAINT applicants_phone_key UNIQUE (phone);

DROP INDEX IF EXISTS uq_applicants_national_id_live;
ALTER TABLE applicants ADD CONSTRAINT applicants_national_id_key UNIQUE (national_id);

COMMIT;
