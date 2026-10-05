-- Modalidad desde la solicitud; OT obligatoria por área, centro de costo para operación sin OT.
BEGIN;
ALTER TABLE public.transport_requests ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE public.transport_requests
 ADD COLUMN IF NOT EXISTS attention_mode text CHECK(attention_mode IN ('TRANSPORTE_JRM','RECOJO_CLIENTE')),
 ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES public.cost_centers(id),
 ADD COLUMN IF NOT EXISTS operational_approved_pen numeric NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS pickup_customer text,
 ADD COLUMN IF NOT EXISTS pickup_contact text,
 ADD COLUMN IF NOT EXISTS pickup_phone text;
ALTER TABLE public.transport_unloading_costs ALTER COLUMN contract_id DROP NOT NULL;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES public.cost_centers(id);
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS cost_center_id uuid REFERENCES public.cost_centers(id);
-- Solo clasifica retiros ya documentados; las solicitudes históricas sin modalidad siguen editables.
UPDATE public.transport_requests t SET attention_mode='RECOJO_CLIENTE'
WHERE attention_mode IS NULL AND COALESCE(service_cost,0)=0 AND EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
 WHERE dr.transport_request_id=t.id AND dr.document_type='NOTA_SALIDA' AND d.driver_id IS NULL
 AND d.vehicle_plate='EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA')<>'TERCERO');
CREATE OR REPLACE FUNCTION public.request_area_requires_ot(p_area text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT upper(trim(COALESCE(p_area,'')))='OT' OR upper(trim(COALESCE(p_area,''))) LIKE 'OT (%'
 OR upper(trim(COALESCE(p_area,''))) LIKE 'OT -%' OR lower(COALESCE(p_area,'')) IN ('administración de contratos','administracion de contratos');
$$;

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
DECLARE v_center uuid := NULLIF(p_payload->>'cost_center_id','')::uuid;
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
    v_site := NULLIF(p_payload->>'site_id','')::uuid;
    IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Selecciona una sede autorizada'; END IF;
    IF v_mode='TRANSPORTE_JRM' AND NOT EXISTS(SELECT 1 FROM public.cost_centers WHERE id=v_center AND is_active) THEN
      RAISE EXCEPTION 'Sin OT, el transporte JRM requiere un centro de costo activo';
    END IF;
  END IF;
  IF v_mode='RECOJO_CLIENTE' AND (NULLIF(trim(p_payload->>'pickup_customer'),'') IS NULL OR
     NULLIF(trim(p_payload->>'pickup_contact'),'') IS NULL OR NULLIF(trim(p_payload->>'pickup_phone'),'') IS NULL) THEN
    RAISE EXCEPTION 'Indica cliente, contacto autorizado y teléfono para el recojo';
  END IF;
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
  UPDATE public.transport_requests SET attention_mode=v_mode, cost_center_id=CASE WHEN v_root.id IS NULL THEN v_center END,
    pickup_customer=NULLIF(trim(p_payload->>'pickup_customer'),''), pickup_contact=NULLIF(trim(p_payload->>'pickup_contact'),''),
    pickup_phone=NULLIF(trim(p_payload->>'pickup_phone'),'') WHERE id=v_request_id;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    INSERT INTO public.transport_request_components(request_id, component_contract_id,
      requested_weight_kg, requested_volume_m3)
    VALUES (v_request_id, (v_item->>'contract_id')::uuid,
      nullif(v_item->>'weight_kg','')::numeric,
      nullif(v_item->>'volume_m3','')::numeric);
  END LOOP;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  SELECT v_request_id, auth.uid(), CASE WHEN p_request_id IS NULL THEN 'CREATED' ELSE 'UPDATED' END,
    v_before, jsonb_build_object('attention_mode',v_mode,'cost_center_id',v_center,'contract_id', v_root.id,
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
    IF v_cost>0 AND NOT EXISTS(SELECT 1 FROM public.cost_centers WHERE id=NEW.cost_center_id AND is_active) THEN
      RAISE EXCEPTION 'El gasto sin OT requiere un centro de costo activo';
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
CREATE OR REPLACE FUNCTION public.save_request_unloading_costs(p_request_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r        record;
  b        public.contract_budgets%ROWTYPE;
  v_item   jsonb;
  v_amount numeric;
  v_total  numeric := 0;
  v_cost   numeric;
BEGIN
  SELECT t.id, t.status, t.contract_id, t.request_number, COALESCE(t.service_cost, 0) AS service_cost, t.site_id
  INTO r FROM public.transport_requests t WHERE t.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud inexistente'); END IF;
  IF NOT public.can_access_site((SELECT site_id FROM public.transport_requests WHERE id=p_request_id)) THEN RETURN jsonb_build_object('success',false,'error','Sede no autorizada'); END IF;
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los costos de descarga se estiman antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Costos de descarga inválidos');
  END IF;

  DELETE FROM public.transport_unloading_costs WHERE transport_request_id = p_request_id AND status = 'ESTIMADO';
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_amount := COALESCE(NULLIF(v_item->>'estimated_pen', '')::numeric, 0);
    IF v_amount < 0 OR upper(COALESCE(v_item->>'concept', '')) NOT IN ('MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Concepto o monto de descarga inválido');
    END IF;
    INSERT INTO public.transport_unloading_costs (transport_request_id, contract_id, concept, description, estimated_pen, created_by, cost_center_id)
    VALUES (p_request_id, r.contract_id, upper(v_item->>'concept'), NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, auth.uid(), (SELECT cost_center_id FROM public.transport_requests WHERE id=p_request_id));
    v_total := v_total + v_amount;
  END LOOP;

  -- La partida debe cubrir flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := r.service_cost + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  IF r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0) THEN
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total, unloading_required = jsonb_array_length(p_items) > 0, status = 'OBSERVADA',
      budget_shortfall = v_cost - COALESCE(b.balance_pen, 0),
      budget_observation = 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga)'
    WHERE id = p_request_id;
  ELSE
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total, unloading_required = jsonb_array_length(p_items) > 0,
      status = CASE WHEN status = 'OBSERVADA' THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
      budget_shortfall = 0, budget_observation = NULL
    WHERE id = p_request_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'unloading_estimate_pen', v_total,
    'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;
CREATE OR REPLACE FUNCTION public.apply_request_tariff(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r         record;
  b         public.contract_budgets%ROWTYPE;
  v_weight  numeric;
  v_unload  jsonb;
  q         jsonb;
  v_total   numeric := 0;
  v_cost    numeric;
  l         record;
  v_amount  numeric;
BEGIN
  SELECT t.id, t.status, t.contract_id, to_jsonb(t) AS j INTO r FROM public.transport_requests t WHERE t.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud inexistente'); END IF;
  IF NOT public.can_access_site((SELECT site_id FROM public.transport_requests WHERE id=p_request_id)) THEN RETURN jsonb_build_object('success',false,'error','Sede no autorizada'); END IF;
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo se calcula antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;


  -- Peso: lo pedido por componente o, si no hay, el estimado de la solicitud
  IF to_regclass('public.transport_request_components') IS NOT NULL THEN
    EXECUTE 'SELECT sum(requested_weight_kg) FROM public.transport_request_components WHERE request_id = $1' INTO v_weight USING p_request_id;
  END IF;
  v_weight := COALESCE(NULLIF(v_weight, 0), NULLIF((r.j->>'estimated_weight')::numeric, 0));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('concept', concept, 'quantity', 1)), '[]'::jsonb) INTO v_unload
  FROM public.transport_unloading_costs WHERE transport_request_id = p_request_id AND status = 'ESTIMADO';

  q := public.quote_transport(r.contract_id,
    jsonb_build_array(jsonb_build_object('district', r.j->>'delivery_district', 'province', r.j->>'delivery_province',
      'department', r.j->>'delivery_department')),
    v_weight, NULL, NULL, v_unload);

  IF r.j->>'attention_mode'='RECOJO_CLIENTE' THEN
    q := q || jsonb_build_object('freight_total',0,'total',COALESCE((q->>'unloading_total')::numeric,0),'client_total',NULL,'vehicle_class',NULL,'vehicle_class_suggested',false,'missing',COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'missing') e WHERE e#>>'{}' NOT ILIKE '%flete%' AND e#>>'{}' NOT ILIKE '%parada adicional%'),'[]'::jsonb),'attention_mode','RECOJO_CLIENTE','lines',
      COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'lines') e
        WHERE e->>'concept' NOT IN ('FLETE','PARADA_ADICIONAL')),'[]'::jsonb));
  END IF;
  PERFORM set_config('tms.tariff_apply', 'on', true);
  -- Montos de descarga desde el tarifario (0 = por cotizar)
  FOR l IN SELECT id, concept FROM public.transport_unloading_costs WHERE transport_request_id = p_request_id AND status = 'ESTIMADO' LOOP
    SELECT COALESCE((e->>'unit_rate')::numeric, 0) INTO v_amount FROM jsonb_array_elements(q->'lines') e WHERE e->>'concept' = l.concept LIMIT 1;
    UPDATE public.transport_unloading_costs SET estimated_pen = COALESCE(v_amount, 0) WHERE id = l.id;
    v_total := v_total + COALESCE(v_amount, 0);
    v_amount := NULL;
  END LOOP;

  -- Partida: flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := COALESCE((q->>'freight_total')::numeric, 0) + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.transport_requests SET
    service_cost = COALESCE((q->>'freight_total')::numeric, 0), unloading_estimate_pen = v_total,
    cost_breakdown = q, cost_source = 'TARIFARIO', cost_override_reason = NULL,
    status = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0) THEN 'OBSERVADA'
                  WHEN status = 'OBSERVADA' AND (budget_shortfall>0 OR budget_observation LIKE 'Partida insuficiente%') THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
    budget_shortfall = CASE WHEN r.contract_id IS NULL THEN 0 ELSE GREATEST(v_cost - COALESCE(b.balance_pen, 0), 0) END,
    budget_observation = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0)
      THEN 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga, referencial)' END
  WHERE id = p_request_id;
  PERFORM set_config('tms.tariff_apply', '', true);

  RETURN jsonb_build_object('success', true, 'quote', q, 'service_cost', COALESCE((q->>'freight_total')::numeric, 0),
    'unloading_estimate_pen', v_total, 'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;

CREATE OR REPLACE FUNCTION public.transport_request_cost_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.attention_mode='RECOJO_CLIENTE' THEN NEW.service_cost:=0; RETURN NEW; END IF;
  -- Procesos internos (sin sesión), el cálculo del tarifario y el Administrador pueden fijarlo
  IF auth.uid() IS NULL OR current_setting('tms.tariff_apply', true) = 'on' OR public.is_tms_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.service_cost := 0;  -- lo calcula apply_request_tariff al guardar
  ELSIF NEW.service_cost IS DISTINCT FROM OLD.service_cost THEN
    NEW.service_cost := OLD.service_cost;
  END IF;
  RETURN NEW;
END $$;

-- Atomic save: freight, unloading, modality and budget observation commit together.
CREATE OR REPLACE FUNCTION public.save_transport_request_attention(p_request_id uuid,p_payload jsonb,p_components jsonb,p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb;
BEGIN
 v_id:=public.save_transport_request(p_request_id,p_payload,p_components);
 v_result:=public.save_request_unloading_costs(v_id,p_unloading);
 IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 v_result:=public.apply_request_tariff(v_id);
 IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 RETURN v_result || jsonb_build_object('id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.request_attention_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.operational_approved_pen>OLD.operational_approved_pen AND auth.uid() IS NOT NULL AND
    (NEW.status<>'APROBADA' OR OLD.status='APROBADA' OR NOT public.has_tms_permission('despacho-aprobacion')) THEN
   RAISE EXCEPTION 'El importe operacional solo aumenta con una nueva aprobación del Supervisor de Despacho';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.attention_mode IS DISTINCT FROM OLD.attention_mode OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.cost_center_id IS DISTINCT FROM OLD.cost_center_id) THEN
   IF OLD.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','OBSERVADA','APROBADA','REPROGRAMADA')
      OR EXISTS(SELECT 1 FROM public.dispatch_requests WHERE transport_request_id=OLD.id) THEN
     RAISE EXCEPTION 'Retire la solicitud del despacho antes de cambiar modalidad o financiamiento';
   END IF;
   IF NEW.status IN ('APROBADA','REPROGRAMADA') THEN
     RAISE EXCEPTION 'El cambio de modalidad o financiamiento requiere nueva aprobación';
   END IF;
 END IF;
 IF NEW.attention_mode IS NOT NULL AND public.request_area_requires_ot(NEW.department) AND NEW.contract_id IS NULL THEN
   RAISE EXCEPTION 'El área OT / Administración de Contratos requiere una OT';
 END IF;
 IF NEW.attention_mode='RECOJO_CLIENTE' AND COALESCE(NEW.service_cost,0)<>0 THEN
   RAISE EXCEPTION 'El recojo por cliente no tiene flete a cargo de JRM';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_request_attention_guard BEFORE INSERT OR UPDATE ON public.transport_requests
FOR EACH ROW EXECUTE FUNCTION public.request_attention_guard();

CREATE OR REPLACE FUNCTION public.request_attention_for_dispatch(p_requests jsonb,p_document_type text,p_contract uuid,p_freight numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; v_center uuid; v_first boolean:=true; v_total numeric:=0; v_site uuid;
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
   IF NOT v_first AND (r.site_id IS DISTINCT FROM v_site OR r.cost_center_id IS DISTINCT FROM v_center) THEN
     RAISE EXCEPTION 'Las solicitudes deben compartir sede y centro de costo'; END IF;
   v_site:=r.site_id; v_center:=r.cost_center_id; v_first:=false;
   v_total:=v_total+LEAST(COALESCE(r.operational_approved_pen,0),COALESCE(r.service_cost,0));
 END LOOP;
 IF p_document_type='NOTA_SALIDA' AND COALESCE(p_freight,0)<>0 THEN RAISE EXCEPTION 'El recojo por cliente tiene flete JRM cero'; END IF;
 IF p_contract IS NULL AND COALESCE(p_freight,0)>0 THEN
   IF NOT EXISTS(SELECT 1 FROM public.cost_centers WHERE id=v_center AND is_active) OR p_freight>v_total THEN
     RAISE EXCEPTION 'El flete sin OT supera el gasto autorizado; solicite nueva aprobación con centro de costo'; END IF;
 END IF;
 RETURN v_center;
END $$;
CREATE OR REPLACE FUNCTION public.dispatch_request_attention_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_mode text;
BEGIN
 SELECT attention_mode INTO v_mode FROM public.transport_requests WHERE id=NEW.transport_request_id;
 IF v_mode IS NOT NULL AND (v_mode='RECOJO_CLIENTE') IS DISTINCT FROM (NEW.document_type='NOTA_SALIDA') THEN
   RAISE EXCEPTION 'El documento de salida debe respetar la modalidad definida en la solicitud';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dispatch_request_attention_guard BEFORE INSERT OR UPDATE OF document_type,transport_request_id ON public.dispatch_requests
FOR EACH ROW EXECUTE FUNCTION public.dispatch_request_attention_guard();
REVOKE ALL ON FUNCTION public.dispatch_request_attention_guard() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) RENAME TO schedule_dispatch_attention_legacy;
REVOKE ALL ON FUNCTION public.schedule_dispatch_attention_legacy(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.schedule_dispatch(p_driver_id uuid,p_vehicle_plate text,p_departure timestamptz,p_estimated_km numeric,
 p_freight_cost numeric,p_contract_id uuid,p_document_type text,p_requests jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_center uuid;
BEGIN
 v_center:=public.request_attention_for_dispatch(p_requests,p_document_type,p_contract_id,p_freight_cost);
 v_id:=public.schedule_dispatch_attention_legacy(p_driver_id,p_vehicle_plate,p_departure,
   CASE WHEN p_document_type='NOTA_SALIDA' THEN 0 ELSE p_estimated_km END,p_freight_cost,p_contract_id,p_document_type,p_requests);
 UPDATE public.dispatches SET cost_center_id=v_center,site_id=(SELECT site_id FROM public.transport_requests WHERE id=(p_requests->0->>'id')::uuid) WHERE id=v_id;
 RETURN v_id;
END $$;
ALTER FUNCTION public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb) RENAME TO schedule_dispatch_tercero_attention_legacy;
REVOKE ALL ON FUNCTION public.schedule_dispatch_tercero_attention_legacy(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.schedule_dispatch_tercero(p_carrier_id uuid,p_plate text,p_conductor text,p_telefono text,p_doc text,
 p_departure timestamptz,p_estimated_km numeric,p_freight_cost numeric,p_contract_id uuid,p_requests jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_center uuid;
BEGIN
 v_center:=public.request_attention_for_dispatch(p_requests,'GR',p_contract_id,p_freight_cost);
 v_id:=public.schedule_dispatch_tercero_attention_legacy(p_carrier_id,p_plate,p_conductor,p_telefono,p_doc,p_departure,p_estimated_km,p_freight_cost,p_contract_id,p_requests);
 UPDATE public.dispatches SET cost_center_id=v_center,site_id=(SELECT site_id FROM public.transport_requests WHERE id=(p_requests->0->>'id')::uuid) WHERE id=v_id;
 RETURN v_id;
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

  IF v_ctr IS NULL AND jsonb_array_length(p_items)>0 THEN
    IF NOT EXISTS(SELECT 1 FROM public.cost_centers WHERE id=d.cost_center_id AND is_active) OR
       COALESCE((SELECT sum((value->>'planned_pen')::numeric) FROM jsonb_array_elements(p_items)),0) >
       COALESCE((SELECT sum(t.operational_approved_pen) FROM public.dispatch_requests r JOIN public.transport_requests t
         ON t.id=r.transport_request_id WHERE r.dispatch_id=p_dispatch_id),0)
       -(SELECT COALESCE(freight_cost,0) FROM public.dispatches WHERE id=p_dispatch_id) THEN
      RETURN jsonb_build_object('success',false,'error','La descarga supera el gasto autorizado en el centro de costo');
    END IF;
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
    IF l.status<>'PLANIFICADO' OR p_amount>COALESCE(l.planned_pen,0) OR NOT EXISTS(SELECT 1 FROM public.cost_centers WHERE id=l.cost_center_id AND is_active) THEN
      RAISE EXCEPTION 'La descarga sin OT requiere costo planificado autorizado y centro de costo';
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
CREATE OR REPLACE FUNCTION public.register_unloading_actual(p_line_id uuid, p_amount numeric, p_provider text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.transport_unloading_costs%ROWTYPE; b public.contract_budgets%ROWTYPE; v_extra numeric;
BEGIN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar costos de descarga');
  END IF;
  SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Costo de descarga inexistente'); END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(l.contract_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF l.status <> 'PLANIFICADO' OR l.dispatch_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se registra el costo real de una descarga planificada en un despacho');
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Monto inválido'); END IF;
  -- Lo que exceda lo planificado debe caber en el saldo
  v_extra := p_amount - COALESCE(l.planned_pen, 0);
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE' FOR UPDATE;
  IF l.contract_id IS NOT NULL AND v_extra > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Saldo insuficiente en la partida de transporte: disponible S/ '
      || COALESCE(b.balance_pen, 0) || ', excede lo planificado en S/ ' || round(v_extra, 2) || '. Amplíe la partida.');
  END IF;
  PERFORM public.unloading_consume(p_line_id, p_amount, NULL, p_provider);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.request_attention_guard(),public.request_attention_for_dispatch(jsonb,text,uuid,numeric),public.request_area_requires_ot(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.save_transport_request_attention(uuid,jsonb,jsonb,jsonb),public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb),public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_attention(uuid,jsonb,jsonb,jsonb),public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb),public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb) TO authenticated,service_role;
-- Caso indicado expresamente por el dueño: RT-000006 / OT 16523 es recojo por cliente.
-- No se reclasifica ninguna otra observación ni se aprueba automáticamente.
DO $$
DECLARE r record; v_cost numeric; v_balance numeric;
BEGIN
 FOR r IN SELECT t.* FROM public.transport_requests t JOIN public.contracts c ON c.id=t.contract_id
   WHERE t.request_number='RT-000006' AND c.code='16523' AND t.status='OBSERVADA'
   AND t.budget_observation LIKE 'Partida insuficiente%' AND t.attention_mode IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE transport_request_id=t.id) FOR UPDATE OF t LOOP
   v_cost:=COALESCE(r.unloading_estimate_pen,0);
   SELECT COALESCE(balance_pen,0) INTO v_balance FROM public.contract_budgets WHERE contract_id=r.contract_id AND concept='PARTIDA_TRANSPORTE';
   UPDATE public.transport_requests SET attention_mode='RECOJO_CLIENTE',service_cost=0,
     status=CASE WHEN v_cost>COALESCE(v_balance,0) THEN 'OBSERVADA' ELSE 'PENDIENTE DE APROBACIÓN' END,
     budget_shortfall=GREATEST(v_cost-COALESCE(v_balance,0),0),
     budget_observation=CASE WHEN v_cost>COALESCE(v_balance,0) THEN 'Partida insuficiente: descarga a cargo de JRM' END,
     cost_breakdown=COALESCE(cost_breakdown,'{}'::jsonb)||jsonb_build_object('attention_mode','RECOJO_CLIENTE','freight_total',0,'total',v_cost,'lines','[]'::jsonb,'client_total',NULL),
     updated_at=now() WHERE id=r.id;
   INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
     SELECT r.id,NULL,'UPDATED',to_jsonb(r),jsonb_build_object('attention_mode','RECOJO_CLIENTE','service_cost',0,'status',t.status,
       'reason','Recojo por cliente confirmado por el dueño del sistema; conserva costos de descarga y exige aprobación')
     FROM public.transport_requests t WHERE t.id=r.id;
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
