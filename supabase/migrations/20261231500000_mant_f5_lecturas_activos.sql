-- Mantenimiento fase 5 (20-11-2026): activos y lecturas.
-- * Una sola vía de lecturas: asset_reading_apply valida y registra en vehicle_odometer_logs; solo una lectura VALIDADA
--   actualiza la unidad. Retroceso (odómetro u horómetro menor al vigente) o salto atípico (> 1 500 km, mismo umbral que
--   unit_odometer_readings) sin foto quedan REQUIERE_AUDITORIA y no mueven el odómetro. La usan el reporte de falla
--   (antes grababa VALIDADO una lectura menor), la lectura de Mantenimiento, el odómetro de despacho, la jornada del
--   conductor, el combustible de caja y el post-ruta (antes sobrescribía el odómetro sin validar).
-- * Desde la pantalla ya no se editan lecturas, ni se borra ni se desactiva una unidad directamente: la lectura va por
--   register_asset_reading y la baja por set_vehicle_active (desactiva; nunca borra).
-- Producción no coincide con las migraciones: las funciones reemplazadas parten de su definición viva.
BEGIN;

CREATE OR REPLACE FUNCTION public.asset_reading_apply(
  p_plate text, p_odometer numeric, p_hours numeric, p_source text, p_photo text DEFAULT NULL,
  p_dispatch uuid DEFAULT NULL, p_driver uuid DEFAULT NULL, p_notes text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v record;
  v_photo  text := NULLIF(btrim(COALESCE(p_photo, '')), '');
  v_flag   text;
  v_status text := 'VALIDADO';
BEGIN
  SELECT id, plate, NULLIF(current_odometer, 0) AS odo, NULLIF(current_hours, 0) AS hrs
  INTO v FROM public.vehicles WHERE plate = upper(btrim(p_plate)) FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION 'Unidad no registrada: %', p_plate; END IF;
  IF p_odometer IS NULL AND p_hours IS NULL THEN RAISE EXCEPTION 'Informe odómetro u horómetro'; END IF;
  IF p_odometer < 0 OR p_hours < 0 THEN RAISE EXCEPTION 'La lectura no puede ser negativa'; END IF;

  IF p_odometer < v.odo OR p_hours < v.hrs THEN
    v_flag := 'RETROCESO';
  ELSIF p_odometer - v.odo > 1500 THEN
    v_flag := 'SALTO';
  END IF;
  IF v_flag = 'RETROCESO' OR (v_flag = 'SALTO' AND v_photo IS NULL) THEN v_status := 'REQUIERE_AUDITORIA'; END IF;

  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, driver_id, dispatch_id, odometer_value, hours_value, photo_url,
                                            source_event, status, notes, created_by)
  VALUES (v.plate, p_driver, p_dispatch, COALESCE(p_odometer, v.odo, 0), p_hours, v_photo,
          upper(COALESCE(NULLIF(btrim(p_source), ''), 'MANTENIMIENTO')), v_status,
          NULLIF(concat_ws(' · ',
            CASE v_flag WHEN 'RETROCESO' THEN 'Lectura menor a la vigente (' || COALESCE(v.odo, 0) || ' km / ' || COALESCE(v.hrs, 0) || ' h)'
                        WHEN 'SALTO' THEN 'Salto atípico de ' || (p_odometer - v.odo) || ' km' || CASE WHEN v_photo IS NULL THEN ' sin foto' ELSE ' con foto' END END,
            NULLIF(btrim(p_notes), '')), ''),
          COALESCE(auth.uid(), p_actor));

  IF v_status = 'VALIDADO' THEN
    UPDATE public.vehicles SET current_odometer = COALESCE(p_odometer, current_odometer),
                               current_hours    = COALESCE(p_hours, current_hours)
    WHERE id = v.id;
  END IF;
  RETURN jsonb_build_object('status', v_status, 'flag', v_flag, 'previous_odometer', v.odo, 'previous_hours', v.hrs);
END $$;
REVOKE ALL ON FUNCTION public.asset_reading_apply(text, numeric, numeric, text, text, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- Lectura manual de Mantenimiento / Flota
CREATE OR REPLACE FUNCTION public.register_asset_reading(p_vehicle_plate text, p_odometer numeric DEFAULT NULL::numeric, p_hours numeric DEFAULT NULL::numeric, p_source text DEFAULT 'MANTENIMIENTO'::text, p_notes text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v public.vehicles%ROWTYPE;
  r jsonb;
BEGIN
  SELECT * INTO v FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada');
  END IF;
  -- Fuente autorizada: mantenimiento/flota de la sede, o el conductor con un viaje activo de la unidad
  IF auth.uid() IS NOT NULL AND NOT (
       (public.can_access_site(v.site_id) AND (public.has_cmms_permission('flota') OR public.has_cmms_permission('ot') OR public.has_tms_permission('flota')))
       OR EXISTS (SELECT 1 FROM public.dispatches d JOIN public.drivers dr ON dr.id = d.driver_id
                  WHERE d.vehicle_plate = v.plate AND dr.profile_id = auth.uid()
                    AND d.status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No es una fuente autorizada para esta unidad');
  END IF;
  IF p_odometer IS NULL AND p_hours IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Informe odómetro u horómetro');
  END IF;
  IF p_odometer IS NOT NULL AND p_odometer < COALESCE(v.current_odometer, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El odómetro no puede retroceder (actual ' || v.current_odometer || ')');
  END IF;
  IF p_hours IS NOT NULL AND p_hours < COALESCE(v.current_hours, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede retroceder (actual ' || v.current_hours || ')');
  END IF;

  r := public.asset_reading_apply(v.plate, p_odometer, p_hours, COALESCE(p_source, 'MANTENIMIENTO'), NULL, NULL, NULL, p_notes, auth.uid());
  IF r->>'status' <> 'VALIDADO' THEN
    RETURN jsonb_build_object('success', true, 'status', r->>'status', 'odometer', v.current_odometer, 'hours', v.current_hours,
      'message', 'Lectura guardada para revisión: salto atípico de más de 1 500 km. Regístrela con foto del tablero desde la app para que actualice la unidad.');
  END IF;
  RETURN jsonb_build_object('success', true, 'status', 'VALIDADO', 'odometer', COALESCE(p_odometer, v.current_odometer), 'hours', COALESCE(p_hours, v.current_hours));
END $$;

-- Odómetro de despacho (app / pantalla)
CREATE OR REPLACE FUNCTION public.record_odometer_reading(p_vehicle_plate text, p_odometer_value numeric, p_photo_url text, p_source_event text, p_dispatch_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_driver_id uuid;
  r jsonb;
BEGIN
  PERFORM public.security_assert_vehicle(p_vehicle_plate, true);
  IF p_odometer_value IS NULL OR p_odometer_value < 0 OR p_odometer_value > 99999999 THEN RAISE EXCEPTION 'Odómetro inválido'; END IF;
  IF p_dispatch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = p_dispatch_id AND d.vehicle_plate = p_vehicle_plate
    AND (current_setting('role', true) NOT IN ('anon', 'authenticated') OR public.can_access_site(d.site_id)
      OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid() AND dr.is_active))) THEN
    RAISE EXCEPTION 'Despacho no asociado a esta unidad' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_driver_id FROM public.drivers WHERE profile_id = auth.uid() AND is_active = true;
  r := public.asset_reading_apply(p_vehicle_plate, p_odometer_value, NULL, p_source_event, p_photo_url, p_dispatch_id, v_driver_id, NULL, NULL);
  RETURN jsonb_build_object('success', true, 'status', r->>'status', 'flag', r->>'flag',
                            'recorded_value', p_odometer_value, 'previous_value', r->'previous_odometer');
END $$;

-- Reporte de falla: la lectura ya no se registra VALIDADA si es menor a la vigente
CREATE OR REPLACE FUNCTION public.submit_maintenance_request_v2(p_vehicle_plate text, p_driver_id uuid, p_dispatch_id uuid, p_description text, p_severity text, p_odometer numeric, p_photo_url text, p_location jsonb, p_audio_url text, p_can_continue boolean, p_horometer numeric, p_extra_photos jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_request_id uuid;
  v_plate      text := upper(trim(p_vehicle_plate));
  r            jsonb;
BEGIN
  IF p_odometer IS NULL OR p_odometer < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'El odómetro no puede ser negativo');
  END IF;
  IF NULLIF(trim(p_description), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Describa la falla');
  END IF;
  -- El conductor solo reporta a su nombre (supervisores pueden reportar por otros)
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.drivers WHERE id = p_driver_id AND profile_id = auth.uid())
     AND NOT public.has_cmms_permission('fallas') THEN
    RETURN jsonb_build_object('success', false, 'message', 'No puede reportar en nombre de otro conductor');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Placa no registrada: ' || v_plate);
  END IF;

  INSERT INTO public.maintenance_requests (
    vehicle_plate, driver_id, dispatch_id, description, severity, status, source,
    photo_url, audio_url, evidence, can_continue, horometer,
    location_lat, location_lon, odometer_at_report, reported_by
  ) VALUES (
    v_plate, p_driver_id, p_dispatch_id, trim(p_description), p_severity, 'REPORTADA', 'APP_CONDUCTOR',
    p_photo_url, p_audio_url, p_extra_photos, p_can_continue, p_horometer,
    NULLIF(p_location->>'lat', '')::numeric, NULLIF(p_location->>'lon', '')::numeric,
    p_odometer, auth.uid()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_request_id;

  IF v_request_id IS NULL THEN
    SELECT id INTO v_request_id FROM public.maintenance_requests
    WHERE vehicle_plate = v_plate AND md5(description) = md5(trim(p_description))
      AND (reported_at AT TIME ZONE 'America/Lima')::date = (now() AT TIME ZONE 'America/Lima')::date
    LIMIT 1;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'request_id', v_request_id,
                              'message', 'Esta falla ya fue reportada hoy para la unidad');
  END IF;

  -- Odómetro 0 = no informado; horómetro 0 = la unidad no tiene horómetro
  IF p_odometer > 0 OR p_horometer > 0 THEN
    r := public.asset_reading_apply(v_plate, NULLIF(p_odometer, 0), NULLIF(p_horometer, 0), 'REPORTE_FALLA', p_photo_url,
                                    p_dispatch_id, p_driver_id, NULL, NULL);
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Falla reportada correctamente', 'request_id', v_request_id,
                            'reading_status', r->>'status');
END $$;

-- Jornada del conductor: el odómetro de la unidad avanza por la misma vía (el salto sin foto queda en revisión)
CREATE OR REPLACE FUNCTION public.unit_odometer_record(p_operation uuid, p_plate text, p_driver uuid, p_day date, p_kind text, p_value text, p_photo text, p_captured timestamp with time zone, p_by uuid, p_revision uuid)
RETURNS unit_odometer_readings LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  -- Odómetro de la unidad para Mantenimiento: misma vía validada que el resto de lecturas
  BEGIN
    PERFORM public.asset_reading_apply(p_plate, v, NULL, 'JORNADA_' || p_kind, photo, NULL, p_driver, NULL, p_by);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Odómetro de % sin actualizar: %', p_plate, SQLERRM;
  END;
  RETURN rec;
END $$;

-- Combustible de caja: el comprobante no es foto del tablero, así que un salto atípico queda en revisión
CREATE OR REPLACE FUNCTION public.caja_fuel_odometer_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.expense_type <> 'COMBUSTIBLE' OR NEW.fuel_odometer IS NULL OR NEW.vehicle_plate IS NULL THEN RETURN NULL; END IF;
  PERFORM public.asset_reading_apply(NEW.vehicle_plate, NEW.fuel_odometer, NULL, 'COMBUSTIBLE', NULL, NEW.dispatch_id, NEW.driver_id,
                                     'Carga de combustible', NEW.created_by);
  RETURN NULL;
END $$;

-- Maestro de unidades: las lecturas y la baja no se editan directamente desde la pantalla
CREATE OR REPLACE FUNCTION public.normalize_vehicle_master()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.plate := upper(trim(NEW.plate));
  NEW.internal_code := NULLIF(upper(trim(NEW.internal_code)), '');
  -- Espejos legados (una sola fuente: current_odometer / weight_capacity / volume_capacity)
  IF TG_OP = 'UPDATE' AND NEW.current_mileage IS DISTINCT FROM OLD.current_mileage
     AND NEW.current_odometer IS NOT DISTINCT FROM OLD.current_odometer THEN
    NEW.current_odometer := NEW.current_mileage;
  END IF;
  NEW.current_mileage := round(COALESCE(NEW.current_odometer, 0))::int;
  NEW.weight_capacity := COALESCE(NEW.weight_capacity, NEW.capacity_weight);
  NEW.capacity_weight := NEW.weight_capacity;
  NEW.volume_capacity := COALESCE(NEW.volume_capacity, NEW.capacity_volume);
  NEW.capacity_volume := NEW.volume_capacity;

  IF TG_OP = 'UPDATE' AND current_user IN ('authenticated', 'anon') THEN
    IF NEW.plate IS DISTINCT FROM OLD.plate THEN
      RAISE EXCEPTION 'La placa/código es la identidad del activo y no se modifica' USING ERRCODE = '42501';
    END IF;
    IF NEW.current_odometer IS DISTINCT FROM OLD.current_odometer OR NEW.current_hours IS DISTINCT FROM OLD.current_hours THEN
      RAISE EXCEPTION 'Las lecturas de odómetro y horómetro se registran con register_asset_reading() (validadas)' USING ERRCODE = '42501';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'La unidad se desactiva o reactiva con set_vehicle_active()' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Una unidad nunca se borra desde una sesión de usuario: se desactiva
CREATE OR REPLACE FUNCTION public.guard_vehicle_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Las unidades no se eliminan: desactive % para conservar su historial', OLD.plate USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_work_orders WHERE vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = OLD.plate)
     OR EXISTS (SELECT 1 FROM public.dispatches WHERE vehicle_plate = OLD.plate OR vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.inspections WHERE vehicle_plate = OLD.plate) THEN
    RAISE EXCEPTION 'El activo % tiene historial operativo: desactívelo en lugar de eliminarlo', OLD.plate USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;

-- Sin DELETE directo: la escritura de la sede queda en INSERT y UPDATE
DROP POLICY IF EXISTS vehicles_write_site ON public.vehicles;
DROP POLICY IF EXISTS vehicles_insert_site ON public.vehicles;
DROP POLICY IF EXISTS vehicles_update_site ON public.vehicles;
CREATE POLICY vehicles_insert_site ON public.vehicles FOR INSERT TO authenticated
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')));
CREATE POLICY vehicles_update_site ON public.vehicles FOR UPDATE TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')))
  WITH CHECK (public.can_access_site(site_id) AND (public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota')));
REVOKE DELETE ON public.vehicles FROM anon, authenticated;

-- Desactivar / reactivar (en lugar de borrar). Inactiva = FUERA_DE_SERVICIO; al reactivar entra OBSERVADA y se libera
-- con el motor de elegibilidad, como una unidad nueva.
CREATE OR REPLACE FUNCTION public.set_vehicle_active(p_plate text, p_active boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.vehicles%ROWTYPE; v_to text;
BEGIN
  SELECT * INTO v FROM public.vehicles WHERE plate = upper(btrim(p_plate)) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada'); END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.can_access_site(v.site_id)
     AND (public.is_tms_admin() OR public.has_tms_permission('flota') OR public.has_tms_permission('mantenimiento-flota'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para dar de baja unidades de esta sede');
  END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo'); END IF;
  IF p_active IS NOT DISTINCT FROM v.is_active THEN
    RETURN jsonb_build_object('success', true, 'note', 'Sin cambios');
  END IF;
  IF NOT p_active AND (v.status IN ('ASIGNADA', 'EN_OPERACION') OR EXISTS (SELECT 1 FROM public.dispatches d
       WHERE d.vehicle_plate = v.plate AND d.status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO', 'ENTREGADO'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La unidad tiene un viaje en curso o programado');
  END IF;
  v_to := CASE WHEN p_active THEN 'OBSERVADA' ELSE 'FUERA_DE_SERVICIO' END;
  UPDATE public.vehicles SET is_active = p_active, status = v_to WHERE id = v.id;
  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (v.plate, auth.uid(), 'status', v.status, v_to, CASE WHEN p_active THEN 'Reactivada: ' ELSE 'Desactivada: ' END || btrim(p_reason));
  RETURN jsonb_build_object('success', true, 'status', v_to);
END $$;
REVOKE ALL ON FUNCTION public.set_vehicle_active(text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_vehicle_active(text, boolean, text) TO authenticated;

-- Post-ruta del conductor
CREATE OR REPLACE FUNCTION public.submit_post_route_checklist(p_dispatch_id uuid, p_vehicle_plate text, p_driver_id uuid, p_odometer numeric, p_liquidation_data jsonb, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_dispatch record;
    v_lat numeric(10,6) := NULL;
    v_lon numeric(10,6) := NULL;
    v_start_odometer numeric;
    v_transition_result jsonb;
BEGIN
    PERFORM public.security_assert_active_session();
    IF current_setting('role',true) IN ('anon','authenticated') AND NOT EXISTS(
      SELECT 1 FROM public.drivers dr JOIN public.dispatches d ON d.driver_id=dr.id
      WHERE d.id=p_dispatch_id AND dr.id=p_driver_id AND dr.profile_id=auth.uid() AND dr.is_active=true) THEN
      RAISE EXCEPTION 'Solo el conductor asignado puede registrar el post-ruta' USING ERRCODE='42501';
    END IF;
    -- 1. Validar que el despacho existe y pertenece al conductor
    SELECT * INTO v_dispatch
    FROM public.dispatches
    WHERE id = p_dispatch_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no encontrado');
    END IF;

    IF v_dispatch.driver_id IS DISTINCT FROM p_driver_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no asignado a este conductor');
    END IF;

    IF v_dispatch.vehicle_plate IS DISTINCT FROM p_vehicle_plate THEN
        RETURN jsonb_build_object('success', false, 'message', 'La placa del vehículo enviada no coincide con la asignada al despacho');
    END IF;

    -- 2. Validar que el estado permite la liquidación/cierre
    IF v_dispatch.status NOT IN ('EN_CURSO', 'EN RUTA', 'RETORNO', 'ENTREGADO', 'RETORNO_COMPLETADO') THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho en estado inválido para checklist post-ruta');
    END IF;

    -- 3. Validar Odómetro
    BEGIN
        v_start_odometer := v_dispatch.start_odometer;
    EXCEPTION WHEN OTHERS THEN
        v_start_odometer := 0;
    END;

    IF p_odometer IS NULL OR p_odometer < 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'Lectura de odómetro inválida. Debe ser un número positivo.');
    END IF;

    IF v_start_odometer IS NOT NULL AND p_odometer < v_start_odometer THEN
        RETURN jsonb_build_object('success', false, 'message', 'El odómetro final no puede ser menor al inicial (' || v_start_odometer || ')');
    END IF;

    -- Extraer coordenadas si el objeto de location es proporcionado
    IF p_location IS NOT NULL THEN
        BEGIN
            v_lat := (p_location->>'lat')::numeric;
            v_lon := (p_location->>'lon')::numeric;
        EXCEPTION WHEN OTHERS THEN
            v_lat := NULL;
            v_lon := NULL;
        END;
    END IF;

    -- 4. Actualizar el despacho con datos de liquidación y finalización
    UPDATE public.dispatches
    SET liquidation_data = p_liquidation_data,
        end_odometer = p_odometer,
        arrival_time = NOW()
    WHERE id = p_dispatch_id;

    -- Opcional: Insertar en driver_checklists para mantener historial (si existe la tabla)
    BEGIN
        INSERT INTO public.driver_checklists (
            dispatch_id, 
            driver_id, 
            vehicle_plate, 
            checklist_data, 
            location_lat, 
            location_lon
        ) VALUES (
            p_dispatch_id, 
            p_driver_id, 
            p_vehicle_plate, 
            jsonb_build_object('type', 'POST_RUTA', 'liquidation', p_liquidation_data, 'end_odometer', p_odometer), 
            v_lat, 
            v_lon
        );
    EXCEPTION WHEN undefined_table THEN
        -- Si la tabla no existe, ignorar, ya actualizamos dispatches.
    END;

    -- 5. Odómetro de la unidad por la vía única validada (antes se sobrescribía sin validar)
    BEGIN
        PERFORM public.asset_reading_apply(p_vehicle_plate, p_odometer, NULL, 'CHECKLIST_POST_RUTA', NULL, p_dispatch_id, p_driver_id,
                                           'Checklist post-ruta', NULL);
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Odómetro de % sin actualizar: %', p_vehicle_plate, SQLERRM;
    END;

    -- 6. Ejecutar transición de estado
    BEGIN
        v_transition_result := public.transition_dispatch_status(
            p_dispatch_id, 
            'RETORNO_COMPLETADO', 
            'Finalizado por checklist post-ruta', 
            p_driver_id
        );
        
        -- Si la máquina de estados rechaza la transición, propagamos el error
        IF NOT (v_transition_result->>'success')::boolean THEN
            RAISE EXCEPTION '%', COALESCE(v_transition_result->>'error','Transición rechazada');
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE;
    END;

    -- 7. Retorna éxito
    RETURN jsonb_build_object('success', true, 'message', 'Viaje finalizado');
END $fn$;

NOTIFY pgrst, 'reload schema';
COMMIT;
