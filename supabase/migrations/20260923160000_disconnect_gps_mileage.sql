-- Fase 1: Desconectar el GPS del Odómetro Oficial
BEGIN;

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
    
    -- FASE 1: DESCONEXIÓN. Ya no sumamos la distancia GPS al odómetro del vehículo.
    -- El GPS solo sirve de contraste. El odómetro real se actualiza mediante checklist u otros métodos.
    SELECT current_mileage INTO v_mileage FROM public.vehicles WHERE plate = v_dispatch.vehicle_plate;
    
    IF v_mileage IS NOT NULL THEN
      INSERT INTO public.vehicle_maintenance_history(vehicle_id, action_type, description, mileage_at_time)
      SELECT id, 'GPS_REGISTRADO', 'Ruta ' || v_dispatch.dispatch_number
        || ' (Recorrido GPS: ' || v_dispatch.actual_distance_km || ' km)', v_mileage
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
