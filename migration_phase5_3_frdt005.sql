-- Fase 5.3: Adaptación a formato FR-DT.005

-- 1. Añadir campos requeridos por el formato físico de Control de Actividades
ALTER TABLE operaciones_actividades 
ADD COLUMN IF NOT EXISTS tipo_hora VARCHAR(10) DEFAULT 'NORMAL',
ADD COLUMN IF NOT EXISTS observaciones TEXT;

-- 2. Asegurarnos que los registros existentes tengan NORMAL por defecto si estaban nulos
UPDATE operaciones_actividades SET tipo_hora = 'NORMAL' WHERE tipo_hora IS NULL;
