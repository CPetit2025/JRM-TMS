-- Add missing columns to clients table
ALTER TABLE clients
ADD COLUMN IF NOT EXISTS email VARCHAR(150),
ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
