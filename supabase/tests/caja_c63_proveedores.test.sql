-- Pruebas C63 — Proveedores de MP/producción/proyectos y su vínculo con la solicitud de transporte.
-- T1 tablas con RLS, barrera de cuenta activa y sin lectura anónima; T2 RUC de 11 dígitos y único;
-- T3 recojo/traslado exige proveedor, punto de recojo del mismo proveedor y documento OC/RQ/OS con número;
-- T4 el guardado completo es la única vía (apply_request_supplier no es ejecutable por usuarios);
-- T5 request_service_types devuelve proveedor, documento y la OC/OS antigua (como administrador);
-- T6 el trigger diferido rechaza un recojo/traslado sin proveedor aunque no pase por el RPC;
-- T7 save_supplier guarda proveedor y puntos juntos: si un punto falla no queda el proveedor.
-- Termina en error para forzar ROLLBACK: "CAJA C63 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c63_proveedores.test.sql
BEGIN;
DO $test$
DECLARE v_pass int := 0; v_fail text[] := '{}'; v_sup uuid; v_other uuid; v_loc uuid; v_other_loc uuid; v_req uuid;
  denied boolean; actor uuid; v_site uuid; v_new uuid; q jsonb; v_row public.transport_requests;
BEGIN
  -- T1
  IF (SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN ('public.suppliers'::regclass, 'public.supplier_locations'::regclass))
     AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid IN ('public.suppliers'::regclass, 'public.supplier_locations'::regclass)
          AND p.polname = 'security_active_account' AND NOT p.polpermissive) = 2
     AND NOT has_table_privilege('anon', 'public.suppliers', 'SELECT') AND NOT has_table_privilege('anon', 'public.supplier_locations', 'SELECT')
     AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.suppliers', 'public.supplier_locations']) tb, unnest(ARRAY['anon', 'authenticated']) rl,
          unnest(ARRAY['TRUNCATE', 'TRIGGER', 'DELETE']) pv WHERE has_table_privilege(rl, tb, pv))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 seguridad de tablas'::text; END IF;

  -- T2
  INSERT INTO public.suppliers(tax_id, business_name, category) VALUES ('20999999991', 'ZZ C63 Proveedor MP', 'MATERIA_PRIMA') RETURNING id INTO v_sup;
  INSERT INTO public.suppliers(tax_id, business_name, category) VALUES ('20999999992', 'ZZ C63 Otro', 'PROYECTOS') RETURNING id INTO v_other;
  denied := false; BEGIN INSERT INTO public.suppliers(tax_id, business_name) VALUES ('123', 'ZZ RUC corto'); EXCEPTION WHEN check_violation THEN denied := true; END;
  IF denied THEN
    denied := false; BEGIN INSERT INTO public.suppliers(tax_id, business_name) VALUES ('20999999991', 'ZZ duplicado'); EXCEPTION WHEN unique_violation THEN denied := true; END;
  END IF;
  IF denied THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 RUC sin validar'::text; END IF;
  INSERT INTO public.supplier_locations(supplier_id, name, address, district) VALUES (v_sup, 'Planta ZZ', 'Av. ZZ 123, Ate', 'ATE') RETURNING id INTO v_loc;
  INSERT INTO public.supplier_locations(supplier_id, name, address, district) VALUES (v_other, 'Almacén ZZ', 'Av. ZZ 456, Lurín', 'LURIN') RETURNING id INTO v_other_loc;

  -- T3
  -- La validación de proveedor no debe editar solicitudes reales ni depender
  -- de que la última carga todavía sea editable. El fixture está pendiente,
  -- sin ruta ni autorización de gastos; se revierte al terminar la prueba.
  FOR actor IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', actor::text, true);
    EXIT WHEN public.is_tms_admin(); actor := NULL;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C63 FAIL (%/7): falta administrador activo para ejecutar T3', v_pass; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  SELECT id INTO v_site FROM public.sites WHERE public.can_access_site(id) ORDER BY id LIMIT 1;
  IF v_site IS NULL THEN RAISE EXCEPTION 'CAJA C63 FAIL (%/7): falta sede autorizada', v_pass; END IF;
  INSERT INTO public.transport_requests(request_number,status,site_id,created_by,requester_name,department,
    request_type,attention_mode,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,
    required_date,supplier_id,reference_type,reference_number)
  VALUES('ZZ-C63-'||substr(gen_random_uuid()::text,1,8),'PENDIENTE',v_site,actor,'Prueba C63','Logística',
    'RECOJO','TRANSPORTE_JRM','Carga sintética','Proveedor prueba','LURIN','Planta prueba','ATE',
    current_date+1,v_sup,'RQ','ZZ-C63-INICIAL') RETURNING id INTO v_req;
  denied := false; BEGIN PERFORM public.apply_request_supplier(v_req, '{}'::jsonb); EXCEPTION WHEN OTHERS THEN denied := SQLERRM LIKE '%proveedor%'; END;
  IF denied THEN
    denied := false; BEGIN PERFORM public.apply_request_supplier(v_req, jsonb_build_object('supplier_id', v_sup, 'supplier_location_id', v_other_loc)); EXCEPTION WHEN OTHERS THEN denied := true; END;
  END IF;
  IF denied THEN
    denied := false; BEGIN PERFORM public.apply_request_supplier(v_req, jsonb_build_object('supplier_id', v_sup, 'reference_type', 'RQ')); EXCEPTION WHEN OTHERS THEN denied := true; END;
  END IF;
  IF denied THEN
    PERFORM public.apply_request_supplier(v_req, jsonb_build_object('supplier_id', v_sup, 'supplier_location_id', v_loc, 'reference_type', 'rq', 'reference_number', ' 1203 '));
    SELECT * INTO v_row FROM public.transport_requests WHERE id = v_req;
    denied := v_row.supplier_id = v_sup AND v_row.supplier_location_id = v_loc AND v_row.reference_type = 'RQ' AND v_row.reference_number = '1203';
  END IF;
  IF denied THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T3 validación de proveedor/documento'::text; END IF;

  -- T4
  IF has_function_privilege('authenticated', 'public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'public.apply_request_supplier(uuid,jsonb)', 'EXECUTE')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 permisos de guardado'::text; END IF;

  -- T6
  denied := false;
  BEGIN
    UPDATE public.transport_requests SET supplier_id = NULL, supplier_location_id = NULL WHERE id = v_req;
    SET CONSTRAINTS public.transport_requests_supplier_update IMMEDIATE;
  EXCEPTION WHEN check_violation THEN denied := SQLERRM LIKE '%proveedor%'; END;
  SET CONSTRAINTS public.transport_requests_supplier_update DEFERRED;
  IF denied AND (SELECT supplier_id FROM public.transport_requests WHERE id = v_req) = v_sup
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T6 recojo sin proveedor aceptado fuera del RPC'::text; END IF;

  -- T7
  denied := false;
  BEGIN
    PERFORM public.save_supplier(jsonb_build_object('tax_id', '20999999993', 'business_name', 'ZZ C63 Atómico'),
      jsonb_build_array(jsonb_build_object('name', 'Punto ZZ', 'address', 'Av. ZZ 1'), jsonb_build_object('name', '', 'address', '')));
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF denied AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE tax_id = '20999999993') THEN
    v_new := public.save_supplier(jsonb_build_object('tax_id', '20999999993', 'business_name', 'ZZ C63 Atómico'),
      jsonb_build_array(jsonb_build_object('name', 'Punto ZZ', 'address', 'Av. ZZ 1', 'district', 'ATE')));
    denied := (SELECT count(*) FROM public.supplier_locations WHERE supplier_id = v_new) = 1;
    IF denied THEN
      denied := false;
      BEGIN PERFORM public.save_supplier(jsonb_build_object('id', v_new, 'tax_id', '20999999993', 'business_name', 'ZZ C63 Atómico'),
        jsonb_build_array(jsonb_build_object('id', v_other_loc, 'name', 'Ajeno', 'address', 'Av. ZZ 9')));
      EXCEPTION WHEN OTHERS THEN denied := SQLERRM LIKE '%no pertenece%'; END;
    END IF;
  ELSE denied := false; END IF;
  IF denied THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 guardado de proveedor no atómico'::text; END IF;

  -- T5
  FOR actor IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', actor::text, true);
    EXIT WHEN public.is_tms_admin(); actor := NULL;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C63 FAIL (%/7): falta administrador activo para ejecutar T5', v_pass; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  q := public.request_service_types(ARRAY[v_req]);
  IF q->0->>'supplier_name' = 'ZZ C63 Proveedor MP' AND q->0->>'reference_type' = 'RQ' AND q->0->>'reference_number' = '1203' AND q->0 ? 'purchase_order'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 respuesta ' || COALESCE(q::text, 'NULL')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C63 PASS (%/7) proveedores y documento de referencia', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C63 FAIL (%/7): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
