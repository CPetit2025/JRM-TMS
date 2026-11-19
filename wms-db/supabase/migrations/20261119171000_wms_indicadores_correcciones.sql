-- Correcciones del modelo analítico (revisión del PR de fases 5 y 6):
--  1. A5 (masa pendiente) respeta también el filtro de categoría, igual que su detalle.
--  2. El detalle de A1 y A2 usa la misma fecha base que su total (auditoría y primera liberación), no el cierre del LPN.
--  3. El tiempo de picking queda fijo al terminar: una carga parcial no vuelve a la tarea «en preparación» y D6 excluye
--     las tareas que volvieron a prepararse (su duración aún no está cerrada).
DO $m$
DECLARE def text; a text; b text;
BEGIN
  def := pg_get_functiondef('public.wh_dispatch_kpis(date, date, jsonb)'::regprocedure);
  a := 'AND (nullif(f->>''severity'', '''') IS NULL OR h2.severity = f->>''severity'') AND (nullif(f->>''area'', '''') IS NULL OR h2.area = f->>''area'')';
  b := 'AND (nullif(f->>''severity'', '''') IS NULL OR h.severity = f->>''severity'') AND (nullif(f->>''area'', '''') IS NULL OR h.area = f->>''area'')';
  IF position(a IN def) = 0 OR position(b IN def) = 0
     OR position('t50 INTO r FROM tt;' IN def) = 0 THEN RAISE EXCEPTION 'wh_dispatch_kpis cambió: revisar esta migración'; END IF;
  def := replace(def, a, a || ' AND (nullif(f->>''category'', '''') IS NULL OR f->>''category'' = ANY (h2.categories))');
  def := replace(def, b, b || ' AND (nullif(f->>''category'', '''') IS NULL OR f->>''category'' = ANY (h.categories))');
  def := replace(def, 't50 INTO r FROM tt;', 't50 INTO r FROM tt WHERE (x->>''listo_auditoria'') IS NOT NULL OR (x->>''inicio'') IS NULL;');
  EXECUTE def;

  def := pg_get_functiondef('public.wh_dispatch_kpi_detail(text, date, date, jsonb)'::regprocedure);
  a := 'l.status <> ''VOID'' AND (l.closed_at AT TIME ZONE ''America/Lima'')::date BETWEEN p_from AND p_to';
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'wh_dispatch_kpi_detail cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, 'l.status <> ''VOID'' AND CASE
          WHEN c = ''A1'' THEN EXISTS (SELECT 1 FROM public.wh_lpn_audits au WHERE au.lpn_id = l.id AND au.result IN (''APROBADO'',''OBSERVADO'',''RECHAZADO'')
                                AND (au.created_at AT TIME ZONE ''America/Lima'')::date BETWEEN p_from AND p_to)
          WHEN c = ''A2'' THEN (SELECT (min(e.occurred_at) AT TIME ZONE ''America/Lima'')::date FROM public.wh_scan_events e WHERE e.task_id = l.task_id AND e.event_type = ''PACKING_LIST_RELEASED'') BETWEEN p_from AND p_to
          ELSE (l.closed_at AT TIME ZONE ''America/Lima'')::date BETWEEN p_from AND p_to END');

  def := pg_get_functiondef('public.wh_task_times(uuid)'::regprocedure);
  a := 'IF t.status IN (''PENDING'',''PARTIAL'',''PICKING'',''PACKING'',''PAUSED'') THEN v_ready := NULL; END IF;';
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'wh_task_times cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, 'IF t.status IN (''PENDING'',''PICKING'',''PACKING'',''PAUSED'') THEN v_ready := NULL; END IF;');
END $m$;
