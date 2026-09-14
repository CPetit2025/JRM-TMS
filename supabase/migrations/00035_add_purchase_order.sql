-- Migration: Add Purchase Order to Transport Requests
ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS purchase_order VARCHAR(100);

NOTIFY pgrst, 'reload schema';
