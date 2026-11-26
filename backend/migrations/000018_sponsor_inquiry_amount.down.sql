-- Reverts 000018. Deploy the previous backend first.

BEGIN;

ALTER TABLE sponsor_inquiries
    DROP COLUMN IF EXISTS amount;

COMMIT;
