-- Odómetro del viaje: la lectura sigue siendo obligatoria al salir y al volver, pero la foto del tablero pasa a ser
-- opcional (indicación del 22-11-2026: la cámara del teléfono puede fallar). Si llega una foto, se valida igual.
-- La lectura registrada se reconoce por su hora (start/end_odometer_at), no por la foto.
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.dispatch_km_odometer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_odo numeric; v_gps numeric;
BEGIN
  -- 1) la lectura de salida registrada solo cambia por su propio registro (el inicio de ruta no la reemplaza por la del preuso)
  IF OLD.start_odometer_at IS NOT NULL AND NEW.start_odometer_at IS NOT DISTINCT FROM OLD.start_odometer_at THEN
    NEW.start_odometer := OLD.start_odometer;
  END IF;
  -- 2) con salida y llegada registradas, el km del viaje es el odómetro y cualquier otro valor escrito (GPS) queda como control
  IF NEW.start_odometer_at IS NOT NULL AND NEW.end_odometer_at IS NOT NULL AND NEW.start_odometer IS NOT NULL
     AND NEW.end_odometer IS NOT NULL AND NEW.end_odometer >= NEW.start_odometer THEN
    v_odo := round(NEW.end_odometer - NEW.start_odometer, 3);
    IF OLD.end_odometer_at IS NULL THEN
      v_gps := NULLIF(OLD.actual_distance_km, 0);  -- producción: 0 por defecto = sin dato
    ELSIF NEW.actual_distance_km IS DISTINCT FROM OLD.actual_distance_km AND NEW.actual_distance_km IS DISTINCT FROM v_odo THEN
      v_gps := NULLIF(NEW.actual_distance_km, 0);
    ELSE
      v_gps := OLD.gps_distance_km;
    END IF;
    NEW.gps_distance_km := v_gps;
    NEW.actual_distance_km := v_odo;
    NEW.actual_distance_source := 'ODOMETRO';
    NEW.km_check := CASE WHEN v_gps IS NULL THEN 'SIN_GPS' WHEN abs(v_odo - v_gps) > greatest(5, 0.10 * v_odo) THEN 'OBSERVADO' ELSE 'COINCIDE' END;
  -- 3) al cerrar el viaje con km solo de GPS, se registra la fuente
  ELSIF NEW.actual_distance_source IS NULL AND NULLIF(NEW.actual_distance_km, 0) IS NOT NULL
     AND NEW.status IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO') AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.actual_distance_source := 'GPS';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_odometer_required()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF coalesce(current_setting('role', true), '') NOT IN ('anon','authenticated') OR NOT public.dispatch_is_own_unit(NEW) THEN RETURN NEW; END IF;
  IF OLD.status = 'PROGRAMADO' AND NEW.status IN ('EN RUTA','EN_CURSO') AND NEW.start_odometer_at IS NULL THEN
    RAISE EXCEPTION 'Registre el odómetro de salida antes de iniciar la ruta';
  END IF;
  IF NEW.status = 'RETORNO_COMPLETADO' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.start_odometer_at IS NOT NULL AND NEW.end_odometer_at IS NULL THEN
    RAISE EXCEPTION 'Registre el odómetro de llegada antes de confirmar la llegada a base';
  END IF;
  RETURN NEW;
END $$;

-- El odómetro final del flujo antiguo tampoco exige foto; si la trae, debe existir
DO $m$
DECLARE def text; a text := E'  IF photo IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=''driver_evidence'' AND o.name=photo) THEN\n    RAISE EXCEPTION ''Adjunte la foto del tablero para validar el odómetro final'';';
BEGIN
  def := pg_get_functiondef('public.dispatch_set_odometer_distance()'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'dispatch_set_odometer_distance cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, E'  IF photo IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=''driver_evidence'' AND o.name=photo) THEN\n    RAISE EXCEPTION ''La foto del tablero no se encontró; vuelva a intentarlo'';');
END $m$;

CREATE OR REPLACE FUNCTION public.dispatch_record_odometer(p_dispatch uuid, p_kind text, p_value numeric, p_photo text, p_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_kind text := upper(btrim(coalesce(p_kind, ''))); v numeric := round(p_value, 1);
  v_photo text := NULLIF(btrim(coalesce(p_photo, '')), ''); v_prev numeric; v_at timestamptz;
BEGIN
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch FOR UPDATE;
  IF d.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.drivers r WHERE r.id = d.driver_id AND r.profile_id = auth.uid() AND r.is_active) THEN
    RAISE EXCEPTION 'Solo el conductor del viaje registra el odómetro' USING ERRCODE = '42501'; END IF;
  IF NOT public.dispatch_is_own_unit(d) THEN RAISE EXCEPTION 'El odómetro se registra solo en unidades propias'; END IF;
  IF v_kind NOT IN ('SALIDA','LLEGADA') THEN RAISE EXCEPTION 'Indique si es la lectura de salida o de llegada'; END IF;
  IF v IS NULL OR v <= 0 OR v >= 5000000 THEN RAISE EXCEPTION 'Ingrese el odómetro (km) que marca el tablero'; END IF;
  -- Foto opcional: si se envía, debe estar en la carpeta del conductor
  IF v_photo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'driver_evidence' AND o.name = v_photo
      AND (storage.foldername(o.name))[1] = auth.uid()::text) THEN
    RAISE EXCEPTION 'La foto del tablero no se encontró; vuelva a intentarlo'; END IF;
  v_at := public.route_event_time(p_dispatch, p_at);
  IF v_kind = 'SALIDA' THEN
    IF d.status NOT IN ('PROGRAMADO','EN RUTA','EN_CURSO') THEN RAISE EXCEPTION 'La lectura de salida se registra antes o durante la ruta'; END IF;
    IF d.end_odometer_at IS NOT NULL THEN RAISE EXCEPTION 'El viaje ya tiene lectura de llegada'; END IF;
    -- No retrocede respecto de la última llegada registrada de la misma unidad
    SELECT x.end_odometer INTO v_prev FROM public.dispatches x WHERE x.vehicle_plate = d.vehicle_plate AND x.id <> d.id
      AND x.end_odometer_at IS NOT NULL AND x.end_odometer_at <= v_at ORDER BY x.end_odometer_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v < v_prev THEN RAISE EXCEPTION 'El odómetro (% km) es menor a la llegada del viaje anterior de la unidad (% km)', v, v_prev; END IF;
    UPDATE public.dispatches SET start_odometer = v, start_odometer_photo = v_photo, start_odometer_at = v_at WHERE id = d.id;
  ELSE
    IF d.status NOT IN ('EN RUTA','EN_CURSO','ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','CIERRE_OPERATIVO','ENTREGADO') THEN
      RAISE EXCEPTION 'La lectura de llegada se registra al volver de la ruta'; END IF;
    IF d.end_odometer_at IS NOT NULL THEN RETURN jsonb_build_object('success', true, 'already', true); END IF;
    IF d.start_odometer IS NULL THEN RAISE EXCEPTION 'El viaje no tiene odómetro de salida'; END IF;
    IF v < d.start_odometer THEN RAISE EXCEPTION 'El odómetro de llegada (% km) es menor al de salida (% km)', v, d.start_odometer; END IF;
    IF v - d.start_odometer > 3000 THEN RAISE EXCEPTION 'Diferencia de % km entre salida y llegada: revise la lectura', v - d.start_odometer; END IF;
    UPDATE public.dispatches SET end_odometer = v, end_odometer_photo = v_photo, end_odometer_at = v_at,
      liquidation_data = coalesce(liquidation_data, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('odometer_photo', v_photo)) WHERE id = d.id;
  END IF;
  -- Lectura de la unidad para Mantenimiento por la vía validada (un salto sin foto queda para auditoría)
  BEGIN PERFORM public.asset_reading_apply(d.vehicle_plate, v, NULL, 'VIAJE_' || v_kind, v_photo, d.id, d.driver_id, NULL, auth.uid());
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Odómetro de % sin actualizar: %', d.vehicle_plate, SQLERRM; END;
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  RETURN jsonb_build_object('success', true, 'start_odometer', d.start_odometer, 'end_odometer', d.end_odometer, 'con_foto', v_photo IS NOT NULL,
    'km', CASE WHEN d.actual_distance_source = 'ODOMETRO' THEN d.actual_distance_km END, 'gps_km', d.gps_distance_km, 'km_check', d.km_check);
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_odometer_state(p_dispatch uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE;
BEGIN
  IF NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin acceso al viaje' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.dispatches WHERE id = p_dispatch;
  RETURN jsonb_build_object('own_unit', public.dispatch_is_own_unit(d), 'status', d.status,
    'start_odometer', CASE WHEN d.start_odometer_at IS NOT NULL THEN d.start_odometer END, 'start_at', d.start_odometer_at, 'start_photo', d.start_odometer_photo IS NOT NULL,
    'end_odometer', CASE WHEN d.end_odometer_at IS NOT NULL THEN d.end_odometer END, 'end_at', d.end_odometer_at, 'end_photo', d.end_odometer_photo IS NOT NULL,
    'km', CASE WHEN d.actual_distance_source = 'ODOMETRO' THEN d.actual_distance_km END, 'gps_km', d.gps_distance_km, 'km_check', d.km_check);
END $$;

UPDATE public.kpi_eq_def SET descripcion = 'Calidad del dato de km: viajes propios cerrados con odómetro de salida y llegada registrados. El control con GPS se ve en el detalle.',
  formula = 'Viajes propios cerrados con km por odómetro ÷ viajes propios cerrados × 100', nota_datos = 'El odómetro es obligatorio desde el 21-11-2026 y la foto del tablero es opcional desde el 22-11-2026.', updated_at = now()
WHERE codigo = 'T10';
