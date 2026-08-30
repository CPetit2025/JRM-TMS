-- 00007_create_ot_items.sql

CREATE TABLE IF NOT EXISTS work_order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    sku VARCHAR(100),
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_weight NUMERIC(10, 2) DEFAULT 0,
    total_weight NUMERIC(10, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE work_order_items ENABLE ROW LEVEL SECURITY;

-- Add a policy that allows everything (or adjust based on business rules)
CREATE POLICY "Enable all actions for authenticated users" ON work_order_items
    FOR ALL
    TO authenticated
    USING (true);
