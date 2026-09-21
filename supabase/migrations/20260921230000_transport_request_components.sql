-- Request components are contract records (mother OT, subcontract, or error).
-- Product/packing rows in transport_request_items retain their separate purpose.
CREATE TABLE public.transport_request_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  component_contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
  requested_weight_kg numeric(12,2) CHECK (requested_weight_kg >= 0),
  requested_volume_m3 numeric(12,2) CHECK (requested_volume_m3 >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, component_contract_id)
);
CREATE INDEX transport_request_components_contract_idx
  ON public.transport_request_components(component_contract_id, request_id);
ALTER TABLE public.transport_request_components ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_request_components FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.transport_request_components TO authenticated;
CREATE POLICY request_components_read ON public.transport_request_components
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.transport_requests r WHERE r.id = request_id
      AND public.can_access_site(r.site_id)
      AND (public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'))
  ));

ALTER TABLE public.transport_requests
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

CREATE TABLE public.transport_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  action text NOT NULL CHECK (action IN ('CREATED','UPDATED','STATUS_CHANGED')),
  previous_state jsonb,
  next_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transport_request_events_request_time
  ON public.transport_request_events(request_id, created_at DESC);
ALTER TABLE public.transport_request_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.transport_request_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.transport_request_events TO authenticated;
CREATE POLICY request_events_read ON public.transport_request_events
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.transport_requests r WHERE r.id = request_id
      AND public.can_access_site(r.site_id)
      AND public.has_tms_read_permission('solicitudes')
  ));

-- Only rows whose old FK certainly identifies the root are backfilled. Historical
-- weight remains unknown rather than being inferred from contractual totals.
INSERT INTO public.transport_request_components(request_id, component_contract_id)
SELECT r.id, c.id FROM public.transport_requests r
JOIN public.contracts c ON c.id = r.contract_id
WHERE c.type IN ('CONTRATO','OT_INDEPENDIENTE')
  AND c.parent_contract_id IS NULL AND c.site_id = r.site_id
  AND NOT EXISTS (SELECT 1 FROM public.transport_request_components i WHERE i.request_id = r.id)
ON CONFLICT (request_id, component_contract_id) DO NOTHING;

CREATE SEQUENCE public.transport_request_number_seq;

CREATE OR REPLACE FUNCTION public.get_transport_request_component_options(
  p_root_id uuid, p_request_id uuid DEFAULT NULL
) RETURNS TABLE (
  contract_id uuid, code text, component_type text, status text,
  total_weight_kg numeric, total_volume_m3 numeric,
  destination_address text, destination_department text,
  destination_province text, destination_district text,
  already_requested_kg numeric, allocated_pen numeric, reserved_pen numeric,
  consumed_pen numeric, balance_pen numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_read_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para consultar solicitudes';
  END IF;
  SELECT c.site_id INTO v_site FROM public.contracts c
  WHERE c.id = p_root_id AND c.type IN ('CONTRATO','OT_INDEPENDIENTE')
    AND c.parent_contract_id IS NULL AND c.status = 'ACTIVO';
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'OT no disponible para esta sede';
  END IF;
  IF p_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transport_requests r WHERE r.id = p_request_id
      AND r.site_id = v_site AND public.can_access_site(r.site_id)
  ) THEN RAISE EXCEPTION 'Solicitud no disponible'; END IF;

  RETURN QUERY
  SELECT c.id, c.code::text, c.type::text, c.status::text,
    c.total_weight_kg, c.total_volume_m3, c.destination_address::text,
    c.destination_department::text, c.destination_province::text,
    c.destination_district::text,
    coalesce(usage.requested_kg, 0), b.allocated_pen, b.reserved_pen,
    b.consumed_pen, b.balance_pen
  FROM public.contracts c
  LEFT JOIN public.contract_budgets b ON b.contract_id = c.id
    AND b.concept = 'PARTIDA_TRANSPORTE'
  LEFT JOIN LATERAL (
    SELECT sum(i.requested_weight_kg) AS requested_kg
    FROM public.transport_request_components i
    JOIN public.transport_requests r ON r.id = i.request_id
    WHERE i.component_contract_id = c.id AND r.id IS DISTINCT FROM p_request_id
      AND r.status NOT IN ('CANCELADA','RECHAZADA')
  ) usage ON true
  WHERE c.site_id = v_site AND c.status = 'ACTIVO'
    AND (c.id = p_root_id OR (c.parent_contract_id = p_root_id
      AND c.type IN ('SUBCONTRATO','ERROR')))
  ORDER BY CASE WHEN c.id = p_root_id THEN 0 ELSE 1 END, c.code;
END $$;
REVOKE ALL ON FUNCTION public.get_transport_request_component_options(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_transport_request_component_options(uuid,uuid) TO authenticated;

-- One batched read for the request list and detail view. Dispatch data is read only.
CREATE OR REPLACE FUNCTION public.get_transport_request_summaries(p_request_ids uuid[])
RETURNS TABLE (request_id uuid, dispatch_count bigint, dispatch_numbers text[],
  root_allocated_pen numeric, root_balance_pen numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_read_permission('solicitudes') OR
     coalesce(cardinality(p_request_ids),0) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Consulta de solicitudes no permitida';
  END IF;
  RETURN QUERY
  SELECT r.id, count(d.id),
    coalesce(array_agg(d.dispatch_number::text ORDER BY d.created_at)
      FILTER (WHERE d.id IS NOT NULL), ARRAY[]::text[]),
    b.allocated_pen, b.balance_pen
  FROM public.transport_requests r
  LEFT JOIN public.contract_budgets b ON b.contract_id = r.contract_id
    AND b.concept = 'PARTIDA_TRANSPORTE'
  LEFT JOIN public.dispatch_requests dr ON dr.transport_request_id = r.id
  LEFT JOIN public.dispatches d ON d.id = dr.dispatch_id
  WHERE r.id = ANY(p_request_ids) AND public.can_access_site(r.site_id)
  GROUP BY r.id, b.allocated_pen, b.balance_pen;
END $$;
REVOKE ALL ON FUNCTION public.get_transport_request_summaries(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_transport_request_summaries(uuid[]) TO authenticated;

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
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para guardar solicitudes';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR
     p_components IS NULL OR jsonb_typeof(p_components) <> 'array' OR
     jsonb_array_length(p_components) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Selecciona al menos un componente';
  END IF;
  SELECT * INTO v_root FROM public.contracts
  WHERE id = (p_payload->>'contract_id')::uuid
    AND type IN ('CONTRATO','OT_INDEPENDIENTE')
    AND parent_contract_id IS NULL AND status = 'ACTIVO' FOR UPDATE;
  IF v_root.id IS NULL OR NOT public.can_access_site(v_root.site_id) THEN
    RAISE EXCEPTION 'Selecciona una OT madre activa de tu sede';
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
  v_cost := coalesce(nullif(p_payload->>'service_cost','')::numeric, 0);
  IF v_cost < 0 OR v_cost > 99999999.99 THEN RAISE EXCEPTION 'Costo estimado inválido'; END IF;
  IF v_cost > 0 AND v_cost > coalesce((SELECT balance_pen FROM public.contract_budgets
    WHERE contract_id = v_root.id AND concept = 'PARTIDA_TRANSPORTE'), 0) THEN
    RAISE EXCEPTION 'El costo estimado supera el saldo de la OT raíz';
  END IF;
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
    IF v_existing.id IS NULL OR NOT public.can_access_site(v_existing.site_id) OR
      v_existing.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','REPROGRAMADA','APROBADA') OR
      EXISTS (SELECT 1 FROM public.dispatch_requests WHERE transport_request_id = p_request_id) THEN
      RAISE EXCEPTION 'La solicitud ya no se puede editar';
    END IF;
    SELECT jsonb_build_object('contract_id', v_existing.contract_id,
      'weight_kg', v_existing.estimated_weight, 'volume_m3', v_existing.estimated_volume,
      'estimated_cost_pen', v_existing.service_cost, 'status', v_existing.status,
      'required_date', v_existing.required_date,
      'components', coalesce(jsonb_agg(jsonb_build_object(
        'contract_id', i.component_contract_id, 'weight_kg', i.requested_weight_kg,
        'volume_m3', i.requested_volume_m3)) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb))
    INTO v_before FROM public.transport_request_components i WHERE i.request_id = p_request_id;
  END IF;

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
      request_type, contract_id, purchase_order, service_cost, site_id, created_by, status)
    VALUES (v_number, v_requester, trim(p_payload->>'department'),
      trim(p_payload->>'pickup_address'), nullif(p_payload->>'pickup_department',''),
      nullif(p_payload->>'pickup_province',''), trim(p_payload->>'pickup_district'),
      trim(p_payload->>'delivery_address'), nullif(p_payload->>'delivery_department',''),
      nullif(p_payload->>'delivery_province',''), trim(p_payload->>'delivery_district'),
      v_date, nullif(p_payload->>'time_window',''), trim(p_payload->>'cargo_description'),
      v_total_weight, v_total_volume, p_payload->>'request_type', v_root.id,
      nullif(p_payload->>'purchase_order',''), v_cost, v_root.site_id, auth.uid(),
      'PENDIENTE DE APROBACIÓN') RETURNING id INTO v_request_id;
  ELSE
    v_request_id := p_request_id;
    DELETE FROM public.transport_request_components WHERE request_id = v_request_id;
    UPDATE public.transport_requests SET requester_name = v_requester,
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
      site_id = v_root.site_id, updated_at = now()
    WHERE id = v_request_id;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    INSERT INTO public.transport_request_components(request_id, component_contract_id,
      requested_weight_kg, requested_volume_m3)
    VALUES (v_request_id, (v_item->>'contract_id')::uuid,
      nullif(v_item->>'weight_kg','')::numeric,
      nullif(v_item->>'volume_m3','')::numeric);
  END LOOP;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  SELECT v_request_id, auth.uid(), CASE WHEN p_request_id IS NULL THEN 'CREATED' ELSE 'UPDATED' END,
    v_before, jsonb_build_object('contract_id', v_root.id,
      'weight_kg', (SELECT estimated_weight FROM public.transport_requests WHERE id = v_request_id),
      'volume_m3', (SELECT estimated_volume FROM public.transport_requests WHERE id = v_request_id),
      'estimated_cost_pen', v_cost, 'required_date', v_date,
      'status', (SELECT status FROM public.transport_requests WHERE id = v_request_id),
      'components', jsonb_agg(jsonb_build_object('contract_id', i.component_contract_id,
        'weight_kg', i.requested_weight_kg, 'volume_m3', i.requested_volume_m3)))
  FROM public.transport_request_components i WHERE i.request_id = v_request_id;
  RETURN v_request_id;
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request(uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request(uuid,jsonb,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_transport_request_status(
  p_request_id uuid, p_new_status text, p_required_date date DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_request public.transport_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('solicitudes') THEN
    RAISE EXCEPTION 'Sin permiso para cambiar solicitudes';
  END IF;
  SELECT * INTO v_request FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
  IF v_request.id IS NULL OR NOT public.can_access_site(v_request.site_id) THEN
    RAISE EXCEPTION 'Solicitud no disponible';
  END IF;
  IF p_new_status IN ('APROBADA','RECHAZADA') AND
     NOT public.has_tms_permission('despacho') THEN
    RAISE EXCEPTION 'Sin permiso para aprobar o rechazar solicitudes';
  END IF;
  IF (p_new_status IN ('APROBADA','RECHAZADA') AND
      v_request.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','REPROGRAMADA')) OR
     (p_new_status = 'REPROGRAMADA' AND
      v_request.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','APROBADA','REPROGRAMADA')) OR
     (p_new_status = 'CANCELADA' AND
      v_request.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','APROBADA','REPROGRAMADA')) OR
     p_new_status NOT IN ('APROBADA','RECHAZADA','REPROGRAMADA','CANCELADA') THEN
    RAISE EXCEPTION 'Cambio de estado no permitido';
  END IF;
  IF p_new_status = 'REPROGRAMADA' AND (p_required_date IS NULL OR p_required_date < current_date) THEN
    RAISE EXCEPTION 'La nueva fecha debe ser hoy o posterior';
  END IF;
  IF p_new_status = 'CANCELADA' AND EXISTS (
    SELECT 1 FROM public.dispatch_requests WHERE transport_request_id = p_request_id
  ) THEN RAISE EXCEPTION 'Retira la solicitud del despacho antes de cancelarla'; END IF;
  UPDATE public.transport_requests SET status = p_new_status,
    required_date = coalesce(p_required_date, required_date), updated_at = now()
  WHERE id = p_request_id;
  INSERT INTO public.transport_request_events(request_id, actor_id, action, previous_state, next_state)
  VALUES (p_request_id, auth.uid(), 'STATUS_CHANGED',
    jsonb_build_object('status', v_request.status, 'required_date', v_request.required_date),
    jsonb_build_object('status', p_new_status,
      'required_date', coalesce(p_required_date, v_request.required_date)));
END $$;
REVOKE ALL ON FUNCTION public.set_transport_request_status(uuid,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status(uuid,text,date) TO authenticated;

NOTIFY pgrst, 'reload schema';
