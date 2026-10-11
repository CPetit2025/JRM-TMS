BEGIN;
-- Isolate this legacy scenario from the separately tested mandatory anticipation policy.
-- The change is transaction-local and is rolled back with every fixture.
DO $legacy_policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
 END IF;
END $legacy_policy$;
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

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE actor uuid; site uuid; doc_role uuid; ro_role uuid; route uuid; req uuid; other_req uuid; result jsonb;
 bad boolean; count_before int; plate text:='ZZ82'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C85 FAIL: faltan perfil o sede'; END IF;
 SELECT id INTO doc_role FROM public.roles WHERE name='Asistente Documentario' LIMIT 1;
 IF doc_role IS NULL THEN INSERT INTO public.roles(id,name,permissions) VALUES(gen_random_uuid(),'Asistente Documentario','["documentario:write"]') RETURNING id INTO doc_role; END IF;
 UPDATE public.roles SET permissions='["documentario:write"]' WHERE id=doc_role;
 INSERT INTO public.roles(id,name,permissions) VALUES(gen_random_uuid(),'ZZ C85 consulta','["documentario:read"]') RETURNING id INTO ro_role;
 UPDATE public.profiles SET role_id=doc_role,is_active=true WHERE id=actor;
 DELETE FROM public.user_site_access WHERE user_id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 route:=pg_temp.ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C85','vehicle_plate',plate,'status','PROGRAMADO','site_id',site,'scheduled_departure',now(),'docs_required',false,'created_by',actor));
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C85-A','status','ASIGNADA','site_id',site,'requester_name','Prueba','department','Logística','request_type','DESPACHO','cargo_description','Referencias','pickup_address','Planta','delivery_address','Obra','required_date',current_date));
 other_req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C85-B','status','ASIGNADA','site_id',site,'requester_name','Prueba','department','Logística','request_type','DESPACHO','cargo_description','Otro servicio','pickup_address','Planta','delivery_address','Obra','required_date',current_date));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order) VALUES(route,req,'PROGRAMADO','GR',1);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 result:=public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY[' t001-6591 ','E001-00006592']);
 IF result->>'success' IS DISTINCT FROM 'true' OR (result->>'linked')::int IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'CAJA C85 FAIL: no registra varias guías sin archivo'; END IF;
 result:=public.link_dispatch_document_numbers(route,req,'NOTA_DESPACHO',ARRAY['ND001-0009']);
 IF result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'CAJA C85 FAIL: no registra nota'; END IF;
 result:=public.get_dispatch_document_references(route);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.get_documentary_queue_period(false,NULL,NULL)) q WHERE q->>'id'=route::text AND jsonb_array_length(q->'number_references')=3) THEN RAISE EXCEPTION 'CAJA C85 FAIL: la tabla no muestra números vinculados'; END IF;
 IF jsonb_array_length(result)<>3 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result) r WHERE r->>'document_number'='E001-00006592' AND r->>'created_by'=actor::text) THEN RAISE EXCEPTION 'CAJA C85 FAIL: consulta pierde nomenclatura o autoría'; END IF;
 IF EXISTS(SELECT 1 FROM public.dispatch_documents WHERE dispatch_id=route) OR (SELECT status FROM public.dispatches WHERE id=route) IS DISTINCT FROM 'PROGRAMADO'
  OR EXISTS(SELECT 1 FROM public.delivery_conformities WHERE dispatch_id=route AND (state<>'PENDIENTE' OR current_submission_id IS NOT NULL)) THEN RAISE EXCEPTION 'CAJA C85 FAIL: número falsea archivo, conformidad o salida'; END IF;
 -- Pickup note identifiers satisfy only the note requirement, never the signed Packing List.
 UPDATE public.dispatches SET vehicle_plate='EXTERNO',modalidad='PROPIA' WHERE id=route;
 IF public.dispatch_documents_missing(route) LIKE '%Nota de Despacho%' OR public.dispatch_documents_missing(route) NOT LIKE '%Packing List%' THEN
  RAISE EXCEPTION 'CAJA C85 FAIL: la nota exige archivo o falsea Packing List firmado'; END IF;
 -- Every rejected batch must leave all original links untouched.
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001-6591','T001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad OR EXISTS(SELECT 1 FROM public.dispatch_document_references WHERE dispatch_id=route AND document_number='T001-7000') THEN RAISE EXCEPTION 'CAJA C85 FAIL: duplicado no atómico'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001-7000','t001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: repetición en el lote'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001 7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: nomenclatura inválida'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,other_req,'GUIA_REMISION',ARRAY['T001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: enlaza solicitud ajena'; END IF;
 result:=public.register_dispatch_document(route,req,'NOTA_DESPACHO',NULL,'ND001-0010',route||'/x.pdf','x.pdf','application/pdf',1000,NULL);
 IF result->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C85 FAIL: el asistente aún carga archivos'; END IF;
 result:=public.confirm_dispatch_documents(route);
 IF result->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C85 FAIL: el asistente aún confirma salida'; END IF;
 -- Read-only account may consult but cannot add; no-site and inactive accounts cannot consult.
 UPDATE public.profiles SET role_id=ro_role WHERE id=actor;
 IF jsonb_array_length(public.get_dispatch_document_references(route))<>3 THEN RAISE EXCEPTION 'CAJA C85 FAIL: consulta autorizada'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: lectura puede escribir'; END IF;
 UPDATE public.profiles SET role_id=doc_role WHERE id=actor;
 DELETE FROM public.user_site_access WHERE user_id=actor;
 bad:=false; BEGIN PERFORM public.get_dispatch_document_references(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: lectura sin sede'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: escritura sin sede'; END IF;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site);
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 bad:=false; BEGIN PERFORM public.get_dispatch_document_references(route); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: cuenta inactiva consulta'; END IF;
 bad:=false; BEGIN PERFORM public.link_dispatch_document_numbers(route,req,'GUIA_REMISION',ARRAY['T001-7000']); EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C85 FAIL: cuenta inactiva escribe'; END IF;
 IF has_table_privilege('authenticated','public.dispatch_document_references','INSERT') OR has_table_privilege('authenticated','public.dispatch_document_references','SELECT')
  OR has_function_privilege('anon','public.link_dispatch_document_numbers(uuid,uuid,text,text[])','EXECUTE') OR has_function_privilege('anon','public.get_dispatch_document_references(uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C85 FAIL: acceso directo o público expuesto'; END IF;
 IF (SELECT count(*) FROM public.dispatch_document_references WHERE dispatch_id=route)<>3 THEN RAISE EXCEPTION 'CAJA C85 FAIL: lote rechazado modifica enlaces'; END IF;
 RAISE EXCEPTION 'CAJA C85 PASS: varias guías y nota sin archivos, nomenclatura, duplicados atómicos, responsabilidad separada y permisos/sede/cuenta';
END $test$;
ROLLBACK;
