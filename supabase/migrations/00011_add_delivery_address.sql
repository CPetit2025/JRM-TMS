-- 00011_add_delivery_address.sql
-- Add delivery_address if it is missing in the actual Supabase database

ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS delivery_address TEXT;

-- Refresh schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
