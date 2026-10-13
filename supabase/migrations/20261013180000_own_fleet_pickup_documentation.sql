BEGIN;
-- Recojos use operational documentation without an automatic freight valuation.
-- Actual third-party costs remain subject to existing explicit approval/caps.
DO $tariff$
DECLARE source text; old text:=$old$IF r.j->>'attention_mode'='RECOJO_CLIENTE' THEN$old$;
BEGIN
 source:=pg_get_functiondef('public.apply_request_tariff(uuid)'::regprocedure);
 IF position(old IN source)=0 THEN RAISE EXCEPTION 'Motor de tarifa incompatible'; END IF;
 source:=replace(source,old,$new$IF r.j->>'attention_mode'='RECOJO_CLIENTE' OR r.j->>'request_type'='RECOJO' THEN$new$);
 source:=replace(source,'''attention_mode'',''RECOJO_CLIENTE''','''attention_mode'',r.j->>''attention_mode'',''pickup_freight_not_valued'',r.j->>''request_type''=''RECOJO''');
 EXECUTE source;
END $tariff$;

-- Repair only unassigned automatic quotes, never actual/manual costs or operational
-- history. A changed estimate returns to approval; manual observations stay intact.
DO $pending$
DECLARE t record;
BEGIN
 PERFORM set_config('tms.tariff_apply','on',true);
 FOR t IN SELECT * FROM public.transport_requests r WHERE r.request_type='RECOJO'
   AND r.attention_mode='TRANSPORTE_JRM' AND r.cost_source='TARIFARIO' AND r.service_cost>0
   AND r.status IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','APROBADA','REPROGRAMADA','OBSERVADA')
   AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests d WHERE d.transport_request_id=r.id)
   AND (r.status<>'OBSERVADA' OR COALESCE(r.budget_observation,'') LIKE 'Partida insuficiente%'
     OR COALESCE(r.budget_observation,'') LIKE 'Vincule una OT%') FOR UPDATE LOOP
   UPDATE public.transport_requests SET service_cost=0,
     cost_breakdown=COALESCE(cost_breakdown,'{}'::jsonb)||jsonb_build_object('freight_total',0,
       'total',COALESCE(unloading_estimate_pen,0),'pickup_freight_not_valued',true,'lines',
         COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(COALESCE(cost_breakdown->'lines','[]'::jsonb))e
           WHERE e->>'concept' NOT IN ('FLETE','PARADA_ADICIONAL')),'[]'::jsonb)),
     status='PENDIENTE DE APROBACIÓN',approved_at=NULL,approved_by=NULL,operational_approved_pen=0,
     budget_shortfall=0,budget_observation=NULL
   WHERE id=t.id;
   INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
   VALUES(t.id,auth.uid(),'STATUS_CHANGED',jsonb_build_object('status',t.status,'service_cost',t.service_cost),
     jsonb_build_object('status','PENDIENTE DE APROBACIÓN','service_cost',0,'reason','Recojo: retirar flete automático; costo del tercero se autoriza al programar'));
 END LOOP;
 PERFORM set_config('tms.tariff_apply','',true);
END $pending$;

-- Normalize only own-fleet pickup allocations. Other services keep their shares;
-- the tercero gateway is deliberately unchanged.
DO $schedule$
DECLARE source text; old text:=$old$SELECT count(DISTINCT COALESCE(t.contract_id::text,'SIN_OT')) INTO v_n$old$;
BEGIN
 source:=pg_get_functiondef('public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'::regprocedure);
 IF position(old IN source)=0 THEN RAISE EXCEPTION 'Motor de programación incompatible'; END IF;
 source:=replace(source,old,$new$IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_requests) e JOIN public.transport_requests t ON t.id=(e->>'id')::uuid WHERE t.request_type='RECOJO' AND t.attention_mode='TRANSPORTE_JRM') THEN
   SELECT jsonb_agg(CASE WHEN t.request_type='RECOJO' AND t.attention_mode='TRANSPORTE_JRM' THEN e.value||jsonb_build_object('freight_share_pen',0) ELSE e.value END ORDER BY e.ordinality)
     INTO p_requests FROM jsonb_array_elements(p_requests) WITH ORDINALITY e(value,ordinality)
     LEFT JOIN public.transport_requests t ON t.id=(e.value->>'id')::uuid;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_requests)e LEFT JOIN public.transport_requests t ON t.id=(e->>'id')::uuid
     WHERE t.request_type IS DISTINCT FROM 'RECOJO' AND (NULLIF(e->>'freight_share_pen','') IS NULL
       OR (e->>'freight_share_pen')::numeric<0 OR (e->>'freight_share_pen')::numeric<>round((e->>'freight_share_pen')::numeric,2)
       OR e->>'freight_share_pen' IN ('NaN','Infinity','-Infinity'))) THEN
     RAISE EXCEPTION 'Indique el flete de cada servicio distinto al recojo'; END IF;
   SELECT COALESCE(sum((e->>'freight_share_pen')::numeric),0) INTO p_freight_cost FROM jsonb_array_elements(p_requests)e;
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_requests)e LEFT JOIN public.transport_requests t ON t.id=(e->>'id')::uuid WHERE t.request_type IS DISTINCT FROM 'RECOJO') THEN p_estimated_km:=0; END IF;
 END IF;
 SELECT count(DISTINCT COALESCE(t.contract_id::text,'SIN_OT')) INTO v_n$new$);
 source:=replace(source,'IF v_n<=1 AND NOT EXISTS',
   'IF v_n<=1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_requests)e JOIN public.transport_requests t ON t.id=(e->>''id'')::uuid WHERE t.request_type=''RECOJO'' AND t.attention_mode=''TRANSPORTE_JRM'') AND NOT EXISTS');
 source:=replace(source,'IF v_n>1 OR EXISTS',
   'IF v_n>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_requests)e JOIN public.transport_requests t ON t.id=(e->>''id'')::uuid WHERE t.request_type=''RECOJO'' AND t.attention_mode=''TRANSPORTE_JRM'') OR EXISTS');
 EXECUTE source;
END $schedule$;

DO $addition$
DECLARE source text; old text:=$old$IF p_freight IS NULL OR p_freight<0$old$;
BEGIN
 source:=pg_get_functiondef('public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure);
 IF position(old IN source)=0 THEN RAISE EXCEPTION 'Motor de incorporación incompatible'; END IF;
 EXECUTE replace(source,old,$new$-- Own-fleet pickups need no freight or estimated extra distance.
 -- Keep zero-valued ledger, documentation, capacity and daily cutoff controls.
 IF COALESCE(d.modalidad,'PROPIA')='PROPIA' AND d.carrier_id IS NULL AND EXISTS(SELECT 1 FROM public.transport_requests x WHERE x.id=p_request AND x.request_type='RECOJO' AND x.attention_mode='TRANSPORTE_JRM') THEN
   p_freight:=0; p_extra_km:=0;
 END IF;
 IF p_freight IS NULL OR p_freight<0$new$);
END $addition$;

DO $context$
DECLARE source text; old text:=$old$'status',d.status));$old$;
BEGIN
 source:=pg_get_functiondef('public.active_route_context_before_daily_cutoff(uuid)'::regprocedure);
 IF position(old IN source)=0 THEN RAISE EXCEPTION 'Contexto de ruta incompatible'; END IF;
 EXECUTE replace(source,old,$new$'status',d.status,'modalidad',d.modalidad));$new$);
END $context$;

-- Supervisor explicitly authorizes a real third-party pickup quote; automatic
-- pickup tariff removal must not prevent a documented and funded tercero route.
CREATE FUNCTION public.authorize_pickup_reference_freight(p_request_id uuid,p_expected_cost numeric,
 p_reference_type text,p_reference_number text,p_freight numeric,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.transport_requests%ROWTYPE;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
   RAISE EXCEPTION 'Solo el Supervisor de Transporte puede autorizar el flete del tercero'; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=p_request_id FOR UPDATE;
 IF t.id IS NULL OR NOT public.can_access_site(t.site_id) OR NOT public.is_reference_transport(t)
   OR t.request_type<>'RECOJO' OR t.attention_mode<>'TRANSPORTE_JRM'
   OR t.status NOT IN ('APROBADA','REPROGRAMADA') OR t.approved_at IS NULL
   OR EXISTS(SELECT 1 FROM public.dispatch_requests r JOIN public.dispatches d ON d.id=r.dispatch_id
     WHERE r.transport_request_id=t.id AND d.status<>'CANCELADO') THEN
   RAISE EXCEPTION 'El recojo aprobado no está disponible para cotizar al tercero'; END IF;
 IF p_expected_cost IS DISTINCT FROM COALESCE(t.service_cost,0)+COALESCE(t.unloading_estimate_pen,0)
   OR p_reference_type IS DISTINCT FROM t.reference_type OR p_reference_number IS DISTINCT FROM t.reference_number THEN
   RAISE EXCEPTION 'El costo o el sustento cambió. Actualice antes de autorizar'; END IF;
 IF p_freight IS NULL OR p_freight<0 OR p_freight<>round(p_freight,2) OR p_freight>99999999.99
   OR p_freight::text IN ('NaN','Infinity','-Infinity') OR length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN
   RAISE EXCEPTION 'Indique flete válido y motivo de la cotización (10 a 500 caracteres)'; END IF;
 PERFORM set_config('tms.tariff_apply','on',true);
 UPDATE public.transport_requests SET service_cost=p_freight,cost_source='MANUAL',cost_override_reason=btrim(p_reason),
   cost_breakdown=COALESCE(cost_breakdown,'{}'::jsonb)||jsonb_build_object('freight_total',p_freight,
     'total',p_freight+COALESCE(unloading_estimate_pen,0),'source','COTIZACION_TERCERO','pickup_freight_not_valued',false)
 WHERE id=t.id;
 PERFORM set_config('tms.tariff_apply','',true);
 PERFORM public.approve_reference_transport_request(t.id,p_freight+COALESCE(t.unloading_estimate_pen,0),t.reference_type,t.reference_number);
 INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
 VALUES(t.id,auth.uid(),'STATUS_CHANGED',jsonb_build_object('service_cost',t.service_cost,'operational_approved_pen',t.operational_approved_pen),
   jsonb_build_object('service_cost',p_freight,'operational_approved_pen',p_freight+COALESCE(t.unloading_estimate_pen,0),'reason',btrim(p_reason),'source','COTIZACION_TERCERO'));
 RETURN jsonb_build_object('success',true,'request_id',t.id,'service_cost',p_freight,
   'operational_approved_pen',p_freight+COALESCE(t.unloading_estimate_pen,0));
END $$;
REVOKE ALL ON FUNCTION public.authorize_pickup_reference_freight(uuid,numeric,text,text,numeric,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.authorize_pickup_reference_freight(uuid,numeric,text,text,numeric,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
