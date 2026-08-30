-- Add cost and balance to transport_requests
ALTER TABLE public.transport_requests
ADD COLUMN IF NOT EXISTS service_cost DECIMAL(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS service_balance DECIMAL(10, 2) DEFAULT 0.00;
