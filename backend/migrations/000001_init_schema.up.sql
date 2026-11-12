-- ComCamp 25th - Initial Database Schema Migration
-- Target: PostgreSQL 16+

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. admins table
CREATE TABLE IF NOT EXISTS admins (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(30) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. settings table (Singleton)
CREATE TABLE IF NOT EXISTS settings (
    id INT PRIMARY KEY DEFAULT 1,
    camp_name VARCHAR(150) NOT NULL DEFAULT 'ComCamp 25th',
    registration_open_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-16 00:00:00+07',
    registration_close_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-30 23:59:59+07',
    announcement_at TIMESTAMPTZ,
    payment_open_at TIMESTAMPTZ,
    payment_deadline TIMESTAMPTZ,
    certificate_release_at TIMESTAMPTZ,
    max_capacity INT NOT NULL DEFAULT 30 CHECK (max_capacity > 0),
    camp_fee DECIMAL(10,2) NOT NULL DEFAULT 300.00 CHECK (camp_fee >= 0),
    is_manual_closed BOOLEAN NOT NULL DEFAULT false,
    updated_by_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT single_row_check CHECK (id = 1)
);

-- 3. applicants table
CREATE TABLE IF NOT EXISTS applicants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_no VARCHAR(20) NOT NULL,
    national_id CHAR(13) NOT NULL,
    prefix VARCHAR(20) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    nickname VARCHAR(50) NOT NULL,
    birth_date DATE NOT NULL,
    gender VARCHAR(20) NOT NULL,
    school VARCHAR(150) NOT NULL,
    grade VARCHAR(20) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    email VARCHAR(150) NULL,
    line_id VARCHAR(100),
    
    address_line TEXT,
    subdistrict VARCHAR(100),
    district VARCHAR(100),
    province VARCHAR(100) NOT NULL,
    postal_code VARCHAR(10),

    parent_name VARCHAR(150),
    parent_relation VARCHAR(50),
    parent_phone VARCHAR(20),
    emergency_contact VARCHAR(150) NOT NULL,
    emergency_phone VARCHAR(20) NOT NULL,

    shirt_size VARCHAR(10) NOT NULL CHECK (shirt_size IN ('XS', 'S', 'M', 'L', 'XL', '2XL', '3XL')),
    allergies TEXT,
    medical_conditions TEXT,
    has_laptop BOOLEAN NOT NULL DEFAULT false,
    motivation TEXT,
    portfolio_url TEXT,
    parent_permission_url TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PASSED', 'RESERVE', 'CONFIRMED', 'REJECTED')),
    attendance_confirmed BOOLEAN NOT NULL DEFAULT false,
    certificate_url TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_application_no_active ON applicants(application_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_national_id_active ON applicants(national_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_phone_active ON applicants(phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applicants_email_active ON applicants(email) WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_applicants_status ON applicants(status);
CREATE INDEX IF NOT EXISTS idx_applicants_school ON applicants(school);
CREATE INDEX IF NOT EXISTS idx_applicants_created_at ON applicants(created_at);

-- 4. payments table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    slip_url TEXT NOT NULL,
    amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    trans_ref VARCHAR(100) UNIQUE,
    slip_hash VARCHAR(64),
    transfer_at TIMESTAMPTZ,
    verified_by_api BOOLEAN NOT NULL DEFAULT false,
    verified_by_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    admin_note TEXT,
    rejection_reason TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_slip_hash ON payments(slip_hash) WHERE slip_hash IS NOT NULL AND slip_hash <> '';
CREATE INDEX IF NOT EXISTS idx_payments_applicant_id ON payments(applicant_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- 5. applicant_status_logs table
CREATE TABLE IF NOT EXISTS applicant_status_logs (
    id BIGSERIAL PRIMARY KEY,
    applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    changed_by_admin_id BIGINT REFERENCES admins(id) ON DELETE SET NULL,
    old_status VARCHAR(20) NOT NULL,
    new_status VARCHAR(20) NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_logs_applicant ON applicant_status_logs(applicant_id);

-- Initial Singleton Setting Row
INSERT INTO settings (id, camp_name, registration_open_at, registration_close_at, max_capacity, camp_fee)
VALUES (1, 'ComCamp 25th', '2026-11-16 00:00:00+07', '2026-11-30 23:59:59+07', 30, 300.00)
ON CONFLICT (id) DO NOTHING;
