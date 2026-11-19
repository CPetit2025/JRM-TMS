-- Fase 2.2 · Asignación planificada: supervisión asigna la tarea a un responsable con prioridad y compromiso.
-- Asignar no inicia la tarea (el estado no cambia). Reasignar o mover un compromiso exige motivo, y cada cambio
-- queda en el historial inmutable (wh_scan_events, evento TASK_PLANNED) con quién lo hizo y el valor anterior.

ALTER TABLE public.wh_tasks
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.wh_tasks DROP CONSTRAINT IF EXISTS wh_tasks_priority_check;
ALTER TABLE public.wh_tasks ADD CONSTRAINT wh_tasks_priority_check CHECK (priority IN ('URGENTE', 'ALTA', 'NORMAL', 'BAJA'));
CREATE INDEX IF NOT EXISTS wh_tasks_assigned_by_idx ON public.wh_tasks(assigned_by);

-- Quien toma la tarea por sí mismo queda también como asignador
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_assign_task(uuid, text)'::regprocedure);
  IF position('assigned_at = now(), updated_by = auth.uid()' IN def) = 0 THEN RAISE EXCEPTION 'wh_assign_task cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, 'assigned_at = now(), updated_by = auth.uid()', 'assigned_at = now(), assigned_by = auth.uid(), updated_by = auth.uid()');
END $m$;

-- Un usuario puede ser responsable de picking si está activo, tiene permiso de picking o supervisión y acceso a la sede
CREATE OR REPLACE FUNCTION public.wh_user_can_pick(p_user uuid, p_site uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = p_user AND p.is_active
      AND (r.name = 'Administrador' OR r.permissions ?| ARRAY['almacen-picking', 'almacen-picking:write', 'almacen-supervisor', 'almacen-supervisor:write'])
      AND EXISTS (SELECT 1 FROM public.user_site_access a WHERE a.user_id = p.id AND a.site_id = p_site))
$$;
REVOKE ALL ON FUNCTION public.wh_user_can_pick(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Responsables posibles para una tarea (solo supervisión)
CREATE OR REPLACE FUNCTION public.wh_task_assignees(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión asigna tareas' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', public.wh_profile_name(p.id)) ORDER BY public.wh_profile_name(p.id))
    FROM public.profiles p WHERE public.wh_user_can_pick(p.id, t.site_id)), '[]'::jsonb);
END $$;

-- Planificar: responsable, prioridad y compromiso. NULL en p_assignee conserva el responsable actual.
CREATE OR REPLACE FUNCTION public.wh_task_plan(p_task_id uuid, p_assignee uuid, p_priority text, p_committed_at timestamptz, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; v_to uuid; v_pri text := upper(btrim(coalesce(p_priority, 'NORMAL'))); v_reason text := nullif(btrim(p_reason), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo supervisión asigna tareas' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF t.status IN ('LOADED', 'RECONCILED', 'CANCELLED') THEN RAISE EXCEPTION 'No se puede planificar una tarea cerrada'; END IF;
  IF v_pri NOT IN ('URGENTE', 'ALTA', 'NORMAL', 'BAJA') THEN RAISE EXCEPTION 'Prioridad no válida'; END IF;
  v_to := coalesce(p_assignee, t.assigned_picker);
  IF v_to IS DISTINCT FROM t.assigned_picker THEN
    IF upper(t.request_status) NOT IN ('APROBADA', 'APROBADO', 'ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada en TMS'; END IF;
    IF NOT public.wh_user_can_pick(v_to, t.site_id) THEN RAISE EXCEPTION 'El responsable no está activo o no tiene permiso de picking en la sede'; END IF;
    IF t.assigned_picker IS NOT NULL AND v_reason IS NULL THEN RAISE EXCEPTION 'Indique el motivo de la reasignación'; END IF;
  END IF;
  IF t.committed_at IS NOT NULL AND p_committed_at IS DISTINCT FROM t.committed_at AND v_reason IS NULL THEN
    RAISE EXCEPTION 'Indique el motivo para cambiar el compromiso';
  END IF;
  IF v_to IS NOT DISTINCT FROM t.assigned_picker AND v_pri = t.priority AND p_committed_at IS NOT DISTINCT FROM t.committed_at THEN
    RETURN jsonb_build_object('task_id', t.id, 'changed', false);
  END IF;
  UPDATE public.wh_tasks SET priority = v_pri, committed_at = p_committed_at, updated_by = auth.uid(),
    assigned_picker = v_to,
    assigned_at = CASE WHEN v_to IS DISTINCT FROM t.assigned_picker THEN now() ELSE assigned_at END,
    assigned_by = CASE WHEN v_to IS DISTINCT FROM t.assigned_picker THEN auth.uid() ELSE assigned_by END
  WHERE id = t.id;
  INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (t.site_id, t.id, 'TASK_PLANNED', t.task_code, jsonb_build_object(
    'assigned_to', v_to, 'previous', t.assigned_picker, 'priority', v_pri, 'previous_priority', t.priority,
    'committed_at', p_committed_at, 'previous_committed_at', t.committed_at, 'reason', v_reason), auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('task_id', t.id, 'changed', true, 'assigned_picker', v_to, 'priority', v_pri, 'committed_at', p_committed_at);
END $$;

-- Historial de asignación de la tarea (tomas propias y planificación de supervisión), del más reciente al más antiguo
CREATE OR REPLACE FUNCTION public.wh_task_assignment_history(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura', 'almacen-supervisor', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-auditoria']) THEN
    RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'at', e.occurred_at, 'type', e.event_type, 'by', public.wh_profile_name(e.operator_id),
      'to', public.wh_profile_name(coalesce((e.payload->>'assigned_to')::uuid, CASE WHEN e.event_type = 'TASK_ASSIGNED' THEN e.operator_id END)),
      'previous', public.wh_profile_name((e.payload->>'previous')::uuid),
      'priority', e.payload->>'priority', 'previous_priority', e.payload->>'previous_priority',
      'committed_at', e.payload->>'committed_at', 'previous_committed_at', e.payload->>'previous_committed_at',
      'reason', e.payload->>'reason', 'idle_minutes', e.payload->'idle_minutes') ORDER BY e.occurred_at DESC, e.recorded_at DESC)
    FROM public.wh_scan_events e WHERE e.task_id = t.id AND e.event_type IN ('TASK_ASSIGNED', 'TASK_PLANNED')), '[]'::jsonb);
END $$;

-- El tablero informa prioridad, compromiso y asignador
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_task_board(text, uuid, date, date)'::regprocedure);
  IF position('''assigned_at'', t.assigned_at,' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_board cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '''assigned_at'', t.assigned_at,',
    '''assigned_at'', t.assigned_at, ''priority'', t.priority, ''committed_at'', t.committed_at, ''assigned_by_name'', public.wh_profile_name(t.assigned_by),');
END $m$;

REVOKE ALL ON FUNCTION public.wh_task_assignees(uuid), public.wh_task_plan(uuid, uuid, text, timestamptz, text),
  public.wh_task_assignment_history(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_task_assignees(uuid), public.wh_task_plan(uuid, uuid, text, timestamptz, text),
  public.wh_task_assignment_history(uuid) TO authenticated;
