-- Partida bruta: 1250 deja 1000 operativos (80%); se conserva el escenario de saldo de esta regresión.
-- Pruebas C9 — Responsabilidad documentaria: Packing List firmado por el auditor, Nota de Despacho, bloqueo de salida,
-- reemisión, anulación, bandeja) y validación de saldo de schedule_dispatch con la reserva de F2.
-- Termina en error para forzar ROLLBACK: "CAJA C9 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c9_documentario.test.sql
BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Cambia el estado del despacho y devuelve el error (NULL si pasó)
CREATE FUNCTION pg_temp.try_depart(p_id uuid, p_status text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.dispatches SET status = p_status WHERE id = p_id;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

-- Temporary fixture stores a real object record; signed packing is registered through the actual role-checked RPC.
CREATE FUNCTION pg_temp.doc(p_dispatch uuid,p_req uuid,p_type text,p_cargo text,p_number text,
 p_mime text DEFAULT 'application/pdf',p_signature boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; path text:=p_dispatch::text||'/'||CASE WHEN p_type='PACKING_LIST' THEN 'packing/'||auth.uid()::text||'/' ELSE '' END||gen_random_uuid()::text||'.pdf';
BEGIN
 INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('dispatch_documents',path,jsonb_build_object('mimetype',p_mime));
 IF p_type='PACKING_LIST' THEN
  r:=public.register_signed_packing_list(p_dispatch,p_req,path,'packing.pdf',p_mime,1000,'Auditor C9',(now() AT TIME ZONE 'America/Lima')::date,p_signature);
 ELSE
  r:=public.register_dispatch_document(p_dispatch,p_req,p_type,p_cargo,p_number,path,'archivo.pdf',p_mime,1000,NULL);
 END IF;
 RETURN CASE WHEN (r->>'success')::boolean THEN NULL ELSE COALESCE(r->>'error','error') END;
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_admin uuid; v_doc uuid; v_desp uuid; v_nobody uuid; v_drv_prof uuid;
  v_role_doc uuid; v_role_desp uuid; v_site uuid; v_carrier uuid; v_driver uuid;
  v_ct uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; d1 uuid; d2 uuid; d3 uuid; v_doc_id uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  r jsonb; q jsonb; v_err text; v_err2 text; v_err3 text; v_err4 text; v_err5 text; v_n int;
BEGIN
  SELECT carrier_id, site_id INTO v_carrier, v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  FOR v_admin IN SELECT id FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u) LOOP
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    EXIT WHEN public.is_tms_admin();
    v_admin := NULL;
  END LOOP;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'CAJA C9 FAIL: no hay administrador'; END IF;
  SELECT id INTO v_doc FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_admin ORDER BY id LIMIT 1;
  SELECT id INTO v_desp FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_doc) ORDER BY id LIMIT 1;
  SELECT id INTO v_nobody FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_doc, v_desp) ORDER BY id LIMIT 1;
  SELECT id INTO v_drv_prof FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_admin, v_doc, v_desp, v_nobody) ORDER BY id LIMIT 1;
  IF v_drv_prof IS NULL THEN RAISE EXCEPTION 'CAJA C9 FAIL: se requieren 5 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Documentario C9', '["documentario","despacho:read","packing-list:write"]') RETURNING id INTO v_role_doc;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ Transporte C9', '["despacho"]') RETURNING id INTO v_role_desp;
  UPDATE public.profiles SET role_id = v_role_doc, is_active = true WHERE id = v_doc;
  UPDATE public.profiles SET role_id = v_role_desp, is_active = true WHERE id = v_desp;
  UPDATE public.profiles SET role_id = NULL, is_active = true WHERE id IN (v_nobody, v_drv_prof);
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_doc, v_site), (v_desp, v_site) ON CONFLICT DO NOTHING;
  INSERT INTO public.drivers (carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
  VALUES (v_carrier, v_drv_prof, 'Conductor', 'C9', 'ZZC9-DOC', 'ZZC9-LIC', true) RETURNING id INTO v_driver;
  INSERT INTO public.vehicles (plate, carrier_id, site_id, type, status, current_odometer) VALUES
    ('ZZC9A', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100), ('ZZC9B', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100),
    ('ZZC9C', v_carrier, v_site, 'TRACTO', 'DISPONIBLE', 100);
  INSERT INTO public.contracts (code, type, status, site_id) VALUES ('ZZ-C9-OT', 'CONTRATO', 'ACTIVO', v_site) RETURNING id INTO v_ct;
  INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_ct, 'PARTIDA_TRANSPORTE', 1250);
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C9-R1', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra 1', 'Ate', current_date),
    ('ZZ-C9-R2', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra 2', 'Ate', current_date),
    ('ZZ-C9-R3', 'ASIGNADA', v_site, v_ct, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Planta', 'Lurín', current_date);
  SELECT id INTO r1 FROM public.transport_requests WHERE request_number = 'ZZ-C9-R1';
  SELECT id INTO r2 FROM public.transport_requests WHERE request_number = 'ZZ-C9-R2';
  SELECT id INTO r3 FROM public.transport_requests WHERE request_number = 'ZZ-C9-R3';
  -- D1: envío propio con dos paradas; D2: recojo del cliente (EXTERNO); ambos sujetos a documentos
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, driver_id, status, site_id, contract_id, scheduled_departure, docs_required)
  VALUES ('ZZ-C9-D1', 'ZZC9A', v_driver, 'PROGRAMADO', v_site, v_ct, now() + interval '1 hour', true) RETURNING id INTO d1;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, contract_id, scheduled_departure, docs_required)
  VALUES ('ZZ-C9-D2', 'EXTERNO', 'PROGRAMADO', v_site, v_ct, now() + interval '5 hours', true) RETURNING id INTO d2;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d1, r1, 'PROGRAMADO'), (d1, r2, 'PROGRAMADO'), (d2, r3, 'PROGRAMADO');
  -- El recojo real se programa como NOTA_SALIDA; EXTERNO también puede ser un proveedor.
  UPDATE public.dispatch_requests SET document_type = 'NOTA_SALIDA' WHERE dispatch_id = d2;

  -- T1: role, signed-file format, auditor signature, stop scope and separation from delivery guides.
  PERFORM pg_temp.as_user(v_nobody);
  v_err:=pg_temp.doc(d1,r1,'PACKING_LIST',NULL,NULL);
  PERFORM pg_temp.as_user(v_doc);
  v_err2:=pg_temp.doc(d1,r1,'NOTA_DESPACHO',NULL,'ND-1');
  v_err3:=pg_temp.doc(d1,r1,'PACKING_LIST',NULL,NULL,'application/x-test-invalid');
  v_err4:=pg_temp.doc(d1,r3,'PACKING_LIST',NULL,NULL);
  v_err5:=pg_temp.doc(d1,r2,'PACKING_LIST',NULL,NULL,'application/pdf',false);
  IF (v_err LIKE 'Solo el Asistente Documentario%' OR v_err LIKE 'Solo el Auditor de Despacho%') AND v_err2 LIKE '%solo para recojos%' AND v_err3 LIKE '%PDF%'
    AND v_err4 LIKE '%no pertenece%' AND v_err5 LIKE '%contiene su firma%'
    AND pg_temp.doc(d1,r1,'GUIA_REMISION','PT','T001-1') LIKE '%conductor desde el app%'
    AND pg_temp.doc(d1,r1,'PACKING_LIST',NULL,NULL) IS NULL
  THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail||('T1 responsabilidades: '||concat_ws(' | ',v_err,v_err2,v_err3,v_err4,v_err5)); END IF;
  PERFORM pg_temp.as_user(NULL);

  -- T2: signed packing must cover every stop; other spreadsheets never replace the signed evidence.
  v_err:=pg_temp.try_depart(d1,'EN RUTA');
  PERFORM pg_temp.as_user(v_doc);
  v_err2:=public.confirm_dispatch_documents(d1)->>'error';
  v_err3:=concat_ws(' | ',pg_temp.doc(d1,r2,'PACKING_LIST',NULL,NULL),
    pg_temp.doc(d1,NULL,'OTRO',NULL,NULL,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  r:=public.confirm_dispatch_documents(d1);
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Documentos pendientes%' AND v_err2 LIKE '%ZZ-C9-R2%' AND NULLIF(v_err3,'') IS NULL AND (r->>'success')::boolean
    AND (SELECT docs_ready_at IS NOT NULL AND docs_ready_by=v_doc FROM public.dispatches WHERE id=d1)
    AND (SELECT count(*)=3 FROM public.dispatch_documents WHERE dispatch_id=d1 AND voided_at IS NULL)
  THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail||('T2 salida: '||concat_ws(' | ',v_err,v_err2,v_err3,r::text)); END IF;

  -- T3: cambio de placa o de paradas después de confirmar → reemisión y bloqueo hasta reconfirmar
  UPDATE public.dispatches SET vehicle_plate = 'ZZC9B' WHERE id = d1;
  v_err := pg_temp.try_depart(d1, 'EN RUTA');
  PERFORM pg_temp.as_user(v_doc);
  r := public.confirm_dispatch_documents(d1);
  PERFORM pg_temp.as_user(NULL);
  v_n := (SELECT count(*) FROM public.dispatches WHERE id = d1 AND NOT docs_reissue);
  DELETE FROM public.dispatch_requests WHERE dispatch_id = d1 AND transport_request_id = r2;
  IF v_err LIKE 'Documentos por reemitir%Cambió la placa ZZC9A → ZZC9B%' AND (r->>'success')::boolean AND v_n = 1
     AND (SELECT docs_reissue AND docs_reissue_reason = 'Se retiró una parada' FROM public.dispatches WHERE id = d1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 reemisión: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(r::text, '∅') || ' n=' || v_n); END IF;
  INSERT INTO public.dispatch_requests (dispatch_id, transport_request_id, status) VALUES (d1, r2, 'PROGRAMADO');

  -- T4: customer pickup retains its release note and signed packing; cancellation remains available.
  PERFORM pg_temp.as_user(v_doc);
  v_err:=pg_temp.doc(d2,r3,'GUIA_REMISION','PT','T001-50');
  v_err2:=public.confirm_dispatch_documents(d2)->>'error';
  v_err3:=concat_ws(' | ',pg_temp.doc(d2,r3,'NOTA_DESPACHO',NULL,'ND-0001'),pg_temp.doc(d2,NULL,'PACKING_LIST',NULL,NULL));
  r:=public.confirm_dispatch_documents(d2);
  PERFORM pg_temp.as_user(NULL);
  v_err4:=pg_temp.try_depart(d2,'ENTREGADO');
  INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_id,status,site_id,docs_required)
  VALUES('ZZ-C9-D3','ZZC9C',NULL,'PROGRAMADO',v_site,true) RETURNING id INTO d3;
  v_err5:=pg_temp.try_depart(d3,'CANCELADO');
  IF v_err IS NOT NULL AND v_err2 LIKE '%Nota de Despacho%' AND NULLIF(v_err3,'') IS NULL AND (r->>'success')::boolean AND v_err4 IS NULL AND v_err5 IS NULL
  THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail||('T4 recojo: '||concat_ws(' | ',v_err,v_err2,v_err3,r::text,v_err4,v_err5)); END IF;

  -- T5: voiding signed packing reblocks departure; replacement and reconfirmation are required; driver reads the file.
  PERFORM pg_temp.as_user(v_doc);
  r:=public.confirm_dispatch_documents(d1);
  SELECT id INTO v_doc_id FROM public.dispatch_documents WHERE dispatch_id=d1 AND transport_request_id=r2 AND doc_type='PACKING_LIST' AND voided_at IS NULL;
  v_err:=public.void_dispatch_document(v_doc_id,'')->>'error';
  q:=public.void_dispatch_document(v_doc_id,'Packing mal firmado');
  v_err2:=public.confirm_dispatch_documents(d1)->>'error';
  v_err4:=pg_temp.doc(d1,r2,'PACKING_LIST',NULL,NULL);
  r:=public.confirm_dispatch_documents(d1);
  PERFORM pg_temp.as_user(NULL);
  v_err5:=pg_temp.try_depart(d1,'EN RUTA');
  PERFORM pg_temp.as_user(v_doc);
  SELECT id INTO v_doc_id FROM public.dispatch_documents WHERE dispatch_id=d1 AND transport_request_id=r1 AND doc_type='PACKING_LIST' AND voided_at IS NULL;
  v_err3:=public.void_dispatch_document(v_doc_id,'tarde')->>'error';
  PERFORM pg_temp.as_user(v_drv_prof);
  SELECT count(*) INTO v_n FROM public.dispatch_documents WHERE dispatch_id=d1;
  PERFORM pg_temp.as_user(NULL);
  IF v_err LIKE 'Indique el motivo%' AND (q->>'success')::boolean AND v_err2 LIKE '%Packing List%' AND v_err4 IS NULL
    AND (r->>'success')::boolean AND v_err5 IS NULL AND v_err3 LIKE 'El despacho ya salió%' AND v_n=4
  THEN v_pass:=v_pass+1; ELSE v_fail:=v_fail||('T5 anulación: '||concat_ws(' | ',v_err,q::text,v_err2,r::text,v_err3)||' n='||v_n); END IF;

  -- T6: bandeja ordenada por salida con estado documentario; terceros sin acceso
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id, scheduled_departure, docs_required)
  VALUES ('ZZ-C9-D4', 'EXTERNO', 'PROGRAMADO', v_site, now() - interval '1 hour', true);
  PERFORM pg_temp.as_user(v_doc);
  q := public.get_documentary_queue(false);
  PERFORM pg_temp.as_user(v_nobody);
  v_err := NULL;
  BEGIN PERFORM public.get_documentary_queue(false); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.as_user(NULL);
  SELECT jsonb_agg(e->>'dispatch_number' ORDER BY o) FILTER (WHERE e->>'dispatch_number' LIKE 'ZZ-C9-%') INTO r
  FROM jsonb_array_elements(q) WITH ORDINALITY AS x(e, o);
  IF r = '["ZZ-C9-D4"]'::jsonb AND v_err LIKE 'Sin permiso%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 bandeja: ' || COALESCE(r::text, '∅') || ' | ' || COALESCE(v_err, '∅')); END IF;

  -- T7: programar usa la reserva de la solicitud aprobada y marca el despacho como sujeto a documentos
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, service_cost, requester_name, department, request_type, cargo_description, pickup_address, pickup_district, delivery_address, delivery_district, required_date) VALUES
    ('ZZ-C9-R4', 'PENDIENTE DE APROBACIÓN', v_site, v_ct, 900, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra 4', 'Ate', current_date)
  RETURNING id INTO r4;
  UPDATE public.transport_requests SET status = 'APROBADA', approved_at = now() WHERE id = r4;  -- reserva 900
  UPDATE public.dispatches SET driver_id = NULL WHERE id = d1;  -- libera al conductor (índice de despacho activo)
  PERFORM pg_temp.as_user(v_desp);
  v_err := NULL;
  BEGIN
    d3 := public.schedule_dispatch(v_driver, 'ZZC9C', now() + interval '2 days', 10, 950, v_ct, 'GR',
      jsonb_build_array(jsonb_build_object('id', r4)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; d3 := NULL;
  END;
  PERFORM pg_temp.as_user(NULL);
  IF v_err IS NULL AND (SELECT docs_required FROM public.dispatches WHERE id = d3)
     AND (SELECT reserved_pen = 950 FROM public.contract_budgets WHERE contract_id = v_ct)
     AND (SELECT status = 'ASIGNADA' AND reserved_pen = 0 FROM public.transport_requests WHERE id = r4)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 programar: ' || COALESCE(v_err, '∅') || ' ' ||
       (SELECT reserved_pen || '/' || consumed_pen FROM public.contract_budgets WHERE contract_id = v_ct)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C9 PASS (%/7)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C9 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
