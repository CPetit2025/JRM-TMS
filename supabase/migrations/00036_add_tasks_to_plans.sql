-- Añadir columna de checklist/tareas a los planes de mantenimiento preventivo
ALTER TABLE public.maintenance_plans 
ADD COLUMN IF NOT EXISTS tasks JSONB DEFAULT '[]'::jsonb;
