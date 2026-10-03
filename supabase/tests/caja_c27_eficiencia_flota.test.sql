-- CAJA C27 — Eficiencia de Flota. Con una historia de prueba (mantenimiento, combustible mensual y rutas):
--   T1 solo flota-eficiencia-carga puede cargar; T2 la carga se aplica y crea los activos;
--   T3 el resumen calcula km, costo por km, toneladas y costo por t·km de la unidad tal como los datos;
--   T4 con un corte manual los meses desde el corte no se toman del Excel (no se cuenta dos veces);
--   T5 el equipo obtiene horas de uso por horómetro y una decisión; T6 sin permiso no hay acceso.
-- El mensaje informa cuántos registros del TMS existen desde 2025 (combustible con odómetro, despachos con guías,
-- lecturas de horómetro y costos de órdenes de trabajo). Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; v_rc uuid; v_rv uuid; v_up uuid; r jsonb; r2 jsonb; r_no jsonb; r_beg jsonb; u jsonb; e jsonb;
  v_fail text[] := '{}'; v_pass int := 0; v_diag text := '';
  n1 bigint; n2 bigint; n3 bigint; n4 bigint;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C27 carga', '["flota-eficiencia-carga"]') RETURNING id INTO v_rc;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C27 ver', '["flota-eficiencia:read"]') RETURNING id INTO v_rv;
  UPDATE public.fe_settings SET desde = DATE '2025-01-01', corte = NULL WHERE id = 1;

  -- T1: el permiso de ver no permite cargar
  UPDATE public.profiles SET is_active = true, role_id = v_rv WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  r_beg := public.fe_upload_begin('zz.xlsx');
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r_beg ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 ver pudo cargar'::text; END IF;

  -- T2: carga con el permiso de carga
  UPDATE public.profiles SET role_id = v_rc WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  v_up := (public.fe_upload_begin('zz.xlsx') ->> 'id')::uuid;
  PERFORM public.fe_upload_rows(v_up, 'MANT', jsonb_build_array(
    jsonb_build_object('activo', 'ZZT 901', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-01-10', 'monto', 300, 'tipo', 'PREVENTIVO', 'anio_fab', 2010),
    jsonb_build_object('activo', 'ZZT 901', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-02-10', 'monto', 100, 'tipo', 'CORRECTIVO', 'anio_fab', 2010),
    jsonb_build_object('activo', 'ZZT 901', 'clase', 'UNIDAD VEHICULAR', 'fecha', '2025-03-10', 'monto', 200, 'tipo', 'PREVENTIVO', 'anio_fab', 2010),
    jsonb_build_object('activo', 'ZZ MONTACARGA 1', 'clase', 'MONTACARGA', 'fecha', '2025-01-05', 'monto', 500, 'km_hrs', 1000, 'anio_fab', 2012),
    jsonb_build_object('activo', 'ZZ MONTACARGA 1', 'clase', 'MONTACARGA', 'fecha', '2025-04-05', 'monto', 500, 'km_hrs', 1050, 'anio_fab', 2012),
    jsonb_build_object('activo', 'ZZ MONTACARGA 1', 'clase', 'MONTACARGA', 'fecha', '2025-09-05', 'monto', 500, 'km_hrs', 1150, 'anio_fab', 2012)));
  PERFORM public.fe_upload_rows(v_up, 'COMB', jsonb_build_array(
    jsonb_build_object('placa', 'ZZT 901', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 1, 'galones', 50, 'soles', 700, 'km_real', 1000, 'valida', 1),
    jsonb_build_object('placa', 'ZZT 901', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 2, 'galones', 40, 'soles', 560, 'km_real', 800, 'valida', 1),
    jsonb_build_object('placa', 'ZZT 901', 'vehiculo', 'CAMION', 'anio', 2025, 'mes', 3, 'galones', 60, 'soles', 840, 'km_real', 1200, 'valida', 1)));
  PERFORM public.fe_upload_rows(v_up, 'RUTA', jsonb_build_array(
    jsonb_build_object('fecha', '2025-01-15', 'placa', 'ZZT 901', 'kg', 4000, 'km', 50, 'm3', 0.5, 'actividad', 'DESPACHO DE CONTRATOS'),
    jsonb_build_object('fecha', '2025-02-15', 'placa', 'ZZT 901', 'kg', 6000, 'km', 100, 'm3', 0.7, 'actividad', 'DESPACHO DE CONTRATOS'),
    jsonb_build_object('fecha', '2025-03-15', 'placa', 'ZZT 901', 'kg', 999999, 'km', 80, 'actividad', 'DESPACHO DE CONTRATOS')));
  r := public.fe_upload_apply(v_up);
  PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND EXISTS (SELECT 1 FROM public.fe_assets WHERE code = 'ZZT 901' AND clase = 'TRANSPORTE')
     AND EXISTS (SELECT 1 FROM public.fe_assets WHERE code = 'ZZ MONTACARGA 1' AND clase = 'MONTACARGA')
     AND (r #>> '{summary,viajes}')::int = 3
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 carga: ' || left(COALESCE(r::text, '∅'), 300)); END IF;

  -- T3: resumen como usuario que solo ve (ene–mar 2025)
  UPDATE public.profiles SET role_id = v_rv WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_resumen(jsonb_build_object('desde', '2025-01-01', 'hasta', '2025-03-01'));
  PERFORM pg_temp.as_user(NULL);
  SELECT x INTO u FROM jsonb_array_elements(r -> 'transporte') x WHERE x ->> 'code' = 'ZZT 901';
  -- km 3000; costo (700+560+840 + 300+100+200) / 3000 = 0,9; ton: 4 + 6 (el viaje de 999 t se anula) en ene–feb; t·km 4*50+6*100 = 800
  IF (r ->> 'success')::boolean AND (u ->> 'km')::numeric = 3000 AND abs((u ->> 'costo_km')::numeric - 0.9) < 0.0001
     AND (u ->> 'ton')::numeric = 10 AND (u ->> 'tkm')::numeric = 800 AND (u ->> 'meses_t')::int = 2 AND u ->> 'rec' IS NOT NULL
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 resumen: ' || left(COALESCE(u::text, r::text, '∅'), 400)); END IF;

  -- T4: corte manual en marzo: marzo deja de venir del Excel
  UPDATE public.fe_settings SET corte = DATE '2025-03-01' WHERE id = 1;
  PERFORM pg_temp.as_user(v_user);
  r2 := public.fe_resumen(jsonb_build_object('desde', '2025-01-01', 'hasta', '2025-03-01'));
  PERFORM pg_temp.as_user(NULL);
  SELECT x INTO u FROM jsonb_array_elements(r2 -> 'transporte') x WHERE x ->> 'code' = 'ZZT 901';
  IF (u ->> 'km_tot')::numeric = 1800 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 corte: ' || left(COALESCE(u::text, '∅'), 300)); END IF;
  UPDATE public.fe_settings SET corte = NULL WHERE id = 1;

  -- T5: horas del montacargas (150 h en ~8 meses) y decisión
  PERFORM pg_temp.as_user(v_user);
  r := public.fe_resumen(jsonb_build_object('desde', '2025-01-01', 'hasta', '2025-12-01'));
  PERFORM pg_temp.as_user(NULL);
  SELECT x INTO e FROM jsonb_array_elements(r -> 'equipos') x WHERE x ->> 'code' = 'ZZ MONTACARGA 1';
  IF (e ->> 'lecturas')::int = 3 AND (e ->> 'horas_anio')::numeric BETWEEN 200 AND 260 AND e ->> 'rec' IS NOT NULL
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 equipo: ' || left(COALESCE(e::text, '∅'), 300)); END IF;

  -- T6: sin permiso
  UPDATE public.profiles SET role_id = NULL WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user);
  r_no := public.fe_resumen('{}');
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r_no ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T6 sin permiso con acceso'::text; END IF;

  -- Diagnóstico de datos del TMS desde 2025
  BEGIN EXECUTE $q$SELECT count(*) FROM public.dispatch_expenses WHERE upper(expense_type::text) IN ('COMBUSTIBLE','FUEL','DIESEL','GASOLINA','GLP') AND fuel_odometer IS NOT NULL AND COALESCE(expense_date, created_at::date) >= '2025-01-01'$q$ INTO n1; EXCEPTION WHEN OTHERS THEN n1 := -1; END;
  BEGIN EXECUTE $q$SELECT count(DISTINCT dispatch_id) FROM public.dispatch_documents WHERE doc_type = 'GUIA_REMISION' AND voided_at IS NULL AND uploaded_at >= '2025-01-01'$q$ INTO n2; EXCEPTION WHEN OTHERS THEN n2 := -1; END;
  BEGIN EXECUTE $q$SELECT count(*) FROM public.vehicle_odometer_logs WHERE hours_value > 0 AND created_at >= '2025-01-01'$q$ INTO n3; EXCEPTION WHEN OTHERS THEN n3 := -1; END;
  BEGIN EXECUTE $q$SELECT count(*) FROM public.work_order_costs WHERE created_at >= '2025-01-01'$q$ INTO n4; EXCEPTION WHEN OTHERS THEN n4 := -1; END;
  v_diag := format(' tms2025: comb_odometro=%s despachos_con_guias=%s lecturas_horas=%s costos_ot=%s', n1, n2, n3, n4);

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C27 PASS (%/6)%', v_pass, v_diag;
  ELSE
    RAISE EXCEPTION 'CAJA C27 FAIL (%/6): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
