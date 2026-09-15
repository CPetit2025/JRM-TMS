-- 00047_add_dispatch_freight_cost.sql
-- Add freight_cost to dispatches to track the assigned rate for the trip

ALTER TABLE public.dispatches 
ADD COLUMN IF NOT EXISTS freight_cost DECIMAL(10, 2) DEFAULT 0.00;

-- Optionally, add a contract_id if we want to trace exactly which contract was charged
ALTER TABLE public.dispatches
ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL;
