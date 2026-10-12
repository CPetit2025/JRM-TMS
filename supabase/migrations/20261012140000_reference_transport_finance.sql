-- OC/OS/RQ: aprobación operacional explícita sin inventar una OT ni consumir partidas ajenas.
BEGIN;
CREATE FUNCTION public.is_reference_transport(t public.transport_requests) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE(t.contract_id IS NULL AND t.request_type IN ('RECOJO','TRASLADO')
 AND t.reference_type IN ('OC','OS','RQ') AND length(trim(COALESCE(t.reference_number,''))) BETWEEN 1 AND 100,false);
$$;
REVOKE ALL ON FUNCTION public.is_reference_transport(public.transport_requests) FROM PUBLIC,anon,authenticated;

ALTER TABLE public.dispatch_request_freight ADD COLUMN reference_type text,
 ADD COLUMN reference_number text;
ALTER TABLE public.dispatch_request_freight ADD CONSTRAINT reference_freight_document CHECK
 ((reference_type IS NULL AND reference_number IS NULL) OR
  (reference_type IS NOT NULL AND reference_number IS NOT NULL AND reference_type IN ('OC','OS','RQ') AND length(trim(reference_number)) BETWEEN 1 AND 100));

-- El control se ejecuta también ante escrituras directas. Cambiar el sustento o el costo anula la aprobación.
CREATE OR REPLACE FUNCTION public.request_ot_funding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_cost numeric:=COALESCE(NEW.service_cost,0)+COALESCE(NEW.unloading_estimate_pen,0); changed boolean:=false;
BEGIN
 IF NEW.contract_id IS NULL AND NEW.request_type IN ('RECOJO','TRASLADO') THEN
  IF v_cost<0 OR v_cost::text IN ('NaN','Infinity','-Infinity') OR NEW.operational_approved_pen::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'El importe del servicio y su aprobación deben ser montos válidos'; END IF;
  IF TG_OP='UPDATE' THEN
   changed:=NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.request_type IS DISTINCT FROM OLD.request_type OR NEW.site_id IS DISTINCT FROM OLD.site_id
    OR NEW.reference_type IS DISTINCT FROM OLD.reference_type OR NEW.reference_number IS DISTINCT FROM OLD.reference_number
    OR NEW.service_cost IS DISTINCT FROM OLD.service_cost OR NEW.unloading_estimate_pen IS DISTINCT FROM OLD.unloading_estimate_pen;
   IF changed AND (OLD.status IN ('ASIGNADA','EN_TRANSITO','ENTREGADA') OR
     EXISTS(SELECT 1 FROM public.dispatch_requests WHERE transport_request_id=OLD.id)) THEN
    RAISE EXCEPTION 'Retire la solicitud de la ruta antes de cambiar su referencia o costo';
   END IF;
   IF changed AND OLD.approved_at IS NOT NULL THEN
    NEW.status:='PENDIENTE DE APROBACIÓN'; NEW.approved_at:=NULL; NEW.approved_by:=NULL; NEW.operational_approved_pen:=0;
   END IF;
  END IF;
  IF NEW.status IN ('APROBADA','ASIGNADA','EN_TRANSITO','ENTREGADA') THEN
   IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Registre la solicitud antes de aprobarla o programarla'; END IF;
   IF NOT public.is_reference_transport(NEW) OR NEW.approved_at IS NULL OR NEW.approved_by IS NULL
     OR NEW.operational_approved_pen<v_cost THEN
    RAISE EXCEPTION 'La OC, OS o RQ y el importe deben ser aprobados por el Supervisor de Transporte';
   END IF;
  END IF;
  IF public.is_reference_transport(NEW) THEN
   IF NEW.status='OBSERVADA' AND (NEW.budget_observation LIKE 'Vincule una OT%' OR NEW.budget_observation LIKE 'Partida insuficiente%') THEN
    NEW.status:='PENDIENTE DE APROBACIÓN'; NEW.approved_at:=NULL; NEW.approved_by:=NULL; NEW.operational_approved_pen:=0;
   END IF;
   IF NEW.budget_observation IS NULL OR NEW.budget_observation LIKE 'Vincule una OT%' OR NEW.budget_observation LIKE 'Partida insuficiente%' THEN
    NEW.budget_shortfall:=0; NEW.budget_observation:=NULL;
   END IF;
   RETURN NEW;
  END IF;
 END IF;
 IF NEW.contract_id IS NULL AND v_cost>0 THEN
  IF NEW.status IN ('ASIGNADA','EN_TRANSITO','ENTREGADA') THEN RAISE EXCEPTION 'Vincule una OT para financiar los costos a cargo de JRM'; END IF;
  IF NEW.status IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','OBSERVADA','APROBADA','REPROGRAMADA') THEN
   NEW.status:='OBSERVADA'; NEW.approved_at:=NULL; NEW.approved_by:=NULL; NEW.operational_approved_pen:=0;
   NEW.budget_shortfall:=v_cost; NEW.budget_observation:='Vincule una OT para financiar los costos a cargo de JRM';
  END IF;
 END IF;
 RETURN NEW;
END $$;

-- Conserva la lógica OT desplegada y sus reservas; sustituye solamente el caso sin OT.
DO $patch$
DECLARE def text; old text;
BEGIN
 def:=pg_get_functiondef('public.transport_request_budget_sync()'::regprocedure);
 old:=$old$IF NEW.status='APROBADA' AND NEW.contract_id IS NULL THEN$old$;
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor de aprobación no reconocido'; END IF;
 def:=replace(def,old,$new$IF NEW.status='APROBADA' AND public.is_reference_transport(NEW) THEN
    IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
      -- Cancelar una ruta devuelve su aprobación anterior, sin aumentar el límite autorizado.
      IF NOT (public.is_active_tms_user() AND public.has_tms_permission('despacho') AND OLD.status='ASIGNADA'
        AND OLD.approved_at IS NOT NULL AND OLD.operational_approved_pen>=v_cost
        AND EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
          WHERE dr.transport_request_id=OLD.id AND d.status='CANCELADO')
        AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
          WHERE dr.transport_request_id=OLD.id AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')
            AND NULLIF(to_jsonb(d)->>'operational_closed_at','') IS NULL)) THEN
        RAISE EXCEPTION 'Solo el Supervisor de Transporte aprueba servicios con OC, OS o RQ';
      END IF;
      NEW.operational_approved_pen:=OLD.operational_approved_pen; NEW.approved_at:=OLD.approved_at; NEW.approved_by:=OLD.approved_by;
    ELSE
      NEW.operational_approved_pen:=v_cost; NEW.approved_at:=now(); NEW.approved_by:=auth.uid();
    END IF;
    NEW.reserved_pen:=0; NEW.budget_shortfall:=0; NEW.budget_observation:=NULL; RETURN NEW;
  END IF;
  IF NEW.status='APROBADA' AND NEW.contract_id IS NULL THEN$new$);
 EXECUTE def;
END $patch$;



CREATE FUNCTION public.approve_reference_transport_request(p_request_id uuid,p_expected_cost numeric,p_reference_type text,p_reference_number text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.transport_requests%ROWTYPE;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
  RAISE EXCEPTION 'Solo el Supervisor de Transporte aprueba servicios con OC, OS o RQ'; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=p_request_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) OR NOT public.is_reference_transport(t) THEN RAISE EXCEPTION 'Solicitud no disponible'; END IF;
 IF p_expected_cost IS DISTINCT FROM COALESCE(t.service_cost,0)+COALESCE(t.unloading_estimate_pen,0)
  OR p_reference_type IS DISTINCT FROM t.reference_type OR trim(p_reference_number) IS DISTINCT FROM t.reference_number THEN
  RAISE EXCEPTION 'El costo o el sustento cambió. Actualice la solicitud antes de aprobar'; END IF;
 PERFORM public.set_transport_request_status(p_request_id,'APROBADA',NULL);
END $$;
REVOKE ALL ON FUNCTION public.approve_reference_transport_request(uuid,numeric,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_reference_transport_request(uuid,numeric,text,text) TO authenticated;

-- Un flete sin OT conserva el sustento y el gasto en el libro por solicitud ya existente.
CREATE FUNCTION public.reference_freight_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.transport_requests%ROWTYPE; unloading numeric;
BEGIN
 IF NEW.contract_id IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=NEW.request_id FOR UPDATE;
 IF NEW.amount_pen=0 AND NOT public.is_reference_transport(t) THEN RETURN NEW; END IF;
 IF NOT public.is_reference_transport(t) OR t.approved_at IS NULL THEN RAISE EXCEPTION 'Servicio sin aprobación de OC, OS o RQ'; END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.reference_type IS DISTINCT FROM OLD.reference_type OR NEW.reference_number IS DISTINCT FROM OLD.reference_number
    OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id THEN RAISE EXCEPTION 'El sustento de un flete registrado no puede cambiar'; END IF;
 ELSE NEW.reference_type:=t.reference_type; NEW.reference_number:=t.reference_number; END IF;
 IF NEW.status<>'LIBERADO' THEN
  SELECT COALESCE(sum(CASE WHEN status='CONSUMIDO' THEN actual_pen WHEN status='PLANIFICADO' THEN planned_pen ELSE 0 END),0)
   INTO unloading FROM public.transport_unloading_costs WHERE transport_request_id=t.id;
  unloading:=unloading+COALESCE((SELECT sum(amount_pen) FROM public.dispatch_request_freight
    WHERE request_id=t.id AND dispatch_id<>NEW.dispatch_id AND status<>'LIBERADO'),0);
  IF NEW.amount_pen+unloading>t.operational_approved_pen THEN RAISE EXCEPTION 'El flete y la descarga superan el importe aprobado para esta referencia'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reference_freight_guard BEFORE INSERT OR UPDATE ON public.dispatch_request_freight
 FOR EACH ROW EXECUTE FUNCTION public.reference_freight_guard();
REVOKE ALL ON FUNCTION public.reference_freight_guard(),public.request_ot_funding_guard() FROM PUBLIC,anon,authenticated,service_role;


DO $patch$ DECLARE def text; old text:=$old$IF v_n<=1 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF v_n<=1 AND NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests)) AND t.contract_id IS NULL) THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF v_n>1 THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF v_n>1 OR EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests)) AND t.contract_id IS NULL) THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF v_n<=1 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF v_n<=1 AND NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests)) AND t.contract_id IS NULL) THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF v_n>1 THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF v_n>1 OR EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests)) AND t.contract_id IS NULL) THEN PERFORM public.reserve_mixed_dispatch(v_id,p_requests); END IF;$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF r.contract_id IS NULL AND v_amount>0 THEN RAISE EXCEPTION 'El flete a cargo de JRM debe imputarse a una OT con partida de transporte'; END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.validate_mixed_dispatch(jsonb,text,numeric)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.validate_mixed_dispatch(jsonb,text,numeric)'; END IF;
 EXECUTE replace(def,old,$new$IF r.contract_id IS NULL AND v_amount>0 THEN
     IF NOT public.is_reference_transport((SELECT t FROM public.transport_requests t WHERE t.id=r.id)) OR r.approved_by IS NULL OR v_amount+COALESCE(r.unloading_estimate_pen,0)>r.operational_approved_pen THEN
       RAISE EXCEPTION 'El flete y la descarga deben estar cubiertos por la aprobación de OC, OS o RQ'; END IF;
   END IF;$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF r.amount>0 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.reserve_mixed_dispatch(uuid,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.reserve_mixed_dispatch(uuid,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF r.amount>0 AND r.contract_id IS NOT NULL THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF r.amount_pen>0 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.settle_mixed_dispatch_freight(uuid,boolean)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.settle_mixed_dispatch_freight(uuid,boolean)'; END IF;
 EXECUTE replace(def,old,$new$IF r.amount_pen>0 AND r.contract_id IS NOT NULL THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF v_ctr IS NULL AND v_amount>0 THEN RAISE EXCEPTION 'Vincule una OT para financiar los costos a cargo de JRM'; END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.plan_dispatch_unloading(uuid,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.plan_dispatch_unloading(uuid,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$IF v_ctr IS NULL AND v_amount>0 AND NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id=v_req AND public.is_reference_transport(t) AND t.approved_at IS NOT NULL) THEN
     RAISE EXCEPTION 'La OC, OS o RQ requiere aprobación del Supervisor'; END IF;$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$FOR r IN WITH proposed AS ($old$; BEGIN
 def:=pg_get_functiondef('public.plan_dispatch_unloading(uuid,jsonb)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.plan_dispatch_unloading(uuid,jsonb)'; END IF;
 EXECUTE replace(def,old,$new$-- Recalcular el total completo propuesto, no solo el delta, por referencia.
 FOR r IN SELECT t.id,t.operational_approved_pen,COALESCE(sum((e.value->>'amount')::numeric),0) AS unloading
   FROM jsonb_array_elements(v_rows)e JOIN public.transport_requests t ON t.id=(e.value->>'req')::uuid
   WHERE t.contract_id IS NULL GROUP BY t.id,t.operational_approved_pen LOOP
   IF r.unloading+COALESCE((SELECT sum(amount_pen) FROM public.dispatch_request_freight WHERE request_id=r.id AND status<>'LIBERADO'),0)
     +COALESCE((SELECT sum(actual_pen) FROM public.transport_unloading_costs WHERE transport_request_id=r.id AND status='CONSUMIDO'),0)+COALESCE((SELECT sum(planned_pen) FROM public.transport_unloading_costs WHERE transport_request_id=r.id AND dispatch_id<>p_dispatch_id AND status='PLANIFICADO'),0)>r.operational_approved_pen THEN
     RAISE EXCEPTION 'El flete y la descarga superan el importe aprobado para OC, OS o RQ'; END IF;
 END LOOP;
 FOR r IN WITH proposed AS ($new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF l.status<>'PLANIFICADO' OR p_amount<>0 OR COALESCE(l.planned_pen,0)<>0 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.unloading_consume(uuid,numeric,uuid,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.unloading_consume(uuid,numeric,uuid,text)'; END IF;
 EXECUTE replace(def,old,$new$IF l.status<>'PLANIFICADO' OR p_amount IS NULL OR p_amount<0 OR p_amount<>round(p_amount,2) THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$UPDATE public.transport_unloading_costs SET status='CONSUMIDO',actual_pen=p_amount,expense_id=p_expense_id,$old$; BEGIN
 def:=pg_get_functiondef('public.unloading_consume(uuid,numeric,uuid,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.unloading_consume(uuid,numeric,uuid,text)'; END IF;
 EXECUTE replace(def,old,$new$PERFORM 1 FROM public.transport_requests t WHERE t.id=l.transport_request_id FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id=l.transport_request_id
      AND public.is_reference_transport(t) AND t.approved_at IS NOT NULL
      AND public.can_access_site(t.site_id)
      AND p_amount+COALESCE((SELECT sum(amount_pen) FROM public.dispatch_request_freight WHERE request_id=t.id AND status<>'LIBERADO'),0)
        +COALESCE((SELECT sum(CASE WHEN status='CONSUMIDO' THEN actual_pen ELSE planned_pen END) FROM public.transport_unloading_costs
          WHERE transport_request_id=t.id AND id<>l.id AND status IN ('CONSUMIDO','PLANIFICADO')),0)<=t.operational_approved_pen) THEN
      RAISE EXCEPTION 'El costo real supera el importe aprobado para OC, OS o RQ'; END IF;
    UPDATE public.transport_unloading_costs SET status='CONSUMIDO',actual_pen=p_amount,expense_id=p_expense_id,$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF public.is_contract_administrator() AND NOT public.has_assigned_contract(l.contract_id, true) THEN$old$; BEGIN
 def:=pg_get_functiondef('public.register_unloading_actual(uuid,numeric,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.register_unloading_actual(uuid,numeric,text)'; END IF;
 EXECUTE replace(def,old,$new$IF public.is_contract_administrator() AND NOT public.has_assigned_request(l.transport_request_id,true) THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF l.status <> 'PLANIFICADO' OR l.dispatch_id IS NULL THEN$old$; BEGIN
 def:=pg_get_functiondef('public.register_unloading_actual(uuid,numeric,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.register_unloading_actual(uuid,numeric,text)'; END IF;
 EXECUTE replace(def,old,$new$IF NOT public.is_active_tms_user() OR NOT EXISTS(SELECT 1 FROM public.transport_requests t WHERE t.id=l.transport_request_id AND public.can_access_site(t.site_id)) THEN RETURN jsonb_build_object('success',false,'error','Sede no autorizada'); END IF;
  IF l.status <> 'PLANIFICADO' OR l.dispatch_id IS NULL THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF p_freight>0 AND owner IS NULL THEN RAISE EXCEPTION 'La solicitud necesita una OT con partida de transporte'; END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'; END IF;
 EXECUTE replace(def,old,$new$IF p_freight>0 AND owner IS NULL AND (NOT public.is_reference_transport(t) OR p_freight+COALESCE(t.unloading_estimate_pen,0)>t.operational_approved_pen) THEN RAISE EXCEPTION 'El adicional requiere una OC, OS o RQ aprobada y saldo autorizado'; END IF;$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF p_freight>0 THEN$old$; BEGIN
 def:=pg_get_functiondef('public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text)'; END IF;
 EXECUTE replace(def,old,$new$IF p_freight>0 AND owner IS NOT NULL THEN$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$f.amount_pen>0 AND f.status<>'LIBERADO' AND f.service_id IS NULL$old$; BEGIN
 def:=pg_get_functiondef('public.get_dispatch_freight_reconciliation_queue()'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.get_dispatch_freight_reconciliation_queue()'; END IF;
 EXECUTE replace(def,old,$new$f.contract_id IS NOT NULL AND f.amount_pen>0 AND f.status<>'LIBERADO' AND f.service_id IS NULL$new$);
END $patch$;

DO $patch$ DECLARE def text; old text:=$old$IF f.amount_pen<=0 OR f.status='LIBERADO' OR f.service_id IS NOT NULL THEN CONTINUE; END IF;$old$; BEGIN
 def:=pg_get_functiondef('public.reconcile_dispatch_freight(uuid)'::regprocedure);
 IF position(old IN def)=0 THEN RAISE EXCEPTION 'Motor no reconocido: public.reconcile_dispatch_freight(uuid)'; END IF;
 EXECUTE replace(def,old,$new$IF f.contract_id IS NULL OR f.amount_pen<=0 OR f.status='LIBERADO' OR f.service_id IS NOT NULL THEN CONTINUE; END IF;$new$);
END $patch$;

CREATE FUNCTION public.get_reference_service_registry(p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT (public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('clientes')) THEN
  RAISE EXCEPTION 'Sin permiso para consultar servicios'; END IF;
 IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from>p_to THEN RAISE EXCEPTION 'Rango de fechas inválido'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.service_date DESC,q.dispatch_number,q.request_number),'[]') INTO result
 FROM (
  SELECT x.*,t.request_number,t.request_type,d.dispatch_number,d.vehicle_plate AS plate,d.driver_name,d.status AS operation_state,
   (d.scheduled_departure AT TIME ZONE 'America/Lima')::date AS service_date,
   CASE WHEN d.status='CANCELADO' OR x.status='LIBERADO' THEN 'ANULADO'
    WHEN x.status='CONSUMIDO' AND d.status IN ('LIQUIDADO','CERRADO') AND NOT EXISTS(
      SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities dc ON dc.dispatch_id=dr.dispatch_id AND dc.request_id=dr.transport_request_id
      WHERE dr.dispatch_id=d.id AND dr.transport_request_id=t.id AND (dr.status IS DISTINCT FROM 'ENTREGADO' OR
        (public.delivery_required(dr.dispatch_id,dr.transport_request_id) AND dc.state IS DISTINCT FROM 'VALIDADA'))) THEN 'REALIZADO'
    ELSE 'COMPROMETIDO' END AS stage
  FROM (
   SELECT f.dispatch_id::text||':'||f.request_id::text AS id,f.dispatch_id,f.request_id,f.reference_type,f.reference_number,
    f.amount_pen,f.status,'FLETE'::text AS service_type,'Flete por referencia'::text AS description,NULL::text AS provider_name
   FROM public.dispatch_request_freight f WHERE f.contract_id IS NULL AND f.reference_type IS NOT NULL
   UNION ALL
   SELECT l.id::text,l.dispatch_id,l.transport_request_id,f.reference_type,f.reference_number,
    CASE WHEN l.status='CONSUMIDO' THEN COALESCE(l.actual_pen,0) ELSE COALESCE(l.planned_pen,0) END,
    CASE l.status WHEN 'CONSUMIDO' THEN 'CONSUMIDO' WHEN 'ANULADO' THEN 'LIBERADO' ELSE 'RESERVADO' END,
    public.unloading_service_type(l.concept),COALESCE(l.description,public.unloading_concept_label(l.concept)),l.provider_name
   FROM public.transport_unloading_costs l JOIN public.dispatch_request_freight f ON f.dispatch_id=l.dispatch_id AND f.request_id=l.transport_request_id
   WHERE l.contract_id IS NULL AND f.reference_type IS NOT NULL AND l.status IN ('PLANIFICADO','CONSUMIDO','ANULADO')
  ) x JOIN public.transport_requests t ON t.id=x.request_id JOIN public.dispatches d ON d.id=x.dispatch_id
  WHERE public.can_access_site(t.site_id) AND public.can_access_site(d.site_id)
   AND (NOT public.is_contract_administrator() OR public.has_assigned_request(t.id,false))
   AND (p_from IS NULL OR (d.scheduled_departure AT TIME ZONE 'America/Lima')::date>=p_from)
   AND (p_to IS NULL OR (d.scheduled_departure AT TIME ZONE 'America/Lima')::date<=p_to)
  ORDER BY d.scheduled_departure DESC,t.request_number LIMIT 500
 ) q;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_reference_service_registry(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_reference_service_registry(date,date) TO authenticated;

-- Solo levanta la observación presupuestal imposible de satisfacer en referencias válidas.
-- Nunca aprueba, reserva ni modifica solicitudes de otra modalidad ni observaciones de seguridad.
WITH repaired AS (
 UPDATE public.transport_requests t SET status='PENDIENTE DE APROBACIÓN',approved_at=NULL,approved_by=NULL,
   operational_approved_pen=0,budget_shortfall=0,budget_observation=NULL
 WHERE public.is_reference_transport(t) AND status='OBSERVADA'
  AND (budget_observation LIKE 'Vincule una OT%' OR budget_observation LIKE 'Partida insuficiente%')
  AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr WHERE dr.transport_request_id=t.id)
 RETURNING id
)
INSERT INTO public.transport_request_events(request_id,actor_id,action,next_state)
 SELECT id,NULL,'STATUS_CHANGED',jsonb_build_object('action','REFERENCE_FUNDING_REVIEW','status','PENDIENTE DE APROBACIÓN','reason','OC/OS/RQ: requiere aprobación operacional del Supervisor') FROM repaired;
NOTIFY pgrst,'reload schema';
COMMIT;
