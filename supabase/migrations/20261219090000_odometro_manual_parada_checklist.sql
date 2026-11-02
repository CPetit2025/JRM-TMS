-- Odómetro por ingreso manual: en la parada (entrega) y en el checklist FR-DT 007 el conductor digita el kilometraje
-- del tablero; la foto deja de ser obligatoria (si llega, p. ej. desde una cola offline antigua, se valida igual).
-- Se mantienen las validaciones de coherencia: retroceso bloquea en la parada y se marca en el checklist; saltos > 1500 km se marcan.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.unit_odometer_readings ALTER COLUMN photo_path DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.unit_odometer_record(p_operation uuid, p_plate text, p_driver uuid, p_day date, p_kind text,
  p_value text, p_photo text, p_captured timestamptz, p_by uuid, p_revision uuid)
RETURNS public.unit_odometer_readings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v numeric; prev numeric; rec public.unit_odometer_readings; photo text := NULLIF(btrim(COALESCE(p_photo, '')), '');
BEGIN
  SELECT * INTO rec FROM public.unit_odometer_readings WHERE operation_id = p_operation;
  IF rec.operation_id IS NOT NULL THEN RETURN rec; END IF;
  BEGIN v := round(replace(btrim(COALESCE(p_value, '')), ',', '.')::numeric, 1);
  EXCEPTION WHEN OTHERS THEN v := NULL; END;
  IF v IS NULL OR v <= 0 OR v >= 5000000 THEN RAISE EXCEPTION 'Ingrese el odómetro (km) que marca el tablero de la unidad'; END IF;
  IF photo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'driver_evidence' AND o.name = photo
      AND (storage.foldername(o.name))[1] = p_by::text) THEN
    RAISE EXCEPTION 'La foto del odómetro no se encontró; vuelva a intentarlo'; END IF;
  SELECT odometer INTO prev FROM public.unit_odometer_readings WHERE vehicle_plate = p_plate AND captured_at <= p_captured
   ORDER BY captured_at DESC LIMIT 1;
  INSERT INTO public.unit_odometer_readings(operation_id, vehicle_plate, driver_id, unit_revision, operation_date, kind, odometer, photo_path,
    previous_odometer, flag, captured_at, created_by)
  VALUES (p_operation, p_plate, p_driver, p_revision, p_day, p_kind, v, photo, prev,
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

CREATE OR REPLACE FUNCTION public.delivery_submit_driver_with_odometer(
  p_dispatch uuid,p_request uuid,p_photos text[],p_received text,p_note text,p_guide text,
  p_operation uuid,p_captured timestamptz,p_odometer numeric,p_odometer_photo text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches; stop public.dispatch_requests; prev numeric; v_km numeric; v_flag text; result jsonb;
  photo text:=NULLIF(btrim(COALESCE(p_odometer_photo,'')),'');
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
  IF d.id IS NULL OR d.vehicle_plate IS NULL OR d.vehicle_plate='EXTERNO'
     OR COALESCE(to_jsonb(d)->>'modalidad','PROPIA')='TERCERO' THEN
    RAISE EXCEPTION 'La captura por odómetro solo aplica a unidades propias';
  END IF;
  IF p_odometer IS NULL OR p_odometer<=0 OR p_odometer>=5000000 THEN RAISE EXCEPTION 'Ingrese el odómetro (km) que marca el tablero'; END IF;
  IF photo IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence'
      AND o.name=photo AND (storage.foldername(o.name))[1]=auth.uid()::text) THEN
    RAISE EXCEPTION 'La foto del odómetro no se encontró; vuelva a intentarlo';
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
    IF stop.stop_odometer IS DISTINCT FROM p_odometer THEN
      RAISE EXCEPTION 'La operación ya se registró con otra lectura de odómetro';
    END IF;
    RETURN result;
  END IF;

  UPDATE public.dispatch_requests SET stop_odometer=p_odometer,stop_odometer_photo=photo,
    stop_odometer_at=p_captured,stop_odometer_flag=v_flag,leg_odometer_km=v_km,
    leg_km_source=CASE WHEN COALESCE(leg_gps_complete,false) THEN 'GPS_COMPLETO' ELSE 'ODOMETRO' END,
    leg_actual_km=CASE WHEN COALESCE(leg_gps_complete,false) THEN leg_actual_km ELSE v_km END
   WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
  SELECT * INTO stop FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
  RETURN result||jsonb_build_object('leg_actual_km',stop.leg_actual_km,'leg_km_source',stop.leg_km_source,'odometer_flag',v_flag);
END $$;
REVOKE ALL ON FUNCTION public.delivery_submit_driver_with_odometer(uuid,uuid,text[],text,text,text,uuid,timestamptz,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.delivery_submit_driver_with_odometer(uuid,uuid,text[],text,text,text,uuid,timestamptz,numeric,text) TO authenticated,service_role;

-- Mensaje de inicio sin GPS: ya no pide foto (solo cambia el texto si está presente)
DO $patch$ DECLARE def text; BEGIN
  def:=pg_get_functiondef('public.start_dispatch_route(uuid,numeric,numeric)'::regprocedure);
  IF position('odómetro inicial con foto en el checklist' IN def)>0 THEN
    EXECUTE replace(def,'odómetro inicial con foto en el checklist','odómetro inicial en el checklist');
  END IF;
END $patch$;

COMMIT;
