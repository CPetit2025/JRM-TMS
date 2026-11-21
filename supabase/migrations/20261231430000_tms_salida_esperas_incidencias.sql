-- Fase 3c de Transporte (diagnóstico 20-11-2026, secciones E y F): en la app del conductor se registra la salida de la
-- parada, las esperas (inicio, fin y motivo, sin superposición) y las incidencias en ruta con catálogo, estado, acción,
-- responsable y causa reportada separada de la confirmada (la confirma otra persona). La hora del evento la informa el
-- teléfono (puede registrarse sin conexión); la hora de registro es la del servidor y se guarda aparte.
-- Los registros usan el id de la operación del teléfono como clave: reenviar la misma operación no duplica nada.

-- Quién opera la parada: el conductor activo del viaje o el tercero autorizado (misma regla que la llegada)
CREATE OR REPLACE FUNCTION public.route_can_operate(p_dispatch uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.delivery_can_read(p_dispatch) AND (public.tercero_puede_operar(p_dispatch) OR EXISTS (
    SELECT 1 FROM public.dispatches x JOIN public.drivers r ON r.id = x.driver_id WHERE x.id = p_dispatch AND r.profile_id = auth.uid() AND r.is_active))
$$;
REVOKE ALL ON FUNCTION public.route_can_operate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_can_operate(uuid) TO authenticated;

-- Hora del evento informada por el teléfono: no futura (margen de reloj) ni más antigua que lo que guarda la cola sin conexión
CREATE OR REPLACE FUNCTION public.route_event_time(p_dispatch uuid, p_at timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_at IS NULL THEN RETURN now(); END IF;
  IF p_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'La hora del evento está en el futuro: revise la hora del teléfono'; END IF;
  IF p_at < now() - interval '7 days' THEN RAISE EXCEPTION 'La hora del evento es demasiado antigua'; END IF;
  RETURN p_at;
END $$;
REVOKE ALL ON FUNCTION public.route_event_time(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- ── Salida de la parada ─────────────────────────────────────────────────────────────
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS departed_at timestamptz;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS departed_recorded_at timestamptz;
COMMENT ON COLUMN public.delivery_conformities.departed_at IS 'Salida de la parada (hora del evento en el teléfono).';
COMMENT ON COLUMN public.delivery_conformities.departed_recorded_at IS 'Hora en que el servidor registró la salida.';

-- ── Esperas en la parada ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_stop_waits (
  id uuid PRIMARY KEY,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('COLA_INGRESO','AUTORIZACION_INGRESO','CONTACTO_NO_DISPONIBLE','CARGA_NO_PREPARADA','DOCUMENTOS','REVISION_CARGA','OTRO')),
  note text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz CHECK (ended_at IS NULL OR ended_at > started_at),
  created_by uuid REFERENCES public.profiles(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ended_recorded_at timestamptz
);
CREATE INDEX IF NOT EXISTS route_stop_waits_stop_idx ON public.route_stop_waits(dispatch_id, request_id, started_at);
CREATE INDEX IF NOT EXISTS route_stop_waits_request_idx ON public.route_stop_waits(request_id);
CREATE INDEX IF NOT EXISTS route_stop_waits_created_by_idx ON public.route_stop_waits(created_by);
ALTER TABLE public.route_stop_waits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.route_stop_waits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.route_stop_waits TO authenticated;
DROP POLICY IF EXISTS route_stop_waits_read ON public.route_stop_waits;
CREATE POLICY route_stop_waits_read ON public.route_stop_waits FOR SELECT TO authenticated USING (public.delivery_can_read(dispatch_id));
DROP POLICY IF EXISTS security_active_account ON public.route_stop_waits;
CREATE POLICY security_active_account ON public.route_stop_waits AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Inicia o termina una espera (la misma operación sirve para ambas). Sin superposición con otras esperas de la parada.
CREATE OR REPLACE FUNCTION public.route_stop_wait(p_id uuid, p_dispatch uuid, p_request uuid, p_reason text, p_note text,
  p_started_at timestamptz, p_ended_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w public.route_stop_waits%ROWTYPE; c public.delivery_conformities%ROWTYPE; v_start timestamptz; v_end timestamptz;
  v_reason text := upper(btrim(coalesce(p_reason, ''))); v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
BEGIN
  IF p_id IS NULL OR NOT public.route_can_operate(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para registrar esperas en esta parada' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id = p_dispatch AND request_id = p_request FOR UPDATE;
  IF c.arrived_at IS NULL THEN RAISE EXCEPTION 'Registre primero la llegada a la parada'; END IF;
  SELECT * INTO w FROM public.route_stop_waits WHERE id = p_id;
  IF w.id IS NULL THEN
    IF v_reason NOT IN ('COLA_INGRESO','AUTORIZACION_INGRESO','CONTACTO_NO_DISPONIBLE','CARGA_NO_PREPARADA','DOCUMENTOS','REVISION_CARGA','OTRO') THEN
      RAISE EXCEPTION 'Elija el motivo de la espera'; END IF;
    IF v_reason = 'OTRO' AND length(coalesce(v_note, '')) < 5 THEN RAISE EXCEPTION 'Describa el motivo de la espera'; END IF;
    v_start := public.route_event_time(p_dispatch, p_started_at);
    IF c.departed_at IS NOT NULL AND v_start >= c.departed_at THEN RAISE EXCEPTION 'La parada ya tiene salida registrada'; END IF;
    INSERT INTO public.route_stop_waits(id, dispatch_id, request_id, reason, note, started_at, created_by)
    VALUES (p_id, p_dispatch, p_request, v_reason, v_note, v_start, auth.uid()) RETURNING * INTO w;
  ELSIF w.dispatch_id <> p_dispatch OR w.request_id <> p_request THEN
    RAISE EXCEPTION 'La espera no corresponde a esta parada';
  END IF;
  IF p_ended_at IS NOT NULL AND w.ended_at IS NULL THEN
    v_end := public.route_event_time(p_dispatch, p_ended_at);
    IF v_end <= w.started_at THEN RAISE EXCEPTION 'El fin de la espera debe ser posterior a su inicio'; END IF;
    IF c.departed_at IS NOT NULL AND v_end > c.departed_at THEN RAISE EXCEPTION 'La espera no puede terminar después de la salida de la parada'; END IF;
    UPDATE public.route_stop_waits SET ended_at = v_end, ended_recorded_at = now() WHERE id = w.id RETURNING * INTO w;
  END IF;
  -- Sin superposición: una espera abierta cuenta hasta ahora
  IF EXISTS (SELECT 1 FROM public.route_stop_waits o WHERE o.dispatch_id = p_dispatch AND o.request_id = p_request AND o.id <> w.id
      AND tstzrange(o.started_at, coalesce(o.ended_at, 'infinity')) && tstzrange(w.started_at, coalesce(w.ended_at, 'infinity'))) THEN
    RAISE EXCEPTION 'La espera se superpone con otra espera de la misma parada';
  END IF;
  RETURN jsonb_build_object('success', true, 'id', w.id, 'started_at', w.started_at, 'ended_at', w.ended_at);
END $$;
REVOKE ALL ON FUNCTION public.route_stop_wait(uuid, uuid, uuid, text, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_stop_wait(uuid, uuid, uuid, text, text, timestamptz, timestamptz) TO authenticated;

-- Salida de la parada: después de la llegada y sin esperas abiertas. Repetirla no cambia la primera.
CREATE OR REPLACE FUNCTION public.delivery_depart_at(p_dispatch uuid, p_request uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.delivery_conformities%ROWTYPE; v_at timestamptz;
BEGIN
  IF NOT public.route_can_operate(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para registrar la salida' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id = p_dispatch AND request_id = p_request FOR UPDATE;
  IF c.arrived_at IS NULL THEN RAISE EXCEPTION 'Registre primero la llegada a la parada'; END IF;
  IF c.departed_at IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'already', true, 'departed_at', c.departed_at); END IF;
  v_at := public.route_event_time(p_dispatch, p_at);
  IF v_at <= c.arrived_at - interval '5 minutes' THEN RAISE EXCEPTION 'La salida debe ser posterior a la llegada'; END IF;
  v_at := greatest(v_at, c.arrived_at);
  IF EXISTS (SELECT 1 FROM public.route_stop_waits w WHERE w.dispatch_id = p_dispatch AND w.request_id = p_request AND (w.ended_at IS NULL OR w.ended_at > v_at)) THEN
    RAISE EXCEPTION 'Termine la espera abierta antes de registrar la salida'; END IF;
  UPDATE public.delivery_conformities SET departed_at = v_at, departed_recorded_at = now(), updated_at = now() WHERE dispatch_id = p_dispatch AND request_id = p_request;
  INSERT INTO public.dispatch_events(dispatch_id, event_type, description, created_by, user_id)
  VALUES (p_dispatch, 'SALIDA_CLIENTE', 'Salida de la parada registrada por el conductor', coalesce(auth.uid()::text, 'tercero'), auth.uid());
  RETURN jsonb_build_object('success', true, 'departed_at', v_at);
END $$;
REVOKE ALL ON FUNCTION public.delivery_depart_at(uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_depart_at(uuid, uuid, timestamptz) TO authenticated;

-- Tiempos de la parada (llegada, salida y esperas) para la app y el detalle del viaje
CREATE OR REPLACE FUNCTION public.route_stop_times(p_dispatch uuid, p_request uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin acceso al viaje' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'arrived_at', (SELECT arrived_at FROM public.delivery_conformities WHERE dispatch_id = p_dispatch AND request_id = p_request),
    'departed_at', (SELECT departed_at FROM public.delivery_conformities WHERE dispatch_id = p_dispatch AND request_id = p_request),
    'waits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'reason', w.reason, 'note', w.note, 'started_at', w.started_at, 'ended_at', w.ended_at) ORDER BY w.started_at)
      FROM public.route_stop_waits w WHERE w.dispatch_id = p_dispatch AND w.request_id = p_request), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.route_stop_times(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_stop_times(uuid, uuid) TO authenticated;

-- ── Incidencias en ruta ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.route_incidents (
  id uuid PRIMARY KEY,
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id uuid REFERENCES public.transport_requests(id) ON DELETE SET NULL,
  site_id uuid,
  category text NOT NULL CHECK (category IN ('RETRASO','ESPERA','DIRECCION_INCORRECTA','CONTACTO_NO_DISPONIBLE','FALTA_DOCUMENTOS','CARGA_NO_PREPARADA',
    'RECHAZO','DIFERENCIA_CANTIDAD','DANO','AVERIA','ACCIDENTE','RESTRICCION_ACCESO','OTRO')),
  description text NOT NULL CHECK (length(btrim(description)) >= 5),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  latitude numeric, longitude numeric,
  reported_by uuid REFERENCES public.profiles(id),
  reported_cause text CHECK (reported_cause IS NULL OR reported_cause IN ('CLIENTE','TRANSPORTE_JRM','ALMACEN_JRM','PROVEEDOR','EXTERNO','OTRO')),
  status text NOT NULL DEFAULT 'ABIERTA' CHECK (status IN ('ABIERTA','EN_ATENCION','CERRADA')),
  action_taken text,
  responsible text,
  confirmed_cause text CHECK (confirmed_cause IS NULL OR confirmed_cause IN ('CLIENTE','TRANSPORTE_JRM','ALMACEN_JRM','PROVEEDOR','EXTERNO','OTRO')),
  confirmed_by uuid REFERENCES public.profiles(id),
  confirmed_at timestamptz,
  closed_at timestamptz,
  updated_by uuid REFERENCES public.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Separación de funciones: la causa la confirma alguien distinto de quien reporta
  CONSTRAINT route_incidents_confirmer_differs CHECK (confirmed_by IS NULL OR confirmed_by IS DISTINCT FROM reported_by),
  CONSTRAINT route_incidents_closed_confirmed CHECK (status <> 'CERRADA' OR (confirmed_cause IS NOT NULL AND action_taken IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS route_incidents_dispatch_idx ON public.route_incidents(dispatch_id);
CREATE INDEX IF NOT EXISTS route_incidents_request_idx ON public.route_incidents(request_id);
CREATE INDEX IF NOT EXISTS route_incidents_open_idx ON public.route_incidents(status) WHERE status <> 'CERRADA';
CREATE INDEX IF NOT EXISTS route_incidents_occurred_idx ON public.route_incidents(occurred_at);
CREATE INDEX IF NOT EXISTS route_incidents_reported_by_idx ON public.route_incidents(reported_by);
CREATE INDEX IF NOT EXISTS route_incidents_confirmed_by_idx ON public.route_incidents(confirmed_by);
CREATE INDEX IF NOT EXISTS route_incidents_updated_by_idx ON public.route_incidents(updated_by);
ALTER TABLE public.route_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.route_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.route_incidents TO authenticated;
DROP POLICY IF EXISTS route_incidents_read ON public.route_incidents;
CREATE POLICY route_incidents_read ON public.route_incidents FOR SELECT TO authenticated USING (public.delivery_can_read(dispatch_id));
DROP POLICY IF EXISTS security_active_account ON public.route_incidents;
CREATE POLICY security_active_account ON public.route_incidents AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Quién gestiona incidencias (acción, responsable, estado, causa confirmada)
CREATE OR REPLACE FUNCTION public.route_incident_can_manage(p_dispatch uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.delivery_can_review(p_dispatch) OR (public.has_tms_permission('despacho')
    AND public.can_access_site((SELECT d.site_id FROM public.dispatches d WHERE d.id = p_dispatch)))
$$;
REVOKE ALL ON FUNCTION public.route_incident_can_manage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_incident_can_manage(uuid) TO authenticated;

-- Reporte desde la app (conductor o tercero) o desde oficina. Repetir la operación devuelve el registro existente.
CREATE OR REPLACE FUNCTION public.route_incident_report(p_id uuid, p_dispatch uuid, p_request uuid, p_category text, p_description text,
  p_reported_cause text, p_occurred_at timestamptz, p_lat numeric DEFAULT NULL, p_lon numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i public.route_incidents%ROWTYPE; v_cat text := upper(btrim(coalesce(p_category, ''))); v_desc text := left(btrim(coalesce(p_description, '')), 1000);
  v_cause text := nullif(upper(btrim(coalesce(p_reported_cause, ''))), ''); v_at timestamptz;
BEGIN
  IF p_id IS NULL OR NOT (public.route_can_operate(p_dispatch) OR public.route_incident_can_manage(p_dispatch)) THEN
    RAISE EXCEPTION 'Sin permiso para reportar incidencias en este viaje' USING ERRCODE = '42501'; END IF;
  SELECT * INTO i FROM public.route_incidents WHERE id = p_id;
  IF i.id IS NOT NULL THEN
    IF i.dispatch_id <> p_dispatch THEN RAISE EXCEPTION 'La incidencia no corresponde a este viaje'; END IF;
    RETURN jsonb_build_object('success', true, 'already', true, 'id', i.id);
  END IF;
  IF v_cat NOT IN ('RETRASO','ESPERA','DIRECCION_INCORRECTA','CONTACTO_NO_DISPONIBLE','FALTA_DOCUMENTOS','CARGA_NO_PREPARADA',
    'RECHAZO','DIFERENCIA_CANTIDAD','DANO','AVERIA','ACCIDENTE','RESTRICCION_ACCESO','OTRO') THEN RAISE EXCEPTION 'Elija el tipo de incidencia'; END IF;
  IF length(v_desc) < 5 THEN RAISE EXCEPTION 'Describa la incidencia (al menos 5 caracteres)'; END IF;
  IF v_cause IS NOT NULL AND v_cause NOT IN ('CLIENTE','TRANSPORTE_JRM','ALMACEN_JRM','PROVEEDOR','EXTERNO','OTRO') THEN RAISE EXCEPTION 'Causa no válida'; END IF;
  IF p_request IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch AND transport_request_id = p_request) THEN
    RAISE EXCEPTION 'La parada no pertenece al viaje'; END IF;
  IF (p_lat IS NULL) <> (p_lon IS NULL) OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Ubicación no válida'; END IF;
  v_at := public.route_event_time(p_dispatch, p_occurred_at);
  INSERT INTO public.route_incidents(id, dispatch_id, request_id, site_id, category, description, occurred_at, latitude, longitude, reported_by, reported_cause)
  SELECT p_id, p_dispatch, p_request, d.site_id, v_cat, v_desc, v_at, p_lat, p_lon, auth.uid(), v_cause FROM public.dispatches d WHERE d.id = p_dispatch
  RETURNING * INTO i;
  -- Se mantiene el aviso en el historial del viaje (torre de control y monitoreo lo leen de aquí)
  INSERT INTO public.dispatch_events(dispatch_id, event_type, description, latitude, longitude, created_by, user_id, payload)
  VALUES (p_dispatch, CASE v_cat WHEN 'RETRASO' THEN 'RETRASO' ELSE 'INCIDENCIA' END, v_desc, p_lat, p_lon, coalesce(auth.uid()::text, 'tercero'), auth.uid(),
    jsonb_build_object('route_incident_id', i.id, 'category', v_cat));
  RETURN jsonb_build_object('success', true, 'id', i.id);
END $$;
REVOKE ALL ON FUNCTION public.route_incident_report(uuid, uuid, uuid, text, text, text, timestamptz, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_incident_report(uuid, uuid, uuid, text, text, text, timestamptz, numeric, numeric) TO authenticated;

-- Gestión (Supervisor de Transporte o Despacho): estado, acción, responsable y causa confirmada (nunca por quien reportó)
CREATE OR REPLACE FUNCTION public.route_incident_update(p_id uuid, p_status text, p_action text, p_responsible text, p_confirmed_cause text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i public.route_incidents%ROWTYPE; v_status text := upper(btrim(coalesce(p_status, '')));
  v_cause text := nullif(upper(btrim(coalesce(p_confirmed_cause, ''))), '');
  v_action text := nullif(left(btrim(coalesce(p_action, '')), 1000), ''); v_resp text := nullif(left(btrim(coalesce(p_responsible, '')), 120), '');
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO i FROM public.route_incidents WHERE id = p_id FOR UPDATE;
  IF i.id IS NULL OR NOT public.route_incident_can_manage(i.dispatch_id) THEN RAISE EXCEPTION 'Sin permiso para gestionar esta incidencia' USING ERRCODE = '42501'; END IF;
  IF i.status = 'CERRADA' THEN RAISE EXCEPTION 'La incidencia ya está cerrada'; END IF;
  IF v_status NOT IN ('ABIERTA','EN_ATENCION','CERRADA') THEN RAISE EXCEPTION 'Estado no válido'; END IF;
  IF v_cause IS NOT NULL AND v_cause NOT IN ('CLIENTE','TRANSPORTE_JRM','ALMACEN_JRM','PROVEEDOR','EXTERNO','OTRO') THEN RAISE EXCEPTION 'Causa no válida'; END IF;
  IF v_cause IS DISTINCT FROM i.confirmed_cause AND v_cause IS NOT NULL AND auth.uid() IS NOT DISTINCT FROM i.reported_by THEN
    RAISE EXCEPTION 'La causa la confirma una persona distinta de quien reportó la incidencia' USING ERRCODE = '42501'; END IF;
  IF v_status = 'CERRADA' AND (v_cause IS NULL OR v_action IS NULL) THEN RAISE EXCEPTION 'Para cerrar, registre la acción tomada y la causa confirmada'; END IF;
  UPDATE public.route_incidents SET status = v_status, action_taken = v_action, responsible = v_resp,
    confirmed_cause = v_cause,
    confirmed_by = CASE WHEN v_cause IS NULL THEN NULL WHEN v_cause IS DISTINCT FROM i.confirmed_cause THEN auth.uid() ELSE confirmed_by END,
    confirmed_at = CASE WHEN v_cause IS NULL THEN NULL WHEN v_cause IS DISTINCT FROM i.confirmed_cause THEN now() ELSE confirmed_at END,
    closed_at = CASE WHEN v_status = 'CERRADA' THEN now() END, updated_by = auth.uid(), updated_at = now()
  WHERE id = i.id RETURNING * INTO i;
  RETURN jsonb_build_object('success', true, 'id', i.id, 'status', i.status);
END $$;
REVOKE ALL ON FUNCTION public.route_incident_update(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_incident_update(uuid, text, text, text, text) TO authenticated;

-- Lista para la app (un viaje) y para la bandeja de oficina (filtros por estado y fechas)
CREATE OR REPLACE FUNCTION public.route_incidents_list(p_dispatch uuid DEFAULT NULL, p_status text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x.occurred_at DESC) FROM (
    SELECT i.id, i.dispatch_id, i.request_id, i.category, i.description, i.occurred_at, i.recorded_at, i.reported_cause, i.status, i.action_taken,
      i.responsible, i.confirmed_cause, i.confirmed_at, i.closed_at, public.kpi_eq_nombre(i.reported_by) AS reporto, public.kpi_eq_nombre(i.confirmed_by) AS confirmo,
      i.reported_by = auth.uid() AS es_mio, d.dispatch_number, d.vehicle_plate, d.driver_name, t.request_number,
      public.route_incident_can_manage(i.dispatch_id) AS puede_gestionar
    FROM public.route_incidents i JOIN public.dispatches d ON d.id = i.dispatch_id LEFT JOIN public.transport_requests t ON t.id = i.request_id
    WHERE public.delivery_can_read(i.dispatch_id) AND (p_dispatch IS NULL OR i.dispatch_id = p_dispatch)
      AND (p_status IS NULL OR i.status = p_status)
      AND (p_from IS NULL OR (i.occurred_at AT TIME ZONE 'America/Lima')::date >= p_from)
      AND (p_to IS NULL OR (i.occurred_at AT TIME ZONE 'America/Lima')::date <= p_to)
    ORDER BY i.occurred_at DESC LIMIT 500) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.route_incidents_list(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.route_incidents_list(uuid, text, date, date) TO authenticated;
