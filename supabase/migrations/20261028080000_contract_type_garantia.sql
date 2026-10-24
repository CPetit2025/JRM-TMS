-- Tipo de documento GARANTÍA DE VENTAS del ERP (código madre-G01). Va en su propia migración: un valor nuevo de enum
-- no se puede usar en la misma transacción en que se crea.
ALTER TYPE public.contract_type ADD VALUE IF NOT EXISTS 'GARANTIA';
