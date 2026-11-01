-- Captura de odómetro por parada con foto y fallback de km por OT cuando el GPS del tramo falta.
-- También usa la lectura final de la ruta para conciliar el recorrido total de la unidad.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.dispatch_requests
  ADD COLUMN IF NOT EXISTS stop_odometer numeric(12,1),
  ADD COLUMN IF NOT EXISTS stop_odometer_photo text,
  ADD COLUMN IF NOT EXISTS stop_odometer_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_odometer_flag text,
  ADD COLUMN IF NOT EXISTS leg_odometer_km numeric(12,3),
  ADD COLUMN IF NOT EXISTS leg_km_source text;
ALTER TABLE public.dispatches
  ADD COLUMN IF NOT EXISTS actual_distance_source text;

DO $constraints$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_requests_leg_km_source_check') THEN
    ALTER TABLE public.dispatch_requests ADD CONSTRAINT dispatch_requests_leg_km_source_check
      CHECK (leg_km_source IS NULL OR leg_km_source IN ('GPS_COMPLETO','ODOMETRO','GPS_PARCIAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_requests_stop_odometer_flag_check') THEN
    ALTER TABLE public.dispatch_requests ADD CONSTRAINT dispatch_requests_stop_odometer_flag_check
      CHECK (stop_odometer_flag IS NULL OR stop_odometer_flag IN ('SALTO'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatches_actual_distance_source_check') THEN
    ALTER TABLE public.dispatches ADD CONSTRAINT dispatches_actual_distance_source_check
      CHECK (actual_distance_source IS NULL OR actual_distance_source IN ('GPS','ODOMETRO'));
  END IF;
END $constraints$;

-- La app admite iniciar sin GPS solo si el checklist FR-DT 007 dejó una lectura inicial válida.
DO $patch$
DECLARE sig regprocedure:='public.start_dispatch_route(uuid,numeric,numeric)'::regprocedure; def text;
  old_guard text:=$old$IF p_lat IS NULL OR p_lon IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Coordenadas iniciales inválidas'; END IF;$old$;
  new_guard text:=$new$IF (p_lat IS NULL OR p_lon IS NULL) AND NOT EXISTS(
    SELECT 1 FROM public.unit_odometer_readings o JOIN public.driver_preuse_units u ON u.driver_id=o.driver_id
    WHERE o.driver_id=(SELECT driver_id FROM public.dispatches WHERE id=p_dispatch_id)
      AND o.vehicle_plate=(SELECT vehicle_plate FROM public.dispatches WHERE id=p_dispatch_id)
      AND o.operation_date=(now() AT TIME ZONE 'America/Lima')::date AND o.kind='INICIO' AND o.unit_revision=u.revision
      AND u.operation_date=o.operation_date AND u.vehicle_plate=o.vehicle_plate) THEN
    RAISE EXCEPTION 'Sin GPS: registre el odómetro inicial con foto en el checklist FR-DT 007 antes de iniciar';
  END IF;
  IF (p_lat IS NULL) <> (p_lon IS NULL) OR (p_lat IS NOT NULL AND (p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180)) THEN
    RAISE EXCEPTION 'Coordenadas iniciales inválidas'; END IF;$new$;
  old_update text:=$old$UPDATE public.dispatches SET status='EN RUTA',start_lat=p_lat,start_lon=p_lon,departure_time=CASE WHEN d.status='PROGRAMADO' THEN now() ELSE COALESCE(departure_time,now()) END WHERE id=p_dispatch_id;$old$;
  new_update text:=$new$UPDATE public.dispatches SET status='EN RUTA',start_lat=p_lat,start_lon=p_lon,
    start_odometer=COALESCE((SELECT z.odometer FROM (
      SELECT o.odometer,o.captured_at AS at FROM public.unit_odometer_readings o JOIN public.driver_preuse_units u ON u.driver_id=o.driver_id
       WHERE o.vehicle_plate=d.vehicle_plate AND o.operation_date=(now() AT TIME ZONE 'America/Lima')::date AND o.kind='INICIO'
         AND o.unit_revision=u.revision AND u.operation_date=o.operation_date
      UNION ALL
      SELECT x.end_odometer,COALESCE(x.arrival_time,x.returned_at,x.scheduled_departure) FROM public.dispatches x
       WHERE x.vehicle_plate=d.vehicle_plate AND x.id<>d.id AND x.end_odometer IS NOT NULL AND x.status<>'CANCELADO'
    ) z ORDER BY z.at DESC NULLS LAST LIMIT 1),start_odometer),
    departure_time=CASE WHEN d.status='PROGRAMADO' THEN now() ELSE COALESCE(departure_time,now()) END WHERE id=p_dispatch_id;$new$;
BEGIN
  def:=pg_get_functiondef(sig);
  IF position('Sin GPS: registre el odómetro inicial' IN def)>0 THEN RETURN; END IF;
  IF position(old_guard IN def)=0 OR position(old_update IN def)=0 THEN
    RAISE EXCEPTION 'Inicio de ruta no reconocido; revisar antes de migrar';
  END IF;
  EXECUTE replace(replace(def,old_guard,new_guard),old_update,new_update);
END $patch$;

-- Solo el camino seguro de entrega que exige una lectura real con evidencia usa este RPC.
CREATE OR REPLACE FUNCTION public.delivery_submit_driver_with_odometer(
  p_dispatch uuid,p_request uuid,p_photos text[],p_received text,p_note text,p_guide text,
  p_operation uuid,p_captured timestamptz,p_odometer numeric,p_odometer_photo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches; stop public.dispatch_requests; prev numeric; v_km numeric; v_flag text; result jsonb;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
  IF d.id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate='EXTERNO'
     OR COALESCE(to_jsonb(d)->>'modalidad','PROPIA')='TERCERO' THEN
    RAISE EXCEPTION 'La captura por odómetro solo aplica a unidades propias';
  END IF;
  IF p_odometer IS NULL OR p_odometer<=0 OR p_odometer>=5000000 THEN RAISE EXCEPTION 'Ingrese una lectura de odómetro válida'; END IF;
  IF p_odometer_photo IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence'
      AND o.name=p_odometer_photo AND (storage.foldername(o.name))[1]=auth.uid()::text) THEN
    RAISE EXCEPTION 'Adjunte la foto del tablero para validar el odómetro';
  END IF;
  SELECT * INTO stop FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request FOR UPDATE;
  IF stop.dispatch_id IS NULL THEN RAISE EXCEPTION 'Parada fuera de la ruta'; END IF;
  SELECT r.stop_odometer INTO prev FROM public.dispatch_requests r
   WHERE r.dispatch_id=p_dispatch AND r.sequence_order<stop.sequence_order AND r.stop_odometer IS NOT NULL
   ORDER BY r.sequence_order DESC LIMIT 1;
  prev:=COALESCE(prev,d.start_odometer,
    (SELECT o.odometer FROM public.unit_odometer_readings o WHERE o.vehicle_plate=d.vehicle_plate AND o.captured_at<=p_captured ORDER BY o.captured_at DESC LIMIT 1));
  IF prev IS NULL THEN RAISE EXCEPTION 'No hay odómetro inicial. Registre el checklist FR-DT 007 antes de iniciar ruta'; END IF;
  IF p_odometer<prev THEN RAISE EXCEPTION 'El odómetro de la parada (%) no puede ser menor al último registrado (%)',p_odometer,prev; END IF;
  v_km:=round(p_odometer-prev,3);
  IF v_km>1500 THEN v_flag:='SALTO'; END IF;

  result:=public.delivery_submit_driver(p_dispatch,p_request,p_photos,p_received,p_note,p_guide,p_operation,p_captured);
  IF COALESCE((result->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION '%',COALESCE(result->>'error','No se pudo guardar la entrega'); END IF;
  IF COALESCE((result->>'duplicate')::boolean,false) AND stop.stop_odometer IS NOT NULL THEN
    IF stop.stop_odometer IS DISTINCT FROM p_odometer OR stop.stop_odometer_photo IS DISTINCT FROM p_odometer_photo THEN
      RAISE EXCEPTION 'La operación ya se registró con otra lectura de odómetro';
    END IF;
    RETURN result;
  END IF;

  UPDATE public.dispatch_requests SET stop_odometer=p_odometer,stop_odometer_photo=p_odometer_photo,
    stop_odometer_at=p_captured,stop_odometer_flag=v_flag,leg_odometer_km=v_km,
    leg_km_source=CASE WHEN COALESCE(leg_gps_complete,false) THEN 'GPS_COMPLETO' ELSE 'ODOMETRO' END,
    leg_actual_km=CASE WHEN COALESCE(leg_gps_complete,false) THEN leg_actual_km ELSE v_km END
   WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
  SELECT * INTO stop FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
  RETURN result||jsonb_build_object('leg_actual_km',stop.leg_actual_km,'leg_km_source',stop.leg_km_source,'odometer_flag',v_flag);
END $$;
REVOKE ALL ON FUNCTION public.delivery_submit_driver_with_odometer(uuid,uuid,text[],text,text,text,uuid,timestamptz,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.delivery_submit_driver_with_odometer(uuid,uuid,text[],text,text,text,uuid,timestamptz,numeric,text) TO authenticated,service_role;
-- Los conductores pasan por el wrapper con evidencia; otras funciones SECURITY DEFINER mantienen su uso interno.
REVOKE EXECUTE ON FUNCTION public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz) FROM authenticated;

-- El sync offline conserva la misma operación, fotos e idempotencia.
DO $patch$ DECLARE def text; old_call text; new_call text; BEGIN
  def:=pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure);
  old_call:=$old$v_result := public.delivery_submit_driver((p_payload->>'dispatch_id')::uuid,(p_payload->>'request_id')::uuid,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'photos')),p_payload->>'received_by',p_payload->>'note',p_payload->>'guide',
      p_operation_id,(p_payload->>'captured_at')::timestamptz);$old$;
  new_call:=$new$v_result := public.delivery_submit_driver_with_odometer((p_payload->>'dispatch_id')::uuid,(p_payload->>'request_id')::uuid,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'photos')),p_payload->>'received_by',p_payload->>'note',p_payload->>'guide',
      p_operation_id,(p_payload->>'captured_at')::timestamptz,NULLIF(p_payload->>'odometer','')::numeric,p_payload->>'odometer_photo');$new$;
  IF position('delivery_submit_driver_with_odometer' IN def)>0 THEN RETURN; END IF;
  IF position(old_call IN def)=0 THEN RAISE EXCEPTION 'Sincronizador offline de entregas no reconocido'; END IF;
  EXECUTE replace(def,old_call,new_call);
END $patch$;

-- La lectura final concilia el total de la ruta y marca su procedencia (sin presentar el estimado como real).
CREATE OR REPLACE FUNCTION public.dispatch_set_odometer_distance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE photo text; gps_complete boolean;
BEGIN
  IF NEW.end_odometer IS NOT DISTINCT FROM OLD.end_odometer OR NEW.end_odometer IS NULL THEN RETURN NEW; END IF;
  IF NEW.vehicle_plate IS NULL OR NEW.vehicle_plate='EXTERNO' OR COALESCE(to_jsonb(NEW)->>'modalidad','PROPIA')='TERCERO' THEN RETURN NEW; END IF;
  photo:=NEW.liquidation_data->>'odometer_photo';
  IF photo IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence' AND o.name=photo) THEN
    RAISE EXCEPTION 'Adjunte la foto del tablero para validar el odómetro final';
  END IF;
  IF NEW.start_odometer IS NULL OR NEW.end_odometer<NEW.start_odometer THEN RAISE EXCEPTION 'Lectura final menor al odómetro de inicio de ruta'; END IF;
  SELECT count(*)>0 AND bool_and(COALESCE(r.leg_gps_complete,false)) INTO gps_complete
    FROM public.dispatch_requests r WHERE r.dispatch_id=NEW.id;
  gps_complete:=COALESCE(gps_complete,false) AND COALESCE(NEW.return_gps_complete,false)
    AND NOT EXISTS(SELECT 1 FROM public.route_track_points p WHERE p.dispatch_id=NEW.id AND p.gap_detected);
  IF NOT gps_complete THEN
    NEW.actual_distance_km:=round(NEW.end_odometer-NEW.start_odometer,3);
    NEW.actual_distance_source:='ODOMETRO';
  ELSIF NEW.actual_distance_km IS NOT NULL THEN
    NEW.actual_distance_source:='GPS';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_set_odometer_distance() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_set_odometer_distance ON public.dispatches;
CREATE TRIGGER dispatch_set_odometer_distance BEFORE UPDATE OF end_odometer ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_set_odometer_distance();

-- Expone kilómetros por OT/servicio, fuente del dato, costos y foto de la lectura.
DO $patch$ DECLARE sig regprocedure:='public.unit_daily_report(text,date,date)'::regprocedure; def text;
  old_stops text := 'dr.leg_gps_complete, sp.business_name AS reference_supplier,';
  new_stops text := 'dr.leg_gps_complete, dr.leg_km_source, dr.stop_odometer, dr.stop_odometer_photo, dr.stop_odometer_flag, sp.business_name AS reference_supplier,';
  old_json text := '''km_leg'', s.leg_actual_km, ''km_source'', CASE WHEN s.leg_gps_complete IS TRUE THEN ''GPS_COMPLETO'' WHEN s.leg_actual_km IS NOT NULL THEN ''GPS_PARCIAL'' ELSE ''SIN_DATO'' END';
  new_json text := '''km_leg'', s.leg_actual_km, ''km_source'', COALESCE(s.leg_km_source, CASE WHEN s.leg_gps_complete IS TRUE THEN ''GPS_COMPLETO'' WHEN s.leg_actual_km IS NOT NULL THEN ''GPS_PARCIAL'' ELSE ''SIN_DATO'' END), ''odo_reading'', s.stop_odometer, ''odo_photo'', s.stop_odometer_photo, ''odo_flag'', s.stop_odometer_flag';
  old_route text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real,';
  new_route text := 'NULLIF((to_jsonb(d)->>''actual_distance_km'')::numeric, 0) AS km_real, to_jsonb(d)->>''actual_distance_source'' AS km_real_source,';
  old_disp_json text := '''km_real'', disp.km_real, ''km_est'', disp.km_est,';
  new_disp_json text := '''km_real'', disp.km_real, ''km_real_source'', disp.km_real_source, ''km_est'', disp.km_est,';
BEGIN
  def:=pg_get_functiondef(sig);
  IF position('odo_reading' IN def)>0 THEN RETURN; END IF;
  IF position(old_stops IN def)=0 OR position(old_json IN def)=0 OR position(old_route IN def)=0 OR position(old_disp_json IN def)=0 THEN
    RAISE EXCEPTION 'Definición de reporte por unidad no reconocida; revisar antes de migrar';
  END IF;
  EXECUTE replace(replace(replace(replace(def,old_stops,new_stops),old_json,new_json),old_route,new_route),old_disp_json,new_disp_json);
END $patch$;

-- Una vez cerrada, la salida de unidad no queda calculada sin cierre físico si no hay GPS completo.
NOTIFY pgrst,'reload schema';
COMMIT;
