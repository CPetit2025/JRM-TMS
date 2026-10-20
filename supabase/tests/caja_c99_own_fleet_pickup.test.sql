-- Own pickups remain documented with no invented freight/distance; third-party quotes require explicit approval.
BEGIN;
DO $settings$ BEGIN
 -- This case tests explicit supervisor authorization; do not depend on the production auto-approval preference.
 IF to_regclass('public.transport_request_approval_settings') IS NOT NULL THEN
  UPDATE public.transport_request_approval_settings SET auto_approve=false WHERE id;
 END IF;
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
 END IF;
END $settings$;
DO $test$
DECLARE actor uuid; site uuid; supplier uuid; req uuid; base_req uuid; quote_req uuid; route uuid;
 payload jsonb; saved jsonb; context jsonb; result jsonb; denied boolean; operation uuid:=gen_random_uuid();
 expected timestamptz:=((current_date+7)::timestamp AT TIME ZONE 'America/Lima')+interval '12 hours';
 services bigint;
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C99 FAIL: falta administrador activo'; END IF;
 SELECT id INTO site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY id LIMIT 1;
 INSERT INTO public.suppliers(tax_id,business_name) VALUES((floor(random()*90000000000)+10000000000)::bigint::text,'ZZ C99') RETURNING id INTO supplier;
 payload:=jsonb_build_object('department','Logística','request_type','RECOJO','attention_mode','TRANSPORTE_JRM',
  'site_id',site,'required_date',current_date+7,'cargo_description','ZZ C99','pickup_address','Origen prueba',
  'pickup_district','CHILCA','delivery_address','Destino prueba','delivery_district','CALLAO','service_cost',999,
  'reference_type','RQ','reference_number','ZZ-C99','supplier_id',supplier);
 saved:=public.save_transport_request_full(NULL,payload,'[]','[]'); req:=(saved->>'id')::uuid;
 IF req IS NULL OR (saved->>'service_cost')::numeric<>0 OR (saved->'quote'->>'freight_total')::numeric<>0 THEN
  RAISE EXCEPTION 'CAJA C99 FAIL: recojo genera flete automático'; END IF;
 PERFORM public.approve_reference_transport_request(req,0,'RQ','ZZ-C99');
 saved:=public.save_transport_request_full(NULL,payload||jsonb_build_object('reference_number','ZZ-C99-BASE'),'[]','[]'); base_req:=(saved->>'id')::uuid;
 PERFORM public.approve_reference_transport_request(base_req,0,'RQ','ZZ-C99-BASE');
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,scheduled_departure,status,freight_cost,estimated_distance_km,site_id,modalidad)
 VALUES('ZZ-C99-'||substr(gen_random_uuid()::text,1,8),'ZZC99-'||substr(gen_random_uuid()::text,1,8),'ZZ C99',expected,'PROGRAMADO',0,10,site,'PROPIA') RETURNING id INTO route;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order) VALUES(route,base_req,'PROGRAMADO','GR',1);
 UPDATE public.transport_requests SET status='ASIGNADA' WHERE id=base_req;
 context:=public.active_route_context(route);
 SELECT count(*) INTO services FROM public.contract_services;
 denied:=false;
 BEGIN PERFORM public.add_active_route_service(route,req,NULL,context->>'revision',gen_random_uuid(),NULL,NULL,2,1,expected,'Prueba de capacidad');
 EXCEPTION WHEN raise_exception THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C99 FAIL: omite capacidad disponible'; END IF;
 denied:=false;
 BEGIN PERFORM public.add_active_route_service(route,req,NULL,context->>'revision',gen_random_uuid(),NULL,NULL,1,10,expected-interval '1 day','Prueba fecha distinta');
 EXCEPTION WHEN raise_exception THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C99 FAIL: permite día distinto'; END IF;
 result:=public.add_active_route_service(route,req,NULL,context->>'revision',operation,NULL,NULL,1,NULL,expected,NULL);
 IF result->>'success'<>'true' OR NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=route AND request_id=req AND amount_pen=0 AND service_id IS NULL)
  OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=route AND transport_request_id=req AND document_type='GR')
  OR NOT EXISTS(SELECT 1 FROM public.delivery_conformities WHERE dispatch_id=route AND request_id=req)
  OR NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=route AND freight_cost=0 AND estimated_distance_km=10)
  OR (SELECT count(*) FROM public.contract_services)<>services THEN RAISE EXCEPTION 'CAJA C99 FAIL: pierde documentación o inventa costo/km'; END IF;
 IF public.add_active_route_service(route,req,NULL,context->>'revision',operation,NULL,NULL,1,NULL,expected,NULL) IS DISTINCT FROM result THEN
  RAISE EXCEPTION 'CAJA C99 FAIL: incorporación no idempotente'; END IF;
 saved:=public.save_transport_request_full(NULL,payload||jsonb_build_object('reference_number','ZZ-C99-T'),'[]','[]'); quote_req:=(saved->>'id')::uuid;
 PERFORM public.approve_reference_transport_request(quote_req,0,'RQ','ZZ-C99-T');
 denied:=false;
 BEGIN PERFORM public.validate_mixed_dispatch(jsonb_build_array(jsonb_build_object('id',quote_req,'freight_share_pen',50)),'GR',50);
 EXCEPTION WHEN raise_exception THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C99 FAIL: paga tercero sin aprobación'; END IF;
 PERFORM public.authorize_pickup_reference_freight(quote_req,0,'RQ','ZZ-C99-T',50,'Cotización real de proveedor');
 PERFORM public.validate_mixed_dispatch(jsonb_build_array(jsonb_build_object('id',quote_req,'freight_share_pen',50)),'GR',50);
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=quote_req AND service_cost=50 AND operational_approved_pen=50 AND cost_source='MANUAL' AND approved_by=actor) THEN
  RAISE EXCEPTION 'CAJA C99 FAIL: no registra autorización expresa'; END IF;
 denied:=false;
 BEGIN PERFORM public.authorize_pickup_reference_freight(quote_req,0,'RQ','ZZ-C99-T',60,'Cotización anterior obsoleta');
 EXCEPTION WHEN raise_exception THEN denied:=true; END;
 IF NOT denied OR has_function_privilege('anon','public.authorize_pickup_reference_freight(uuid,numeric,text,text,numeric,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C99 FAIL: autorización obsoleta o acceso anónimo'; END IF;
 RAISE EXCEPTION 'CAJA C99 PASS: recojo sin valorización, adicional sin flete/km, documentación, capacidad, día, idempotencia y autorización expresa de terceros';
END $test$;
ROLLBACK;
