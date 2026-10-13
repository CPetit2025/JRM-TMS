-- Comprueba la aprobación y la trazabilidad financiera OC/OS/RQ sin imputar una OT ficticia.
BEGIN;
DO $settings$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  UPDATE public.transport_lead_time_settings SET settings=jsonb_set(settings,'{enabled}','false'::jsonb);
 END IF;
END $settings$;
DO $test$
DECLARE actor uuid; site uuid; supplier uuid; req uuid; route uuid; route2 uuid; line uuid;
 cap numeric; before_budget numeric; before_services bigint; denied boolean; registry jsonb;
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C94 FAIL: falta administrador activo'; END IF;
 SELECT s.id INTO site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY s.id LIMIT 1;
 INSERT INTO public.suppliers(tax_id,business_name) VALUES((floor(random()*90000000000)+10000000000)::bigint::text,'ZZ C94') RETURNING id INTO supplier;
 -- Use a valued transfer: own-fleet pickups are documented without automatic freight.
 req:=public.save_transport_request(NULL,jsonb_build_object('department','Logística','request_type','TRASLADO',
  'attention_mode','TRANSPORTE_JRM','site_id',site,'required_date',current_date+7,'cargo_description','ZZ C94',
  'pickup_address','Origen prueba','pickup_district','CHILCA','delivery_address','Destino prueba','delivery_district','CALLAO',
  'service_cost',100,'reference_type','OC','reference_number','ZZ-C94-OC','supplier_id',supplier),'[]');
 PERFORM public.apply_request_supplier(req,jsonb_build_object('supplier_id',supplier,'reference_type','OC','reference_number','ZZ-C94-OC'));
 SELECT COALESCE(service_cost,0)+COALESCE(unloading_estimate_pen,0) INTO cap FROM public.transport_requests WHERE id=req;
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id=req AND public.is_reference_transport(t) AND public.can_access_site(t.site_id)) THEN
  RAISE EXCEPTION 'CAJA C94 FAIL: solicitud de prueba no conserva referencia y sede'; END IF;
 IF cap<=0 THEN RAISE EXCEPTION 'CAJA C94 FAIL: falta importe positivo para probar aprobación'; END IF;
 denied:=false;
 BEGIN PERFORM public.approve_reference_transport_request(req,cap+1,'OC','ZZ-C94-OC');
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'El costo o el sustento cambió%' THEN RAISE EXCEPTION 'CAJA C94 FAIL: aprobación inesperada: %',SQLERRM; END IF;
  denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C94 FAIL: aprueba importe desactualizado'; END IF;
 PERFORM public.approve_reference_transport_request(req,cap,'OC','ZZ-C94-OC');
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=req AND status='APROBADA' AND approved_by=actor AND operational_approved_pen=cap AND reserved_pen=0) THEN
  RAISE EXCEPTION 'CAJA C94 FAIL: no registra aprobación operacional'; END IF;
 SELECT COALESCE(sum(reserved_pen+consumed_pen),0) INTO before_budget FROM public.contract_budgets;
 SELECT count(*) INTO before_services FROM public.contract_services;
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,scheduled_departure,status,freight_cost,site_id)
 VALUES('ZZ-C94-'||substr(gen_random_uuid()::text,1,8),'EXTERNO','ZZ C94',now()+interval '7 days','PROGRAMADO',cap/2,site) RETURNING id INTO route;
 PERFORM public.validate_mixed_dispatch(jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',round(cap/2,2))),'GR',round(cap/2,2));
 PERFORM public.reserve_mixed_dispatch(route,jsonb_build_array(jsonb_build_object('id',req,'freight_share_pen',round(cap/2,2))));
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,document_type,sequence_order) VALUES(route,req,'PROGRAMADO','GR',1);
 UPDATE public.transport_requests SET status='ASIGNADA' WHERE id=req;
 INSERT INTO public.transport_unloading_costs(transport_request_id,dispatch_id,contract_id,concept,planned_pen,status,created_by)
 VALUES(req,route,NULL,'ESTIBA',cap-round(cap/2,2),'PLANIFICADO',actor) RETURNING id INTO line;
 denied:=false;
 BEGIN PERFORM public.unloading_consume(line,cap-round(cap/2,2)+1,NULL,'ZZ C94');
 EXCEPTION WHEN raise_exception THEN denied:=SQLERRM LIKE 'El costo real supera%'; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C94 FAIL: permite exceder aprobación combinada'; END IF;
 PERFORM public.unloading_consume(line,cap-round(cap/2,2),NULL,'ZZ C94');
 PERFORM public.settle_mixed_dispatch_freight(route,true);
 INSERT INTO public.dispatches(dispatch_number,vehicle_plate,driver_name,scheduled_departure,status,freight_cost,site_id)
 VALUES('ZZ-C94-'||substr(gen_random_uuid()::text,1,8),'EXTERNO','ZZ C94',now()+interval '8 days','PROGRAMADO',cap/2,site) RETURNING id INTO route2;
 denied:=false;
 BEGIN INSERT INTO public.dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen) VALUES(route2,req,NULL,1);
 EXCEPTION WHEN raise_exception THEN denied:=SQLERRM LIKE 'El flete y la descarga superan%'; END;
 IF NOT denied THEN RAISE EXCEPTION 'CAJA C94 FAIL: reutiliza aprobación consumida en otra ruta'; END IF;
 registry:=public.get_reference_service_registry(NULL,NULL);
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(registry) e WHERE e->>'request_id'=req::text AND e->>'reference_number'='ZZ-C94-OC') THEN
  RAISE EXCEPTION 'CAJA C94 FAIL: falta sustento en registro'; END IF;
 IF (SELECT COALESCE(sum(reserved_pen+consumed_pen),0) FROM public.contract_budgets)<>before_budget
   OR (SELECT count(*) FROM public.contract_services)<>before_services THEN
  RAISE EXCEPTION 'CAJA C94 FAIL: imputa gasto sin OT a partida o servicio de contrato'; END IF;
 IF has_function_privilege('anon','public.approve_reference_transport_request(uuid,numeric,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.get_reference_service_registry(date,date)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C94 FAIL: acceso anónimo'; END IF;
 RAISE EXCEPTION 'CAJA C94 PASS: aprobación OC/OS/RQ, cap combinado, trazabilidad y consumo sin OT ficticia ni reutilización del monto';
END $test$;
ROLLBACK;
