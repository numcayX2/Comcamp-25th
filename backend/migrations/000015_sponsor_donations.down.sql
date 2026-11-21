-- Reverts 000015_sponsor_donations.

BEGIN;

DROP TABLE IF EXISTS sponsor_donation_files;
DROP TABLE IF EXISTS sponsor_donations;
DROP TABLE IF EXISTS sponsor_notify_emails;
DROP TABLE IF EXISTS sponsor_inquiries;

COMMIT;
