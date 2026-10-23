-- Reporte por unidad: km por semana y mes, y OT, OS, OC y RQ atendidas.
-- Redefine unit_daily_report (20261016100000) sin cambiar su forma: cada parada trae su referencia de compra (OS, OC o RQ),
-- cada ruta y día traen los km reales registrados y los estimados al programar (respaldo cuando no hay odómetro ni GPS) y
-- el rango sube a 13 meses para el resumen mensual. La agregación semanal y mensual se hace en la pantalla.
BEGIN;

CREATE OR REPLACE FUNCTION public.unit_daily_report(p_plate text, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; v_days jsonb; v_tot jsonb;
BEGIN
  IF NOT public.can_view_unit_report() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para el reporte de unidades'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique un rango de fechas válido (máximo 13 meses)'); END IF;
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
      (SELECT round(max((to_jsonb(t)->>'cumulative_m')::numeric) / 1000, 1) FROM public.route_track_points t WHERE t.dispatch_id = d.id) AS km_gps,
      -- Km de la ruta: real registrado (0 = sin dato en producción) y estimado al programar, como respaldo sin odómetro ni GPS
      NULLIF((to_jsonb(d)->>'actual_distance_km')::numeric, 0) AS km_real, NULLIF((to_jsonb(d)->>'estimated_distance_km')::numeric, 0) AS km_est
    FROM public.dispatches d
    WHERE d.vehicle_plate = v.plate AND d.status <> 'CANCELADO'
      AND (d.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to),
  stops AS (
    SELECT dr.dispatch_id, dr.sequence_order, dr.status AS stop_status, dr.leg_actual_km, r.id AS request_id, r.request_number, r.request_type,
      c.code AS ot, COALESCE(cl.business_name, cl2.business_name) AS client,
      NULLIF(btrim(to_jsonb(r)->>'reference_type'), '') AS ref_type, NULLIF(btrim(to_jsonb(r)->>'reference_number'), '') AS ref_number,
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
    SELECT disp.day, disp.id, disp.km_gps, disp.km_real, disp.km_est,
      jsonb_build_object('dispatch_number', disp.dispatch_number, 'status', disp.status, 'driver', disp.driver_name, 'modalidad', disp.modalidad,
        'departure', disp.scheduled_departure, 'km_gps', disp.km_gps, 'km_real', disp.km_real, 'km_est', disp.km_est,
        'stops', COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence', s.sequence_order, 'status', s.stop_status, 'request_number', s.request_number,
            'type', s.request_type, 'ot', s.ot, 'ref_type', s.ref_type, 'ref_number', s.ref_number, 'client', s.client, 'destination', s.destination, 'km_leg', s.leg_actual_km, 'guide', s.guide,
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
      (SELECT round(sum(x.km_real), 1) FROM disp x WHERE x.day = d.day) AS km_real,
      (SELECT round(sum(x.km_est), 1) FROM disp x WHERE x.day = d.day) AS km_est,
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
      'odo_start', f.odo_start, 'odo_end', f.odo_end, 'end_source', f.end_source, 'km_odo', f.km_odo, 'km_gps', f.km_gps, 'km_real', f.km_real, 'km_est', f.km_est,
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
      'km_real', round(COALESCE(sum(f.km_real), 0), 1), 'km_est', round(COALESCE(sum(f.km_est), 0), 1),
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

COMMIT;
