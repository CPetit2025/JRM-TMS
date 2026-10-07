BEGIN;
-- Isolate this legacy scenario from the separately tested mandatory anticipation policy.
-- The change is transaction-local and is rolled back with every fixture.
DO $legacy_policy$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  EXECUTE 'UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,''{enabled}'',''false''::jsonb)';
 END IF;
END $legacy_policy$;
CREATE FUNCTION pg_temp.c54_ins(p_table text,p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id',p_table,
   string_agg(quote_ident(k.key),','),string_agg(quote_nullable(k.value #>> '{}'),',')) FROM jsonb_each(p_cols) k
   WHERE EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=p_table AND c.column_name=k.key)) INTO v_id;
 RETURN v_id;
END $$;
-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE actor uuid; site uuid; foreign_site uuid; v_role_id uuid; portfolio_role uuid; ct uuid; ct2 uuid; d uuid; foreign_d uuid; cancelled uuid;
 req uuid; pickup uuid; transfer uuid; foreign_req uuid; client_pickup uuid; submission uuid; upload uuid;
 q jsonb; leg jsonb; fail boolean; guide text:='T954-'||(100000000+floor(random()*899999999))::bigint::text;
 second_guide text:='T955-'||(100000000+floor(random()*899999999))::bigint::text;
BEGIN
 IF has_function_privilege('anon','public.get_transport_request_execution(uuid)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C54 FAIL: consulta anónima'; END IF;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 SELECT id INTO foreign_site FROM public.sites WHERE id<>site LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C54 FAIL: faltan perfil o sede'; END IF;
 IF foreign_site IS NULL THEN foreign_site:=pg_temp.c54_ins('sites',jsonb_build_object('code','ZZ-C54','name','Prueba C54')); END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C54 solicitudes','["solicitudes:read"]') RETURNING id INTO v_role_id;
 UPDATE public.profiles SET role_id=v_role_id,is_active=true WHERE id=actor;
 DELETE FROM public.user_site_access WHERE user_id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site);
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 ct:=pg_temp.c54_ins('contracts',jsonb_build_object('code','ZZ-C54-OT1','type','CONTRATO','status','ACTIVO','site_id',site));
 ct2:=pg_temp.c54_ins('contracts',jsonb_build_object('code','ZZ-C54-OT2','type','CONTRATO','status','ACTIVO','site_id',site));
 d:=pg_temp.c54_ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C54-MIXTA','vehicle_plate','ZZ54'||substr(gen_random_uuid()::text,1,8),'status','LIQUIDADO','site_id',site,'contract_id',ct,'scheduled_departure',now(),'actual_distance_km',999));
 req:=pg_temp.c54_ins('transport_requests',jsonb_build_object('request_number','ZZ-C54-ENTREGA','status','ASIGNADA','site_id',site,'contract_id',ct,'requester_name','ZZ','department','Logística','request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','cargo_description','Acero','estimated_weight',500,'pickup_address','Planta','delivery_address','Obra','required_date',current_date));
 pickup:=pg_temp.c54_ins('transport_requests',jsonb_build_object('request_number','ZZ-C54-RECOJO','status','ASIGNADA','site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','request_type','RECOJO','attention_mode','TRANSPORTE_JRM','cargo_description','Recojo','pickup_address','Obra','delivery_address','Planta','required_date',current_date));
 transfer:=pg_temp.c54_ins('transport_requests',jsonb_build_object('request_number','ZZ-C54-TRASLADO','status','ASIGNADA','site_id',site,'contract_id',ct2,'requester_name','ZZ','department','Logística','request_type','TRASLADO','attention_mode','TRANSPORTE_JRM','cargo_description','Traslado','pickup_address','Obra A','delivery_address','Obra B','required_date',current_date));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,leg_actual_km,leg_gps_complete,document_number)
 VALUES(d,req,'ENTREGADO',1,11.125,true,guide),(d,pickup,'ENTREGADO',2,7.5,false,NULL),(d,transfer,'ENTREGADO',3,4.25,true,second_guide);
 foreign_d:=pg_temp.c54_ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C54-OTRA-RUTA','vehicle_plate','ZZ54'||substr(gen_random_uuid()::text,1,8),'status','LIQUIDADO','site_id',foreign_site,'scheduled_departure',now()));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,leg_actual_km) VALUES(foreign_d,req,'ENTREGADO',888);
 INSERT INTO public.delivery_conformities(dispatch_id,request_id,state) VALUES(d,req,'VALIDADA'),(d,transfer,'RECIBIDA');
 INSERT INTO public.delivery_submissions(operation_id,dispatch_id,request_id,photos,guide_number,source,captured_at)
 VALUES(gen_random_uuid(),d,req,ARRAY['ZZ54/no-archivo.jpg'],guide,'HISTORICO',now()) RETURNING id INTO submission;
 UPDATE public.delivery_conformities SET current_submission_id=submission WHERE dispatch_id=d AND request_id=req;
 INSERT INTO public.delivery_submissions(operation_id,dispatch_id,request_id,photos,guide_number,source,captured_at)
 VALUES(gen_random_uuid(),d,transfer,ARRAY['ZZ54/no-archivo2.jpg'],second_guide,'HISTORICO',now()) RETURNING id INTO submission;
 UPDATE public.delivery_conformities SET current_submission_id=submission WHERE dispatch_id=d AND request_id=transfer;
 INSERT INTO public.apt_uploads(file_name,status) VALUES('ZZ-C54-sintético.xlsx','APLICADA') RETURNING id INTO upload;
 INSERT INTO public.apt_movements(upload_id,kind,row_no,raw,active,valid,documento,peso_kg)
 VALUES(upload,'SALIDA',1,'{}',true,true,guide,120),(upload,'SALIDA',2,'{}',true,true,guide,80),
 (upload,'SALIDA',3,'{}',false,true,guide,900),(upload,'SALIDA',4,'{}',true,false,guide,900),
 (upload,'SALIDA',5,'{}',true,true,second_guide,300),(upload,'SALIDA',6,'{}',true,true,second_guide,0);
 q:=public.get_transport_request_execution(req);leg:=q->'legs'->0;
 IF q->>'ot_code'<>'ZZ-C54-OT1' OR (q->>'requested_weight_kg')::numeric<>500 OR jsonb_array_length(q->'legs')<>1 OR
   (leg->>'actual_km')::numeric<>11.125 OR (leg->>'actual_weight_kg')::numeric<>200 OR leg->>'weight_status'<>'APT_VALIDADO' THEN RAISE EXCEPTION 'CAJA C54 FAIL: entrega no enlaza OT, tramo o peso validado: %',q; END IF;
 q:=public.get_transport_request_execution(pickup);leg:=q->'legs'->0;
 IF q->>'ot_code'<>'ZZ-C54-OT2' OR q->>'request_type'<>'RECOJO' OR (leg->>'actual_km')::numeric<>7.5 OR
   leg->>'gps_complete'<>'false' OR leg->>'actual_weight_kg' IS NOT NULL OR leg->>'weight_status'<>'RECOJO_SIN_PESO' THEN RAISE EXCEPTION 'CAJA C54 FAIL: recojo o GPS parcial'; END IF;
 q:=public.get_transport_request_execution(transfer);leg:=q->'legs'->0;
 IF q->>'ot_code'<>'ZZ-C54-OT2' OR (leg->>'actual_km')::numeric<>4.25 OR leg->>'actual_weight_kg' IS NOT NULL THEN RAISE EXCEPTION 'CAJA C54 FAIL: traslado mezcla OT o acepta guía sin validar'; END IF;
 UPDATE public.delivery_conformities SET state='VALIDADA' WHERE dispatch_id=d AND request_id=transfer;
 q:=public.get_transport_request_execution(transfer);
 IF q->'legs'->0->>'actual_weight_kg' IS NOT NULL OR q->'legs'->0->>'weight_status'<>'SIN_PESO_APT' THEN RAISE EXCEPTION 'CAJA C54 FAIL: acepta peso parcial APT'; END IF;
 UPDATE public.apt_movements SET peso_kg=100 WHERE upload_id=upload AND row_no=6;
 q:=public.get_transport_request_execution(transfer);
 IF (q->'legs'->0->>'actual_weight_kg')::numeric<>400 THEN RAISE EXCEPTION 'CAJA C54 FAIL: traslado no obtiene peso real'; END IF;
 UPDATE public.dispatch_requests SET document_number=guide WHERE dispatch_id=d AND transport_request_id=pickup;
 q:=public.get_transport_request_execution(req);
 IF q->'legs'->0->>'actual_weight_kg' IS NOT NULL OR q->'legs'->0->>'weight_status'<>'GUIA_COMPARTIDA' THEN RAISE EXCEPTION 'CAJA C54 FAIL: duplica peso de guía compartida'; END IF;
 UPDATE public.dispatch_requests SET document_number=NULL WHERE dispatch_id=d AND transport_request_id=pickup;
 UPDATE public.delivery_submissions SET guide_number=split_part(guide,'-',2) WHERE dispatch_id=d AND request_id=req;
 q:=public.get_transport_request_execution(req);
 IF q->'legs'->0->>'weight_status'<>'GUIA_INCOMPLETA' OR q->'legs'->0->>'actual_weight_kg' IS NOT NULL THEN RAISE EXCEPTION 'CAJA C54 FAIL: número sin serie mezcla guías'; END IF;
 UPDATE public.delivery_submissions SET guide_number=guide WHERE dispatch_id=d AND request_id=req;
 cancelled:=pg_temp.c54_ins('dispatches',jsonb_build_object('dispatch_number','ZZ-C54-CANCEL','vehicle_plate','ZZ54'||substr(gen_random_uuid()::text,1,8),'status','CANCELADO','site_id',site,'scheduled_departure',now()));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,leg_actual_km,leg_gps_complete) VALUES(cancelled,req,'CANCELADO',300,true);
 q:=public.get_transport_request_execution(req);
 SELECT value INTO leg FROM jsonb_array_elements(q->'legs') WHERE value->>'dispatch_id'=cancelled::text;
 IF leg->>'actual_km' IS NOT NULL OR leg->>'actual_weight_kg' IS NOT NULL OR leg->>'weight_status'<>'CANCELADO' THEN RAISE EXCEPTION 'CAJA C54 FAIL: mide viaje cancelado'; END IF;
 client_pickup:=pg_temp.c54_ins('transport_requests',jsonb_build_object('request_number','ZZ-C54-CLIENTE','status','ASIGNADA','site_id',site,'requester_name','ZZ','department','Logística','request_type','DESPACHO','attention_mode','RECOJO_CLIENTE','cargo_description','Recojo cliente','pickup_address','Planta','delivery_address','Obra','required_date',current_date));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_type,leg_actual_km) VALUES(d,client_pickup,'ENTREGADO',4,'NOTA_SALIDA',20);
 q:=public.get_transport_request_execution(client_pickup);
 IF q->>'contract_id' IS NOT NULL OR q->'legs'->0->>'actual_km' IS NOT NULL OR q->'legs'->0->>'weight_status'<>'NO_APLICA' THEN RAISE EXCEPTION 'CAJA C54 FAIL: imputa transporte JRM a recojo cliente'; END IF;
 foreign_req:=pg_temp.c54_ins('transport_requests',jsonb_build_object('request_number','ZZ-C54-OTRA-SEDE','status','PENDIENTE','site_id',foreign_site,'requester_name','ZZ','department','Logística','request_type','DESPACHO','cargo_description','ZZ','pickup_address','Planta','delivery_address','Obra','required_date',current_date));
 fail:=false;BEGIN PERFORM public.get_transport_request_execution(foreign_req);EXCEPTION WHEN raise_exception THEN fail:=true;END;
 IF NOT fail THEN RAISE EXCEPTION 'CAJA C54 FAIL: accede a otra sede'; END IF;
 SELECT id INTO portfolio_role FROM public.roles WHERE name='Administrador de Contratos' LIMIT 1;
 IF portfolio_role IS NULL THEN INSERT INTO public.roles(name,permissions) VALUES('Administrador de Contratos','["solicitudes:read"]') RETURNING id INTO portfolio_role;
 ELSE UPDATE public.roles SET permissions='["solicitudes:read"]' WHERE id=portfolio_role; END IF;
 UPDATE public.profiles SET role_id=portfolio_role WHERE id=actor;
 DELETE FROM public.contract_user_assignments WHERE user_id=actor;
 fail:=false;BEGIN PERFORM public.get_transport_request_execution(req);EXCEPTION WHEN raise_exception THEN fail:=true;END;
 IF NOT fail THEN RAISE EXCEPTION 'CAJA C54 FAIL: accede a OT fuera de cartera'; END IF;
 INSERT INTO public.contract_user_assignments(contract_id,user_id,role,active) VALUES(ct,actor,'CONSULTOR',true);
 q:=public.get_transport_request_execution(req);
 IF q->>'ot_code'<>'ZZ-C54-OT1' THEN RAISE EXCEPTION 'CAJA C54 FAIL: cartera asignada no consulta'; END IF;
 fail:=false;BEGIN PERFORM public.get_transport_request_execution(transfer);EXCEPTION WHEN raise_exception THEN fail:=true;END;
 IF NOT fail THEN RAISE EXCEPTION 'CAJA C54 FAIL: ruta compartida expone servicio de otra OT'; END IF;
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 fail:=false;BEGIN PERFORM public.get_transport_request_execution(req);EXCEPTION WHEN raise_exception THEN fail:=true;END;
 IF NOT fail THEN RAISE EXCEPTION 'CAJA C54 FAIL: perfil inactivo consulta'; END IF;
 RAISE EXCEPTION 'CAJA C54 PASS: ruta mixta multi-OT, km por tramo sin repartir ruta, GPS parcial, peso APT validado sin duplicar guías, recojos sin peso ficticio, cancelaciones, sede y cartera';
END $test$;
ROLLBACK;
