-- Migration: Add Weight and Volume to Contracts and Transport Requests
-- Description: Agrega soporte para métricas de peso (kg) y volumen (m3)

-- 1. Actualizar tabla de contratos
ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS total_weight_kg DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_volume_m3 DECIMAL(10,2) DEFAULT 0;

-- 2. Actualizar tabla de solicitudes de transporte
-- Ya existe estimated_weight, pero podemos agregar estimated_volume
ALTER TABLE public.transport_requests
ADD COLUMN IF NOT EXISTS estimated_volume DECIMAL(10,2) DEFAULT 0;

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
