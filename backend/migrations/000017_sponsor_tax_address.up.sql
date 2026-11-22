-- ComCamp 25th - Store Thai tax ID / national ID (13 digits, checksum-verified) and structured
-- Thai address on money sponsor inquiries and staff-recorded sponsor donations so staff can
-- prepare faculty tax-deduction documents. Goods donations leave all six columns empty.
-- Never returned by public endpoints, never sent in notification emails, and never written as
-- values in audit_logs.
-- Additive only and safe with the previous backend running (it never selects these columns).
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000017_sponsor_tax_address.up.sql

BEGIN;

ALTER TABLE sponsor_inquiries
    ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_line TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_subdistrict TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_district TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_province TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_postcode TEXT NOT NULL DEFAULT '';

ALTER TABLE sponsor_donations
    ADD COLUMN IF NOT EXISTS tax_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_line TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_subdistrict TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_district TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_province TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS address_postcode TEXT NOT NULL DEFAULT '';

COMMIT;
