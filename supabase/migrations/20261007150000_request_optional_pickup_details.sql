-- Request simplification: no site/cost-center selection, optional pickup contacts, OT finances JRM costs.
-- Existing columns and executed financial history are retained.

CREATE OR REPLACE FUNCTION public.save_transport_request(
  p_request_id uuid, p_payload jsonb, p_components jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root public.contracts%ROWTYPE;
DECLARE v_existing public.transport_requests%ROWTYPE;
DECLARE v_item jsonb;
DECLARE v_component public.contracts%ROWTYPE;
DECLARE v_request_id uuid;
DECLARE v_number text;
DECLARE v_date date;
DECLARE v_cost numeric;
DECLARE v_weight numeric;
DECLARE v_volume numeric;
DECLARE v_used numeric;
DECLARE v_total_weight numeric := 0;
DECLARE v_total_volume numeric := 0;
DECLARE v_has_weight boolean := false;
DECLARE v_has_volume boolean := false;
DECLARE v_requester text;
DECLARE v_before jsonb;
DECLARE v_destinations integer;
DECLARE v_available numeric;
DECLARE v_shortfall numeric := 0;
DECLARE v_status text;
DECLARE v_mode text := COALESCE(NULLIF(p_payload->>'attention_mode',''), 'TRANSPORTE_JRM');
DECLARE v_site uuid;

BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para guardar solicitudes';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR
     p_components IS NULL OR jsonb_typeof(p_components) <> 'array' OR
     jsonb_array_length(p_components) NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Selecciona al menos un componente';
  END IF;
  IF v_mode NOT IN ('TRANSPORTE_JRM','RECOJO_CLIENTE') THEN RAISE EXCEPTION 'Modalidad de atención inválida'; END IF;
  IF NULLIF(p_payload->>'contract_id','') IS NULL AND
     (public.is_contract_administrator() OR public.request_area_requires_ot(p_payload->>'department')) THEN
    RAISE EXCEPTION 'El área OT / Administración de Contratos requiere una OT activa';
  END IF;
  IF NULLIF(p_payload->>'contract_id','') IS NOT NULL THEN
    SELECT * INTO v_root FROM public.contracts WHERE id = (p_payload->>'contract_id')::uuid
      AND type IN ('CONTRATO','OT_INDEPENDIENTE') AND parent_contract_id IS NULL AND status = 'ACTIVO' FOR UPDATE;
    IF v_root.id IS NULL OR NOT public.can_access_site(v_root.site_id) OR
       (public.is_contract_administrator() AND NOT public.has_assigned_contract(v_root.id,true)) THEN
      RAISE EXCEPTION 'Selecciona una OT madre asignada y activa';
    END IF;
    IF jsonb_array_length(p_components)=0 THEN RAISE EXCEPTION 'Selecciona al menos un componente'; END IF;
    v_site := v_root.site_id;
  ELSE
    IF jsonb_array_length(p_components)<>0 THEN RAISE EXCEPTION 'No se admiten componentes sin OT'; END IF;
    -- Site is internal access scope, inherited from the edited request or the user's authorized default.
    v_site := NULLIF(p_payload->>'site_id','')::uuid;
    IF v_site IS NULL AND p_request_id IS NOT NULL THEN
      SELECT site_id INTO v_site FROM public.transport_requests WHERE id=p_request_id;
    END IF;
    IF v_site IS NULL THEN
      v_site := public.primary_site_id();
      IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
        SELECT a.site_id INTO v_site FROM public.user_site_access a
        WHERE a.user_id=auth.uid() AND public.can_access_site(a.site_id) ORDER BY a.site_id LIMIT 1;
      END IF;
    END IF;
    IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
      RAISE EXCEPTION 'El usuario no tiene una sede autorizada; solicite al administrador que asigne su acceso';
    END IF;
  END IF;
  -- Pickup identity/contact can be completed later; it never conditions request registration.
  v_date := nullif(p_payload->>'required_date','')::date;
  IF v_date IS NULL OR (v_date < current_date AND p_request_id IS NULL) THEN
    RAISE EXCEPTION 'Fecha requerida inválida';
  END IF;
  IF coalesce(p_payload->>'request_type','') NOT IN ('DESPACHO','RECOJO','TRASLADO') OR
     length(trim(coalesce(p_payload->>'department',''))) = 0 OR
     length(trim(coalesce(p_payload->>'cargo_description',''))) = 0 OR
     length(trim(coalesce(p_payload->>'pickup_address',''))) = 0 OR
     length(trim(coalesce(p_payload->>'delivery_address',''))) = 0 OR
     length(trim(coalesce(p_payload->>'pickup_district',''))) = 0 OR
     length(trim(coalesce(p_payload->>'delivery_district',''))) = 0 THEN
    RAISE EXCEPTION 'Completa tipo, área, descripción, origen y destino';
  END IF;
  v_cost := CASE WHEN v_mode='RECOJO_CLIENTE' THEN 0 ELSE coalesce(nullif(p_payload->>'service_cost','')::numeric, 0) END;
  IF v_cost < 0 OR v_cost > 99999999.99 THEN RAISE EXCEPTION 'Costo estimado inválido'; END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
    IF v_existing.id IS NULL OR
      NOT public.can_access_site(v_existing.site_id) OR
      (public.is_contract_administrator() AND NOT public.has_assigned_request(v_existing.id,true)) OR
      v_existing.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','REPROGRAMADA','APROBADA','OBSERVADA') OR
      EXISTS (SELECT 1 FROM public.dispatch_requests WHERE transport_request_id = p_request_id) THEN
      RAISE EXCEPTION 'La solicitud ya no se puede editar';
    END IF;
    SELECT jsonb_build_object('attention_mode', v_existing.attention_mode, 'cost_center_id',v_existing.cost_center_id, 'contract_id', v_existing.contract_id,
      'weight_kg', v_existing.estimated_weight, 'volume_m3', v_existing.estimated_volume,
      'estimated_cost_pen', v_existing.service_cost, 'status', v_existing.status,
      'required_date', v_existing.required_date,
      'components', coalesce(jsonb_agg(jsonb_build_object(
        'contract_id', i.component_contract_id, 'weight_kg', i.requested_weight_kg,
        'volume_m3', i.requested_volume_m3)) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb))
    INTO v_before FROM public.transport_request_components i WHERE i.request_id = p_request_id;
  END IF;

  IF v_root.id IS NULL THEN
    v_total_weight := COALESCE(NULLIF(p_payload->>'estimated_weight','')::numeric,0);
    v_total_volume := COALESCE(NULLIF(p_payload->>'estimated_volume','')::numeric,0);
    v_has_weight := true; v_has_volume := true;
    IF v_total_weight<0 OR v_total_volume<0 THEN RAISE EXCEPTION 'Peso o volumen inválido'; END IF;
  END IF;
  -- F2: la partida no bloquea el registro; si no alcanza, la solicitud queda OBSERVADA (no se aprueba ni
  -- programa hasta ampliar la partida). Una edición vuelve a pasar por aprobación (libera su reserva).
  v_available := coalesce((SELECT balance_pen FROM public.contract_budgets
    WHERE contract_id = v_root.id AND concept = 'PARTIDA_TRANSPORTE'), 0) + coalesce(v_existing.reserved_pen, 0);
  v_shortfall := CASE WHEN v_root.id IS NOT NULL AND v_cost > v_available THEN v_cost - v_available ELSE 0 END;
  v_status := CASE WHEN v_shortfall > 0 THEN 'OBSERVADA' ELSE 'PENDIENTE DE APROBACIÓN' END;

  -- Lock every selected contract in a stable order before checking the outstanding load.
  PERFORM 1 FROM public.contracts c WHERE c.id IN (
    SELECT (value->>'contract_id')::uuid FROM jsonb_array_elements(p_components)
  ) ORDER BY c.id FOR UPDATE;
  SELECT count(DISTINCT nullif(trim(c.destination_address),'')) INTO v_destinations
  FROM public.contracts c WHERE c.id IN (
    SELECT (value->>'contract_id')::uuid FROM jsonb_array_elements(p_components)
  );
  IF v_destinations > 1 AND coalesce(p_payload->>'destination_acknowledged','false') <> 'true' THEN
    RAISE EXCEPTION 'Los componentes tienen destinos diferentes; confirma el destino principal';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    SELECT * INTO v_component FROM public.contracts
      WHERE id = (v_item->>'contract_id')::uuid;
    IF v_component.id IS NULL OR v_component.status <> 'ACTIVO' OR
       v_component.site_id <> v_root.site_id OR NOT (
         v_component.id = v_root.id OR
         (v_component.parent_contract_id = v_root.id AND
          v_component.type IN ('SUBCONTRATO','ERROR'))
       ) THEN RAISE EXCEPTION 'Componente ajeno o inactivo en la OT seleccionada'; END IF;
    IF v_component.type = 'ERROR' AND v_component.subcontract_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.contracts s WHERE s.id = v_component.subcontract_id
         AND s.parent_contract_id = v_root.id AND s.type = 'SUBCONTRATO') THEN
      RAISE EXCEPTION 'El Error no pertenece al Subcontrato de esta OT';
    END IF;
    v_weight := nullif(v_item->>'weight_kg','')::numeric;
    v_volume := nullif(v_item->>'volume_m3','')::numeric;
    IF (v_weight IS NOT NULL AND (v_weight < 0 OR v_weight > 100000000)) OR
       (v_volume IS NOT NULL AND (v_volume < 0 OR v_volume > 100000000)) THEN
      RAISE EXCEPTION 'Peso o volumen inválido';
    END IF;
    SELECT coalesce(sum(i.requested_weight_kg),0) INTO v_used
    FROM public.transport_request_components i
    JOIN public.transport_requests r ON r.id = i.request_id
    WHERE i.component_contract_id = v_component.id
      AND r.id IS DISTINCT FROM p_request_id AND r.status NOT IN ('CANCELADA','RECHAZADA');
    IF v_weight IS NOT NULL AND coalesce(v_component.total_weight_kg,0) > 0 AND
       v_used + v_weight > v_component.total_weight_kg + 0.01 THEN
      RAISE EXCEPTION 'El peso solicitado supera el pendiente del componente %', v_component.code;
    END IF;
    IF v_weight IS NOT NULL THEN v_total_weight := v_total_weight + v_weight; v_has_weight := true; END IF;
    IF v_volume IS NOT NULL THEN v_total_volume := v_total_volume + v_volume; v_has_volume := true; END IF;
  END LOOP;
  IF v_total_weight > 99999999.99 OR v_total_volume > 99999999.99 THEN
    RAISE EXCEPTION 'El total de peso o volumen supera la capacidad del registro';
  END IF;

  SELECT coalesce(nullif(trim(concat_ws(' ',p.first_name,p.last_name)),''),
    nullif(trim(p_payload->>'requester_name'),'')) INTO v_requester
  FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active = true;
  IF v_requester IS NULL THEN RAISE EXCEPTION 'Perfil solicitante inactivo'; END IF;
  IF public.is_tms_admin() AND length(trim(coalesce(p_payload->>'requester_name',''))) > 0 THEN
    v_requester := trim(p_payload->>'requester_name');
  END IF;

  IF p_request_id IS NULL THEN
    LOOP
      v_number := 'RT-' || lpad(nextval('public.transport_request_number_seq')::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.transport_requests WHERE request_number = v_number);
    END LOOP;
    INSERT INTO public.transport_requests(request_number, requester_name, department,
      pickup_address, pickup_department, pickup_province, pickup_district,
      delivery_address, delivery_department, delivery_province, delivery_district,
      required_date, time_window, cargo_description, estimated_weight, estimated_volume,
      request_type, contract_id, purchase_order, service_cost, site_id, created_by, status,
      budget_shortfall, budget_observation, attention_mode)
    VALUES (v_number, v_requester, trim(p_payload->>'department'),
      trim(p_payload->>'pickup_address'), nullif(p_payload->>'pickup_department',''),
      nullif(p_payload->>'pickup_province',''), trim(p_payload->>'pickup_district'),
      trim(p_payload->>'delivery_address'), nullif(p_payload->>'delivery_department',''),
      nullif(p_payload->>'delivery_province',''), trim(p_payload->>'delivery_district'),
      v_date, nullif(p_payload->>'time_window',''), trim(p_payload->>'cargo_description'),
      v_total_weight, v_total_volume, p_payload->>'request_type', v_root.id,
      nullif(p_payload->>'purchase_order',''), v_cost, v_site, auth.uid(),
      v_status, v_shortfall, CASE WHEN v_shortfall > 0 THEN 'Partida insuficiente: faltan S/ ' || round(v_shortfall, 2) END, v_mode)
      RETURNING id INTO v_request_id;
  ELSE
    v_request_id := p_request_id;
    DELETE FROM public.transport_request_components WHERE request_id = v_request_id;
    UPDATE public.transport_requests SET requester_name = v_requester, attention_mode=v_mode,
      department = trim(p_payload->>'department'),
      pickup_address = trim(p_payload->>'pickup_address'),
      pickup_department = nullif(p_payload->>'pickup_department',''),
      pickup_province = nullif(p_payload->>'pickup_province',''),
      pickup_district = trim(p_payload->>'pickup_district'),
      delivery_address = trim(p_payload->>'delivery_address'),
      delivery_department = nullif(p_payload->>'delivery_department',''),
      delivery_province = nullif(p_payload->>'delivery_province',''),
      delivery_district = trim(p_payload->>'delivery_district'),
      required_date = v_date, time_window = nullif(p_payload->>'time_window',''),
      cargo_description = trim(p_payload->>'cargo_description'),
      estimated_weight = CASE WHEN v_has_weight THEN v_total_weight ELSE estimated_weight END,
      estimated_volume = CASE WHEN v_has_volume THEN v_total_volume ELSE estimated_volume END,
      request_type = p_payload->>'request_type', contract_id = v_root.id,
      purchase_order = nullif(p_payload->>'purchase_order',''), service_cost = v_cost,
      site_id = v_site, updated_at = now(), status = v_status, budget_shortfall = v_shortfall,
      budget_observation = CASE WHEN v_shortfall > 0 THEN 'Partida insuficiente: faltan S/ ' || round(v_shortfall, 2) END
    WHERE id = v_request_id;
  END IF;
  UPDATE public.transport_requests SET attention_mode=v_mode, cost_center_id=NULL,
    pickup_customer=CASE WHEN p_payload ? 'pickup_customer' THEN NULLIF(trim(p_payload->>'pickup_customer'),'') ELSE pickup_customer END, pickup_contact=CASE WHEN p_payload ? 'pickup_contact' THEN NULLIF(trim(p_payload->>'pickup_contact'),'') ELSE pickup_contact END,
    pickup_phone=CASE WHEN p_payload ? 'pickup_phone' THEN NULLIF(trim(p_payload->>'pickup_phone'),'') ELSE pickup_phone END WHERE id=v_request_id;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    INSERT INTO public.transport_request_components(request_id, component_contract_id,
      requested_weight_kg, requested_volume_m3)
    VALUES (v_request_id, (v_item->>'contract_id')::uuid,
      nullif(v_item->>'weight_kg','')::numeric,
      nullif(v_item->>'volume_m3','')::numeric);
  END LOOP;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  SELECT v_request_id, auth.uid(), CASE WHEN p_request_id IS NULL THEN 'CREATED' ELSE 'UPDATED' END,
    v_before, jsonb_build_object('attention_mode',v_mode,'cost_center_id',NULL,'contract_id', v_root.id,
      'weight_kg', (SELECT estimated_weight FROM public.transport_requests WHERE id = v_request_id),
      'volume_m3', (SELECT estimated_volume FROM public.transport_requests WHERE id = v_request_id),
      'estimated_cost_pen', v_cost, 'required_date', v_date,
      'status', (SELECT status FROM public.transport_requests WHERE id = v_request_id),
      'components', jsonb_agg(jsonb_build_object('contract_id', i.component_contract_id,
        'weight_kg', i.requested_weight_kg, 'volume_m3', i.requested_volume_m3)))
  FROM public.transport_request_components i WHERE i.request_id = v_request_id;
  RETURN v_request_id;
END $$;

CREATE OR REPLACE FUNCTION public.transport_request_budget_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       public.contract_budgets%ROWTYPE;
  v_cost  numeric := COALESCE(NEW.service_cost, 0) + COALESCE(NEW.unloading_estimate_pen,0);
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  -- Sale de "aprobada / reprogramada con aprobación": se libera su reserva
  IF COALESCE(OLD.reserved_pen, 0) > 0 AND NEW.status NOT IN ('APROBADA', 'REPROGRAMADA') THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - OLD.reserved_pen, 0), updated_at = now()
    WHERE contract_id = OLD.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    NEW.reserved_pen := 0;
  END IF;
  IF NEW.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA', 'RECHAZADA', 'CANCELADA') THEN
    NEW.approved_at := NULL; NEW.approved_by := NULL;
  END IF;

  -- Entra a APROBADA: reserva el costo estimado; sin saldo queda OBSERVADA
  IF NEW.status='APROBADA' AND NEW.attention_mode IS NOT NULL AND auth.uid() IS NOT NULL AND NOT public.has_tms_permission('despacho-aprobacion') THEN RAISE EXCEPTION 'Solo el Supervisor de Despacho aprueba solicitudes'; END IF;
  IF NEW.status NOT IN ('APROBADA','REPROGRAMADA','ASIGNADA','EN_TRANSITO','ENTREGADA') THEN NEW.operational_approved_pen:=0; END IF;
  IF NEW.status='APROBADA' AND NEW.contract_id IS NULL THEN
    IF v_cost>0 THEN
      NEW.status:='OBSERVADA'; NEW.approved_at:=NULL; NEW.approved_by:=NULL;
      NEW.operational_approved_pen:=0; NEW.budget_shortfall:=v_cost;
      NEW.budget_observation:='Vincule una OT para financiar los costos a cargo de JRM';
      RETURN NEW;
    END IF;
    NEW.operational_approved_pen:=v_cost;
    NEW.approved_at:=COALESCE(NEW.approved_at,now()); NEW.approved_by:=COALESCE(NEW.approved_by,auth.uid());
    NEW.budget_shortfall:=0; NEW.budget_observation:=NULL;
    RETURN NEW;
  END IF;
  IF NEW.status = 'APROBADA' AND COALESCE(OLD.reserved_pen, 0) = 0 THEN
    IF v_cost > 0 THEN
      SELECT * INTO b FROM public.contract_budgets WHERE contract_id = NEW.contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
      IF b.id IS NULL OR b.balance_pen < v_cost THEN
        NEW.status := 'OBSERVADA';
        NEW.budget_shortfall := v_cost - COALESCE(b.balance_pen, 0);
        NEW.budget_observation := 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2);
        NEW.approved_at := NULL; NEW.approved_by := NULL;
        RETURN NEW;
      END IF;
      UPDATE public.contract_budgets SET reserved_pen = reserved_pen + v_cost, updated_at = now() WHERE id = b.id;
      NEW.reserved_pen := v_cost;
    END IF;
    NEW.approved_at := COALESCE(NEW.approved_at, now());
    NEW.approved_by := COALESCE(NEW.approved_by, auth.uid());
    NEW.budget_shortfall := 0; NEW.budget_observation := NULL;
  END IF;

  -- Solo se programa lo aprobado (una reprogramación sin aprobación previa vuelve a aprobación)
  IF NEW.status = 'ASIGNADA' AND OLD.status IN ('REPROGRAMADA', 'APROBADA') AND OLD.approved_at IS NULL THEN
    RAISE EXCEPTION 'La solicitud % debe aprobarse antes de programarse', NEW.request_number;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.request_attention_for_dispatch(p_requests jsonb,p_document_type text,p_contract uuid,p_freight numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_first boolean:=true; v_site uuid;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar despachos'; END IF;
 IF p_requests IS NULL OR jsonb_typeof(p_requests)<>'array' OR jsonb_array_length(p_requests) NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'Seleccione solicitudes válidas'; END IF;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p_requests))<>jsonb_array_length(p_requests) THEN
   RAISE EXCEPTION 'Solicitud duplicada'; END IF;
 FOR r IN SELECT t.* FROM public.transport_requests t WHERE t.id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_requests))
   ORDER BY t.id FOR UPDATE LOOP
   IF NOT public.can_access_site(r.site_id) OR r.contract_id IS DISTINCT FROM p_contract THEN
     RAISE EXCEPTION 'Las solicitudes deben pertenecer a una sede autorizada y la misma imputación'; END IF;
   IF r.attention_mode IS NOT NULL AND (r.attention_mode='RECOJO_CLIENTE') IS DISTINCT FROM (p_document_type='NOTA_SALIDA') THEN
     RAISE EXCEPTION 'La modalidad se define en la solicitud; no mezcle transporte JRM y recojo por cliente'; END IF;
   IF NOT v_first AND (r.site_id IS DISTINCT FROM v_site) THEN
     RAISE EXCEPTION 'Las solicitudes deben compartir sede y OT'; END IF;
   v_site:=r.site_id; v_first:=false;
 END LOOP;
 IF p_document_type='NOTA_SALIDA' AND COALESCE(p_freight,0)<>0 THEN RAISE EXCEPTION 'El recojo por cliente tiene flete JRM cero'; END IF;
 IF p_contract IS NULL AND COALESCE(p_freight,0)>0 THEN
   RAISE EXCEPTION 'El flete a cargo de JRM debe imputarse a una OT con partida de transporte';
 END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.plan_dispatch_unloading(p_dispatch_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d        record;
  l        record;
  b        public.contract_budgets%ROWTYPE;
  v_item   jsonb;
  v_id     uuid;
  v_req    uuid;
  v_ctr    uuid;
  v_amount numeric;
  v_keep   uuid[] := '{}';
  v_delta  numeric := 0;
  v_release numeric := 0;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Supervisor de Transporte planifica los costos de descarga');
  END IF;
  SELECT x.id, x.status, x.site_id, x.contract_id, x.cost_center_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La descarga se planifica mientras el despacho está programado; después registre el costo real');
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Costos de descarga inválidos');
  END IF;

  -- Validación y cálculo de la reserva adicional
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_id := NULLIF(v_item->>'id', '')::uuid;
    v_amount := COALESCE(NULLIF(v_item->>'planned_pen', '')::numeric, -1);
    IF v_amount < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el monto planificado de cada costo'); END IF;
    IF v_id IS NOT NULL THEN
      SELECT * INTO l FROM public.transport_unloading_costs WHERE id = v_id FOR UPDATE;
      IF NOT FOUND OR l.status NOT IN ('ESTIMADO', 'PLANIFICADO') OR COALESCE(l.dispatch_id, p_dispatch_id) <> p_dispatch_id
         OR NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND transport_request_id = l.transport_request_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Costo de descarga no disponible para este despacho');
      END IF;
      v_delta := v_delta + v_amount - CASE WHEN l.status = 'PLANIFICADO' THEN COALESCE(l.planned_pen, 0) ELSE 0 END;
    ELSE
      v_req := NULLIF(v_item->>'request_id', '')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND transport_request_id = v_req) THEN
        RETURN jsonb_build_object('success', false, 'error', 'La solicitud no pertenece a este despacho');
      END IF;
      IF upper(COALESCE(v_item->>'concept', '')) NOT IN ('MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Concepto de descarga inválido');
      END IF;
      v_delta := v_delta + v_amount;
    END IF;
  END LOOP;
  -- Lo planificado que se retira de la lista se libera
  SELECT COALESCE(sum(planned_pen), 0) INTO v_release FROM public.transport_unloading_costs
  WHERE dispatch_id = p_dispatch_id AND status = 'PLANIFICADO'
    AND id NOT IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_items) WHERE NULLIF(value->>'id', '') IS NOT NULL);
  v_delta := v_delta - v_release;

  SELECT t.contract_id INTO v_ctr FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
  WHERE r.dispatch_id = p_dispatch_id LIMIT 1;
  v_ctr := COALESCE(d.contract_id, v_ctr);
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = v_ctr AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF v_ctr IS NOT NULL AND b.id IS NULL AND jsonb_array_length(p_items) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'El contrato no tiene partida de transporte');
  END IF;
  IF v_ctr IS NOT NULL AND v_delta > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Saldo insuficiente en la partida de transporte para la descarga: disponible S/ '
      || COALESCE(b.balance_pen, 0) || ', requerido S/ ' || round(v_delta, 2) || '. Amplíe la partida.');
  END IF;

  IF v_ctr IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) e WHERE (e->>'planned_pen')::numeric>0) THEN
    RETURN jsonb_build_object('success',false,'error','Vincule una OT para financiar la descarga a cargo de JRM');
  END IF;
  -- Aplicar
  UPDATE public.transport_unloading_costs SET status = CASE WHEN estimated_pen > 0 THEN 'ESTIMADO' ELSE 'ANULADO' END,
    dispatch_id = CASE WHEN estimated_pen > 0 THEN NULL ELSE dispatch_id END, planned_pen = NULL, planned_by = NULL, planned_at = NULL
  WHERE dispatch_id = p_dispatch_id AND status = 'PLANIFICADO'
    AND id NOT IN (SELECT (value->>'id')::uuid FROM jsonb_array_elements(p_items) WHERE NULLIF(value->>'id', '') IS NOT NULL);
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_id := NULLIF(v_item->>'id', '')::uuid;
    v_amount := (v_item->>'planned_pen')::numeric;
    IF v_id IS NOT NULL THEN
      UPDATE public.transport_unloading_costs SET status = 'PLANIFICADO', dispatch_id = p_dispatch_id, planned_pen = v_amount,
        description = COALESCE(NULLIF(trim(COALESCE(v_item->>'description', '')), ''), description),
        planned_by = auth.uid(), planned_at = now()
      WHERE id = v_id;
    ELSE
      v_req := (v_item->>'request_id')::uuid;
      INSERT INTO public.transport_unloading_costs (transport_request_id, dispatch_id, contract_id, concept, description,
        planned_pen, status, created_by, planned_by, planned_at, cost_center_id)
      SELECT v_req, p_dispatch_id, COALESCE(t.contract_id, v_ctr), upper(v_item->>'concept'),
        NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, 'PLANIFICADO', auth.uid(), auth.uid(), now(), t.cost_center_id
      FROM public.transport_requests t WHERE t.id = v_req;
    END IF;
  END LOOP;
  IF b.id IS NOT NULL AND v_delta <> 0 THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen + v_delta, 0), updated_at = now() WHERE id = b.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'reserved_delta', v_delta);
END $$;

-- Covers direct writes and every tariff/unloading RPC, without rewriting historical executed services.
CREATE OR REPLACE FUNCTION public.request_ot_funding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_cost numeric:=COALESCE(NEW.service_cost,0)+COALESCE(NEW.unloading_estimate_pen,0);
BEGIN
 IF NEW.contract_id IS NULL AND v_cost>0 THEN
   IF NEW.status IN ('ASIGNADA','EN_TRANSITO','ENTREGADA') THEN
     IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Vincule una OT para financiar los costos a cargo de JRM'; END IF;
     IF NEW.status IS DISTINCT FROM OLD.status OR NEW.contract_id IS DISTINCT FROM OLD.contract_id OR
        NEW.service_cost IS DISTINCT FROM OLD.service_cost OR NEW.unloading_estimate_pen IS DISTINCT FROM OLD.unloading_estimate_pen THEN
       RAISE EXCEPTION 'Vincule una OT para financiar los costos a cargo de JRM';
     END IF;
   ELSIF NEW.status IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','OBSERVADA','APROBADA','REPROGRAMADA') THEN
     NEW.status:='OBSERVADA'; NEW.approved_at:=NULL; NEW.approved_by:=NULL;
     NEW.operational_approved_pen:=0; NEW.budget_shortfall:=v_cost;
     NEW.budget_observation:='Vincule una OT para financiar los costos a cargo de JRM';
   END IF;
 ELSIF v_cost=0 AND NEW.status='OBSERVADA' AND
       NEW.budget_observation='Vincule una OT para financiar los costos a cargo de JRM' THEN
   NEW.status:='PENDIENTE DE APROBACIÓN'; NEW.budget_observation:=NULL; NEW.budget_shortfall:=0;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.request_ot_funding_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zzz_request_ot_funding_guard BEFORE INSERT OR UPDATE ON public.transport_requests
FOR EACH ROW EXECUTE FUNCTION public.request_ot_funding_guard();


CREATE OR REPLACE FUNCTION public.unloading_consume(p_line_id uuid, p_amount numeric, p_expense_id uuid, p_provider text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  l      public.transport_unloading_costs%ROWTYPE;
  d      record;
  v_svc  uuid;
BEGIN
  SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
  SELECT x.dispatch_number, x.vehicle_plate, x.driver_name INTO d FROM public.dispatches x WHERE x.id = l.dispatch_id;
  IF l.contract_id IS NULL THEN
    IF l.status<>'PLANIFICADO' OR p_amount<>0 OR COALESCE(l.planned_pen,0)<>0 THEN
      RAISE EXCEPTION 'Vincule una OT para registrar los costos de descarga a cargo de JRM';
    END IF;
    UPDATE public.transport_unloading_costs SET status='CONSUMIDO',actual_pen=p_amount,expense_id=p_expense_id,
      provider_name=NULLIF(trim(p_provider),''),consumed_by=auth.uid(),consumed_at=now() WHERE id=p_line_id;
    RETURN NULL;
  END IF;
  INSERT INTO public.contract_services (contract_id, service_type, description, amount_pen, service_date, plate, driver_name,
    provider_name, category, created_by, dispatch_id)
  VALUES (l.contract_id, public.unloading_service_type(l.concept),
    'Descarga · ' || public.unloading_concept_label(l.concept) || COALESCE(' · ' || l.description, '') || COALESCE(' · ' || d.dispatch_number, '')
      || CASE WHEN p_expense_id IS NOT NULL THEN ' (gasto de Caja)' ELSE '' END,
    p_amount, current_date, d.vehicle_plate, d.driver_name, NULLIF(trim(COALESCE(p_provider, '')), ''), 'Contrato', auth.uid(), l.dispatch_id)
  RETURNING id INTO v_svc;
  UPDATE public.contract_budgets SET
    reserved_pen = GREATEST(reserved_pen - CASE WHEN l.status = 'PLANIFICADO' THEN COALESCE(l.planned_pen, 0) ELSE 0 END, 0),
    consumed_pen = consumed_pen + p_amount, updated_at = now()
  WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.transport_unloading_costs SET status = 'CONSUMIDO', actual_pen = p_amount, contract_service_id = v_svc,
    expense_id = p_expense_id, provider_name = COALESCE(NULLIF(trim(COALESCE(p_provider, '')), ''), provider_name),
    consumed_by = auth.uid(), consumed_at = now()
  WHERE id = p_line_id;
  RETURN v_svc;
END $$;

CREATE OR REPLACE FUNCTION public.set_transport_request_status(
  p_request_id uuid, p_new_status text, p_required_date date DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_request   public.transport_requests%ROWTYPE;
  v_supervisor boolean := public.has_tms_permission('despacho-aprobacion');
  v_contracts boolean;
  v_dispatch  record;
  v_final     text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión'; END IF;
  SELECT * INTO v_request FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
  IF v_request.id IS NULL OR NOT public.can_access_site(v_request.site_id) THEN RAISE EXCEPTION 'Solicitud no disponible'; END IF;
  -- Administrador de Contratos asignado a la OT, o personal de solicitudes (el equipo de Contratos)
  v_contracts := (public.is_contract_administrator() AND public.has_assigned_request(v_request.id, true))
              OR (NOT public.is_contract_administrator() AND public.has_tms_permission('solicitudes'));

  IF p_new_status IN ('APROBADA', 'RECHAZADA') THEN
    IF NOT v_supervisor THEN RAISE EXCEPTION 'Solo el Supervisor de Despacho aprueba o rechaza solicitudes'; END IF;
    IF v_request.status = 'OBSERVADA' THEN
      IF v_request.contract_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud observada: vincule una OT para financiar los costos a cargo de JRM';
      END IF;
      RAISE EXCEPTION 'Solicitud observada: %. Contratos debe ampliar la partida.', COALESCE(v_request.budget_observation, 'partida insuficiente');
    END IF;
    IF v_request.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'REPROGRAMADA') THEN RAISE EXCEPTION 'Cambio de estado no permitido'; END IF;
  ELSIF p_new_status = 'REPROGRAMADA' THEN
    IF NOT (v_supervisor OR (public.is_contract_administrator() AND public.has_assigned_request(v_request.id, true))) THEN
      RAISE EXCEPTION 'Reprograman el Supervisor de Despacho o el Administrador de Contratos';
    END IF;
    IF v_request.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'REPROGRAMADA', 'OBSERVADA', 'ASIGNADA') THEN
      RAISE EXCEPTION 'Cambio de estado no permitido';
    END IF;
    IF p_required_date IS NULL OR p_required_date < current_date THEN RAISE EXCEPTION 'La nueva fecha debe ser hoy o posterior'; END IF;
  ELSIF p_new_status = 'CANCELADA' THEN
    IF NOT (v_supervisor OR v_contracts) THEN RAISE EXCEPTION 'Sin permiso para cancelar la solicitud'; END IF;
    IF v_request.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'REPROGRAMADA', 'OBSERVADA', 'ASIGNADA') THEN
      RAISE EXCEPTION 'Cambio de estado no permitido';
    END IF;
  ELSE
    RAISE EXCEPTION 'Cambio de estado no permitido';
  END IF;

  -- Asignada a un despacho: solo si aún no sale; sale del despacho (sin paradas, el despacho se cancela)
  IF v_request.status = 'ASIGNADA' THEN
    SELECT d.id, d.status, d.dispatch_number INTO v_dispatch
    FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
    WHERE dr.transport_request_id = p_request_id AND COALESCE(d.status, '') <> 'CANCELADO' LIMIT 1;
    IF v_dispatch.id IS NOT NULL AND v_dispatch.status <> 'PROGRAMADO' THEN
      RAISE EXCEPTION 'La unidad ya está en ruta (despacho %): no se puede cancelar ni reprogramar; la partida se consume al cerrar el despacho',
        v_dispatch.dispatch_number;
    END IF;
    IF v_dispatch.id IS NOT NULL THEN
      DELETE FROM public.dispatch_requests WHERE dispatch_id = v_dispatch.id AND transport_request_id = p_request_id;
      INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
      VALUES (v_dispatch.id, 'SOLICITUD_RETIRADA', 'Solicitud ' || v_request.request_number || ' retirada: ' || lower(p_new_status), auth.uid()::text);
      IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = v_dispatch.id) THEN
        UPDATE public.dispatches SET status = 'CANCELADO' WHERE id = v_dispatch.id;
        PERFORM public.dispatch_release_on_cancel(v_dispatch.id, 'Sin solicitudes: se retiró ' || v_request.request_number);
      END IF;
    END IF;
  END IF;

  -- Reprogramar una aprobada conserva la aprobación y su reserva; si no estaba aprobada, vuelve a aprobación
  UPDATE public.transport_requests SET status = p_new_status,
    required_date = coalesce(p_required_date, required_date), updated_at = now()
  WHERE id = p_request_id
  RETURNING status INTO v_final;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  VALUES (p_request_id, auth.uid(), 'STATUS_CHANGED',
    jsonb_build_object('status', v_request.status, 'required_date', v_request.required_date),
    jsonb_build_object('status', v_final, 'required_date', coalesce(p_required_date, v_request.required_date)));
END $$;
