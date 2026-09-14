-- Migration: Add Destination to Contracts
-- Description: Agrega los campos de destino (Region/Provincia/Distrito) a los contratos para futura cotización

ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS destination_department VARCHAR(100),
ADD COLUMN IF NOT EXISTS destination_province VARCHAR(100),
ADD COLUMN IF NOT EXISTS destination_district VARCHAR(100);

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
