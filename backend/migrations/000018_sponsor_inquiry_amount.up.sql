-- ComCamp 25th - Store the amount (baht, > 0, at most 2 decimals) a money sponsor declares on
-- /sponsor so staff do not have to read it out of the free-text details. Goods inquiries and rows
-- created before this migration keep NULL.
-- Never returned by public endpoints and never written as a value in audit_logs.
-- Additive only and safe with the previous backend running (it never selects this column).
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000018_sponsor_inquiry_amount.up.sql

BEGIN;

ALTER TABLE sponsor_inquiries
    ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) NULL CHECK (amount IS NULL OR amount > 0);

COMMIT;
