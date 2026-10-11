BEGIN;
-- A route amendment is atomic, auditable and replayable. No public table writes.
CREATE TABLE public.dispatch_service_additions (
 operation_id uuid PRIMARY KEY,
 dispatch_id uuid NOT NULL REFERENCES public.dispatches(id),
 request_id uuid NOT NULL REFERENCES public.transport_requests(id),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL,
 expected_at timestamptz NOT NULL,
 available_kg numeric NOT NULL,
 cargo_kg numeric NOT NULL,
 extra_km numeric NOT NULL,
 result jsonb NOT NULL,
 UNIQUE(dispatch_id,request_id)
);
ALTER TABLE public.dispatch_service_additions ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.dispatch_service_additions AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.dispatch_service_additions FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.active_route_context(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; frontier int; revision text; stops jsonb; requests jsonb;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch;
 IF NOT public.is_active_tms_user() OR d.id IS NULL OR NOT public.can_access_site(d.site_id) OR NOT public.has_tms_permission('despacho')
 OR NOT (public.is_tms_admin() OR public.delivery_can_review(p_dispatch)) THEN
   RAISE EXCEPTION 'Solo el Supervisor de Transporte puede agregar servicios de su sede'; END IF;
 IF d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') OR d.vehicle_plate='EXTERNO' THEN
   RAISE EXCEPTION 'La ruta no admite nuevos servicios'; END IF;
 -- Freeze the current leg even without GPS coverage. Completed/arrived legs never move.
 SELECT greatest(COALESCE(max(dr.sequence_order) FILTER(WHERE dr.status='ENTREGADO' OR c.arrived_at IS NOT NULL OR c.state IN ('RECIBIDA','VALIDADA')),0),
   CASE WHEN d.status<>'PROGRAMADO' THEN COALESCE(min(dr.sequence_order) FILTER(WHERE dr.status<>'ENTREGADO'),0) ELSE 0 END,
   COALESCE((SELECT max(leg_order) FROM public.route_track_points WHERE dispatch_id=p_dispatch),0))
 INTO frontier FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
 WHERE dr.dispatch_id=p_dispatch;
 SELECT md5(COALESCE(string_agg(dr.transport_request_id::text||':'||dr.sequence_order||':'||dr.status||':'||COALESCE(c.state,'')||':'||COALESCE(c.arrived_at::text,''),'|' ORDER BY dr.sequence_order),'')||':'||frontier||':'||d.status),
 COALESCE(jsonb_agg(jsonb_build_object('id',dr.transport_request_id,'order',dr.sequence_order,'status',dr.status,'locked',dr.sequence_order<=frontier,
   'number',t.request_number,'origin',t.pickup_address,'destination',t.delivery_address,'ot',ct.code) ORDER BY dr.sequence_order),'[]')
 INTO revision,stops FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
 LEFT JOIN public.contracts ct ON ct.id=t.contract_id LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id WHERE dr.dispatch_id=p_dispatch;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',t.id,'number',t.request_number,'type',to_jsonb(t)->>'request_type','ot',ct.code,
 'origin',t.pickup_address,'destination',t.delivery_address,'required_at',to_jsonb(t)->>'required_at','required_date',to_jsonb(t)->>'required_date',
 'weight_kg',to_jsonb(t)->>'estimated_weight') ORDER BY t.required_date,t.id),'[]') INTO requests
 FROM public.transport_requests t LEFT JOIN public.contracts ct ON ct.id=t.contract_id
 WHERE t.status IN ('APROBADA','REPROGRAMADA') AND t.approved_at IS NOT NULL AND t.site_id IS NOT DISTINCT FROM d.site_id
 AND t.attention_mode='TRANSPORTE_JRM' AND public.request_party_missing(t.id) IS NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests x JOIN public.dispatches y ON y.id=x.dispatch_id
 WHERE x.transport_request_id=t.id AND y.status<>'CANCELADO');
 RETURN jsonb_build_object('revision',revision,'frontier',frontier,'stops',stops,'requests',requests,
 'capacity_kg',(SELECT NULLIF(to_jsonb(v)->>'weight_capacity','')::numeric FROM public.vehicles v WHERE v.plate=d.vehicle_plate),
 'dispatch',jsonb_build_object('id',d.id,'number',d.dispatch_number,'plate',d.vehicle_plate,'driver',d.driver_name,'status',d.status));
END $$;

CREATE FUNCTION public.add_active_route_service(p_dispatch uuid,p_request uuid,p_before uuid,p_revision text,p_operation uuid,
 p_freight numeric,p_extra_km numeric,p_cargo_kg numeric,p_available_kg numeric,p_expected_at timestamptz,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; t public.transport_requests%ROWTYPE; context jsonb; receipt record;
 owner uuid; b public.contract_budgets%ROWTYPE; pos int; frontier int; first_request uuid; old_service uuid; service uuid; result jsonb;
 due_at timestamptz; capacity numeric; profile uuid;
BEGIN
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF NOT public.is_active_tms_user() OR d.id IS NULL OR NOT public.can_access_site(d.site_id) OR NOT public.has_tms_permission('despacho')
 OR NOT (public.is_tms_admin() OR public.delivery_can_review(p_dispatch)) THEN RAISE EXCEPTION 'Solo el Supervisor de Transporte puede agregar servicios de su sede'; END IF;
 SELECT * INTO receipt FROM public.dispatch_service_additions WHERE operation_id=p_operation;
 IF FOUND THEN
   IF receipt.dispatch_id IS DISTINCT FROM p_dispatch OR receipt.request_id IS DISTINCT FROM p_request OR receipt.created_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Operación de otro usuario o servicio'; END IF;
   RETURN receipt.result;
 END IF;
 context:=public.active_route_context(p_dispatch);
 IF p_operation IS NULL OR p_revision IS DISTINCT FROM context->>'revision' THEN RAISE EXCEPTION 'La ruta cambió. Actualice antes de confirmar'; END IF;
 IF p_freight IS NULL OR p_freight<0 OR p_freight<>round(p_freight,2) OR p_extra_km IS NULL OR p_extra_km<0
 OR p_cargo_kg IS NULL OR p_cargo_kg<=0 OR p_available_kg IS NULL OR p_available_kg<p_cargo_kg
 OR p_expected_at IS NULL OR p_expected_at<now() OR length(trim(COALESCE(p_reason,'')))<10
 OR length(trim(COALESCE(p_reason,'')))>500
 OR p_freight::text IN ('NaN','Infinity','-Infinity') OR p_extra_km::text IN ('NaN','Infinity','-Infinity')
 OR p_cargo_kg::text IN ('NaN','Infinity','-Infinity') OR p_available_kg::text IN ('NaN','Infinity','-Infinity') THEN
 RAISE EXCEPTION 'Confirme costo, kilómetros, capacidad disponible, peso, hora y motivo (mínimo 10 caracteres)'; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=p_request FOR UPDATE;
 IF t.id IS NULL OR t.status NOT IN ('APROBADA','REPROGRAMADA') OR t.approved_at IS NULL OR t.attention_mode<>'TRANSPORTE_JRM'
 OR t.site_id IS DISTINCT FROM d.site_id OR EXISTS(SELECT 1 FROM public.dispatch_requests x JOIN public.dispatches y ON y.id=x.dispatch_id
 WHERE x.transport_request_id=p_request AND y.status<>'CANCELADO') THEN RAISE EXCEPTION 'Solicitud no disponible para esta ruta'; END IF;
 IF public.request_party_missing(p_request) IS NOT NULL THEN RAISE EXCEPTION 'Vincule el cliente o proveedor de la solicitud antes de asignarla'; END IF;
 IF COALESCE(NULLIF(to_jsonb(t)->>'estimated_weight','')::numeric,0)>p_cargo_kg THEN RAISE EXCEPTION 'El peso no puede ser menor que el registrado en la solicitud'; END IF;
 capacity:=NULLIF(context->>'capacity_kg','')::numeric;
 IF capacity>0 AND p_available_kg>capacity THEN RAISE EXCEPTION 'La capacidad disponible supera la capacidad de la unidad'; END IF;
 due_at:=COALESCE(NULLIF(to_jsonb(t)->>'required_at','')::timestamptz,
   ((NULLIF(to_jsonb(t)->>'required_date','')::date+1)::timestamp AT TIME ZONE 'America/Lima')-interval '1 second');
 IF due_at IS NULL OR p_expected_at>due_at THEN RAISE EXCEPTION 'La hora prevista supera la atención solicitada'; END IF;
 frontier:=(context->>'frontier')::int;
 IF p_before IS NULL THEN SELECT COALESCE(max(sequence_order),0)+1 INTO pos FROM public.dispatch_requests WHERE dispatch_id=p_dispatch;
 ELSE SELECT sequence_order INTO pos FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_before;
   IF pos IS NULL OR pos<=frontier THEN RAISE EXCEPTION 'No se puede modificar una parada atendida o el tramo iniciado'; END IF;
 END IF;
 owner:=public.contract_budget_owner(t.contract_id);
 IF p_freight>0 AND owner IS NULL THEN RAISE EXCEPTION 'La solicitud necesita una OT con partida de transporte'; END IF;
 -- Release the existing request reservation through its installed trigger, then reserve only the amendment.
 UPDATE public.transport_requests SET status='ASIGNADA' WHERE id=p_request;
 IF p_freight>0 THEN
   SELECT * INTO b FROM public.contract_budgets WHERE contract_id=owner AND concept='PARTIDA_TRANSPORTE' FOR UPDATE;
   IF b.balance_pen<p_freight THEN RAISE EXCEPTION 'Saldo operativo insuficiente. Solo se dispone del 80%% de la partida'; END IF;
   UPDATE public.contract_budgets SET reserved_pen=reserved_pen+p_freight,updated_at=now() WHERE id=b.id;
 END IF;
 -- Legacy single-OT freight remains one historical reservation, linked to its first stop.
 -- Do not create replacement services or redistribute the original amount across unrelated OT.
 IF d.contract_id IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id=p_dispatch) THEN RAISE EXCEPTION 'La reserva actual requiere conciliación antes de ampliar la ruta'; END IF;
   SELECT transport_request_id INTO first_request FROM public.dispatch_requests WHERE dispatch_id=p_dispatch ORDER BY sequence_order LIMIT 1;
   IF first_request IS NULL THEN RAISE EXCEPTION 'La ruta no tiene servicios originales'; END IF;
   SELECT id INTO old_service FROM public.contract_services WHERE dispatch_id=p_dispatch AND service_type='FLETE' AND status IS DISTINCT FROM 'ANULADO' ORDER BY id LIMIT 1;
   INSERT INTO public.dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id)
   SELECT p_dispatch,dr.transport_request_id,d.contract_id,CASE WHEN dr.transport_request_id=first_request THEN COALESCE(d.freight_cost,0) ELSE 0 END,
     CASE WHEN dr.transport_request_id=first_request THEN old_service ELSE NULL END FROM public.dispatch_requests dr WHERE dr.dispatch_id=p_dispatch;
 END IF;
 -- Reverse updates avoid transient sequence collisions if a unique sequence index is installed.
 FOR receipt IN SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND sequence_order>=pos ORDER BY sequence_order DESC LOOP
   UPDATE public.dispatch_requests SET sequence_order=sequence_order+1 WHERE dispatch_id=p_dispatch AND transport_request_id=receipt.transport_request_id;
 END LOOP;
 INSERT INTO public.dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_type)
 VALUES(p_dispatch,p_request,'PROGRAMADO',pos,'GR');
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(p_dispatch,p_request) ON CONFLICT DO NOTHING;
 IF p_freight>0 THEN
   INSERT INTO public.contract_services(contract_id,service_type,description,amount_pen,service_date,plate,driver_name,category,created_by,dispatch_id,budget_contract_id)
   VALUES(t.contract_id,'FLETE','Servicio adicional '||t.request_number||' · '||d.dispatch_number,p_freight,(p_expected_at AT TIME ZONE 'America/Lima')::date,d.vehicle_plate,d.driver_name,'Contrato',auth.uid(),p_dispatch,owner) RETURNING id INTO service;
 END IF;
 INSERT INTO public.dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id) VALUES(p_dispatch,p_request,owner,p_freight,service);
 UPDATE public.dispatches SET contract_id=NULL,freight_cost=COALESCE(freight_cost,0)+p_freight,
 estimated_distance_km=COALESCE(estimated_distance_km,0)+p_extra_km WHERE id=p_dispatch;
 result:=jsonb_build_object('success',true,'dispatch_id',p_dispatch,'request_id',p_request,'order',pos);
 INSERT INTO public.dispatch_service_additions VALUES(p_operation,p_dispatch,p_request,auth.uid(),now(),trim(p_reason),p_expected_at,p_available_kg,p_cargo_kg,p_extra_km,result);
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'SERVICIO_AGREGADO',t.request_number||' · OT '||COALESCE((SELECT code FROM public.contracts WHERE id=t.contract_id),'sin OT')||' · posición '||pos||' · +'||p_extra_km||' km · S/ '||p_freight||' · '||trim(p_reason),auth.uid()::text);
 SELECT profile_id INTO profile FROM public.drivers WHERE id=d.driver_id;
 IF profile IS NOT NULL THEN
 INSERT INTO public.notifications(evento,categoria,severidad,titulo,cuerpo,link,permisos,target_user,dedupe_key)
 VALUES('RUTA_SERVICIO_AGREGADO','DESPACHO','warning','Nuevo servicio en tu ruta',t.request_number||': revisa el orden actualizado antes de continuar.','/app/ruta','{}',profile,'ruta-servicio:'||p_operation);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.active_route_context(uuid),public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.active_route_context(uuid),public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamptz,text) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
