-- Operational equipment inspections are scoped to the operator's assigned unit or site.
-- A critical report may block that same unit internally; it never authorizes a direct status RPC.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
CREATE FUNCTION public.security_can_inspect_equipment(p_vehicle uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND EXISTS(SELECT 1 FROM public.vehicles v WHERE v.id=p_vehicle AND
  (public.is_tms_admin() OR public.can_access_site(v.site_id) OR EXISTS(SELECT 1 FROM public.drivers d
   WHERE d.id=v.assigned_driver_id AND d.profile_id=auth.uid() AND d.is_active)));
$$;
REVOKE ALL ON FUNCTION public.security_can_inspect_equipment(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.security_can_inspect_equipment(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.mant_equipos_turno()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_items jsonb;
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  EXECUTE $q$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'vehicle_id', v.id, 'plate', v.plate, 'codigo', to_jsonb(v) ->> 'internal_code', 'modelo', concat_ws(' ', v.brand, v.model),
      'familia', f.code, 'familia_nombre', f.nombre, 'lectura', f.lectura,
      'checklist', f.checklist, 'checklist_frecuencia', f.checklist_frecuencia,
      'horas', NULLIF(to_jsonb(v) ->> 'current_hours', '')::numeric,
      'ultimo_turno', (SELECT max(t.created_at) FROM public.mant_turnos t WHERE t.vehicle_id = v.id),
      'ultimo_semanal', (SELECT max(t.created_at) FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.tipo = 'SEMANAL'),
      'semanal_pendiente', f.checklist_frecuencia = 'SEMANAL' AND NOT EXISTS (
        SELECT 1 FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.tipo = 'SEMANAL' AND t.created_at > now() - interval '7 days'))
      ORDER BY f.orden, v.plate), '[]')
    FROM public.vehicles v
    JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
    JOIN public.mant_familias f ON f.code = af.familia
    WHERE f.checklist_frecuencia IS NOT NULL AND public.security_can_inspect_equipment(v.id)
      AND upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'$q$ INTO v_items;
  RETURN jsonb_build_object('success', true, 'equipos', v_items);
END $function$
;
CREATE OR REPLACE FUNCTION public.mant_registrar_turno(p_vehicle_id uuid, p_horas numeric DEFAULT NULL::numeric, p_checklist jsonb DEFAULT '[]'::jsonb, p_observaciones text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v record; f record; v_actual numeric; v_last timestamptz; v_max numeric;
  v_estado text := 'SIN_LECTURA'; v_tipo text; v_items jsonb := '[]'::jsonb; it jsonb; x jsonb; v_fallas int := 0;
  v_desc text; v_sev text; v_id bigint; v_msg text := NULL; v_activo boolean; v_n int;
BEGIN
  IF NOT public.security_can_inspect_equipment(p_vehicle_id) THEN
    RETURN jsonb_build_object('success',false,'error','Sin acceso al equipo de esta sede o unidad asignada');
  END IF;
  IF jsonb_typeof(COALESCE(p_checklist,'[]'::jsonb))<>'array' OR jsonb_array_length(COALESCE(p_checklist,'[]'::jsonb))>1000
   OR length(COALESCE(p_observaciones,''))>4000 OR (p_horas IS NOT NULL AND (p_horas<0 OR p_horas>99999999)) THEN
    RETURN jsonb_build_object('success',false,'error','Datos de inspección inválidos');
  END IF;
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  BEGIN
    EXECUTE 'SELECT COALESCE((to_jsonb(p) ->> ''is_active'')::boolean, true) FROM public.profiles p WHERE p.id = $1' INTO v_activo USING v_uid;
  EXCEPTION WHEN OTHERS THEN v_activo := true; END;
  IF v_activo IS NOT TRUE THEN RETURN jsonb_build_object('success', false, 'error', 'Usuario inactivo'); END IF;

  EXECUTE 'SELECT id, plate, NULLIF(to_jsonb(vehicles) ->> ''current_hours'', '''')::numeric AS horas, COALESCE(NULLIF(to_jsonb(vehicles) ->> ''current_odometer'', '''')::numeric, 0) AS odo FROM public.vehicles WHERE id = $1 FOR UPDATE'
    INTO v USING p_vehicle_id;
  IF v.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Equipo no registrado'); END IF;
  SELECT fa.* INTO f FROM public.mant_asset_familia af JOIN public.mant_familias fa ON fa.code = af.familia
  WHERE af.vehicle_id = v.id AND fa.checklist_frecuencia IS NOT NULL;
  IF f.code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El equipo no tiene checklist de operario'); END IF;
  v_tipo := CASE WHEN f.checklist_frecuencia = 'SEMANAL' THEN 'SEMANAL' ELSE 'TURNO' END;

  IF f.lectura = 'HORAS' AND p_horas IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registra el horómetro');
  END IF;
  IF p_horas IS NOT NULL THEN
    IF p_horas < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede ser negativo'); END IF;
    v_actual := COALESCE(v.horas, 0);
    IF p_horas < v_actual THEN
      RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede ser menor a ' || v_actual || ' h. Si se cambió el horómetro, avisa a Mantenimiento.');
    END IF;
    SELECT max(t.created_at) INTO v_last FROM public.mant_turnos t WHERE t.vehicle_id = v.id AND t.estado_lectura = 'VALIDADA';
    v_max := v_actual + GREATEST(24, 16 * CEIL(EXTRACT(epoch FROM now() - COALESCE(v_last, now() - interval '30 days')) / 86400.0));
    IF p_horas > v_max THEN
      v_estado := 'POR_VALIDAR';
      v_msg := 'Lectura guardada para validar: el salto desde ' || v_actual || ' h es mayor a lo posible. Mantenimiento la revisará.';
    ELSE
      v_estado := 'VALIDADA';
      EXECUTE 'UPDATE public.vehicles SET current_hours = $1 WHERE id = $2' USING p_horas, v.id;
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vehicle_odometer_logs' AND column_name = 'hours_value') THEN
          EXECUTE 'INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, hours_value, source_event, status, notes, created_by) VALUES ($1, $2, $3, ''TURNO_OPERARIO'', ''VALIDADO'', ''Horómetro al iniciar turno'', $4)'
            USING v.plate, v.odo, p_horas, v_uid;
        END IF;
      EXCEPTION WHEN OTHERS THEN NULL;   -- la bitácora de lecturas es informativa; el turno guarda la lectura
      END;
    END IF;
  END IF;

  -- Checklist: se arma desde la plantilla de la familia (el cliente solo marca ok/obs)
  FOR it IN SELECT * FROM jsonb_array_elements(f.checklist) LOOP
    SELECT e INTO x FROM jsonb_array_elements(COALESCE(p_checklist, '[]'::jsonb)) e WHERE e ->> 'id' = it ->> 'id' LIMIT 1;
    v_items := v_items || jsonb_build_object('id', it ->> 'id', 'texto', it ->> 'texto', 'critico', COALESCE((it ->> 'critico')::boolean, false),
      'ok', COALESCE((x ->> 'ok')::boolean, true), 'obs', NULLIF(btrim(COALESCE(x ->> 'obs', '')), ''));
  END LOOP;

  INSERT INTO public.mant_turnos (vehicle_id, vehicle_plate, profile_id, tipo, horas, estado_lectura, checklist, observaciones)
  VALUES (v.id, v.plate, v_uid, v_tipo, p_horas, v_estado, v_items, NULLIF(btrim(COALESCE(p_observaciones, '')), ''))
  RETURNING id INTO v_id;

  -- Ítems en falla → maintenance_requests (una por ítem y día: índice único de la tabla)
  FOR it IN SELECT * FROM jsonb_array_elements(v_items) WHERE (value ->> 'ok')::boolean = false LOOP
    v_sev := CASE WHEN (it ->> 'critico')::boolean THEN 'CRITICA' ELSE 'MEDIA' END;
    v_desc := 'Checklist de ' || lower(CASE WHEN v_tipo = 'SEMANAL' THEN 'semana' ELSE 'turno' END) || ': ' || (it ->> 'texto') || COALESCE(' — ' || (it ->> 'obs'), '');
    BEGIN
      IF to_regclass('public.maintenance_requests') IS NOT NULL THEN
        EXECUTE 'INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, source, reported_by, notes) VALUES ($1, $2, $3, ''REPORTADA'', ''INSPECCION'', $4, $5) ON CONFLICT DO NOTHING'
          USING v.plate, v_desc, v_sev, v_uid, 'Turno ' || v_id || ' (horómetro ' || COALESCE(p_horas::text, '-') || ')';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_fallas := v_fallas + v_n;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE; -- Do not persist a successful inspection without its required critical report.
    END;
  END LOOP;
  UPDATE public.mant_turnos SET fallas = v_fallas WHERE id = v_id AND v_fallas > 0;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'estado_lectura', v_estado, 'fallas', v_fallas, 'aviso', v_msg);
END $function$
;
CREATE OR REPLACE FUNCTION public.security_assert_vehicle(p_plate text,p_write boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid; v_own boolean; v_staff boolean;
BEGIN
 IF current_setting('role',true) NOT IN ('anon','authenticated') THEN RETURN; END IF;
 PERFORM public.security_assert_active_session();
 IF public.is_tms_admin() THEN RETURN; END IF; -- Active administrators can repair units without a site.
 SELECT site_id INTO v_site FROM public.vehicles WHERE plate=p_plate;
 v_own:=EXISTS(SELECT 1 FROM public.drivers dr WHERE dr.profile_id=auth.uid() AND dr.is_active AND
  (EXISTS(SELECT 1 FROM public.vehicles v WHERE v.plate=p_plate AND v.assigned_driver_id=dr.id)
   OR EXISTS(SELECT 1 FROM public.dispatches d WHERE d.vehicle_plate=p_plate AND d.driver_id=dr.id AND d.status NOT IN ('LIQUIDADO','CERRADO','CANCELADO'))));
 v_staff:=public.can_access_site(v_site) AND CASE WHEN p_write THEN public.can_manage_fleet_status() ELSE
  public.can_manage_fleet_status() OR public.has_tms_read_permission('mantenimiento-flota') OR public.has_tms_read_permission('mantenimiento-ot')
  OR public.has_tms_read_permission('mantenimiento-dashboard') OR public.has_tms_read_permission('mantenimiento-vencimientos')
  OR public.has_tms_read_permission('mantenimiento-fallas') OR public.has_tms_read_permission('mantenimiento-planes')
  OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('planificacion')
  OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('torre-control') OR public.has_caja_read_access() END;
 IF NOT COALESCE(v_own OR v_staff,false) THEN RAISE EXCEPTION 'Sin acceso a esta unidad' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.transition_vehicle_status(p_vehicle_plate text, p_new_status text, p_reason text, p_user_id uuid, p_metadata jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_current     text;
  v_actor       uuid := COALESCE(auth.uid(), p_user_id);
  v_is_system   boolean := auth.uid() IS NULL;   -- service_role / procesos internos
  v_is_admin    boolean;
  v_is_manager  boolean;
  v_allowed     text[];
  v_eligibility jsonb;
BEGIN
  -- The AFTER INSERT trigger sees its authorized critical report; direct RPCs have depth zero.
  IF pg_trigger_depth()>0 AND p_new_status='BLOQUEADA' AND EXISTS(
    SELECT 1 FROM public.maintenance_requests r JOIN public.vehicles v ON v.plate=r.vehicle_plate
    WHERE r.vehicle_plate=p_vehicle_plate AND r.severity='CRITICA' AND r.status NOT IN ('CERRADA','DESCARTADA')
     AND r.reported_by=auth.uid() AND public.security_can_inspect_equipment(v.id)) THEN
    PERFORM public.security_assert_active_session();
  ELSE
    PERFORM public.security_assert_vehicle(p_vehicle_plate,true);
  END IF;
  v_is_admin   := v_is_system OR public.is_tms_admin();
  v_is_manager := v_is_admin OR public.can_manage_fleet_status();

  IF p_new_status NOT IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA',
                          'MANTENIMIENTO', 'BLOQUEADA', 'FUERA_DE_SERVICIO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Estado no válido: ' || COALESCE(p_new_status, 'NULL'));
  END IF;

  -- Permisos
  IF NOT v_is_manager AND p_new_status NOT IN ('BLOQUEADA', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso: solo puede reportar la unidad como OBSERVADA o BLOQUEADA');
  END IF;
  IF p_new_status = 'FUERA_DE_SERVICIO' AND NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo un administrador puede dar de baja (FUERA_DE_SERVICIO)');
  END IF;

  SELECT status INTO v_current FROM public.vehicles WHERE plate = p_vehicle_plate FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Vehículo no encontrado: ' || p_vehicle_plate);
  END IF;

  IF v_current = p_new_status THEN
    RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status, 'unchanged', true);
  END IF;

  v_allowed := CASE v_current
    WHEN 'DISPONIBLE'        THEN ARRAY['ASIGNADA','EN_OPERACION','OBSERVADA','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'ASIGNADA'          THEN ARRAY['EN_OPERACION','DISPONIBLE','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'EN_OPERACION'      THEN ARRAY['DISPONIBLE','ASIGNADA','OBSERVADA','MANTENIMIENTO','BLOQUEADA']
    WHEN 'OBSERVADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'MANTENIMIENTO'     THEN ARRAY['DISPONIBLE','OBSERVADA','BLOQUEADA','FUERA_DE_SERVICIO']
    WHEN 'BLOQUEADA'         THEN ARRAY['DISPONIBLE','MANTENIMIENTO','OBSERVADA','FUERA_DE_SERVICIO']
    WHEN 'FUERA_DE_SERVICIO' THEN ARRAY['DISPONIBLE','OBSERVADA','MANTENIMIENTO']
    ELSE ARRAY[]::text[] END;

  IF NOT (p_new_status = ANY (v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transición no permitida: ' || v_current || ' → ' || p_new_status);
  END IF;

  -- Compuerta de elegibilidad: liberar o poner en operación exige que no sea NO_APTO
  IF p_new_status IN ('DISPONIBLE', 'ASIGNADA', 'EN_OPERACION') THEN
    v_eligibility := public.check_asset_eligibility(
      p_vehicle_plate,
      CASE WHEN p_new_status = 'DISPONIBLE' THEN 'RELEASE' ELSE 'OPERATION' END);
    IF v_eligibility->>'status' = 'NO_APTO' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unidad NO_APTO: ' || (SELECT string_agg(value, '; ') FROM jsonb_array_elements_text(v_eligibility->'motives')),
        'eligibility', v_eligibility);
    END IF;
  END IF;

  UPDATE public.vehicles SET status = p_new_status WHERE plate = p_vehicle_plate;

  INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
  VALUES (p_vehicle_plate, v_actor, 'status', v_current, p_new_status,
          NULLIF(concat_ws(' | ', p_reason,
                 CASE WHEN p_metadata IS NOT NULL AND p_metadata <> '{}'::jsonb THEN p_metadata::text END,
                 CASE WHEN v_eligibility IS NOT NULL THEN 'elegibilidad=' || (v_eligibility->>'status') END), ''));

  RETURN jsonb_build_object('success', true, 'previous_status', v_current, 'new_status', p_new_status,
                            'eligibility', v_eligibility);
END;
$function$;

REVOKE ALL ON FUNCTION public.mant_equipos_turno(), public.mant_registrar_turno(uuid,numeric,jsonb,text), public.transition_vehicle_status(text,text,text,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.mant_equipos_turno(), public.mant_registrar_turno(uuid,numeric,jsonb,text), public.transition_vehicle_status(text,text,text,uuid,jsonb) TO authenticated,service_role;

CREATE POLICY security_equipment_turno_insert ON public.mant_turnos AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK(public.security_can_inspect_equipment(vehicle_id) AND (profile_id=auth.uid() OR public.has_tms_permission('mantenimiento-flota') OR public.has_tms_permission('mantenimiento-fallas')));
CREATE POLICY security_equipment_turno_update ON public.mant_turnos AS RESTRICTIVE FOR UPDATE TO authenticated
 USING(public.security_can_inspect_equipment(vehicle_id))
 WITH CHECK(public.security_can_inspect_equipment(vehicle_id) AND (profile_id=auth.uid() OR public.has_tms_permission('mantenimiento-flota') OR public.has_tms_permission('mantenimiento-fallas')));
NOTIFY pgrst,'reload schema';
COMMIT;
