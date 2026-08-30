-- Agregar columna para Ventana Horaria a la tabla de solicitudes de transporte
ALTER TABLE public.transport_requests 
ADD COLUMN IF NOT EXISTS time_window VARCHAR(100);
