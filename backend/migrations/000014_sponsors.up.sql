-- ComCamp 25th - Sponsors table for landing page sponsor logos and admin management.
-- Additive only and safe with the previous backend running.
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000014_sponsors.up.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sponsors (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    url VARCHAR(500) NOT NULL DEFAULT '',
    show_name BOOLEAN NOT NULL DEFAULT false,
    sort_order INT NOT NULL DEFAULT 0,
    logo_path VARCHAR(255) NOT NULL,
    logo_mime VARCHAR(20) NOT NULL,
    logo_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sponsors_logo_mime_check CHECK (logo_mime IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT sponsors_url_check CHECK (url = '' OR url ~* '^https?://')
);

CREATE INDEX IF NOT EXISTS idx_sponsors_sort_order ON sponsors (sort_order, id);

COMMIT;
