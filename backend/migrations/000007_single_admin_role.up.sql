-- ComCamp 25th - Simplify admin RBAC to a single 'admin' role
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
UPDATE admins SET role = 'admin' WHERE role <> 'admin';
ALTER TABLE admins ALTER COLUMN role SET DEFAULT 'admin';
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('admin'));
