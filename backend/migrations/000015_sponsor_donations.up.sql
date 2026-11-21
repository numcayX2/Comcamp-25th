-- ComCamp 25th - Sponsor inquiries (public /sponsor form), staff notification addresses, and
-- donations recorded by staff in /admin with their signed form / transfer slip scans.
-- Tax ID / national ID is never stored (the printed faculty form leaves that line blank).
-- Additive only and safe with the previous backend running.
-- On an existing volume apply it by hand (docker-entrypoint-initdb.d only runs on an empty one):
--   psql -v ON_ERROR_STOP=1 ... < backend/migrations/000015_sponsor_donations.up.sql

BEGIN;

CREATE TABLE IF NOT EXISTS sponsor_inquiries (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    phone VARCHAR(10) NOT NULL,
    email VARCHAR(150) NOT NULL DEFAULT '',
    kind VARCHAR(10) NOT NULL,
    details VARCHAR(500) NOT NULL DEFAULT '',
    handled_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sponsor_inquiries_kind_check CHECK (kind IN ('money', 'goods'))
);

CREATE INDEX IF NOT EXISTS idx_sponsor_inquiries_created ON sponsor_inquiries (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sponsor_notify_emails (
    email VARCHAR(150) PRIMARY KEY,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sponsor_donations (
    id BIGSERIAL PRIMARY KEY,
    donor_name VARCHAR(200) NOT NULL,
    address VARCHAR(500) NOT NULL DEFAULT '',
    phone VARCHAR(20) NOT NULL DEFAULT '',
    kind VARCHAR(10) NOT NULL,
    amount NUMERIC(12, 2) NULL,
    goods_description VARCHAR(500) NOT NULL DEFAULT '',
    donated_on DATE NULL,
    note VARCHAR(500) NOT NULL DEFAULT '',
    faculty_submitted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sponsor_donations_kind_check CHECK (kind IN ('money', 'goods')),
    CONSTRAINT sponsor_donations_amount_check CHECK (amount IS NULL OR amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sponsor_donations_created ON sponsor_donations (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS sponsor_donation_files (
    donation_id BIGINT NOT NULL REFERENCES sponsor_donations (id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL,
    path VARCHAR(255) NOT NULL,
    mime VARCHAR(30) NOT NULL,
    size_bytes INT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (donation_id, kind),
    CONSTRAINT sponsor_donation_files_kind_check CHECK (kind IN ('signed', 'slip')),
    CONSTRAINT sponsor_donation_files_mime_check CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'))
);

COMMIT;
