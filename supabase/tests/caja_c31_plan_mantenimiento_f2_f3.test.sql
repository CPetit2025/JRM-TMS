-- CAJA C31 — Plan de mantenimiento, Fases 2 y 3:
--   T1 planes creados desde las plantillas, inactivos y con línea base del historial; T2 validar activa el plan con la
--   fecha indicada (con permiso) y sin permiso se rechaza; T3 OT correctiva sobre el umbral sin cotización se bloquea
--   (tabla temporal con el mismo disparador) y con cotización pasa; T4 el disparador está en maintenance_work_orders;
--   T5 plan anual con servicios, presupuesto e indicadores; T6 sin permiso no hay plan anual; T7 Eficiencia de Flota
--   lee las fallas de maintenance_requests; T8 CFO 930, CJS 716 y ARB 976 en Flota con familia.
--   Informe: planes creados/por validar, odómetros actualizados y presupuesto del año. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

CREATE TEMP TABLE zz_c31_ot (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, order_type text, estimated_cost_pen numeric,
  total_cost numeric, approved_quote_id uuid);
CREATE TRIGGER zz_c31_trg BEFORE UPDATE ON zz_c31_ot FOR EACH ROW EXECUTE FUNCTION public.mant_trg_ot_umbral();

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; r_p uuid; r_n uuid; r jsonb; v_fail text[] := '{}'; v_pass int := 0; v_plate text; v_pid uuid; n int; n2 int;
  v_ok boolean; v_ot uuid; v_rep text; v_fecha date := (now() AT TIME ZONE 'America/Lima')::date - 10;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C31 planes', '["mantenimiento-planes:write"]') RETURNING id INTO r_p;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C31 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.profiles SET role_id = r_n, is_active = true WHERE id = v_user;

  -- T1: un montacargas con planes de plantilla
  SELECT p.vehicle_plate INTO v_plate FROM public.maintenance_plans p JOIN public.mant_plan_templates t ON t.id = p.mant_template_id
  WHERE t.familia = 'MONTACARGA_IC' ORDER BY p.vehicle_plate LIMIT 1;
  SELECT count(*), count(*) FILTER (WHERE NOT is_active), count(*) FILTER (WHERE mant_base_origen LIKE 'Historial%')
  INTO n, n2, v_pass FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND mant_template_id IS NOT NULL;
  IF v_plate IS NOT NULL AND n = 4 AND (n2 = 4 OR EXISTS (SELECT 1 FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND mant_base_origen LIKE 'Validado%')) AND v_pass >= 1
  THEN v_pass := 1; ELSE v_pass := 0; v_fail := v_fail || ('T1 planes: ' || COALESCE(v_plate, 'sin montacargas') || ' ' || n || '/' || n2); END IF;

  -- T2
  SELECT id INTO v_pid FROM public.maintenance_plans WHERE vehicle_plate = v_plate AND name = 'Servicio 250 h' LIMIT 1;
  PERFORM pg_temp.as_user(v_user);
  r := public.mant_validar_planes(v_plate, jsonb_build_array(jsonb_build_object('id', v_pid, 'fecha', v_fecha, 'activo', true)));
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN
    UPDATE public.profiles SET role_id = r_p WHERE id = v_user;
    PERFORM pg_temp.as_user(v_user);
    r := public.mant_validar_planes(v_plate, jsonb_build_array(jsonb_build_object('id', v_pid, 'fecha', v_fecha, 'activo', true)));
    PERFORM pg_temp.as_user(NULL);
    IF (r ->> 'success')::boolean AND EXISTS (SELECT 1 FROM public.maintenance_plans WHERE id = v_pid AND is_active AND last_performed_date = v_fecha AND mant_base_origen LIKE 'Validado%')
    THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 validar: ' || r::text); END IF;
  ELSE v_fail := v_fail || 'T2 validar sin permiso'::text; END IF;

  -- T3
  INSERT INTO zz_c31_ot (status, order_type, estimated_cost_pen) VALUES ('BORRADOR', 'CORRECTIVA', 7200) RETURNING id INTO v_ot;
  v_ok := false;
  BEGIN UPDATE zz_c31_ot SET status = 'APROBADA' WHERE id = v_ot;
  EXCEPTION WHEN OTHERS THEN v_ok := SQLERRM LIKE 'Reparación mayor%'; END;
  UPDATE zz_c31_ot SET approved_quote_id = gen_random_uuid() WHERE id = v_ot;
  BEGIN UPDATE zz_c31_ot SET status = 'APROBADA' WHERE id = v_ot;
  EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  INSERT INTO zz_c31_ot (status, order_type, estimated_cost_pen) VALUES ('BORRADOR', 'PREVENTIVA', 9000) RETURNING id INTO v_ot;
  BEGIN UPDATE zz_c31_ot SET status = 'APROBADA' WHERE id = v_ot;
  EXCEPTION WHEN OTHERS THEN v_ok := false; END;
  IF v_ok AND (SELECT count(*) FROM zz_c31_ot WHERE status = 'APROBADA') = 2 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T3 umbral'::text; END IF;

  -- T4
  IF to_regclass('public.maintenance_work_orders') IS NULL OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'mant_ot_umbral' AND tgrelid = 'public.maintenance_work_orders'::regclass)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 disparador'::text; END IF;

  -- T5
  PERFORM pg_temp.as_user(v_user); r := public.mant_plan_anual(NULL); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND jsonb_array_length(r -> 'unidades') >= 12 AND (r -> 'totales' ->> 'preventivo')::numeric > 0
     AND jsonb_array_length(r -> 'totales' -> 'por_mes') = 12 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T5 plan anual: ' || left(r::text, 200)); END IF;
  v_rep := 'presupuesto ' || COALESCE(r -> 'totales' ->> 'preventivo', '?') || ' + reserva ' || COALESCE(r -> 'totales' ->> 'reserva_correctivo', '?')
        || ', vencidos ' || COALESCE(r -> 'totales' ->> 'vencidos', '?') || ', cumplimiento ' || COALESCE(r -> 'totales' ->> 'cumplimiento_preventivo', '?') || '%'
        || ', caja sin unidad ' || COALESCE(jsonb_array_length(r -> 'caja_sin_unidad'), 0) || ', OT mayores ' || COALESCE(jsonb_array_length(r -> 'ot_mayores'), 0);

  -- T6
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.mant_plan_anual(NULL); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T6 sin permiso'::text; END IF;

  -- T7
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fe_build' AND pronamespace = 'public'::regnamespace LIMIT 1) LIKE '%FROM public.maintenance_requests f%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 fallas EF'::text; END IF;

  -- T8
  SELECT count(*) INTO n FROM public.vehicles v JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
  WHERE public.fe_code(v.plate) IN ('CFO 930', 'CJS 716', 'ARB 976');
  IF n = 3 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 unidades nuevas: ' || n || '/3'); END IF;

  v_rep := v_rep || ' | planes: ' || (SELECT count(*) FROM public.maintenance_plans WHERE mant_template_id IS NOT NULL)
        || ' (por validar ' || (SELECT count(*) FROM public.maintenance_plans WHERE mant_template_id IS NOT NULL AND NOT is_active) || ')'
        || ' | odómetros: ' || COALESCE((SELECT string_agg(detalle, '; ') FROM public.mant_setup_log WHERE paso = 'odometro'), '-')
        || ' | errores: ' || COALESCE((SELECT string_agg(detalle, '; ') FROM public.mant_setup_log WHERE paso IN ('plan', 'fase2') AND detalle ~ 'error'), 'ninguno');

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C31 PASS (%/8) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C31 FAIL (%/8): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
