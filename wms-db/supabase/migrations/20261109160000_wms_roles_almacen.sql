-- Roles del almacén: Asistente de Recepción, Auditor de Despacho y Analista de Inventario.
-- Nuevo permiso almacen-inventario: gestiona campañas de inventario (abrir, revisar, reconteo, cerrar, anular,
-- reabrir, anular líneas ajenas) sin los demás poderes de supervisión (formatos de etiqueta, embalajes, tareas).

-- Las funciones wh_count_* que exigían solo supervisión aceptan también almacen-inventario
DO $m$
DECLARE f record; def text;
BEGIN
  FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'wh\_count\_%' AND p.prosrc LIKE '%ARRAY[''almacen-supervisor'']%'
  LOOP
    def := replace(pg_get_functiondef(f.oid), 'ARRAY[''almacen-supervisor'']', 'ARRAY[''almacen-supervisor'',''almacen-inventario'']');
    EXECUTE def;
  END LOOP;
END $m$;

INSERT INTO public.roles(name, description, permissions) VALUES
  ('Asistente de Recepción', 'Recepción por IPT, control de recepción y etiquetado de bultos; participa en conteos.',
   '["almacen-lectura","almacen-etiquetado"]'::jsonb),
  ('Auditor de Despacho', 'Auditoría de despacho (LPN y packing list), liberación, consulta de stock, tareas y paquetes.',
   '["almacen-lectura","almacen-auditoria"]'::jsonb),
  ('Analista de Inventario', 'Campañas de inventario (abrir, contar, cuadre, reconteo, cierre y anulación), rótulos y consulta de stock.',
   '["almacen-lectura","almacen-etiquetado","almacen-inventario"]'::jsonb)
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, permissions = EXCLUDED.permissions;
