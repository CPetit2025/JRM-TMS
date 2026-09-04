-- 1. Añadir columna para la OT / Solicitud de Transporte en las actividades del tareo
ALTER TABLE operaciones_actividades ADD COLUMN IF NOT EXISTS referencia_ot TEXT;

-- 2. Solucionar el problema de visualización en el Live (Torre de Control)
-- Las políticas de seguridad (RLS) bloquean la lectura por defecto. 
-- Añadiremos políticas que permitan a cualquier usuario autenticado LEER (SELECT) los turnos y actividades.

-- Habilitar RLS si no estaba habilitado (por precaución)
ALTER TABLE operaciones_turnos ENABLE ROW LEVEL SECURITY;
ALTER TABLE operaciones_actividades ENABLE ROW LEVEL SECURITY;

-- Eliminar políticas anteriores si existían (para evitar errores de conflicto al re-ejecutar)
DROP POLICY IF EXISTS "Permitir lectura global a usuarios autenticados" ON operaciones_turnos;
DROP POLICY IF EXISTS "Permitir lectura global a usuarios autenticados" ON operaciones_actividades;
DROP POLICY IF EXISTS "Permitir insercion a dueños" ON operaciones_turnos;
DROP POLICY IF EXISTS "Permitir actualizacion a dueños" ON operaciones_turnos;
DROP POLICY IF EXISTS "Permitir insert a autenticados" ON operaciones_actividades;
DROP POLICY IF EXISTS "Permitir update a autenticados" ON operaciones_actividades;

-- Política para permitir lectura (SELECT) a todos los usuarios autenticados
CREATE POLICY "Permitir lectura global a usuarios autenticados" 
ON operaciones_turnos 
FOR SELECT 
TO authenticated 
USING (true);

CREATE POLICY "Permitir lectura global a usuarios autenticados" 
ON operaciones_actividades 
FOR SELECT 
TO authenticated 
USING (true);

-- (Opcional pero recomendado) Permitir a los usuarios insertar/actualizar sus propios registros
CREATE POLICY "Permitir insercion a dueños" 
ON operaciones_turnos 
FOR INSERT 
TO authenticated 
WITH CHECK (auth.uid() = profile_id);

CREATE POLICY "Permitir actualizacion a dueños" 
ON operaciones_turnos 
FOR UPDATE 
TO authenticated 
USING (auth.uid() = profile_id);

-- Para actividades, el insert/update no tiene profile_id directo, así que lo permitimos para todos los autenticados
CREATE POLICY "Permitir insert a autenticados" 
ON operaciones_actividades 
FOR INSERT 
TO authenticated 
WITH CHECK (true);

CREATE POLICY "Permitir update a autenticados" 
ON operaciones_actividades 
FOR UPDATE 
TO authenticated 
USING (true);
