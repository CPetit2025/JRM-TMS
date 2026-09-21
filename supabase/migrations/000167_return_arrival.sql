BEGIN;

ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS return_actual_km numeric(12,3);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS return_gps_complete boolean;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS returned_at timestamptz;

CREATE OR REPLACE FUNCTION public.complete_dispatch_return(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid;
DECLARE v_last public.route_track_points%ROWTYPE;
DECLARE v_km numeric;
DECLARE v_complete boolean;
BEGIN
  SELECT driver_id INTO v_driver FROM public.dispatches
    WHERE id = p_dispatch_id AND status = 'RETORNO' FOR UPDATE;
  IF v_driver IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers
    WHERE id = v_driver AND profile_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Retorno no autorizado';
  END IF;
  SELECT * INTO v_last FROM public.route_track_points
    WHERE dispatch_id = p_dispatch_id ORDER BY recorded_at DESC LIMIT 1;
  IF v_last.id IS NULL OR v_last.recorded_at < now() - interval '45 seconds' THEN
    RAISE EXCEPTION 'Se requiere una señal GPS reciente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.authorized_locations l WHERE l.is_active = true
    AND 6371 * 2 * asin(sqrt(
      power(sin(radians((v_last.latitude - l.latitude)::double precision) / 2), 2)
      + cos(radians(l.latitude::double precision)) * cos(radians(v_last.latitude::double precision))
      * power(sin(radians((v_last.longitude - l.longitude)::double precision) / 2), 2)
    )) <= l.radius_km) THEN
    RAISE EXCEPTION 'La unidad debe llegar a una base autorizada';
  END IF;
  SELECT round(coalesce(sum(distance_m), 0) / 1000, 3),
    count(*) >= 2 AND NOT bool_or(gap_detected)
  INTO v_km, v_complete FROM public.route_track_points
  WHERE dispatch_id = p_dispatch_id AND leg_order = 0;
  UPDATE public.dispatches SET status = 'RETORNO_COMPLETADO', return_actual_km = v_km,
    return_gps_complete = v_complete, returned_at = now()
  WHERE id = p_dispatch_id;
  RETURN jsonb_build_object('return_actual_km', v_km, 'return_gps_complete', v_complete,
    'actual_distance_km', v_last.cumulative_m / 1000);
END $$;
REVOKE ALL ON FUNCTION public.complete_dispatch_return(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_dispatch_return(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_dispatch_route(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dispatch public.dispatches%ROWTYPE;
DECLARE v_coverage boolean;
DECLARE v_mileage numeric;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para cerrar despachos'; END IF;
  SELECT * INTO v_dispatch FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF v_dispatch.id IS NULL THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
  IF v_dispatch.status = 'LIQUIDADO' THEN
    RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
      'gps_complete', v_dispatch.gps_coverage_complete);
  END IF;
  IF v_dispatch.status <> 'RETORNO_COMPLETADO'
    OR EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND status <> 'ENTREGADO') THEN
    RAISE EXCEPTION 'Falta confirmar el retorno a base o hay paradas pendientes';
  END IF;
  SELECT count(*) > 0 AND bool_and(coalesce(leg_gps_complete, false))
    INTO v_coverage FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id;
  v_coverage := coalesce(v_coverage, false) AND coalesce(v_dispatch.return_gps_complete, false)
    AND NOT EXISTS (SELECT 1 FROM public.route_track_points
      WHERE dispatch_id = p_dispatch_id AND gap_detected);
  IF coalesce(v_dispatch.freight_cost, 0) > 0 AND v_dispatch.contract_id IS NOT NULL THEN
    UPDATE public.contract_budgets SET reserved_pen = reserved_pen - v_dispatch.freight_cost,
      consumed_pen = consumed_pen + v_dispatch.freight_cost, updated_at = now()
    WHERE contract_id = v_dispatch.contract_id AND concept = 'PARTIDA_TRANSPORTE'
      AND reserved_pen >= v_dispatch.freight_cost;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reserva presupuestal inconsistente'; END IF;
  END IF;
  IF v_coverage AND coalesce(v_dispatch.actual_distance_km, 0) > 0
    AND v_dispatch.vehicle_plate IS NOT NULL AND v_dispatch.vehicle_plate <> 'EXTERNO' THEN
    UPDATE public.vehicles SET current_mileage = coalesce(current_mileage, 0) + v_dispatch.actual_distance_km
    WHERE plate = v_dispatch.vehicle_plate RETURNING current_mileage INTO v_mileage;
    IF v_mileage IS NOT NULL THEN
      INSERT INTO public.vehicle_maintenance_history(vehicle_id, action_type, description, mileage_at_time)
      SELECT id, 'KM_ACTUALIZADO', 'Ruta ' || v_dispatch.dispatch_number
        || ' (GPS: ' || v_dispatch.actual_distance_km || ' km)', v_mileage
      FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    END IF;
  END IF;
  UPDATE public.transport_requests SET status = 'ENTREGADA' WHERE id IN (
    SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id);
  UPDATE public.dispatches SET status = 'LIQUIDADO', gps_coverage_complete = v_coverage
    WHERE id = p_dispatch_id;
  RETURN jsonb_build_object('actual_distance_km', v_dispatch.actual_distance_km,
    'gps_complete', v_coverage);
END $$;
REVOKE ALL ON FUNCTION public.close_dispatch_route(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_dispatch_route(uuid) TO authenticated;

COMMIT;
