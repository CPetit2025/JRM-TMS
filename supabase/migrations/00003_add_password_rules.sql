-- 00003_add_password_rules.sql

-- Add columns for password expiration and temporary flags
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS requires_password_change BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP WITH TIME ZONE;

-- We could enforce this via a database function, but for now it will be enforced in the application layer during login.
