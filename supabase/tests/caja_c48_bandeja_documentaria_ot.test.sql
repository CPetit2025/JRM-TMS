BEGIN;
-- Isolate this legacy scenario from the separately tested mandatory anticipation policy.
-- The change is transaction-local and is rolled back with every fixture.
DO $legacy_policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
 END IF;
END $legacy_policy$;
DO $test$
DECLARE v_user uuid; queue jsonb; q jsonb; s jsonb; expected text; matched integer:=0;
 v_site uuid; v_dispatch uuid; v_req uuid; v_no_ot uuid; v_contract uuid; v_code text;
BEGIN
 IF has_function_privilege('anon','public.get_documentary_queue(boolean)','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C48 FAIL: bandeja expuesta a anónimos';
 END IF;
 FOR v_user IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',v_user::text,true);
   EXIT WHEN public.is_tms_admin(); v_user:=NULL;
 END LOOP;
 IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C48 FAIL: falta administrador para comprobar bandeja'; END IF;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_user,'role','authenticated')::text,true);
 -- Fixtures independientes de la cantidad de servicios activos; todo se revierte al terminar.
 SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 SELECT id, NULLIF(trim(code::text),'') INTO v_contract, v_code FROM public.contracts WHERE NULLIF(trim(code::text),'') IS NOT NULL LIMIT 1;
 IF v_site IS NULL OR v_contract IS NULL THEN RAISE EXCEPTION 'CAJA C48 FAIL: falta sede u OT para comprobar vínculo'; END IF;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,status,site_id,scheduled_departure,docs_required)
 VALUES('ZZ-C48-OT','ZZC48','PROGRAMADO',v_site,now(),true) RETURNING id INTO v_dispatch;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,
   pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C48-OT-R','ASIGNADA',v_site,'Prueba C48','Logística','DESPACHO','Packing','Planta','CHILCA','Obra','LURIN',current_date,v_contract) RETURNING id INTO v_req;
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,
   pickup_address,pickup_district,delivery_address,delivery_district,required_date)
 VALUES('ZZ-C48-SIN-OT','ASIGNADA',v_site,'Prueba C48','Logística','DESPACHO','Packing','Planta','CHILCA','Obra','LURIN',current_date) RETURNING id INTO v_no_ot;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order)
 VALUES(v_dispatch,v_req,'PROGRAMADO','GR',1),(v_dispatch,v_no_ot,'PROGRAMADO','GR',2);
 queue:=public.get_documentary_queue(true);
 IF jsonb_typeof(queue) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'CAJA C48 FAIL: respuesta no es una bandeja'; END IF;
 SELECT value INTO q FROM jsonb_array_elements(queue) WHERE value->>'id'=v_dispatch::text;
 IF q IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'stops') x WHERE x->>'request_id'=v_req::text AND x->>'ot_code'=v_code)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'stops') x WHERE x->>'request_id'=v_no_ot::text AND x ? 'ot_code' AND x->>'ot_code' IS NULL) THEN
   RAISE EXCEPTION 'CAJA C48 FAIL: despacho consolidado omite OT o solicitud sin OT';
 END IF;
 FOR q IN SELECT value FROM jsonb_array_elements(queue) LOOP
   FOR s IN SELECT value FROM jsonb_array_elements(q->'stops') LOOP
     SELECT NULLIF(trim(c.code::text),'') INTO expected FROM public.transport_requests t
       LEFT JOIN public.contracts c ON c.id=t.contract_id WHERE t.id=(s->>'request_id')::uuid;
     IF NOT (s ? 'ot_code') OR s->>'ot_code' IS DISTINCT FROM expected THEN
       RAISE EXCEPTION 'CAJA C48 FAIL: OT de solicitud ausente o pertenece a otro proceso';
     END IF;
     matched:=matched+1;
   END LOOP;
 END LOOP;
 IF matched=0 THEN RAISE EXCEPTION 'CAJA C48 FAIL: sin solicitudes para comprobar vínculo OT'; END IF;
 RAISE EXCEPTION 'CAJA C48 PASS: consulta real privada, OT por solicitud y solicitudes sin OT conservadas';
END $test$;
ROLLBACK;
