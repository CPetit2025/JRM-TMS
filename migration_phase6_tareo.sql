-- migration_phase6_tareo.sql
-- Fase 6: Tareo Automatizado y Gestión de Trabajadores

-- 1. Añadir auxiliar_id a la tabla dispatches (rutas)
ALTER TABLE dispatches
ADD COLUMN IF NOT EXISTS auxiliary_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS auxiliary_name TEXT;

-- 2. Asegurarse que employee_type permita los nuevos cargos (si es un ENUM o simplemente VARCHAR)
-- En este caso, employee_type es VARCHAR en la tabla profiles. 
-- Actualizamos los cargos operativos comunes para tener data base:
UPDATE profiles 
SET employee_type = 'CONDUCTOR' 
WHERE first_name ILIKE '%Conductor%';

-- 3. Crear tabla (opcional) o vistas para agilizar el Tareo Automatizado
-- El tareo se inyectará directamente a operaciones_turnos y operaciones_actividades.

-- NOTA: Si el operario no tiene cuenta de auth.users, el profile_id puede existir solo en profiles. 
-- operaciones_turnos ya acepta cualquier profile_id que exista en la tabla profiles.
