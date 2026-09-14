-- Migration: Add Destination Address to Contracts
-- Description: Agrega el campo de dirección exacta de destino a los contratos

ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS destination_address VARCHAR(255);

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
