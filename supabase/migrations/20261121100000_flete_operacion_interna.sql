-- Flete según quién ejecuta y cómo se financia el servicio:
-- 1) Flota propia: recojos y servicios sin OT (traslados y recojos con OC, OS o RQ) son operación interna, sin flete.
--    Con OT, el flete es costo logístico de su partida de transporte. Si toda la ruta es operación interna el flete
--    queda en 0; en rutas mixtas el flete se reparte solo entre los servicios con OT.
-- 2) Tercero: todo servicio tiene costo. Sin OT, el Supervisor de Transporte autoriza el flete pactado contra la
--    OC, OS o RQ al programar (recojos y, ahora, traslados).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. schedule_route_resources: misma lógica de 20261111100000_sustento_unidades_cobro + operación interna.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_supplier_person uuid; v_name text; v_doc text; v_rate numeric;
 v_license text; v_expiration date; v_phone text; v_registered_plate text; v_stop uuid; v_stops uuid[];
 v_freight numeric; v_freight_ref numeric; v_freight_reason text; v_all_internal boolean; v_customer_pickup boolean;
 v_own boolean := COALESCE(p->>'mode','') <> 'TERCERO'; v_internal_share numeric;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 -- Operación interna con flota propia: un servicio sin OT no lleva flete. Si toda la ruta es interna, el flete queda en 0;
 -- en una ruta mixta el flete debe repartirse solo entre los servicios con OT. (Los recojos con OT los normaliza schedule_dispatch.)
 IF v_own AND jsonb_typeof(p->'p_requests') = 'array' THEN
  SELECT COALESCE(sum(COALESCE(NULLIF(j->>'freight_share_pen','')::numeric, 0)) FILTER (WHERE t.contract_id IS NULL), 0),
   COALESCE(bool_and(t.contract_id IS NULL OR to_jsonb(t)->>'request_type' = 'RECOJO'), false)
  INTO v_internal_share, v_all_internal
  FROM jsonb_array_elements(p->'p_requests') j LEFT JOIN public.transport_requests t ON t.id = NULLIF(j->>'id','')::uuid;
  IF v_all_internal THEN
   p := jsonb_set(jsonb_set(p, '{p_requests}', (SELECT jsonb_agg(j || jsonb_build_object('freight_share_pen', 0) ORDER BY o)
     FROM jsonb_array_elements(p->'p_requests') WITH ORDINALITY x(j, o))), '{p_freight_cost}', to_jsonb(0));
  ELSIF v_internal_share > 0 THEN
   RAISE EXCEPTION 'Con flota propia, los servicios sin OT son operación interna y no llevan flete: reparta el flete solo entre los servicios con OT';
  END IF;
 END IF;
 -- Flete acordado vs. referencial (costo de las solicitudes que llevan flete). Operación interna con flota propia y Nota de Salida sin flete: sin motivo.
 v_freight := COALESCE(NULLIF(p->>'p_freight_cost','')::numeric, 0);
 v_freight_reason := NULLIF(btrim(COALESCE(p->>'freight_reason','')),'');
 SELECT COALESCE(sum(COALESCE(t.service_cost, 0)) FILTER (WHERE NOT v_own OR (t.contract_id IS NOT NULL AND to_jsonb(t)->>'request_type' IS DISTINCT FROM 'RECOJO')), 0),
  COALESCE(bool_and(t.contract_id IS NULL OR to_jsonb(t)->>'request_type' = 'RECOJO'), false),
  COALESCE(bool_or(to_jsonb(t)->>'attention_mode' = 'RECOJO_CLIENTE'), false)
 INTO v_freight_ref, v_all_internal, v_customer_pickup
 FROM public.transport_requests t
 WHERE t.id IN (SELECT NULLIF(j->>'id','')::uuid FROM jsonb_array_elements(COALESCE(p->'p_requests','[]'::jsonb)) j);
 IF round(v_freight, 2) <> round(v_freight_ref, 2)
    AND NOT (v_freight = 0 AND (p->>'p_document_type' = 'NOTA_SALIDA' OR v_customer_pickup OR (v_own AND v_all_internal))) THEN
  IF v_freight_reason IS NULL OR length(v_freight_reason) < 5 THEN
   RAISE EXCEPTION 'Justifique la diferencia del flete con el referencial de las solicitudes (S/ % → S/ %)', round(v_freight_ref, 2), round(v_freight, 2);
  END IF;
  IF length(v_freight_reason) > 500 THEN RAISE EXCEPTION 'Motivo del flete demasiado extenso'; END IF;
 ELSE
  v_freight_reason := NULL;
 END IF;
 -- El evento ACORDADO del flete (dispatch_freight_stage_sync) toma el motivo al crear el despacho.
 PERFORM set_config('tms.cost_reason', COALESCE(v_freight_reason, ''), true);
 IF p->>'mode'='TERCERO' THEN
  v_id:=public.schedule_dispatch_tercero((p->>'p_carrier_id')::uuid,p->>'p_plate',p->>'p_conductor',p->>'p_telefono',p->>'p_doc',
   (p->>'p_departure')::timestamptz,(p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->'p_requests');
 ELSE
  v_id:=public.schedule_dispatch((p->>'p_driver_id')::uuid,p->>'p_vehicle_plate',(p->>'p_departure')::timestamptz,
   (p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->>'p_document_type',p->'p_requests');
 END IF;
 PERFORM set_config('tms.cost_reason', '', true);
 IF v_freight_reason IS NOT NULL THEN
  UPDATE public.dispatch_freight_stages SET agreed_reason = v_freight_reason, updated_at = now() WHERE dispatch_id = v_id AND agreed_reason IS DISTINCT FROM v_freight_reason;
 END IF;
 IF p->>'mode'='TERCERO' THEN
  UPDATE public.dispatches SET tercero_license_number=NULLIF(btrim(p->>'p_tercero_license_number'),''),
   tercero_license_expiration=NULLIF(p->>'p_tercero_license_expiration','')::date WHERE id=v_id;
  IF NULLIF(p->>'p_supplier_personnel_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.full_name,x.document_number,x.license_number,x.license_expiration,x.phone FROM public.supplier_personnel x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING (p->>'p_supplier_personnel_id')::uuid,v_id;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El conductor no pertenece al transportista seleccionado o está inactivo'; END IF;
   UPDATE public.dispatches SET tercero_conductor=v_name,tercero_doc=v_doc,tercero_telefono=v_phone,tercero_license_number=v_license,tercero_license_expiration=v_expiration WHERE id=v_id;
  END IF;
  IF NULLIF(p->>'p_supplier_vehicle_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.plate FROM public.supplier_vehicles x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_registered_plate USING (p->>'p_supplier_vehicle_id')::uuid,v_id;
   IF v_registered_plate IS NULL OR upper(regexp_replace(v_registered_plate,'[^A-Za-z0-9]','','g'))<>upper(regexp_replace((SELECT vehicle_plate FROM public.dispatches WHERE id=v_id),'[^A-Za-z0-9]','','g')) THEN
    RAISE EXCEPTION 'La placa seleccionada no corresponde a una unidad activa del transportista';
   END IF;
  END IF;
 END IF;
 IF jsonb_array_length(COALESCE(p->'auxiliaries','[]'::jsonb))>0 THEN
  v_result:=public.set_route_auxiliaries(v_id,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p->'auxiliaries')));
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 IF f IS NOT NULL AND f<>'null'::jsonb THEN
  v_stop:=NULLIF(f->>'transport_request_id','')::uuid;
  SELECT array_agg(dr.transport_request_id) INTO v_stops FROM public.dispatch_requests dr WHERE dr.dispatch_id=v_id;
  IF v_stop IS NULL AND cardinality(v_stops)=1 THEN v_stop:=v_stops[1]; END IF;
  IF v_stop IS NULL OR NOT COALESCE(v_stop=ANY(v_stops),false) THEN
   RAISE EXCEPTION 'Seleccione la parada de esta ruta donde se usará el montacarga';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=(f->>'supplier_id')::uuid AND is_active) THEN RAISE EXCEPTION 'Seleccione un proveedor activo de montacarga'; END IF;
  v_rate:=NULLIF(f->>'hourly_rate','')::numeric;
  IF v_rate IS NULL OR v_rate<=0 OR v_rate>100000 THEN RAISE EXCEPTION 'Ingrese una tarifa por hora válida'; END IF;
  v_person:=NULLIF(f->>'person_id','')::uuid;
  IF v_person IS NOT NULL THEN
   SELECT * INTO hp FROM public.hhee_people WHERE id=v_person AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Montacarguista inactivo o inexistente'; END IF;
   v_name:=hp.name; v_doc:=hp.document_number;
  ELSE v_name:=btrim(f->>'operator_name'); v_doc:=NULLIF(btrim(f->>'document_number'),''); END IF;
  IF COALESCE(length(v_name),0)<3 OR length(v_name)>200 THEN RAISE EXCEPTION 'Indique el nombre del montacarguista'; END IF;
  IF length(COALESCE(f->>'notes',''))>1000 OR length(COALESCE(f->>'license_number',''))>100 OR length(COALESCE(v_doc,''))>50 OR length(COALESCE(f->>'phone',''))>50 THEN RAISE EXCEPTION 'Datos de montacarga demasiado extensos'; END IF;
  INSERT INTO public.route_forklifts(dispatch_id,supplier_id,person_id,operator_name,document_number,license_number,license_expiration,phone,notes,assigned_by,hourly_rate,transport_request_id)
   VALUES(v_id,(f->>'supplier_id')::uuid,v_person,v_name,v_doc,NULLIF(btrim(f->>'license_number'),''),NULLIF(f->>'license_expiration','')::date,NULLIF(btrim(f->>'phone'),''),NULLIF(btrim(f->>'notes'),''),auth.uid(),v_rate,v_stop);
  v_supplier_person:=NULLIF(f->>'supplier_personnel_id','')::uuid;
  IF v_supplier_person IS NOT NULL THEN
   EXECUTE 'SELECT full_name,document_number,license_number,license_expiration,phone FROM public.supplier_personnel WHERE id=$1 AND supplier_id=$2 AND is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING v_supplier_person,(f->>'supplier_id')::uuid;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El montacarguista no pertenece al proveedor seleccionado o está inactivo'; END IF;
   EXECUTE 'UPDATE public.route_forklifts SET supplier_personnel_id=$1,operator_name=$2,document_number=$3,license_number=$4,license_expiration=$5,phone=$6 WHERE dispatch_id=$7'
    USING v_supplier_person,v_name,v_doc,v_license,v_expiration,v_phone,v_id;
  END IF;
 END IF;
 -- Servicios especiales pedidos en la solicitud: pasan a la ruta (sin duplicar) y el montacarga se vincula.
 PERFORM public.inherit_route_unloading(v_id);
 -- Costos acordados con proveedores (y servicios agregados o retirados con motivo)
 IF p->'special_services' IS NOT NULL AND p->'special_services'<>'null'::jsonb THEN
  v_result:=public.set_special_service_agreements(v_id,p->'special_services');
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.schedule_route_resources(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_route_resources(jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 2. Tercero en un servicio sin OT: el Supervisor de Transporte autoriza el flete pactado contra la OC, OS o RQ.
--    Misma función de 20261013180000_own_fleet_pickup_documentation, ahora también para traslados.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_pickup_reference_freight(p_request_id uuid,p_expected_cost numeric,
 p_reference_type text,p_reference_number text,p_freight numeric,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.transport_requests%ROWTYPE;
BEGIN
 IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
   RAISE EXCEPTION 'Solo el Supervisor de Transporte puede autorizar el flete del tercero'; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=p_request_id FOR UPDATE;
 IF t.id IS NULL OR NOT public.can_access_site(t.site_id) OR NOT public.is_reference_transport(t)
   OR t.request_type NOT IN ('RECOJO','TRASLADO') OR t.attention_mode<>'TRANSPORTE_JRM'
   OR t.status NOT IN ('APROBADA','REPROGRAMADA') OR t.approved_at IS NULL
   OR EXISTS(SELECT 1 FROM public.dispatch_requests r JOIN public.dispatches d ON d.id=r.dispatch_id
     WHERE r.transport_request_id=t.id AND d.status<>'CANCELADO') THEN
   RAISE EXCEPTION 'El servicio aprobado (recojo o traslado sin OT) no está disponible para cotizar al tercero'; END IF;
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
