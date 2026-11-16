-- ComCamp 25th - Update official camp fee to 1,200.00 THB.
BEGIN;

ALTER TABLE settings ALTER COLUMN camp_fee SET DEFAULT 1200.00;

UPDATE settings
SET camp_fee = 1200.00,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1 AND camp_fee = 1000.00;

COMMIT;
