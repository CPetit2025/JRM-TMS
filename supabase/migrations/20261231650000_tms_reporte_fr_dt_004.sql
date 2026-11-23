-- Reporte FR-DT.004 «Programa de despacho» (decisiones del 23-11-2026): una fila por parada, flota propia y terceros.
-- 1. % de ocupación de la unidad por parada: lo registra quien programa y el conductor puede corregirlo al cargar.
-- 2. Reporte con las 28 columnas del formato. Km en el cliente: odómetro de la parada; si falta, segunda barrera con
--    el odómetro inicial + km del GPS hasta la llegada (fuente GPS). Cada dato estimado o ausente queda marcado.

ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS occupancy_pct numeric(5,1);
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS occupancy_source text;
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS occupancy_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.dispatch_requests ADD COLUMN IF NOT EXISTS occupancy_at timestamptz;
DO $m$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_requests_occupancy_check') THEN
    ALTER TABLE public.dispatch_requests ADD CONSTRAINT dispatch_requests_occupancy_check CHECK (
      (occupancy_pct IS NULL OR occupancy_pct > 0 AND occupancy_pct <= 100) AND (occupancy_source IS NULL OR occupancy_source IN ('PROGRAMACION', 'CONDUCTOR')));
  END IF;
END $m$;
CREATE INDEX IF NOT EXISTS dispatch_requests_occupancy_by_idx ON public.dispatch_requests(occupancy_by);

-- Programación: % por parada al programar (o corrección de Despacho antes del cierre)
CREATE OR REPLACE FUNCTION public.dispatch_set_occupancy(p_dispatch uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT id, site_id, status INTO d FROM public.dispatches WHERE id = p_dispatch;
  IF d.id IS NULL OR NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Ruta no disponible'; END IF;
  IF NOT (public.has_tms_permission('despacho') OR public.is_tms_admin()) THEN RAISE EXCEPTION 'Sin permiso para programar rutas' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x
     WHERE NOT coalesce((x->>'pct')::numeric > 0 AND (x->>'pct')::numeric <= 100, false)) THEN
    RAISE EXCEPTION 'La ocupación de cada parada va de 1 a 100 %%';
  END IF;
  UPDATE public.dispatch_requests r SET occupancy_pct = round((x->>'pct')::numeric, 1), occupancy_source = 'PROGRAMACION', occupancy_by = auth.uid(), occupancy_at = now()
  FROM jsonb_array_elements(p_items) x WHERE r.dispatch_id = p_dispatch AND r.transport_request_id = (x->>'request_id')::uuid;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.dispatch_set_occupancy(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_set_occupancy(uuid, jsonb) TO authenticated;

-- Conductor: consulta (p_pct NULL) o corrige el % de su parada mientras la ruta no está cerrada
CREATE OR REPLACE FUNCTION public.dispatch_stop_occupancy(p_dispatch uuid, p_request uuid, p_pct numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; r record;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT x.id, x.status, x.driver_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch;
  IF d.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid() AND dr.is_active) THEN
    RAISE EXCEPTION 'Ruta no autorizada'; END IF;
  SELECT occupancy_pct, occupancy_source INTO r FROM public.dispatch_requests WHERE dispatch_id = p_dispatch AND transport_request_id = p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'La parada no pertenece a la ruta'; END IF;
  IF p_pct IS NULL THEN RETURN jsonb_build_object('pct', r.occupancy_pct, 'source', r.occupancy_source); END IF;
  IF d.status IN ('CIERRE_OPERATIVO', 'RETORNO_COMPLETADO', 'LIQUIDADO', 'CERRADO', 'CANCELADO') THEN RAISE EXCEPTION 'La ruta ya está cerrada'; END IF;
  IF NOT (p_pct > 0 AND p_pct <= 100) THEN RAISE EXCEPTION 'La ocupación va de 1 a 100 %%'; END IF;
  UPDATE public.dispatch_requests SET occupancy_pct = round(p_pct, 1), occupancy_source = 'CONDUCTOR', occupancy_by = auth.uid(), occupancy_at = now()
  WHERE dispatch_id = p_dispatch AND transport_request_id = p_request;
  RETURN jsonb_build_object('pct', round(p_pct, 1), 'source', 'CONDUCTOR');
END $$;
REVOKE ALL ON FUNCTION public.dispatch_stop_occupancy(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_stop_occupancy(uuid, uuid, numeric) TO authenticated;

-- Reporte FR-DT.004: una fila por parada, en hora de Lima, con la fuente de cada dato calculado
CREATE OR REPLACE FUNCTION public.fr_dt_004_report(p_from date, p_to date, p_plate text DEFAULT NULL, p_driver text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT (public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('flota')
     OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control')) THEN
    RAISE EXCEPTION 'Sin permiso para el reporte de despacho' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN RAISE EXCEPTION 'Elija un período de hasta 3 meses'; END IF;
  RETURN coalesce((
    WITH s AS (
      SELECT d.id did, d.dispatch_number, d.modalidad, d.status ds, d.site_id,
        upper(btrim(CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(nullif(to_jsonb(d)->>'tercero_placa', ''), d.vehicle_plate) ELSE d.vehicle_plate END)) placa,
        CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(d.tercero_conductor, d.driver_name) ELSE d.driver_name END conductor,
        coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at) salida_viaje, coalesce(d.returned_at, d.end_odometer_at) retorno,
        d.start_odometer, d.end_odometer, r.sequence_order, r.occupancy_pct, r.occupancy_source, r.stop_odometer, r.document_number doc_parada,
        t.id rid, t.request_number, t.department, t.request_type, t.reference_type, t.purchase_order, t.reference_number, t.estimated_weight,
        t.pickup_customer, t.client_id, t.supplier_id, t.contract_id,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_province ELSE t.delivery_province END provincia,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_district ELSE t.delivery_district END distrito,
        CASE WHEN t.request_type = 'RECOJO' THEN t.pickup_address ELSE t.delivery_address END direccion,
        c.arrived_at, c.departed_at, CASE WHEN d.modalidad = 'TERCERO' THEN coalesce(c.arrived_at, d.tercero_entrega_at) ELSE c.arrived_at END llegada,
        ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date fecha,
        coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure) orden_viaje
      FROM public.dispatches d JOIN public.dispatch_requests r ON r.dispatch_id = d.id JOIN public.transport_requests t ON t.id = r.transport_request_id
      LEFT JOIN public.delivery_conformities c ON c.dispatch_id = d.id AND c.request_id = t.id
      WHERE d.status <> 'CANCELADO' AND coalesce(r.status, '') NOT IN ('CANCELADO', 'RETIRADO') AND public.can_access_site(d.site_id)
        AND ((coalesce(d.departure_time, d.start_odometer_at, d.tercero_salida_at, d.scheduled_departure)) AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to),
    s2 AS (
      -- Orden del viaje en el día de la unidad: el odómetro de jornada solo vale para el primer y el último viaje
      SELECT s1.*, max(s1.viaje_dia) OVER (PARTITION BY s1.placa, s1.fecha) viajes_dia
      FROM (SELECT s.*, dense_rank() OVER (PARTITION BY s.placa, s.fecha ORDER BY s.orden_viaje, s.did) viaje_dia FROM s) s1),
    k AS (
      SELECT s.*,
        -- Km en el cliente: odómetro de la parada; si falta, km inicial + km GPS acumulados hasta la llegada
        CASE WHEN s.stop_odometer > 0 THEN s.stop_odometer
             WHEN s.modalidad = 'PROPIA' AND s.start_odometer > 0 AND s.arrived_at IS NOT NULL THEN
               s.start_odometer + round(nullif((SELECT max(p.cumulative_m) FROM public.route_track_points p WHERE p.dispatch_id = s.did AND p.recorded_at <= s.arrived_at), 0) / 1000.0, 1)
        END km_cliente,
        CASE WHEN s.stop_odometer > 0 THEN 'ODOMETRO' WHEN s.modalidad = 'PROPIA' AND s.start_odometer > 0 AND s.arrived_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.route_track_points p WHERE p.dispatch_id = s.did AND p.recorded_at <= s.arrived_at AND p.cumulative_m > 0) THEN 'GPS' END km_cliente_fuente,
        coalesce(nullif(s.start_odometer, 0), (SELECT u.odometer FROM public.unit_odometer_readings u WHERE u.kind = 'INICIO'
          AND upper(replace(u.vehicle_plate, ' ', '')) = upper(replace(s.placa, ' ', '')) AND u.operation_date = s.fecha AND s.viaje_dia = 1 ORDER BY u.captured_at LIMIT 1)) km_inicio_viaje,
        coalesce(nullif(s.end_odometer, 0), (SELECT u.odometer FROM public.unit_odometer_readings u WHERE u.kind = 'CIERRE'
          AND upper(replace(u.vehicle_plate, ' ', '')) = upper(replace(s.placa, ' ', '')) AND u.operation_date = s.fecha AND s.viaje_dia = s.viajes_dia ORDER BY u.captured_at DESC LIMIT 1)) km_fin_viaje,
        (SELECT round(sum(extract(epoch FROM (w.ended_at - w.started_at)) / 60)) FROM public.route_stop_waits w WHERE w.dispatch_id = s.did AND w.request_id = s.rid AND w.ended_at IS NOT NULL) espera_min,
        row_number() OVER (PARTITION BY s.did ORDER BY s.sequence_order, s.llegada NULLS LAST, s.rid) n_parada,
        count(*) OVER (PARTITION BY s.did) paradas
      FROM s2 s),
    f AS (
      SELECT k.*,
        row_number() OVER (PARTITION BY k.placa, k.fecha ORDER BY k.salida_viaje NULLS LAST, k.did, k.n_parada) vuelta,
        CASE WHEN k.n_parada = 1 THEN k.salida_viaje ELSE lag(k.departed_at) OVER (PARTITION BY k.did ORDER BY k.n_parada) END hora_salida,
        CASE WHEN k.n_parada = 1 THEN k.km_inicio_viaje ELSE lag(k.km_cliente) OVER (PARTITION BY k.did ORDER BY k.n_parada) END km_inicial,
        CASE WHEN k.n_parada = k.paradas THEN k.retorno ELSE k.departed_at END hora_planta,
        CASE WHEN k.n_parada = k.paradas THEN k.km_fin_viaje ELSE k.km_cliente END km_planta
      FROM k)
    SELECT jsonb_agg(jsonb_build_object(
      'area', f.department,
      'fecha', f.fecha,
      'tipo_actividad', CASE WHEN f.request_type = 'DESPACHO' THEN 'DESPACHO DE CONTRATOS'
                             WHEN f.request_type = 'RECOJO' AND f.reference_type = 'OC' THEN 'RECOJO DE ORDENES DE COMPRA'
                             ELSE 'ENVIO O RECOJO DE SERVICIOS' END,
      'guia', coalesce((SELECT sb.guide_number FROM public.delivery_submissions sb WHERE sb.dispatch_id = f.did AND sb.request_id = f.rid ORDER BY sb.submitted_at DESC LIMIT 1), f.doc_parada),
      'ot_oc_os', nullif(concat_ws(' / ', (SELECT ct.code FROM public.contracts ct WHERE ct.id = f.contract_id),
                    CASE WHEN f.reference_type IS NOT NULL AND f.reference_number IS NOT NULL THEN f.reference_type || ' ' || f.reference_number END,
                    CASE WHEN f.purchase_order IS NOT NULL AND f.purchase_order IS DISTINCT FROM f.reference_number THEN 'OC ' || f.purchase_order END), ''),
      'razon_social', coalesce((SELECT cl.business_name FROM public.clients cl WHERE cl.id = f.client_id),
                               (SELECT su.business_name FROM public.suppliers su WHERE su.id = f.supplier_id), nullif(f.pickup_customer, '')),
      'provincia', f.provincia, 'distrito', f.distrito, 'destino', coalesce(upper(f.distrito), f.direccion),
      'vuelta', f.vuelta, 'placa', f.placa,
      'marca', CASE WHEN f.modalidad = 'PROPIA' THEN (SELECT v.brand FROM public.vehicles v WHERE upper(replace(v.plate, ' ', '')) = upper(replace(f.placa, ' ', ''))) END,
      'conductor', f.conductor, 'modalidad', f.modalidad,
      'hora_salida', f.hora_salida, 'hora_llegada_cliente', f.llegada,
      'espera_min', f.espera_min,
      'descarga_min', CASE WHEN f.departed_at IS NOT NULL AND f.arrived_at IS NOT NULL
                           THEN greatest(round(extract(epoch FROM (f.departed_at - f.arrived_at)) / 60) - coalesce(f.espera_min, 0), 0) END,
      'hora_salida_cliente', f.departed_at, 'hora_llegada_planta', f.hora_planta,
      'total_min', CASE WHEN f.hora_planta IS NOT NULL AND f.hora_salida IS NOT NULL THEN round(extract(epoch FROM (f.hora_planta - f.hora_salida)) / 60) END,
      'km_inicial', f.km_inicial, 'km_cliente', f.km_cliente, 'km_cliente_fuente', f.km_cliente_fuente,
      'km_recorridos', CASE WHEN f.km_cliente IS NOT NULL AND f.km_inicial IS NOT NULL THEN f.km_cliente - f.km_inicial END,
      'km_planta', f.km_planta,
      'km_total', CASE WHEN f.km_planta IS NOT NULL AND f.km_inicial IS NOT NULL THEN f.km_planta - f.km_inicial END,
      'ocupacion_pct', f.occupancy_pct, 'ocupacion_fuente', f.occupancy_source,
      'peso_kg', coalesce(nullif(f.estimated_weight, 0), (SELECT nullif(sum(pl.total_weight_kg), 0) FROM public.wms_packing_releases pl WHERE pl.transport_request_id = f.rid AND coalesce(pl.status, '') <> 'REEMPLAZADO')),
      'peso_fuente', CASE WHEN f.estimated_weight > 0 THEN 'SOLICITUD'
                          WHEN EXISTS (SELECT 1 FROM public.wms_packing_releases pl WHERE pl.transport_request_id = f.rid AND pl.total_weight_kg > 0 AND coalesce(pl.status, '') <> 'REEMPLAZADO') THEN 'PACKING_LIST' END,
      'tipo_descarga', coalesce(
        CASE WHEN EXISTS (SELECT 1 FROM public.route_forklifts rf WHERE rf.dispatch_id = f.did AND (rf.transport_request_id IS NULL OR rf.transport_request_id = f.rid)) THEN 'MONTACARGAS' END,
        (SELECT string_agg(DISTINCT CASE WHEN upper(uc.concept) LIKE 'MONTACARG%' THEN 'MONTACARGAS' ELSE upper(uc.concept) END, ' / ')
           FROM public.transport_unloading_costs uc WHERE uc.transport_request_id = f.rid AND coalesce(uc.status, '') <> 'ANULADO'),
        'MANUAL'),
      'viaje', f.dispatch_number, 'solicitud', f.request_number, 'estado_viaje', f.ds)
      ORDER BY f.fecha, f.placa, f.vuelta)
    -- Los filtros se aplican después de numerar vueltas y viajes del día: filtrar no cambia los datos de una fila
    FROM f WHERE (p_plate IS NULL OR upper(replace(coalesce(f.placa, ''), ' ', '')) LIKE '%' || upper(replace(p_plate, ' ', '')) || '%')
      AND (p_driver IS NULL OR coalesce(f.conductor, '') ILIKE '%' || p_driver || '%')), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.fr_dt_004_report(date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fr_dt_004_report(date, date, text, text) TO authenticated;
