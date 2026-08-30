-- 00012_fix_schema_columns.sql
-- Force add/ensure transport_budget_id exists and is nullable
-- This fixes the issue if the column was accidentally dropped from the Supabase UI

ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS transport_budget_id UUID REFERENCES transport_budgets(id);

-- Make it nullable in case it was created as NOT NULL and was causing issues
ALTER TABLE work_orders
ALTER COLUMN transport_budget_id DROP NOT NULL;

-- Force schema reload
NOTIFY pgrst, 'reload schema';
