-- C220: un hallazgo MAYOR/CRITICO sin cerrar bloquea la salida del despacho vinculado por todos los caminos
-- (Torre de Control, app del conductor, hitos del tercero, cualquier otro UPDATE de estado: checklist / cola offline).
-- Pasa con un Menor, con el hallazgo cerrado o con excepción; la excepción no aplica a seguridad; otra ruta de la
-- misma OT no se bloquea. Respeta dispatch_one_active_driver/vehicle y drivers_document_number_key. Siempre se revierte.
BEGIN;
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
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('request.jwt.claims', CASE WHEN p_user IS NULL THEN '' ELSE json_build_object('sub', p_user, 'role', 'authenticated')::text END, true);
END $$;
-- true si la sentencia fue rechazada por el bloqueo de hallazgos y el despacho conserva su estado.
CREATE FUNCTION pg_temp.blocked(p_sql text, p_dispatch uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_before text := (SELECT status FROM public.dispatches WHERE id = p_dispatch);
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLERRM LIKE 'HALLAZGO_BLOQUEA_SALIDA: %' AND (SELECT status FROM public.dispatches WHERE id = p_dispatch) = v_before;
  END;
  RETURN false;
END $$;
CREATE FUNCTION pg_temp.odo(p_user uuid, p_km numeric) RETURNS jsonb LANGUAGE plpgsql AS $odo$
DECLARE v_path text := p_user::text || '/odometro/' || gen_random_uuid()::text || '.jpg';
BEGIN
 INSERT INTO storage.objects(bucket_id, name) VALUES ('driver_evidence', v_path);
 RETURN jsonb_build_object('odometer', p_km::text, 'odometer_photo', v_path);
END $odo$;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; site uuid; carrier uuid; client uuid; ct uuid; safe uuid; safety uuid;
 d1 uuid; d2 uuid; d3 uuid; d4 uuid; f1 uuid; f3 uuid; f_safety uuid; unit jsonb; data jsonb; r jsonb; v_err text;
 plate text := 'ZZ220' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 4));
 finding_cols jsonb;
BEGIN
 IF to_regclass('public.audit_finding_release_exceptions') IS NULL OR to_regprocedure('public.audit_finding_grant_exception(uuid,uuid,text)') IS NULL THEN
   RAISE EXCEPTION 'CAJA C220 FAIL: falta la migración de bloqueo de salida'; END IF;
 IF has_table_privilege('authenticated', 'public.audit_finding_release_exceptions', 'INSERT')
   OR has_table_privilege('authenticated', 'public.audit_finding_release_exceptions', 'UPDATE')
   OR has_function_privilege('anon', 'public.audit_finding_grant_exception(uuid,uuid,text)', 'EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C220 FAIL: excepciones con escritura directa o RPC expuesto a anon'; END IF;

 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
   PERFORM pg_temp.as_user(admin_id); EXIT WHEN public.is_tms_admin(); admin_id := NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT id FROM auth.users) AND id <> admin_id
   AND id NOT IN (SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 SELECT id INTO client FROM public.clients ORDER BY id LIMIT 1;
 SELECT id INTO safe FROM public.audit_finding_categories WHERE NOT is_safety ORDER BY sort LIMIT 1;
 SELECT id INTO safety FROM public.audit_finding_categories WHERE is_safety ORDER BY sort LIMIT 1;
 IF admin_id IS NULL OR actor IS NULL OR site IS NULL OR client IS NULL OR safe IS NULL OR safety IS NULL THEN
   RAISE EXCEPTION 'CAJA C220 FAIL: faltan administrador, perfil libre, sede, cliente o categorías'; END IF;

 -- Conductor con FR-DT 007 del día (start_dispatch_route lo exige antes de cambiar el estado)
 UPDATE public.profiles SET is_active = true, role_id = NULL WHERE id = actor;
 INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
 INSERT INTO public.drivers(carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
 VALUES (carrier, actor, 'Conductor', 'C220', 'ZZ-C220-DNI', 'ZZ-C220-LIC', true) RETURNING id INTO driver;
 INSERT INTO public.vehicles(plate, carrier_id, site_id, type, status, current_odometer, soat_expiration, technical_review_expiration)
 VALUES (plate, carrier, site, 'CAMION', 'DISPONIBLE', 1000, current_date + 365, current_date + 365);
 PERFORM pg_temp.as_user(actor);
 unit := public.select_driver_preuse_unit(plate);
 SELECT jsonb_build_object('format_code', 'FR-DT 007', 'format_version', '01', 'license', 'ZZ-C220-LIC',
   'soat_expiration', current_date + 365, 'technical_review_expiration', current_date + 365, 'vehicle_operational', true,
   'observation', 'Prueba C220', 'inspector_name', 'Conductor C220', 'signature', '[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
   'answers', jsonb_agg(jsonb_build_object('code', i.code, 'response', 'B', 'comment', ''))) INTO data FROM public.checklist_items i
   JOIN public.checklist_templates t ON t.id = i.template_id WHERE t.code = 'FR_DT007';
 r := public.submit_driver_preuse(gen_random_uuid(), (unit ->> 'revision')::uuid, now(), data || pg_temp.odo(actor, 1500));
 IF r ->> 'can_operate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C220 FAIL: no se habilitó al conductor: %', r; END IF;
 PERFORM pg_temp.as_user(admin_id);

 -- Una OT con dos rutas propias (d1 con el hallazgo, d2 libre), un tercero (d3) y una ruta con un Menor (d4)
 ct := pg_temp.ins('contracts', jsonb_build_object('code', 'ZZ-C220', 'type', 'CONTRATO', 'status', 'ACTIVO', 'site_id', site, 'client_id', client));
 d1 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C220-1', 'driver_id', driver, 'vehicle_plate', plate, 'status', 'PROGRAMADO',
   'site_id', site, 'scheduled_departure', now(), 'docs_required', false, 'modalidad', 'PROPIA'));
 d2 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C220-2', 'status', 'PROGRAMADO', 'site_id', site, 'scheduled_departure', now(), 'docs_required', false, 'modalidad', 'PROPIA'));
 d3 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C220-3', 'vehicle_plate', 'EXTERNO', 'status', 'PROGRAMADO', 'site_id', site, 'scheduled_departure', now(), 'docs_required', false, 'modalidad', 'TERCERO'));
 d4 := pg_temp.ins('dispatches', jsonb_build_object('dispatch_number', 'ZZ-C220-4', 'status', 'PROGRAMADO', 'site_id', site, 'scheduled_departure', now(), 'docs_required', false, 'modalidad', 'PROPIA'));
 finding_cols := jsonb_build_object('contract_id', ct, 'site_id', site, 'client_id', client, 'ot_code', 'ZZ-C220', 'client_name', 'Cliente C220',
   'destination', 'Destino C220', 'process_area', 'DESPACHO', 'auditor_id', admin_id, 'description', 'Hallazgo de prueba C220', 'status', 'ABIERTO');
 -- audit_findings.number lo asigna el RPC de F1; aquí se da explícito y único dentro de la transacción.
 f1 := pg_temp.ins('audit_findings', finding_cols || jsonb_build_object('number', 'ZZ-C220-' || plate || '-1', 'dispatch_id', d1, 'severity', 'MAYOR'));
 f_safety := pg_temp.ins('audit_findings', finding_cols || jsonb_build_object('number', 'ZZ-C220-' || plate || '-2', 'dispatch_id', d3, 'severity', 'CRITICO', 'status', 'PENDIENTE_VALIDACION'));
 f3 := pg_temp.ins('audit_findings', finding_cols || jsonb_build_object('number', 'ZZ-C220-' || plate || '-3', 'dispatch_id', d4, 'severity', 'MENOR'));
 PERFORM pg_temp.ins('audit_findings', finding_cols || jsonb_build_object('number', 'ZZ-C220-' || plate || '-4', 'dispatch_id', d2, 'severity', 'CRITICO', 'status', 'CERRADO', 'closed_at', now()));
 INSERT INTO public.audit_finding_category_links(finding_id, category_id) VALUES (f1, safe), (f_safety, safety), (f3, safe);

 -- 1. Cada camino de salida se rechaza
 IF NOT pg_temp.blocked(format('SELECT public.transition_dispatch_status(%L, ''EN_CURSO'', ''Caja C220'')', d1), d1) THEN v_err := 'Torre de Control (transition_dispatch_status) no se bloqueó';
 ELSIF NOT pg_temp.blocked(format('SELECT public.tercero_salida_core(%L, now(), ''CAJA'')', d3), d3) THEN v_err := 'hito de salida del tercero no se bloqueó';
 ELSIF NOT pg_temp.blocked(format('UPDATE public.dispatches SET status = ''EN_RUTA'' WHERE id = %L', d1), d1) THEN v_err := 'UPDATE directo a EN_RUTA (checklist / offline) no se bloqueó';
 ELSIF NOT pg_temp.blocked(format('UPDATE public.dispatches SET status = ''EN_TRANSITO'' WHERE id = %L', d1), d1) THEN v_err := 'UPDATE directo a EN_TRANSITO no se bloqueó';
 END IF;
 IF v_err IS NULL THEN
   PERFORM pg_temp.as_user(actor);
   IF NOT pg_temp.blocked(format('SELECT public.start_dispatch_route(%L, -12, -77)', d1), d1) THEN v_err := 'app del conductor (start_dispatch_route) no se bloqueó'; END IF;
   PERFORM pg_temp.as_user(admin_id);
 END IF;

 -- 2. Pasa: otra ruta de la misma OT (con un hallazgo cerrado) y una ruta con un Menor; cancelar no se bloquea
 IF v_err IS NULL THEN
   r := public.transition_dispatch_status(d2, 'EN_CURSO', 'Caja C220');
   IF r ->> 'success' IS DISTINCT FROM 'true' THEN v_err := 'otra ruta de la misma OT quedó bloqueada: ' || r::text; END IF;
 END IF;
 IF v_err IS NULL THEN
   r := public.transition_dispatch_status(d4, 'EN_CURSO', 'Caja C220');
   IF r ->> 'success' IS DISTINCT FROM 'true' THEN v_err := 'un hallazgo Menor bloqueó la salida: ' || r::text; END IF;
 END IF;

 -- 3. Excepción: rechazada en seguridad; concedida en Mayor libera la salida del conductor
 IF v_err IS NULL THEN
   PERFORM pg_temp.as_user(admin_id);
   r := public.audit_finding_release_check(d1);
   IF r ->> 'blocked' IS DISTINCT FROM 'true' THEN v_err := 'release_check no reporta el bloqueo: ' || r::text; END IF;
   r := public.audit_finding_grant_exception(f_safety, d3, 'Excepción de prueba sobre categoría de seguridad C220');
   IF v_err IS NULL AND (r ->> 'success' = 'true' OR r ->> 'error' NOT ILIKE '%seguridad%') THEN v_err := 'aceptó excepción en seguridad: ' || r::text; END IF;
   r := public.audit_finding_grant_exception(f1, d1, 'corto');
   IF v_err IS NULL AND r ->> 'success' = 'true' THEN v_err := 'aceptó motivo corto'; END IF;
   r := public.audit_finding_grant_exception(f1, d1, 'Material repuesto, sale con control del supervisor C220');
   IF v_err IS NULL AND r ->> 'success' IS DISTINCT FROM 'true' THEN v_err := 'no registró la excepción: ' || r::text; END IF;
   IF v_err IS NULL AND (NOT EXISTS (SELECT 1 FROM public.audit_finding_events WHERE finding_id = f1 AND event_type = 'EXCEPCION_SALIDA')
       OR NOT EXISTS (SELECT 1 FROM public.dispatch_events WHERE dispatch_id = d1 AND event_type = 'EXCEPCION_HALLAZGO')) THEN
     v_err := 'la excepción no quedó en el historial'; END IF;
 END IF;
 IF v_err IS NULL THEN
   PERFORM pg_temp.as_user(actor);
   BEGIN PERFORM public.start_dispatch_route(d1, -12, -77);
   EXCEPTION WHEN OTHERS THEN v_err := 'con excepción el conductor no pudo salir: ' || SQLERRM; END;
   IF v_err IS NULL AND (SELECT status FROM public.dispatches WHERE id = d1) <> 'EN RUTA' THEN v_err := 'la ruta exceptuada no quedó EN RUTA'; END IF;
 END IF;
 -- 4. Cerrar el hallazgo libera la salida (tercero)
 IF v_err IS NULL THEN
   PERFORM pg_temp.as_user(admin_id);
   UPDATE public.audit_findings SET status = 'CERRADO' WHERE id = f_safety;
   r := public.tercero_salida_core(d3, now(), 'CAJA');
   IF r ->> 'success' IS DISTINCT FROM 'true' THEN v_err := 'hallazgo cerrado sigue bloqueando: ' || r::text; END IF;
 END IF;

 IF v_err IS NOT NULL THEN RAISE EXCEPTION 'CAJA C220 FAIL: %', v_err; END IF;
 RAISE EXCEPTION 'CAJA C220 PASS: salida bloqueada en Torre, app, tercero y UPDATE directo; libera Menor, cerrado, otra ruta y excepción (no en seguridad)';
END $test$;
ROLLBACK;
