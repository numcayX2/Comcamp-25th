-- ComCamp 25th - Restore multi-role admin RBAC constraint
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
UPDATE admins SET role = 'superadmin' WHERE role = 'admin';
ALTER TABLE admins ALTER COLUMN role SET DEFAULT 'staff';
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('superadmin', 'staff', 'finance', 'reviewer'));
