-- ComCamp 25th - Revert shirt_size constraint back to XS..3XL.
BEGIN;

UPDATE applicants SET shirt_size = 'S' WHERE shirt_size IN ('SSS', 'SS');
UPDATE applicants SET shirt_size = '3XL' WHERE shirt_size = '4XL';

ALTER TABLE applicants DROP CONSTRAINT IF EXISTS applicants_shirt_size_check;

ALTER TABLE applicants ADD CONSTRAINT applicants_shirt_size_check
    CHECK (shirt_size IN ('XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'));

COMMIT;
