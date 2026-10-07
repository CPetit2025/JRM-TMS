-- Historical boundaries for adversarial regression only; never applied to production.
CREATE OR REPLACE FUNCTION public.cash_box_balance(p_box_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(direction * amount), 0) FROM public.cash_movements WHERE box_id = p_box_id;
$function$;
CREATE OR REPLACE FUNCTION public.check_expense_duplicate(p_ruc character varying, p_type character varying, p_serial character varying, p_number character varying)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_exists BOOLEAN;
BEGIN
    -- Ignoramos si alguno es nulo
    IF p_ruc IS NULL OR p_type IS NULL OR p_serial IS NULL OR p_number IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Los recibos, tickets y otros a veces no tienen serie, pero si es factura/boleta es obligatorio
    SELECT EXISTS(
        SELECT 1 FROM public.expense_records
        WHERE provider_ruc = p_ruc
          AND document_type = p_type
          AND document_serial = p_serial
          AND document_number = p_number
          AND status != 'ANULADO'
    ) INTO v_exists;

    RETURN v_exists;
END;
$function$;
CREATE OR REPLACE FUNCTION public.caja_driver_overdue_trips(p_driver_id uuid)
 RETURNS TABLE(dispatch_id uuid, dispatch_number text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT d.id, d.dispatch_number::text FROM public.dispatches d
  WHERE d.driver_id = p_driver_id
    AND NOT public.caja_trip_is_settled(d.id)
    AND EXISTS (SELECT 1 FROM public.trip_advances a WHERE a.dispatch_id = d.id AND a.status = 'ENTREGADO')
    AND d.status NOT IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'CANCELADO')
    AND COALESCE(NULLIF(to_jsonb(d)->>'returned_at', ''), NULLIF(to_jsonb(d)->>'arrival_time', ''),
                 NULLIF(to_jsonb(d)->>'updated_at', ''), d.created_at::text)::timestamptz
        < now() - make_interval(hours => (SELECT settlement_due_hours FROM public.caja_settings WHERE id));
$function$;
CREATE OR REPLACE FUNCTION public.caja_driver_overdue_advances(p_driver_id uuid)
 RETURNS TABLE(advance_id uuid, code text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT a.id, a.code FROM public.trip_advances a
  WHERE a.driver_id = p_driver_id AND a.dispatch_id IS NULL AND a.status = 'ENTREGADO'
    AND a.due_at < now() AND NOT public.caja_advance_is_settled(a.id);
$function$;
CREATE OR REPLACE FUNCTION public.caja_trip_is_settled(p_dispatch_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.trip_settlements WHERE dispatch_id = p_dispatch_id AND status = 'CERRADA');
$function$;
CREATE OR REPLACE FUNCTION public.caja_advance_is_settled(p_advance_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.trip_settlements WHERE advance_id = p_advance_id AND status = 'CERRADA');
$function$;
CREATE OR REPLACE FUNCTION public.profile_display_name(p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''),
                  to_jsonb(p)->>'email', p_user::text)
  FROM public.profiles p WHERE p.id = p_user;
$function$;
CREATE OR REPLACE FUNCTION public.spare_part_available(p_part uuid, p_exclude_work_order uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT sp.current_stock - COALESCE((
    SELECT sum(r.quantity - r.consumed) FROM public.spare_part_reservations r
    WHERE r.spare_part_id = sp.id AND r.status = 'ACTIVA'
      AND (p_exclude_work_order IS NULL OR r.work_order_id <> p_exclude_work_order)), 0)
  FROM public.spare_parts sp WHERE sp.id = p_part;
$function$;
CREATE OR REPLACE FUNCTION public.evaluate_part_replenishment(p_part uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_part      public.spare_parts%ROWTYPE;
  v_available numeric;
BEGIN
  SELECT * INTO v_part FROM public.spare_parts WHERE id = p_part;
  IF NOT FOUND OR NOT COALESCE(v_part.is_active, true) OR COALESCE(v_part.minimum_stock, 0) <= 0 THEN
    RETURN;
  END IF;
  v_available := public.spare_part_available(p_part);
  IF v_available < v_part.minimum_stock THEN
    INSERT INTO public.spare_part_replenishment_requests (spare_part_id, site_id, suggested_quantity, available_at_request, notes)
    VALUES (p_part, v_part.site_id,
            GREATEST(COALESCE(v_part.maximum_stock, v_part.minimum_stock * 2) - v_available, v_part.minimum_stock - v_available),
            v_available, 'Generada automáticamente: disponible bajo el mínimo')
    ON CONFLICT (spare_part_id) WHERE status IN ('PENDIENTE', 'APROBADA') DO NOTHING;
  ELSE
    UPDATE public.spare_part_replenishment_requests SET status = 'ATENDIDA', resolved_at = now(),
      notes = concat_ws(' | ', notes, 'Atendida por ingreso de stock')
    WHERE spare_part_id = p_part AND status IN ('PENDIENTE', 'APROBADA');
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.next_vehicle_internal_code(p_type text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.pfx || '-' || lpad((COALESCE(max(substring(v.internal_code FROM '^[A-Z]+-([0-9]+)$')::int), 0) + 1)::text, 3, '0')
  FROM (SELECT public.vehicle_code_prefix(p_type) AS pfx) p
  LEFT JOIN public.vehicles v ON upper(v.internal_code) ~ ('^' || p.pfx || '-[0-9]+$')
  GROUP BY p.pfx;
$function$;
CREATE OR REPLACE FUNCTION public.submit_post_route_checklist(p_dispatch_id uuid, p_vehicle_plate text, p_driver_id uuid, p_odometer numeric, p_liquidation_data jsonb, p_location jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_dispatch record;
    v_lat numeric(10,6) := NULL;
    v_lon numeric(10,6) := NULL;
    v_start_odometer numeric;
    v_transition_result jsonb;
BEGIN
    -- 1. Validar que el despacho existe y pertenece al conductor
    SELECT * INTO v_dispatch
    FROM public.dispatches
    WHERE id = p_dispatch_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no encontrado');
    END IF;

    IF v_dispatch.driver_id != p_driver_id THEN
        RETURN jsonb_build_object('success', false, 'message', 'Despacho no asignado a este conductor');
    END IF;

    IF v_dispatch.vehicle_plate != p_vehicle_plate THEN
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

    -- 5. Actualizar el odómetro
    -- 5.1 Insertar en vehicle_odometer_logs
    BEGIN
        INSERT INTO public.vehicle_odometer_logs (
            vehicle_plate, 
            driver_id, 
            dispatch_id, 
            odometer_value, 
            source_event, 
            status, 
            notes
        ) VALUES (
            p_vehicle_plate, 
            p_driver_id, 
            p_dispatch_id, 
            p_odometer, 
            'CHECKLIST_POST_RUTA', 
            'VALIDADO', 
            'Actualización automática desde checklist post-ruta'
        );
    EXCEPTION WHEN undefined_table THEN
        -- Ignorar si la tabla no existe
    END;

    -- 5.2 Actualizar vehicles.current_odometer
    BEGIN
        UPDATE public.vehicles
        SET current_odometer = p_odometer
        WHERE plate = p_vehicle_plate;
    EXCEPTION WHEN OTHERS THEN
        -- Ignorar fallas (e.g. si current_odometer no existe en vehicles)
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
            RETURN v_transition_result;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'message', 'Error en transición de estado: ' || SQLERRM);
    END;

    -- 7. Retorna éxito
    RETURN jsonb_build_object('success', true, 'message', 'Viaje finalizado');
END $function$;
CREATE OR REPLACE FUNCTION public.record_odometer_reading(p_vehicle_plate text, p_odometer_value numeric, p_photo_url text, p_source_event text, p_dispatch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_driver_id UUID;
    v_current_odometer NUMERIC(10,2);
    v_status TEXT := 'VALIDADO';
    v_user_id UUID;
BEGIN
    v_user_id := auth.uid();
    
    -- Get driver id if called by a driver
    SELECT id INTO v_driver_id FROM public.drivers WHERE user_id = v_user_id;

    -- Get current odometer and mileage
    SELECT COALESCE(current_odometer, current_mileage) INTO v_current_odometer
    FROM public.vehicles
    WHERE plate = p_vehicle_plate;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vehículo no encontrado';
    END IF;

    -- Validation logic
    IF v_current_odometer IS NOT NULL THEN
        IF p_odometer_value < v_current_odometer THEN
            v_status := 'REQUIERE_AUDITORIA';
        ELSIF (p_odometer_value - v_current_odometer) > 2000 THEN
            -- Unlikely to jump more than 2000 km between readings
            v_status := 'REQUIERE_AUDITORIA';
        END IF;
    END IF;

    -- Insert log
    INSERT INTO public.vehicle_odometer_logs(
        vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, created_by
    ) VALUES (
        p_vehicle_plate, v_driver_id, p_dispatch_id, p_odometer_value, p_photo_url, p_source_event, v_status, v_user_id
    );

    -- Update vehicle if valid
    IF v_status = 'VALIDADO' THEN
        UPDATE public.vehicles
        SET current_odometer = p_odometer_value,
            current_mileage = p_odometer_value,
            updated_at = NOW()
        WHERE plate = p_vehicle_plate;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'status', v_status,
        'recorded_value', p_odometer_value,
        'previous_value', v_current_odometer
    );
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_public_tracking_info(p_token uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_dispatch RECORD;
  v_result JSONB;
BEGIN
  SELECT d.id, d.dispatch_number, d.driver_name, d.vehicle_plate, d.status, d.scheduled_departure, d.estimated_distance_km
  INTO v_dispatch
  FROM public.dispatches d
  WHERE d.tracking_token = p_token 
    AND d.tracking_pin = p_pin
    AND d.tracking_expires_at > NOW();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tracking link is invalid, expired, or incorrect PIN.';
  END IF;

  SELECT jsonb_build_object(
    'id', v_dispatch.id,
    'dispatch_number', v_dispatch.dispatch_number,
    'driver_name', v_dispatch.driver_name,
    'vehicle_plate', v_dispatch.vehicle_plate,
    'status', v_dispatch.status,
    'scheduled_departure', v_dispatch.scheduled_departure,
    'estimated_distance_km', v_dispatch.estimated_distance_km,
    'requests', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', tr.id,
            'request_number', tr.request_number,
            'pickup_address', tr.pickup_address,
            'delivery_address', tr.delivery_address,
            'status', tr.status
          )
        )
        FROM public.dispatch_requests dr
        JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
        WHERE dr.dispatch_id = v_dispatch.id
      ), 
      '[]'::jsonb
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_info(p_token uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE day date; rows jsonb:='[]'; item record;
BEGIN
 SELECT planning_date INTO day FROM public.daily_tracking_links WHERE tracking_token=p_token AND tracking_pin=p_pin AND expires_at>now();
 IF day IS NULL THEN RAISE EXCEPTION 'PIN incorrecto, enlace vencido o no válido'; END IF;
 FOR item IN SELECT d.id FROM public.dispatches d WHERE (d.scheduled_departure AT TIME ZONE 'America/Lima')::date=day LOOP
  rows:=rows||public.delivery_rows_core(item.id,true);
 END LOOP;
 RETURN jsonb_build_object('planning_date',day,'rows',rows);
END $function$;
CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_locations(p_token uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE day date; locations jsonb;
BEGIN
 SELECT planning_date INTO day FROM public.daily_tracking_links WHERE tracking_token=p_token AND tracking_pin=p_pin AND expires_at>now();
 IF day IS NULL THEN RAISE EXCEPTION 'PIN incorrecto, enlace vencido o no válido'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('dispatch_id',d.id,'driver_name',d.driver_name,'vehicle_plate',d.vehicle_plate,
  'lat',d.last_lat,'lng',d.last_lon,'last_gps_at',d.last_gps_at)),'[]'::jsonb) INTO locations FROM public.dispatches d
 WHERE (d.scheduled_departure AT TIME ZONE 'America/Lima')::date=day AND d.last_gps_at>now()-interval '15 minutes' AND d.last_lat IS NOT NULL AND d.last_lon IS NOT NULL;
 RETURN locations;
END $function$;
