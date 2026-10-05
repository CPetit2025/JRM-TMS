-- Casos reales, siempre ROLLBACK: modalidad desde solicitud, OT condicional y ruta heredada.
BEGIN;
DO $test$
DECLARE v_admin uuid; v_site uuid; v_ct uuid; v_req uuid; v_generic uuid; v_dispatch uuid;
 p jsonb; r jsonb; v_err text; v_pass int:=0;
BEGIN
 SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 FOR v_admin IN SELECT id FROM public.profiles WHERE is_active AND id IN(SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
   EXIT WHEN public.is_tms_admin(); v_admin:=NULL;
 END LOOP;
 IF v_admin IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C45 FAIL: falta administrador activo o sede'; END IF;
 PERFORM set_config('request.jwt.claims',json_build_object('sub',v_admin,'role','authenticated')::text,true);
 INSERT INTO public.contracts(code,type,status,site_id) VALUES('ZZ-C45-OT','CONTRATO','ACTIVO',v_site) RETURNING id INTO v_ct;
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(v_ct,'PARTIDA_TRANSPORTE',0);
 p:=jsonb_build_object('contract_id',v_ct,'department','OT (Administración de Contratos)','attention_mode','RECOJO_CLIENTE',
 'request_type','DESPACHO','required_date',current_date,'cargo_description','Prueba C45','pickup_address','Planta','pickup_district','CHILCA',
 'delivery_address','Retiro por cliente','delivery_district','CHILCA','pickup_customer','Cliente C45','pickup_contact','Responsable C45','pickup_phone','999999999','service_cost',308);
 r:=public.save_transport_request_attention(NULL,p,jsonb_build_array(jsonb_build_object('contract_id',v_ct,'weight_kg',1)),'[]');
 v_req:=(r->>'id')::uuid;
 IF NOT COALESCE((r->>'success')::boolean,false) OR (r->>'service_cost')::numeric<>0 OR r->>'status'<>'PENDIENTE DE APROBACIÓN' THEN
   RAISE EXCEPTION 'CAJA C45 FAIL: recojo con partida cero %',r;
 END IF;
 PERFORM public.set_transport_request_status(v_req,'APROBADA',NULL);
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=v_req AND reserved_pen=0 AND status='APROBADA') THEN
   RAISE EXCEPTION 'CAJA C45 FAIL: aprobación de recojo reservó flete'; END IF;
 v_pass:=v_pass+1;
 BEGIN PERFORM public.schedule_dispatch(NULL,'EXTERNO',now(),0,0,v_ct,'GR',jsonb_build_array(jsonb_build_object('id',v_req)));
 EXCEPTION WHEN OTHERS THEN v_err:=SQLERRM; END;
 IF COALESCE(v_err,'') NOT LIKE 'La modalidad se define%' THEN RAISE EXCEPTION 'CAJA C45 FAIL: aceptó otra modalidad %',v_err; END IF;
 v_dispatch:=public.schedule_dispatch(NULL,'EXTERNO',now(),0,0,v_ct,'NOTA_SALIDA',jsonb_build_array(jsonb_build_object('id',v_req)));
 IF NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=v_dispatch AND driver_id IS NULL AND freight_cost=0 AND site_id=v_site) OR
    NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=v_dispatch AND document_type='NOTA_SALIDA') THEN
   RAISE EXCEPTION 'CAJA C45 FAIL: no heredó Nota de Salida/flete cero/sede'; END IF;
 v_pass:=v_pass+1;
 v_err:=NULL;
 BEGIN PERFORM public.save_transport_request_attention(NULL,p||jsonb_build_object('contract_id',NULL,'site_id',v_site),'[]','[]');
 EXCEPTION WHEN OTHERS THEN v_err:=SQLERRM; END;
 IF COALESCE(v_err,'') NOT LIKE 'El área OT%' THEN RAISE EXCEPTION 'CAJA C45 FAIL: permitió área OT sin OT %',v_err; END IF;
 r:=public.save_transport_request_attention(NULL,p||jsonb_build_object('contract_id',NULL,'department','Logística','site_id',v_site,'estimated_weight',2),'[]','[]');
 v_generic:=(r->>'id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=v_generic AND contract_id IS NULL AND attention_mode='RECOJO_CLIENTE' AND estimated_weight=2 AND status='PENDIENTE DE APROBACIÓN') THEN
   RAISE EXCEPTION 'CAJA C45 FAIL: otra área sigue exigiendo OT %',r; END IF;
 v_pass:=v_pass+1;
 RAISE EXCEPTION 'CAJA C45 PASS (%/3)',v_pass;
END $test$;
ROLLBACK;
