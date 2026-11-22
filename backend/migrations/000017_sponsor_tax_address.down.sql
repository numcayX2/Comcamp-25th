-- Reverts 000017. Deploy the previous backend first.

BEGIN;

ALTER TABLE sponsor_inquiries
    DROP COLUMN IF EXISTS tax_id,
    DROP COLUMN IF EXISTS address_line,
    DROP COLUMN IF EXISTS address_subdistrict,
    DROP COLUMN IF EXISTS address_district,
    DROP COLUMN IF EXISTS address_province,
    DROP COLUMN IF EXISTS address_postcode;

ALTER TABLE sponsor_donations
    DROP COLUMN IF EXISTS tax_id,
    DROP COLUMN IF EXISTS address_line,
    DROP COLUMN IF EXISTS address_subdistrict,
    DROP COLUMN IF EXISTS address_district,
    DROP COLUMN IF EXISTS address_province,
    DROP COLUMN IF EXISTS address_postcode;

COMMIT;
