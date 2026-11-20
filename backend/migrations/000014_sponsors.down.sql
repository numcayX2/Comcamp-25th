-- Reverts 000014_sponsors.

BEGIN;

DROP TABLE IF EXISTS sponsors;

COMMIT;
