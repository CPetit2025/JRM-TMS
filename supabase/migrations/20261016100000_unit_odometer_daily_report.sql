-- Odómetro diario de la unidad y reporte diario por unidad.
-- · El checklist diario FR-DT 007 (y cada cambio de unidad) registra el odómetro de inicio con foto del tablero.
-- · «Cerrar jornada» en el app registra el odómetro de cierre con foto; si no se cierra, el reporte usa el inicio
--   del día siguiente.
-- · Lecturas menores a la anterior o con saltos grandes no bloquean al conductor: quedan marcadas para revisión.
-- · unit_daily_report: por unidad y día, conductores, checklist, odómetro, km odómetro vs GPS, rutas, servicios,
--   OT, clientes y peso (APT validado por guía, o declarado en la solicitud).
CREATE TABLE IF NOT EXISTS public.unit_odometer_readings (
  operation_id      uuid PRIMARY KEY,
  vehicle_plate     text NOT NULL,
  driver_id         uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  unit_revision     uuid,
  operation_date    date NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('INICIO', 'CIERRE')),
  odometer          numeric(12,1) NOT NULL CHECK (odometer > 0 AND odometer < 5000000),
  photo_path        text NOT NULL,
  previous_odometer numeric(12,1),
  flag              text CHECK (flag IN ('RETROCESO', 'SALTO')),
  captured_at       timestamptz NOT NULL,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_odometer_readings_plate_idx ON public.unit_odometer_readings(vehicle_plate, captured_at DESC);
CREATE INDEX IF NOT EXISTS unit_odometer_readings_driver_idx ON public.unit_odometer_readings(driver_id, operation_date);
CREATE UNIQUE INDEX IF NOT EXISTS unit_odometer_one_close ON public.unit_odometer_readings(driver_id, unit_revision) WHERE kind = 'CIERRE';
ALTER TABLE public.unit_odometer_readings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.unit_odometer_readings;
CREATE POLICY security_active_account ON public.unit_odometer_readings AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.unit_odometer_readings FROM PUBLIC, anon, authenticated;

-- Desde cuándo el checklist exige odómetro (las inspecciones guardadas sin señal antes del cambio se aceptan)
DO $since$
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION public.unit_odometer_required_since() RETURNS timestamptz
    LANGUAGE sql IMMUTABLE AS $body$SELECT %L::timestamptz$body$$f$, now() + interval '2 hours');
END $since$;

-- Registro interno de una lectura (lo usan el checklist y el cierre de jornada)
CREATE OR REPLACE FUNCTION public.unit_odometer_record(p_operation uuid, p_plate text, p_driver uuid, p_day date, p_kind text,
  p_value text, p_photo text, p_captured timestamptz, p_by uuid, p_revision uuid)
RETURNS public.unit_odometer_readings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v numeric; prev numeric; rec public.unit_odometer_readings;
BEGIN
  SELECT * INTO rec FROM public.unit_odometer_readings WHERE operation_id = p_operation;
  IF rec.operation_id IS NOT NULL THEN RETURN rec; END IF;
  BEGIN v := round(replace(btrim(COALESCE(p_value, '')), ',', '.')::numeric, 1);
  EXCEPTION WHEN OTHERS THEN v := NULL; END;
  IF v IS NULL OR v <= 0 OR v >= 5000000 THEN RAISE EXCEPTION 'Ingrese el odómetro (km) que marca el tablero de la unidad'; END IF;
  IF p_photo IS NULL OR NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'driver_evidence' AND o.name = p_photo
      AND (storage.foldername(o.name))[1] = p_by::text) THEN
    RAISE EXCEPTION 'Tome la foto del odómetro (tablero) para registrar el kilometraje'; END IF;
  SELECT odometer INTO prev FROM public.unit_odometer_readings WHERE vehicle_plate = p_plate AND captured_at <= p_captured
   ORDER BY captured_at DESC LIMIT 1;
  INSERT INTO public.unit_odometer_readings(operation_id, vehicle_plate, driver_id, unit_revision, operation_date, kind, odometer, photo_path,
    previous_odometer, flag, captured_at, created_by)
  VALUES (p_operation, p_plate, p_driver, p_revision, p_day, p_kind, v, p_photo, prev,
    CASE WHEN prev IS NOT NULL AND v < prev THEN 'RETROCESO' WHEN prev IS NOT NULL AND v - prev > 1500 THEN 'SALTO' END, p_captured, p_by)
  RETURNING * INTO rec;
  -- Odómetro de la unidad para Mantenimiento (solo avanza)
  BEGIN
    UPDATE public.vehicles SET current_odometer = v WHERE plate = p_plate AND COALESCE(current_odometer, 0) < v;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Odómetro de % sin actualizar: %', p_plate, SQLERRM;
  END;
  RETURN rec;
END $$;
REVOKE ALL ON FUNCTION public.unit_odometer_record(uuid, text, uuid, date, text, text, text, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- El checklist diario registra el odómetro de inicio (obligatorio desde unit_odometer_required_since)
DO $patch$
DECLARE sig regprocedure := 'public.submit_driver_preuse(uuid,uuid,timestamptz,jsonb)'::regprocedure; def text;
  anchor text := $a$ RETURN jsonb_build_object('success',true,'operation_id',p_operation,'can_operate',public.driver_preuse_can_operate(dr.id,v.plate),'critical_failures',critical);$a$;
  addition text := $b$ -- Odómetro de inicio con foto del tablero
 IF p_data ? 'odometer' OR p_captured_at >= public.unit_odometer_required_since() THEN
   PERFORM public.unit_odometer_record(p_operation, v.plate, dr.id, day, 'INICIO', p_data->>'odometer', p_data->>'odometer_photo', p_captured_at, auth.uid(), p_revision);
 END IF;
$b$;
BEGIN
  def := pg_get_functiondef(sig);
  IF position('unit_odometer_record' IN def) > 0 THEN RETURN; END IF;
  IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'Checklist diario no reconocido: revisar antes de migrar'; END IF;
  EXECUTE replace(def, anchor, addition || anchor);
END $patch$;

-- Conductor activo de la sesión
CREATE OR REPLACE FUNCTION public.unit_odometer_session_driver() RETURNS public.drivers
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.* FROM public.drivers d JOIN public.profiles p ON p.id = d.profile_id
  WHERE d.profile_id = auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.unit_odometer_session_driver() FROM PUBLIC, anon, authenticated;

-- Última lectura conocida de la unidad (para avisar al conductor antes de registrar)
CREATE OR REPLACE FUNCTION public.get_unit_last_odometer(p_plate text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dr public.drivers; r public.unit_odometer_readings; cur numeric;
BEGIN
  dr := public.unit_odometer_session_driver();
  IF dr.id IS NULL AND NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false); END IF;
  SELECT * INTO r FROM public.unit_odometer_readings WHERE vehicle_plate = p_plate ORDER BY captured_at DESC LIMIT 1;
  SELECT NULLIF(current_odometer, 0) INTO cur FROM public.vehicles WHERE plate = p_plate;
  RETURN jsonb_build_object('success', true, 'odometer', COALESCE(r.odometer, cur), 'captured_at', r.captured_at,
    'source', CASE WHEN r.operation_id IS NOT NULL THEN 'APP' WHEN cur IS NOT NULL THEN 'FLOTA' END);
END $$;
REVOKE ALL ON FUNCTION public.get_unit_last_odometer(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unit_last_odometer(text) TO authenticated;

-- Jornada del conductor: unidad del día, odómetro de inicio y de cierre
CREATE OR REPLACE FUNCTION public.get_driver_workday() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dr public.drivers; u public.driver_preuse_units; ini public.unit_odometer_readings; fin public.unit_odometer_readings;
  today date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  dr := public.unit_odometer_session_driver();
  IF dr.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin conductor activo'); END IF;
  SELECT * INTO u FROM public.driver_preuse_units WHERE driver_id = dr.id AND operation_date = today;
  IF u.driver_id IS NULL THEN RETURN jsonb_build_object('success', true, 'unit', NULL, 'operation_date', today); END IF;
  SELECT * INTO ini FROM public.unit_odometer_readings WHERE driver_id = dr.id AND unit_revision = u.revision AND kind = 'INICIO'
   ORDER BY captured_at LIMIT 1;
  SELECT * INTO fin FROM public.unit_odometer_readings WHERE driver_id = dr.id AND unit_revision = u.revision AND kind = 'CIERRE';
  RETURN jsonb_build_object('success', true, 'operation_date', today, 'unit', u.vehicle_plate, 'revision', u.revision,
    'start', CASE WHEN ini.operation_id IS NOT NULL THEN jsonb_build_object('odometer', ini.odometer, 'captured_at', ini.captured_at) END,
    'close', CASE WHEN fin.operation_id IS NOT NULL THEN jsonb_build_object('odometer', fin.odometer, 'captured_at', fin.captured_at) END,
    'active_route', EXISTS (SELECT 1 FROM public.dispatches d WHERE d.driver_id = dr.id
      AND d.status IN ('EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO')));
END $$;
REVOKE ALL ON FUNCTION public.get_driver_workday() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_workday() TO authenticated;

CREATE OR REPLACE FUNCTION public.close_driver_workday(p_operation uuid, p_odometer text, p_photo text, p_captured_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dr public.drivers; u public.driver_preuse_units; ini public.unit_odometer_readings; rec public.unit_odometer_readings;
  v_captured timestamptz := LEAST(COALESCE(p_captured_at, now()), now() + interval '30 seconds');
BEGIN
  dr := public.unit_odometer_session_driver();
  IF dr.id IS NULL OR p_operation IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin conductor activo'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:' || dr.id::text, 0));
  SELECT * INTO rec FROM public.unit_odometer_readings WHERE operation_id = p_operation;
  IF rec.operation_id IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'duplicate', true, 'km', NULL); END IF;
  SELECT * INTO u FROM public.driver_preuse_units WHERE driver_id = dr.id AND operation_date = (v_captured AT TIME ZONE 'America/Lima')::date;
  IF u.driver_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una unidad confirmada hoy: realice primero el checklist del día'); END IF;
  IF EXISTS (SELECT 1 FROM public.unit_odometer_readings WHERE driver_id = dr.id AND unit_revision = u.revision AND kind = 'CIERRE') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La jornada de esta unidad ya fue cerrada'); END IF;
  SELECT * INTO ini FROM public.unit_odometer_readings WHERE driver_id = dr.id AND unit_revision = u.revision AND kind = 'INICIO'
   ORDER BY captured_at LIMIT 1;
  rec := public.unit_odometer_record(p_operation, u.vehicle_plate, dr.id, u.operation_date, 'CIERRE', p_odometer, p_photo, v_captured, auth.uid(), u.revision);
  RETURN jsonb_build_object('success', true, 'plate', u.vehicle_plate, 'odometer', rec.odometer, 'flag', rec.flag,
    'km', CASE WHEN ini.operation_id IS NOT NULL AND rec.odometer >= ini.odometer THEN rec.odometer - ini.odometer END);
EXCEPTION WHEN raise_exception THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.close_driver_workday(uuid, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_driver_workday(uuid, text, text, timestamptz) TO authenticated;

-- ── Reporte diario por unidad ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.can_view_unit_report() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user() AND (public.is_tms_admin() OR public.has_cmms_read_permission('flota')
    OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('flota-eficiencia'));
$$;
REVOKE ALL ON FUNCTION public.can_view_unit_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_unit_report() TO authenticated;

CREATE OR REPLACE FUNCTION public.unit_report_plates() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.can_view_unit_report() THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('plate', v.plate, 'type', v.type, 'status', v.status) ORDER BY v.plate)
    FROM public.vehicles v WHERE v.plate IS NOT NULL AND v.plate <> 'EXTERNO' AND public.can_access_site(v.site_id)), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.unit_report_plates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_report_plates() TO authenticated;

CREATE OR REPLACE FUNCTION public.unit_daily_report(p_plate text, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; v_days jsonb; v_tot jsonb;
BEGIN
  IF NOT public.can_view_unit_report() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para el reporte de unidades'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique un rango de fechas válido (máximo 93 días)'); END IF;
  SELECT x.plate, x.type, x.status, x.site_id, NULLIF(x.current_odometer, 0) AS current_odometer INTO v FROM public.vehicles x WHERE x.plate = btrim(p_plate);
  IF v.plate IS NULL OR NOT public.can_access_site(v.site_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad inexistente o sin acceso'); END IF;

  WITH days AS (SELECT generate_series(p_from, p_to, interval '1 day')::date AS day),
  rd AS (SELECT * FROM public.unit_odometer_readings WHERE vehicle_plate = v.plate AND operation_date BETWEEN p_from AND p_to + 7),
  odo AS (
    SELECT d.day,
      (SELECT r.odometer FROM rd r WHERE r.operation_date = d.day AND r.kind = 'INICIO' ORDER BY r.captured_at LIMIT 1) AS odo_start,
      (SELECT r.odometer FROM rd r WHERE r.operation_date = d.day AND r.kind = 'CIERRE' ORDER BY r.captured_at DESC LIMIT 1) AS odo_close,
      (SELECT r.odometer FROM rd r WHERE r.operation_date > d.day AND r.kind = 'INICIO' ORDER BY r.captured_at LIMIT 1) AS odo_next,
      (SELECT jsonb_agg(DISTINCT r.flag) FROM rd r WHERE r.operation_date = d.day AND r.flag IS NOT NULL) AS flags,
      (SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'odometer', r.odometer, 'at', r.captured_at, 'photo', r.photo_path, 'flag', r.flag) ORDER BY r.captured_at)
         FROM rd r WHERE r.operation_date = d.day) AS readings
    FROM days d),
  chk AS (
    SELECT i.operation_date AS day, count(*) AS n, bool_and(i.can_operate) AS all_ok, array_agg(DISTINCT i.driver_name) AS drivers
    FROM public.driver_preuse_inspections i WHERE i.vehicle_plate = v.plate AND i.operation_date BETWEEN p_from AND p_to GROUP BY 1),
  disp AS (
    SELECT d.id, d.dispatch_number, d.status, d.driver_name, d.scheduled_departure, to_jsonb(d)->>'modalidad' AS modalidad,
      (d.scheduled_departure AT TIME ZONE 'America/Lima')::date AS day,
      (SELECT round(max((to_jsonb(t)->>'cumulative_m')::numeric) / 1000, 1) FROM public.route_track_points t WHERE t.dispatch_id = d.id) AS km_gps
    FROM public.dispatches d
    WHERE d.vehicle_plate = v.plate AND d.status <> 'CANCELADO'
      AND (d.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to),
  stops AS (
    SELECT dr.dispatch_id, dr.sequence_order, dr.status AS stop_status, dr.leg_actual_km, r.id AS request_id, r.request_number, r.request_type,
      c.code AS ot, COALESCE(cl.business_name, cl2.business_name) AS client,
      NULLIF(concat_ws(', ', NULLIF(btrim(r.delivery_address), ''), NULLIF(btrim(to_jsonb(r)->>'delivery_district'), '')), '') AS destination,
      COALESCE(NULLIF(btrim(s.guide_number), ''), NULLIF(btrim(dr.document_number), '')) AS guide,
      w.kg AS kg_apt, NULLIF(r.estimated_weight, 0) AS kg_declared
    FROM disp JOIN public.dispatch_requests dr ON dr.dispatch_id = disp.id
    JOIN public.transport_requests r ON r.id = dr.transport_request_id
    LEFT JOIN public.contracts c ON c.id = r.contract_id
    LEFT JOIN public.clients cl ON cl.id = NULLIF(to_jsonb(r)->>'client_id', '')::uuid
    LEFT JOIN public.clients cl2 ON cl2.id = c.client_id
    LEFT JOIN public.delivery_conformities dc ON dc.dispatch_id = dr.dispatch_id AND dc.request_id = dr.transport_request_id
    LEFT JOIN public.delivery_submissions s ON s.id = dc.current_submission_id
    LEFT JOIN LATERAL (
      SELECT NULLIF(sum(m.peso_kg), 0) AS kg FROM public.apt_movements m
      WHERE dc.state = 'VALIDADA' AND r.request_type IN ('DESPACHO', 'TRASLADO') AND m.active AND m.valid AND m.kind = 'SALIDA'
        AND public.apt_guia_key(m.documento) = public.apt_guia_key(COALESCE(NULLIF(btrim(s.guide_number), ''), NULLIF(btrim(dr.document_number), '')))
    ) w ON true
    WHERE dr.status <> 'CANCELADO'),
  disp_json AS (
    SELECT disp.day, disp.id, disp.km_gps,
      jsonb_build_object('dispatch_number', disp.dispatch_number, 'status', disp.status, 'driver', disp.driver_name, 'modalidad', disp.modalidad,
        'departure', disp.scheduled_departure, 'km_gps', disp.km_gps,
        'stops', COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence', s.sequence_order, 'status', s.stop_status, 'request_number', s.request_number,
            'type', s.request_type, 'ot', s.ot, 'client', s.client, 'destination', s.destination, 'km_leg', s.leg_actual_km, 'guide', s.guide,
            'kg', COALESCE(s.kg_apt, s.kg_declared), 'kg_source', CASE WHEN s.kg_apt IS NOT NULL THEN 'APT' WHEN s.kg_declared IS NOT NULL THEN 'DECLARADO' END)
          ORDER BY s.sequence_order) FROM stops s WHERE s.dispatch_id = disp.id), '[]'::jsonb)) AS j
    FROM disp),
  day_rows AS (
    SELECT d.day, o.odo_start, o.odo_close, o.odo_next, o.flags, o.readings,
      COALESCE(o.odo_close, o.odo_next) AS odo_end,
      CASE WHEN o.odo_close IS NOT NULL THEN 'CIERRE' WHEN o.odo_next IS NOT NULL THEN 'SIGUIENTE_INICIO' END AS end_source,
      ch.n AS checklists, ch.all_ok, ch.drivers,
      (SELECT count(*) FROM disp x WHERE x.day = d.day) AS routes,
      (SELECT round(sum(x.km_gps), 1) FROM disp x WHERE x.day = d.day) AS km_gps,
      (SELECT count(*) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS services,
      (SELECT count(DISTINCT s.ot) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS ots,
      (SELECT count(DISTINCT s.client) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS clients,
      (SELECT round(sum(COALESCE(s.kg_apt, s.kg_declared)) / 1000, 3) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS tn,
      (SELECT round(sum(s.kg_apt) / 1000, 3) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS tn_apt,
      (SELECT array_agg(DISTINCT x.driver_name) FROM disp x WHERE x.day = d.day AND x.driver_name IS NOT NULL) AS route_drivers,
      (SELECT jsonb_agg(j.j ORDER BY (j.j->>'departure')) FROM disp_json j WHERE j.day = d.day) AS dispatches
    FROM days d JOIN odo o ON o.day = d.day LEFT JOIN chk ch ON ch.day = d.day),
  final AS (
    SELECT r.*, CASE WHEN r.odo_start IS NOT NULL AND r.odo_end IS NOT NULL AND r.odo_end >= r.odo_start THEN r.odo_end - r.odo_start END AS km_odo
    FROM day_rows r)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'date', f.day,
      'drivers', (SELECT jsonb_agg(DISTINCT n) FROM unnest(COALESCE(f.drivers, '{}') || COALESCE(f.route_drivers, '{}')) n WHERE n IS NOT NULL),
      'checklists', COALESCE(f.checklists, 0), 'operative', f.all_ok,
      'odo_start', f.odo_start, 'odo_end', f.odo_end, 'end_source', f.end_source, 'km_odo', f.km_odo, 'km_gps', f.km_gps,
      'routes', f.routes, 'services', f.services, 'ots', f.ots, 'clients', f.clients, 'tn', f.tn, 'tn_apt', f.tn_apt,
      'readings', COALESCE(f.readings, '[]'::jsonb), 'dispatches', COALESCE(f.dispatches, '[]'::jsonb),
      'alerts', to_jsonb(array_remove(ARRAY[
        CASE WHEN f.routes > 0 AND COALESCE(f.checklists, 0) = 0 THEN 'SIN_CHECKLIST' END,
        CASE WHEN (f.routes > 0 OR COALESCE(f.checklists, 0) > 0) AND f.odo_start IS NULL THEN 'SIN_ODOMETRO' END,
        CASE WHEN f.odo_start IS NOT NULL AND f.odo_end IS NULL THEN 'SIN_CIERRE' END,
        CASE WHEN f.km_odo > 5 AND f.routes = 0 THEN 'KM_SIN_RUTA' END,
        CASE WHEN f.km_odo > 5 AND f.routes > 0 AND COALESCE(f.km_gps, 0) < f.km_odo * 0.7 THEN 'GPS_INCOMPLETO' END,
        CASE WHEN f.flags ? 'RETROCESO' THEN 'ODOMETRO_RETROCEDE' END,
        CASE WHEN f.flags ? 'SALTO' THEN 'ODOMETRO_SALTO' END,
        CASE WHEN f.odo_end IS NOT NULL AND f.odo_start IS NOT NULL AND f.odo_end < f.odo_start THEN 'ODOMETRO_RETROCEDE' END], NULL))
    ) ORDER BY f.day DESC), '[]'::jsonb),
    jsonb_build_object(
      'days_active', count(*) FILTER (WHERE f.routes > 0 OR COALESCE(f.checklists, 0) > 0),
      'routes', COALESCE(sum(f.routes), 0), 'services', COALESCE(sum(f.services), 0),
      'km_odo', round(COALESCE(sum(f.km_odo), 0), 1), 'km_gps', round(COALESCE(sum(f.km_gps), 0), 1),
      'days_with_odo', count(*) FILTER (WHERE f.km_odo IS NOT NULL),
      'tn', round(COALESCE(sum(f.tn), 0), 3), 'tn_apt', round(COALESCE(sum(f.tn_apt), 0), 3),
      'checklists', COALESCE(sum(f.checklists), 0))
  INTO v_days, v_tot FROM final f;

  v_tot := v_tot || jsonb_build_object(
    'ots', (SELECT count(DISTINCT c.code) FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id = d.id
             JOIN public.transport_requests r ON r.id = dr.transport_request_id JOIN public.contracts c ON c.id = r.contract_id
             WHERE d.vehicle_plate = v.plate AND d.status <> 'CANCELADO' AND dr.status <> 'CANCELADO'
               AND (d.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to));
  RETURN jsonb_build_object('success', true, 'plate', v.plate, 'type', v.type, 'status', v.status, 'current_odometer', v.current_odometer,
    'from', p_from, 'to', p_to, 'totals', v_tot, 'days', v_days);
END $$;
REVOKE ALL ON FUNCTION public.unit_daily_report(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unit_daily_report(text, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
