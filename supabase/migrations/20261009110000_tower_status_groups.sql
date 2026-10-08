-- Torre de Control: grupos de estado "En ruta" (RUTA) y "Por cerrar" (POR_CERRAR) filtrados en el servidor,
-- antes del LIMIT 200 de get_tower_dispatches (los contadores de Despacho abren Torre con ese grupo).
-- Producción no coincide con el historial del repositorio: se ajusta la definición instalada en su lugar
-- (lista de estados válidos y predicado de estado) y se aborta si el texto esperado no aparece.
-- Los grupos coinciden con DISPATCH_STATUS_GROUPS (src/lib/dispatch-status.ts).
DO $migration$
DECLARE source text; definition text;
BEGIN
  source := pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure);
  definition := regexp_replace(source,
    '\(\s*''ACTIVOS''\s*,\s*''HISTORIAL''\s*,\s*''TODOS''\s*,\s*''PROGRAMADO''\s*\)',
    '(''ACTIVOS'',''HISTORIAL'',''TODOS'',''PROGRAMADO'',''RUTA'',''POR_CERRAR'')');
  IF definition = source THEN RAISE EXCEPTION 'get_tower_dispatches: lista de estados no reconocida'; END IF;
  source := definition;
  definition := regexp_replace(source, 'd\.status\s*=\s*p_status\)',
    'd.status=p_status OR (p_status=''RUTA'' AND d.status IN (''EN_CURSO'',''EN RUTA'',''ESPERANDO_AUTORIZACION'',''RETORNO''))'
    || ' OR (p_status=''POR_CERRAR'' AND d.status IN (''ENTREGADO'',''RETORNO_COMPLETADO'')))');
  IF definition = source THEN RAISE EXCEPTION 'get_tower_dispatches: predicado de estado no reconocido'; END IF;
  EXECUTE definition;
END $migration$;
NOTIFY pgrst, 'reload schema';
