-- 00013_add_parent_ot.sql
-- Add self-referencing relationship to support subcontracts (child OTs)

ALTER TABLE work_orders
ADD COLUMN IF NOT EXISTS parent_work_order_id UUID REFERENCES work_orders(id);

-- Add index for faster lookup of subcontracts
CREATE INDEX IF NOT EXISTS idx_work_orders_parent_id ON work_orders(parent_work_order_id);

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
