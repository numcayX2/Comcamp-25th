-- ComCamp 25th - Update default registration open/close schedule to 18 Nov - 18 Dec 2026 (+07).
BEGIN;

ALTER TABLE settings
    ALTER COLUMN registration_open_at SET DEFAULT '2026-11-18 00:00:00+07',
    ALTER COLUMN registration_close_at SET DEFAULT '2026-12-18 23:59:59+07';

UPDATE settings
SET registration_open_at = '2026-11-18 00:00:00+07',
    registration_close_at = '2026-12-18 23:59:59+07',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1
  AND registration_open_at = '2026-11-16 00:00:00+07'
  AND registration_close_at = '2026-11-30 23:59:59+07';

COMMIT;
