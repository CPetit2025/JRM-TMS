-- Añadir campo request_type para diferenciar DESPACHO y RECOJO explicitamente
ALTER TABLE public.transport_requests 
ADD COLUMN IF NOT EXISTS request_type VARCHAR(50) DEFAULT 'DESPACHO';
