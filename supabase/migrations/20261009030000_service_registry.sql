-- Registro económico: restaurar vínculos no vuelve a consumir/reservar una partida.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_service_registry_context(p_services uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('clientes')) THEN RAISE EXCEPTION 'Sin permiso para consultar servicios'; END IF;
 IF cardinality(p_services)>200 THEN RAISE EXCEPTION 'Consulte hasta 200 servicios por bloque'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('service_id',s.id,'dispatch_number',d.dispatch_number,
   'request_numbers',COALESCE((SELECT jsonb_agg(t.request_number ORDER BY dr.sequence_order) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
     WHERE dr.dispatch_id=d.id AND (f.request_id IS NULL OR t.id=f.request_id) AND public.can_access_site(t.site_id) AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(t.contract_id,true))), '[]'::jsonb),
   'operation_state',d.status,'stage',CASE WHEN s.status='ANULADO' OR d.status='CANCELADO' OR f.status='LIBERADO' THEN 'ANULADO'
     WHEN d.id IS NULL THEN 'REGISTRO_MANUAL'
     WHEN d.status IN ('LIQUIDADO','CERRADO') AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr
       LEFT JOIN public.delivery_conformities dc ON dc.dispatch_id=dr.dispatch_id AND dc.request_id=dr.transport_request_id
       WHERE dr.dispatch_id=d.id AND (f.request_id IS NULL OR dr.transport_request_id=f.request_id)
       AND (dr.status IS DISTINCT FROM 'ENTREGADO' OR (public.delivery_required(dr.dispatch_id,dr.transport_request_id) AND dc.state IS DISTINCT FROM 'VALIDADA')))
       AND EXISTS(SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=d.id) THEN 'REALIZADO'
     ELSE 'COMPROMETIDO' END)), '[]'::jsonb) INTO result
 FROM public.contract_services s JOIN public.contracts c ON c.id=s.contract_id
 LEFT JOIN public.dispatches d ON d.id=s.dispatch_id
 LEFT JOIN public.dispatch_request_freight f ON f.service_id=s.id
 WHERE s.id=ANY(p_services) AND public.can_access_site(c.site_id)
   AND (NOT public.is_contract_administrator() OR public.has_assigned_contract(s.contract_id,true))
   AND (d.id IS NULL OR public.can_access_site(d.site_id));
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.get_dispatch_freight_reconciliation_queue()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('clientes')) THEN RAISE EXCEPTION 'Sin permiso para regularizar fletes'; END IF;
 RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(q)),'[]'::jsonb) FROM (
 SELECT d.id,d.dispatch_number,d.driver_name,d.vehicle_plate,d.scheduled_departure,d.status,d.freight_cost,d.contract_id,
   jsonb_build_object('code',COALESCE(c.code,'Varias OT')) AS contracts
 FROM public.dispatches d LEFT JOIN public.contracts c ON c.id=d.contract_id
 WHERE d.status<>'CANCELADO' AND d.vehicle_plate<>'EXTERNO' AND d.freight_cost>0 AND public.can_access_site(d.site_id)
 AND (d.contract_id IS NULL OR public.can_access_site(c.site_id))
 AND NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight f JOIN public.contracts fc ON fc.id=f.contract_id WHERE f.dispatch_id=d.id AND NOT public.can_access_site(fc.site_id))
 AND (NOT public.is_contract_administrator() OR (d.contract_id IS NOT NULL AND public.has_assigned_contract(d.contract_id,true))
   OR (EXISTS(SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id)
     AND NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id AND NOT public.has_assigned_contract(f.contract_id,true))))
 AND ((EXISTS(SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id AND f.amount_pen>0 AND f.status<>'LIBERADO' AND f.service_id IS NULL))
   OR (d.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight f WHERE f.dispatch_id=d.id)
     AND NOT EXISTS(SELECT 1 FROM public.contract_services s WHERE s.dispatch_id=d.id AND s.service_type='FLETE')))
 ORDER BY d.scheduled_departure DESC LIMIT 200) q);
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_dispatch_freight(p_dispatch uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; f record; service uuid; n integer:=0; b record; expected numeric; existing_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('clientes')) THEN RAISE EXCEPTION 'Sin permiso para regularizar fletes'; END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF d.id IS NULL OR NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
 IF d.status='CANCELADO' OR d.vehicle_plate='EXTERNO' OR COALESCE(d.freight_cost,0)<=0 THEN RAISE EXCEPTION 'No corresponde regularizar flete para este despacho'; END IF;
 IF EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=d.id) THEN
   FOR f IN SELECT * FROM public.dispatch_request_freight WHERE dispatch_id=d.id ORDER BY contract_id,request_id FOR UPDATE LOOP
     IF public.is_contract_administrator() AND (f.contract_id IS NULL OR NOT public.has_assigned_contract(f.contract_id,true)) THEN RAISE EXCEPTION 'OT no asignada'; END IF;
     IF f.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=f.contract_id AND public.can_access_site(c.site_id)) THEN RAISE EXCEPTION 'Sede de la OT no autorizada'; END IF;
     IF f.amount_pen<=0 OR f.status='LIBERADO' OR f.service_id IS NOT NULL THEN CONTINUE; END IF;
     -- Un cargo huérfano de vínculo no puede recrearse: requiere revisión para evitar duplicados.
     IF EXISTS(SELECT 1 FROM public.contract_services s WHERE s.dispatch_id=d.id AND s.contract_id=f.contract_id AND s.service_type='FLETE'
       AND NOT EXISTS(SELECT 1 FROM public.dispatch_request_freight x WHERE x.service_id=s.id)) THEN RAISE EXCEPTION 'Existe un flete sin vínculo: revise la imputación antes de regularizar'; END IF;
     SELECT * INTO b FROM public.contract_budgets WHERE contract_id=f.contract_id AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
     SELECT sum(amount_pen) INTO expected FROM public.dispatch_request_freight WHERE dispatch_id=d.id AND contract_id=f.contract_id AND status=f.status;
     IF b.id IS NULL OR (CASE WHEN f.status='CONSUMIDO' THEN b.consumed_pen ELSE b.reserved_pen END)<expected THEN RAISE EXCEPTION 'La imputación presupuestal requiere revisión; no se generó ningún cargo'; END IF;
     INSERT INTO public.contract_services(contract_id,service_type,description,amount_pen,service_date,plate,driver_name,category,created_by,dispatch_id)
     VALUES(f.contract_id,'FLETE','Regularización de vínculo · '||d.dispatch_number||' · '||f.request_id,f.amount_pen,(d.scheduled_departure AT TIME ZONE 'America/Lima')::date,d.vehicle_plate,d.driver_name,'Contrato',auth.uid(),d.id) RETURNING id INTO service;
     UPDATE public.dispatch_request_freight SET service_id=service WHERE dispatch_id=d.id AND request_id=f.request_id;
     n:=n+1;
   END LOOP;
 ELSE
   IF d.contract_id IS NULL OR (public.is_contract_administrator() AND NOT public.has_assigned_contract(d.contract_id,true)) THEN RAISE EXCEPTION 'OT no asignada'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=d.contract_id AND public.can_access_site(c.site_id)) THEN RAISE EXCEPTION 'Sede de la OT no autorizada'; END IF;
   SELECT count(*) INTO existing_count FROM public.contract_services WHERE dispatch_id=d.id AND service_type='FLETE';
   IF existing_count>0 THEN RETURN jsonb_build_object('created',0,'already_linked',true); END IF;
   IF EXISTS(SELECT 1 FROM public.contract_services s WHERE s.contract_id=d.contract_id AND s.service_type='FLETE' AND s.dispatch_id IS NULL
     AND (position(d.dispatch_number IN COALESCE(s.description,''))>0 OR (s.amount_pen=d.freight_cost AND s.plate=d.vehicle_plate AND s.service_date=(d.scheduled_departure AT TIME ZONE 'America/Lima')::date))) THEN RAISE EXCEPTION 'Existe un posible flete sin vínculo: requiere revisión antes de regularizar'; END IF;
   SELECT * INTO b FROM public.contract_budgets WHERE contract_id=d.contract_id AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
   IF b.id IS NULL OR (CASE WHEN d.status IN ('LIQUIDADO','CERRADO') THEN b.consumed_pen ELSE b.reserved_pen END)<d.freight_cost THEN RAISE EXCEPTION 'La imputación presupuestal requiere revisión; no se generó ningún cargo'; END IF;
   INSERT INTO public.contract_services(contract_id,service_type,description,amount_pen,service_date,plate,driver_name,category,created_by,dispatch_id)
   VALUES(d.contract_id,'FLETE','Regularización de vínculo · '||d.dispatch_number,d.freight_cost,(d.scheduled_departure AT TIME ZONE 'America/Lima')::date,d.vehicle_plate,d.driver_name,'Contrato',auth.uid(),d.id);
   n:=1;
 END IF;
 IF n>0 THEN INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
   VALUES(d.id,'FLETE_REGULARIZADO',n||' cargo(s) vinculados; sin modificación de reserva ni consumo',auth.uid()::text); END IF;
 RETURN jsonb_build_object('created',n,'already_linked',n=0);
END $$;
REVOKE ALL ON FUNCTION public.get_service_registry_context(uuid[]),public.get_dispatch_freight_reconciliation_queue(),public.reconcile_dispatch_freight(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_service_registry_context(uuid[]),public.get_dispatch_freight_reconciliation_queue(),public.reconcile_dispatch_freight(uuid) TO authenticated;
COMMIT;
