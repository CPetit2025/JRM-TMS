-- Renombrar columnas para homologarlas con transport_request_items
ALTER TABLE public.products 
RENAME COLUMN default_weight TO weight;

ALTER TABLE public.products 
RENAME COLUMN default_volume TO volume_m3;

-- Agregar nuevas columnas solicitadas
ALTER TABLE public.products 
ADD COLUMN IF NOT EXISTS color VARCHAR(50),
ADD COLUMN IF NOT EXISTS length_m DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS width_m DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS thickness_m DECIMAL(10,2) DEFAULT 0;
