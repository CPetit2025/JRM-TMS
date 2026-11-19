-- Fase 2.3 · Esperas con motivo de catálogo, eventos de inicio/pausa/fin y tiempo activo vs. espera.
-- La espera no cambia el estado de la tarea: solo separa el tiempo. Una sola espera abierta por tarea (sin
-- solapamientos). La pausa de supervisión abre una espera y reanudar, finalizar o cancelar la cierran.
-- «Listo para auditoría» = Finalizar picking (evento TASK_FINISH_PICKING).

CREATE TABLE IF NOT EXISTS public.wh_task_waits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES public.wh_tasks(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  reason_code text NOT NULL CHECK (reason_code IN ('STOCK','PROGRAMACION','AUDITORIA','CORRECCION','DOCUMENTACION','VEHICULO','EQUIPO','SISTEMA','OTRO')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid NOT NULL REFERENCES public.profiles(id),
  ended_at timestamptz,
  ended_by uuid REFERENCES public.profiles(id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (reason_code <> 'OTRO' OR nullif(btrim(note), '') IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_task_waits_one_open ON public.wh_task_waits(task_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS wh_task_waits_task_idx ON public.wh_task_waits(task_id, started_at);
CREATE INDEX IF NOT EXISTS wh_task_waits_site_idx ON public.wh_task_waits(site_id);
CREATE INDEX IF NOT EXISTS wh_task_waits_started_by_idx ON public.wh_task_waits(started_by);
CREATE INDEX IF NOT EXISTS wh_task_waits_ended_by_idx ON public.wh_task_waits(ended_by);
ALTER TABLE public.wh_task_waits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_task_waits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wh_task_waits TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_task_waits;
CREATE POLICY security_active_account ON public.wh_task_waits AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_task_waits_read ON public.wh_task_waits;
CREATE POLICY wh_task_waits_read ON public.wh_task_waits FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-auditoria']));

-- Abre una espera (interna; valida estado y unicidad)
CREATE OR REPLACE FUNCTION wms_private.wh_wait_open(t public.wh_tasks, p_reason text, p_note text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM public.wh_task_waits WHERE task_id = t.id AND ended_at IS NULL) THEN RAISE EXCEPTION 'La tarea ya tiene una espera abierta'; END IF;
  INSERT INTO public.wh_task_waits(task_id, site_id, reason_code, note, started_by)
  VALUES (t.id, t.site_id, upper(btrim(p_reason)), nullif(btrim(p_note), ''), auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION wms_private.wh_wait_close(p_task_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.wh_task_waits SET ended_at = now(), ended_by = auth.uid() WHERE task_id = p_task_id AND ended_at IS NULL
$$;
REVOKE ALL ON FUNCTION wms_private.wh_wait_open(public.wh_tasks, text, text), wms_private.wh_wait_close(uuid) FROM PUBLIC, anon, authenticated;

-- Toda salida de la preparación (finalizar, cargar, cancelar, incluso por sincronización con el TMS) cierra la espera abierta
CREATE OR REPLACE FUNCTION wms_private.wh_task_close_wait_on_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('READY_FOR_LOAD','LOADED','PARTIAL','RECONCILED','CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.wh_task_waits SET ended_at = now(), ended_by = auth.uid() WHERE task_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_task_close_wait_on_status() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS wh_tasks_close_wait ON public.wh_tasks;
CREATE TRIGGER wh_tasks_close_wait AFTER UPDATE OF status ON public.wh_tasks FOR EACH ROW EXECUTE FUNCTION wms_private.wh_task_close_wait_on_status();

-- Registrar o cerrar una espera: el responsable de la tarea o supervisión, con la tarea en preparación
CREATE OR REPLACE FUNCTION public.wh_task_wait(p_task_id uuid, p_action text, p_reason text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; v_id bigint;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF NOT (public.wh_has_permission(ARRAY['almacen-supervisor'])
      OR (coalesce(t.assigned_picker = auth.uid(), false) AND public.wh_has_permission(ARRAY['almacen-picking','almacen-packing']))) THEN
    RAISE EXCEPTION 'Solo el responsable de la tarea o supervisión registran esperas' USING ERRCODE = '42501';
  END IF;
  IF upper(p_action) = 'START' THEN
    IF t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'Solo se registran esperas durante la preparación'; END IF;
    IF upper(btrim(coalesce(p_reason, ''))) = 'OTRO' AND nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'Describa la espera «Otro»'; END IF;
    v_id := wms_private.wh_wait_open(t, p_reason, p_note);
  ELSIF upper(p_action) = 'END' THEN
    IF t.status = 'PAUSED' THEN RAISE EXCEPTION 'La tarea está pausada por supervisión: use Reanudar'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.wh_task_waits WHERE task_id = t.id AND ended_at IS NULL) THEN RAISE EXCEPTION 'No hay una espera abierta'; END IF;
    PERFORM wms_private.wh_wait_close(t.id);
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  RETURN jsonb_build_object('task_id', t.id, 'wait_id', v_id);
END $$;

-- Todas las transiciones de la tarea quedan como eventos (antes solo finalizar y reabrir), para medir tiempos
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.wh_task_action(uuid, text, text)'::regprocedure);
  IF position('WHERE v_action IN (''FINISH_PICKING'',''REOPEN_PICKING'');' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_action cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, 'WHERE v_action IN (''FINISH_PICKING'',''REOPEN_PICKING'');', 'WHERE v_action <> ''CANCEL'';');
END $m$;

-- Pausar abre una espera (motivo de catálogo en p_reason «CODIGO: detalle» o texto libre como «Otro»);
-- reanudar la cierra (finalizar, cargar o cancelar la cierran por el trigger de estado).
CREATE OR REPLACE FUNCTION public.wh_task_action(p_task_id uuid, p_action text, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_action text := upper(p_action); t public.wh_tasks%ROWTYPE; v_code text;
BEGIN
  v_result := wms_private.wh_task_action(p_task_id, p_action, p_reason);
  IF v_action IN ('FINISH_PICKING','READY_FOR_LOAD') THEN PERFORM wms_private.refresh_packing_list(p_task_id); END IF;
  IF v_action = 'RESUME' THEN PERFORM wms_private.wh_wait_close(p_task_id); END IF;
  IF v_action = 'PAUSE' THEN
    SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
    v_code := upper(split_part(btrim(p_reason), ':', 1));
    PERFORM wms_private.wh_wait_close(p_task_id);
    IF v_code IN ('STOCK','PROGRAMACION','AUDITORIA','CORRECCION','DOCUMENTACION','VEHICULO','EQUIPO','SISTEMA','OTRO') THEN
      PERFORM wms_private.wh_wait_open(t, v_code, coalesce(nullif(btrim(substr(btrim(p_reason), length(split_part(btrim(p_reason), ':', 1)) + 2)), ''), CASE WHEN v_code = 'OTRO' THEN 'Pausa de supervisión' END));
    ELSE
      PERFORM wms_private.wh_wait_open(t, 'OTRO', p_reason);
    END IF;
  END IF;
  RETURN v_result;
END $$;

-- Tiempos de la tarea: inicio de picking, listo para auditoría, transcurrido, espera por motivo y activo (minutos)
CREATE OR REPLACE FUNCTION public.wh_task_times(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; v_start timestamptz; v_ready timestamptz; v_end timestamptz; v_total numeric; v_wait numeric; v_by jsonb; v_open jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-auditoria']) THEN
    RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  -- Inicio real: primer evento de inicio. Las tareas anteriores a estos eventos quedan «sin dato» (no se infiere).
  SELECT min(occurred_at) INTO v_start FROM public.wh_scan_events
    WHERE task_id = t.id AND event_type IN ('TASK_START_PICKING','TASK_PICK','TASK_STARTED');
  SELECT max(occurred_at) INTO v_ready FROM public.wh_scan_events WHERE task_id = t.id AND event_type IN ('TASK_FINISH_PICKING','TASK_READY_FOR_LOAD');
  -- Si volvió a preparación por cualquier camino (reabrir, quitar un paquete…), aún no está lista para auditoría
  IF t.status IN ('PENDING','PARTIAL','PICKING','PACKING','PAUSED') THEN v_ready := NULL; END IF;
  v_end := CASE WHEN v_ready IS NOT NULL THEN v_ready WHEN t.status = 'CANCELLED' THEN t.updated_at ELSE now() END;
  v_total := CASE WHEN v_start IS NOT NULL THEN round(extract(epoch FROM v_end - v_start) / 60.0, 1) END;
  SELECT coalesce(jsonb_object_agg(reason_code, min), '{}'::jsonb), coalesce(sum(min), 0) INTO v_by, v_wait FROM (
    SELECT reason_code, round(sum(extract(epoch FROM least(coalesce(w.ended_at, now()), v_end) - greatest(w.started_at, v_start)) / 60.0), 1) AS min
    FROM public.wh_task_waits w
    WHERE w.task_id = t.id AND v_start IS NOT NULL AND least(coalesce(w.ended_at, now()), v_end) > greatest(w.started_at, v_start)
    GROUP BY reason_code) x;
  SELECT jsonb_build_object('reason', reason_code, 'note', note, 'since', started_at, 'by', public.wh_profile_name(started_by)) INTO v_open
    FROM public.wh_task_waits WHERE task_id = t.id AND ended_at IS NULL;
  RETURN jsonb_build_object(
    'inicio', v_start, 'listo_auditoria', v_ready, 'en_curso', v_start IS NOT NULL AND v_ready IS NULL AND t.status NOT IN ('CANCELLED'),
    'transcurrido_min', v_total, 'espera_min', CASE WHEN v_start IS NOT NULL THEN v_wait END,
    'activo_min', CASE WHEN v_start IS NOT NULL THEN greatest(v_total - v_wait, 0) END,
    'espera_por_motivo', v_by, 'espera_abierta', v_open,
    'esperas', coalesce((SELECT jsonb_agg(jsonb_build_object('reason', reason_code, 'note', note, 'from', started_at, 'to', ended_at,
        'by', public.wh_profile_name(started_by)) ORDER BY started_at) FROM public.wh_task_waits WHERE task_id = t.id), '[]'::jsonb));
END $$;

-- El tablero informa la espera abierta
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_task_board(text, uuid, date, date)'::regprocedure);
  IF position('''assigned_at'', t.assigned_at,' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_board cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '''assigned_at'', t.assigned_at,',
    '''assigned_at'', t.assigned_at, ''wait_reason'', (SELECT w.reason_code FROM public.wh_task_waits w WHERE w.task_id = t.id AND w.ended_at IS NULL),');
END $m$;

REVOKE ALL ON FUNCTION public.wh_task_wait(uuid, text, text, text), public.wh_task_times(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_task_wait(uuid, text, text, text), public.wh_task_times(uuid) TO authenticated;
