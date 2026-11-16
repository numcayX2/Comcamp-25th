-- ComCamp 25th - Expand shirt_size constraint to support IDO IDEA official size chart (SSS, SS, S, M, L, XL, 2XL, 3XL, 4XL; keep XS for backward compatibility).
BEGIN;

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_shirt_size_check;

ALTER TABLE applicants ADD CONSTRAINT applicants_shirt_size_check
    CHECK (shirt_size IN ('SSS', 'SS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'));

COMMIT;
