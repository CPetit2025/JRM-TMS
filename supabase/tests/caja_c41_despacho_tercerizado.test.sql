-- CAJA C41 — Despacho tercerizado (unidad de un transportista que no usa el app).
--   T1 sin permiso no se programa; T2 Despacho programa con un tercero: sin conductor propio, placa escrita, flete
--   reservado en la partida a nombre del proveedor y solicitudes asignadas; T3 la misma placa no toma dos viajes
--   activos y la empresa propia no se programa como tercero; T4 la salida exige la guía confirmada y guarda la hora
--   real; T5 la entrega exige foto y deja la constancia en la galería del despacho; T6 el enlace del chofer muestra
--   el viaje sin costos, rechaza fotos ajenas y con la última entrega pasa a ENTREGADO; T7 "Cerrar ruta" consume la
--   partida y el enlace deja de valer; T8 el desempeño por proveedor cuenta el viaje y sus entregas.
-- Termina en error para forzar ROLLBACK.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Inserta solo las columnas que existen (el esquema de producción difiere del repositorio)
CREATE FUNCTION pg_temp.ins(p_table text, p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id', p_table,
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = p_table AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;

DO $test$
DECLARE
  v_desp uuid; v_nadie uuid; r_desp uuid; r_nadie uuid; v_site uuid; v_car uuid; v_propio uuid; v_ct uuid;
  q1 uuid; q2 uuid; q3 uuid; d uuid; v_plate text := 'ZZC' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
  v_err text; r jsonb; v_res0 numeric; v_con0 numeric; v_tok text; v_n int; v_at timestamptz := now() - interval '20 minutes';
  v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT id INTO v_desp FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_nadie FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_desp ORDER BY id LIMIT 1;
  IF v_nadie IS NULL THEN RAISE EXCEPTION 'CAJA C41 FAIL (0/8): se requieren 2 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C41 despacho', '["despacho"]') RETURNING id INTO r_desp;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C41 nada', '["clientes"]') RETURNING id INTO r_nadie;
  UPDATE public.profiles SET role_id = r_desp, is_active = true WHERE id = v_desp;
  UPDATE public.profiles SET role_id = r_nadie, is_active = true WHERE id = v_nadie;
  SELECT NULLIF(to_jsonb(v) ->> 'site_id', '')::uuid INTO v_site FROM public.vehicles v WHERE to_jsonb(v) ->> 'site_id' IS NOT NULL LIMIT 1;
  IF v_site IS NOT NULL AND to_regclass('public.user_site_access') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.user_site_access (user_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING' USING v_desp, v_site;
  END IF;
  v_car := pg_temp.ins('carriers', jsonb_build_object('type', 'PROVEEDOR', 'business_name', 'ZZ C41 Transportes SAC',
             'ruc', '20' || lpad((floor(random() * 1e9))::bigint::text, 9, '0'), 'is_active', true));
  SELECT id INTO v_propio FROM public.carriers WHERE upper(type) = 'PROPIO' LIMIT 1;
  v_ct := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C41-OT', 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', v_site));
  UPDATE public.contract_budgets SET allocated_pen = 1000 WHERE contract_id = v_ct AND concept = 'PARTIDA_TRANSPORTE';
  IF NOT FOUND THEN INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_ct, 'PARTIDA_TRANSPORTE', 1000); END IF;
  q1 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C41-R1', 'status', 'APROBADA', 'site_id', v_site, 'contract_id', v_ct,
          'requester_name', 'Obra ZZ', 'department', 'Logística', 'request_type', 'DESPACHO', 'cargo_description', 'Prueba', 'pickup_address', 'Planta',
          'delivery_address', 'Obra 1, Ate', 'required_date', current_date + 1, 'approved_at', now()));
  q2 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C41-R2', 'status', 'APROBADA', 'site_id', v_site, 'contract_id', v_ct,
          'requester_name', 'Obra ZZ', 'department', 'Logística', 'request_type', 'DESPACHO', 'cargo_description', 'Prueba', 'pickup_address', 'Planta',
          'delivery_address', 'Obra 2, Lurín', 'required_date', current_date + 1, 'approved_at', now()));
  q3 := pg_temp.ins('transport_requests', jsonb_build_object('request_number', 'ZZ-C41-R3', 'status', 'APROBADA', 'site_id', v_site, 'contract_id', v_ct,
          'requester_name', 'Obra ZZ', 'department', 'Logística', 'request_type', 'DESPACHO', 'cargo_description', 'Prueba', 'pickup_address', 'Planta',
          'delivery_address', 'Obra 3, Ate', 'required_date', current_date + 1, 'approved_at', now()));
  SELECT reserved_pen, consumed_pen INTO v_res0, v_con0 FROM public.contract_budgets WHERE contract_id = v_ct AND concept = 'PARTIDA_TRANSPORTE';

  -- T1 sin permiso
  PERFORM pg_temp.as_user(v_nadie);
  BEGIN
    PERFORM public.schedule_dispatch_tercero(v_car, v_plate, 'Pedro Tercero', '999888777', '40000041', now() + interval '1 hour', 30, 300, v_ct,
      jsonb_build_array(jsonb_build_object('id', q1)));
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Sin permiso%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 ' || COALESCE(v_err, 'programó sin permiso')); END IF;

  -- T2 programar con tercero (placa con espacio y minúsculas: se normaliza)
  PERFORM pg_temp.as_user(v_desp);
  d := public.schedule_dispatch_tercero(v_car, lower(substr(v_plate, 1, 3)) || ' ' || substr(v_plate, 4), 'Pedro Tercero', '999888777', '40000041',
         now() + interval '10 minutes', 30, 300, v_ct,
         jsonb_build_array(jsonb_build_object('id', q1, 'document_number', 'T001-41'), jsonb_build_object('id', q2, 'document_number', 'T001-42')));
  PERFORM pg_temp.as_user(NULL);
  IF EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = d AND x.modalidad = 'TERCERO' AND x.driver_id IS NULL AND x.vehicle_plate = v_plate
             AND x.carrier_id = v_car AND x.status = 'PROGRAMADO' AND x.tercero_telefono = '999888777')
     AND (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct AND concept = 'PARTIDA_TRANSPORTE') = v_res0 + 300
     AND EXISTS (SELECT 1 FROM public.contract_services s WHERE s.dispatch_id = d AND s.service_type = 'FLETE' AND s.amount_pen = 300
                 AND s.provider_name = 'ZZ C41 Transportes SAC' AND s.provider_ruc IS NOT NULL)
     AND (SELECT count(*) FROM public.transport_requests WHERE id IN (q1, q2) AND status = 'ASIGNADA') = 2
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 programar con tercero'::text; END IF;

  -- T3 placa ocupada y empresa propia
  PERFORM pg_temp.as_user(v_desp);
  BEGIN
    PERFORM public.schedule_dispatch_tercero(v_car, v_plate, 'Otro', '988', NULL, now() + interval '2 hours', 10, 0, v_ct, jsonb_build_array(jsonb_build_object('id', q3)));
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err LIKE '%ya tiene un despacho activo%' THEN
    v_err := NULL;
    IF v_propio IS NOT NULL THEN
      BEGIN
        PERFORM public.schedule_dispatch_tercero(v_propio, 'ZZP' || substr(v_plate, 4), 'Otro', '988', NULL, now() + interval '2 hours', 10, 0, v_ct,
          jsonb_build_array(jsonb_build_object('id', q3)));
        v_err := 'programó a la empresa propia como tercero';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%empresa propia%' THEN v_err := SQLERRM; END IF;
      END;
    END IF;
  ELSE v_err := COALESCE(v_err, 'aceptó la misma placa dos veces');
  END IF;
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 ' || v_err); END IF;

  -- T4 salida: primero exige la guía confirmada; luego guarda la hora real
  PERFORM pg_temp.as_user(v_desp);
  BEGIN r := public.tercero_registrar_salida(d, v_at); v_err := r ->> 'error';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.as_user(NULL);
  UPDATE public.dispatches SET docs_ready_at = now() WHERE id = d;   -- la Asistente Documentario confirma la guía
  PERFORM pg_temp.as_user(v_desp); r := public.tercero_registrar_salida(d, v_at); PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Documentos pendientes%' AND (r ->> 'success')::boolean
     AND EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = d AND x.status = 'EN_CURSO' AND x.tercero_salida_at = v_at)
     AND (to_regclass('public.kpi_dispatch_log') IS NULL
          OR EXISTS (SELECT 1 FROM public.kpi_dispatch_log l WHERE l.dispatch_id = d AND l.estado_nuevo = 'EN_CURSO' AND l.at = v_at))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 salida: ' || COALESCE(v_err, '-') || ' / ' || COALESCE(r::text, '')); END IF;

  -- T5 entrega desde la web: sin foto no; con foto queda la constancia y sigue en ruta
  PERFORM pg_temp.as_user(v_desp);
  r := public.tercero_registrar_entrega(d, q1, now() - interval '5 minutes', 'Juan Almacén', '', NULL);
  v_err := r ->> 'error';
  r := public.tercero_registrar_entrega(d, q1, now() - interval '5 minutes', 'Juan Almacén', v_desp::text || '/tercero/' || d::text || '/g1.jpg', 'Guía firmada');
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Adjunte la foto%' AND (r ->> 'success')::boolean AND (r ->> 'pendientes')::int = 1
     AND EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = d AND x.status = 'EN_CURSO')
     AND EXISTS (SELECT 1 FROM public.route_stops_log s WHERE s.dispatch_id = d AND s.transport_request_id = q1 AND s.photo_url LIKE '%/g1.jpg')
     AND EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = d AND transport_request_id = q1 AND status = 'ENTREGADO')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 entrega web: ' || COALESCE(v_err, '-') || ' / ' || COALESCE(r::text, '')); END IF;

  -- T6 enlace del chofer (lo llama el servidor con la llave de servicio: sin sesión)
  PERFORM pg_temp.as_user(v_desp); r := public.tercero_generar_enlace(d); PERFORM pg_temp.as_user(NULL);
  v_tok := r ->> 'token';
  r := public.tercero_enlace_info(v_tok);
  v_err := NULL;
  IF NOT (r ->> 'success')::boolean OR jsonb_array_length(r -> 'paradas') <> 2 OR r::text LIKE '%300%' THEN v_err := 'info: ' || left(r::text, 150); END IF;
  r := public.tercero_enlace_entregar(v_tok, q2, 'Rosa Obra', 'otra/carpeta/x.jpg', NULL);
  IF COALESCE((r ->> 'success')::boolean, false) THEN v_err := COALESCE(v_err, '') || ' aceptó una foto ajena'; END IF;
  r := public.tercero_enlace_entregar(v_tok, q2, 'Rosa Obra', 'tercero/' || d::text || '/g2.jpg', NULL);
  IF v_err IS NULL AND (r ->> 'success')::boolean AND (r ->> 'entregado')::boolean
     AND EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = d AND x.status = 'ENTREGADO' AND x.tercero_entrega_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM public.dispatch_tercero_entregas e WHERE e.dispatch_id = d AND e.transport_request_id = q2 AND e.fuente = 'ENLACE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 enlace: ' || COALESCE(v_err, '-') || ' / ' || COALESCE(r::text, '')); END IF;

  -- T7 cerrar ruta: consume la partida; el enlace deja de valer
  PERFORM pg_temp.as_user(v_desp); PERFORM public.close_dispatch_route(d); PERFORM pg_temp.as_user(NULL);
  r := public.tercero_enlace_info(v_tok);
  IF EXISTS (SELECT 1 FROM public.dispatches x WHERE x.id = d AND x.status = 'LIQUIDADO')
     AND (SELECT consumed_pen FROM public.contract_budgets WHERE contract_id = v_ct AND concept = 'PARTIDA_TRANSPORTE') = v_con0 + 300
     AND (SELECT reserved_pen FROM public.contract_budgets WHERE contract_id = v_ct AND concept = 'PARTIDA_TRANSPORTE') = v_res0
     AND (SELECT count(*) FROM public.transport_requests WHERE id IN (q1, q2) AND status = 'ENTREGADA') = 2
     AND NOT (r ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 cierre: ' || COALESCE(r::text, '')); END IF;

  -- T8 desempeño por proveedor
  PERFORM pg_temp.as_user(v_desp); r := public.tercero_desempeno(NULL, NULL); PERFORM pg_temp.as_user(NULL);
  SELECT count(*) INTO v_n FROM jsonb_array_elements(r -> 'proveedores') p
  WHERE p ->> 'carrier_id' = v_car::text AND (p ->> 'viajes')::int = 1 AND (p ->> 'entregas')::int = 2 AND (p ->> 'cerrados')::int = 1
    AND (p ->> 'salida_puntual_pct')::numeric = 100 AND (p ->> 'entrega_a_tiempo_pct')::numeric = 100 AND (p ->> 'flete')::numeric = 300;
  IF (r ->> 'success')::boolean AND v_n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 desempeño: ' || left(COALESCE(r::text, ''), 200)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C41 PASS (%/8) placa %; dispatches.scheduled_date %', v_pass, v_plate,
      COALESCE((SELECT CASE WHEN is_nullable = 'NO' AND column_default IS NULL THEN 'obligatorio sin valor por defecto' ELSE 'opcional' END
                FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dispatches' AND column_name = 'scheduled_date'), 'no existe');
  ELSE
    RAISE EXCEPTION 'CAJA C41 FAIL (%/8): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
