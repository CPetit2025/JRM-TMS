-- C70 Portal público: el registro trae el distrito de la solicitud y la guía subida por el conductor
-- (conformidad RECIBIDA o VALIDADA) se puede ver; una observada o rechazada no.
BEGIN;
DO $test$
DECLARE actor uuid; site uuid; ca uuid:=gen_random_uuid(); r uuid; payload jsonb; result jsonb; tag text:=substr(replace(gen_random_uuid()::text,'-',''),1,6);
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles ro ON ro.id=p.role_id WHERE ro.name='Administrador' AND p.is_active LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C70 FAIL: fixture administrador/sede ausente'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 INSERT INTO public.contracts(id,code,site_id) VALUES(ca,'ZZ-C70-'||tag,site);
 INSERT INTO public.transport_requests(request_number,status,site_id,requester_name,department,request_type,cargo_description,pickup_address,pickup_district,delivery_address,delivery_district,required_date,contract_id)
 VALUES('ZZ-C70','PENDIENTE',site,'Prueba C70','Logística','RECOJO','Carga','Origen','CHILCA','Destino','LURIN',current_date,ca) RETURNING id INTO r;
 payload:=public.generate_tracking_portal_link(jsonb_build_object('site_id',site,'contract_ids',jsonb_build_array(ca),'label','C70'));
 result:=public.get_public_tracking_portal_info((payload->>'token')::uuid,payload->>'pin',current_date-1,current_date+1);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'requests') x WHERE x->>'id'=r::text AND x->>'delivery_district'='LURIN' AND x->>'pickup_district'='CHILCA') THEN
  RAISE EXCEPTION 'CAJA C70 FAIL (T1): el registro no trae el distrito';
 END IF;
 IF position('IN (''RECIBIDA'',''VALIDADA'')' IN pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure))=0
 OR position('IN (''RECIBIDA'',''VALIDADA'')' IN pg_get_functiondef('public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C70 FAIL (T2): la guía recibida del conductor no se habilita en el portal';
 END IF;
 RAISE EXCEPTION 'CAJA C70 PASS (2/2) portal: distrito en el registro y guía del conductor visible al recibirse';
END $test$;
ROLLBACK;
