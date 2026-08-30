-- 00010_add_missing_ot_cols.sql
-- Add missing columns to work_orders that are used in the UI

ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS contract_administrator_id UUID REFERENCES profiles(id),
ADD COLUMN IF NOT EXISTS origin VARCHAR(255),
ADD COLUMN IF NOT EXISTS destination VARCHAR(255),
ADD COLUMN IF NOT EXISTS cargo_details TEXT;

-- Refresh schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
