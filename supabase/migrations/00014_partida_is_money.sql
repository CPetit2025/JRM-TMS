-- Add budget_amount as a numeric column representing the monetary cost/budget of the work order
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(15, 2) DEFAULT 0.00;

-- Optional: Since transport_budget_id is no longer needed, we could drop it, but to be safe we'll leave it 
-- as nullable so we don't break any legacy views, though we will ignore it in the app from now on.
