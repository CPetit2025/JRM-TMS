-- Tareas abandonadas: si el operador asignado no registra actividad (lecturas o LPN) en 20 minutos, otro operador
-- con permiso de picking puede tomar la tarea indicando el motivo. Supervisión puede reasignar en cualquier momento,
-- también con motivo. Lo ya recogido conserva a su autor (la regla de no autoaprobación lo sigue considerando).

CREATE OR REPLACE FUNCTION public.wh_task_last_activity(p_task_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT greatest(t.assigned_at,
    (SELECT max(e.occurred_at) FROM public.wh_scan_events e WHERE e.task_id = t.id AND e.operator_id = t.assigned_picker),
    (SELECT max(l.created_at) FROM public.wh_lpns l WHERE l.task_id = t.id AND l.created_by = t.assigned_picker))
  FROM public.wh_tasks t WHERE t.id = p_task_id
$$;
REVOKE ALL ON FUNCTION public.wh_task_last_activity(uuid) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.wh_assign_task(uuid);
CREATE FUNCTION public.wh_assign_task(p_task_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; v_idle interval;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para asignar tareas'; END IF;
  IF t.status IN ('LOADED','RECONCILED','CANCELLED') THEN RAISE EXCEPTION 'No se puede asignar una tarea cerrada'; END IF;
  IF upper(t.request_status) NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada en TMS'; END IF;
  IF t.assigned_picker IS NOT NULL AND t.assigned_picker <> auth.uid() THEN
    v_idle := now() - public.wh_task_last_activity(t.id);
    IF v_idle < interval '20 minutes' AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
      RAISE EXCEPTION 'La tarea ya está asignada a otro operador (última actividad hace % min). Podrá tomarla tras 20 min sin actividad o pedirlo a supervisión',
        floor(extract(epoch FROM v_idle) / 60)::int;
    END IF;
    IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Indique el motivo para tomar la tarea de otro operador'; END IF;
  END IF;
  IF t.assigned_picker IS DISTINCT FROM auth.uid() THEN
    UPDATE public.wh_tasks SET assigned_picker = auth.uid(), assigned_at = now(), updated_by = auth.uid() WHERE id = t.id;
    INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (t.site_id, t.id, 'TASK_ASSIGNED', t.task_code,
      jsonb_build_object('previous', t.assigned_picker, 'reason', nullif(btrim(p_reason), ''),
        'idle_minutes', CASE WHEN v_idle IS NOT NULL THEN floor(extract(epoch FROM v_idle) / 60)::int END),
      auth.uid(), gen_random_uuid());
  END IF;
  RETURN jsonb_build_object('task_id', t.id, 'assigned_picker', auth.uid(), 'assigned', true, 'previous', t.assigned_picker);
END $$;
REVOKE ALL ON FUNCTION public.wh_assign_task(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_assign_task(uuid, text) TO authenticated;

-- El tablero informa la última actividad del responsable para mostrar cuándo se puede tomar la tarea
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_task_board(text, uuid)'::regprocedure);
  IF position('''assigned_at'', t.assigned_at,' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_board cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '''assigned_at'', t.assigned_at,', '''assigned_at'', t.assigned_at, ''last_activity_at'', public.wh_task_last_activity(t.id),');
END $m$;
