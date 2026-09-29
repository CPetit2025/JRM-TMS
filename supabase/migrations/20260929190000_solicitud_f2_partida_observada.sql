-- ============================================================
-- SOLICITUDES F2 — Partida observada, reserva al aprobar, reprogramación y roles de Despacho/Transporte
-- ============================================================
-- Reglas del negocio (docs/despacho/02-f2-solicitud-partida.md):
--  * La solicitud se registra aunque la partida no alcance: queda OBSERVADA y no se aprueba ni programa
--    hasta que Contratos amplía la partida (la observación se levanta sola).
--  * Al APROBAR se reserva el costo estimado en la partida; la reserva se libera al programar (el flete del
--    despacho toma su lugar), rechazar, cancelar, observar o editar.
--  * Aprueba/rechaza el Supervisor de Despacho (permiso despacho-aprobacion); programa el Supervisor de
--    Transporte (permiso despacho). Reprograman el Supervisor de Despacho y el Administrador de Contratos.
--  * Una solicitud asignada a un despacho PROGRAMADO se puede reprogramar/cancelar (sale del despacho);
--    si la unidad ya está en ruta no: la partida se consume al cerrar el despacho.
BEGIN;

ALTER TABLE public.transport_requests
  ADD COLUMN IF NOT EXISTS budget_shortfall   numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_observation text,
  ADD COLUMN IF NOT EXISTS reserved_pen       numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_at        timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL;
-- Solicitudes ya aprobadas antes de F2: quedan aprobadas (sin reserva retroactiva)
UPDATE public.transport_requests SET approved_at = COALESCE(approved_at, updated_at, created_at, now())
WHERE status IN ('APROBADA', 'REPROGRAMADA', 'ASIGNADA', 'EN_TRANSITO', 'ENTREGADA') AND approved_at IS NULL;

-- ------------------------------------------------------------
-- 1. Roles: Supervisor de Despacho (aprueba) y Supervisor de Transporte (programa)
-- ------------------------------------------------------------
-- Quien hoy tiene Despacho con escritura conserva la aprobación (no se rompe nada)
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["despacho-aprobacion"]'::jsonb) p)
WHERE permissions ? 'despacho' OR permissions ? 'despacho:write';
INSERT INTO public.roles (name, permissions)
SELECT 'Supervisor de Despacho', '["dashboard","despacho-aprobacion","solicitudes:read","despacho:read","monitoreo:read","torre-control:read"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Supervisor de Despacho');
INSERT INTO public.roles (name, permissions)
SELECT 'Supervisor de Transporte', '["dashboard","despacho","solicitudes:read","monitoreo","torre-control"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Supervisor de Transporte');

-- ------------------------------------------------------------
-- 2. Registro de la solicitud: observada si la partida no alcanza
-- ------------------------------------------------------------
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
  IF v_root.id IS NULL OR NOT public.can_access_site(v_root.site_id) OR
     (public.is_contract_administrator() AND NOT public.has_assigned_contract(v_root.id,true)) THEN
    RAISE EXCEPTION 'Selecciona una OT madre asignada y activa';
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
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.transport_requests WHERE id = p_request_id FOR UPDATE;
    IF v_existing.id IS NULL OR v_existing.contract_id IS DISTINCT FROM v_root.id OR
      NOT public.can_access_site(v_existing.site_id) OR
      (public.is_contract_administrator() AND NOT public.has_assigned_request(v_existing.id,true)) OR
      v_existing.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','REPROGRAMADA','APROBADA','OBSERVADA') OR
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

  -- F2: la partida no bloquea el registro; si no alcanza, la solicitud queda OBSERVADA (no se aprueba ni
  -- programa hasta ampliar la partida). Una edición vuelve a pasar por aprobación (libera su reserva).
  v_available := coalesce((SELECT balance_pen FROM public.contract_budgets
    WHERE contract_id = v_root.id AND concept = 'PARTIDA_TRANSPORTE'), 0) + coalesce(v_existing.reserved_pen, 0);
  v_shortfall := CASE WHEN v_cost > v_available THEN v_cost - v_available ELSE 0 END;
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
      budget_shortfall, budget_observation)
    VALUES (v_number, v_requester, trim(p_payload->>'department'),
      trim(p_payload->>'pickup_address'), nullif(p_payload->>'pickup_department',''),
      nullif(p_payload->>'pickup_province',''), trim(p_payload->>'pickup_district'),
      trim(p_payload->>'delivery_address'), nullif(p_payload->>'delivery_department',''),
      nullif(p_payload->>'delivery_province',''), trim(p_payload->>'delivery_district'),
      v_date, nullif(p_payload->>'time_window',''), trim(p_payload->>'cargo_description'),
      v_total_weight, v_total_volume, p_payload->>'request_type', v_root.id,
      nullif(p_payload->>'purchase_order',''), v_cost, v_root.site_id, auth.uid(),
      v_status, v_shortfall, CASE WHEN v_shortfall > 0 THEN 'Partida insuficiente: faltan S/ ' || round(v_shortfall, 2) END)
      RETURNING id INTO v_request_id;
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
      site_id = v_root.site_id, updated_at = now(), status = v_status, budget_shortfall = v_shortfall,
      budget_observation = CASE WHEN v_shortfall > 0 THEN 'Partida insuficiente: faltan S/ ' || round(v_shortfall, 2) END
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
-- ------------------------------------------------------------
-- 3. Reserva de la partida según el estado de la solicitud
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transport_request_budget_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       public.contract_budgets%ROWTYPE;
  v_cost  numeric := COALESCE(NEW.service_cost, 0);
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
DROP TRIGGER IF EXISTS trg_transport_request_budget_sync ON public.transport_requests;
CREATE TRIGGER trg_transport_request_budget_sync BEFORE UPDATE OF status ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.transport_request_budget_sync();

-- Al ampliar la partida se levantan las observaciones que ya caben (vuelven a aprobación)
CREATE OR REPLACE FUNCTION public.transport_request_lift_observations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.concept <> 'PARTIDA_TRANSPORTE' OR NEW.balance_pen <= COALESCE(OLD.balance_pen, 0) THEN RETURN NULL; END IF;
  UPDATE public.transport_requests r SET status = 'PENDIENTE DE APROBACIÓN', budget_shortfall = 0, budget_observation = NULL, updated_at = now()
  WHERE r.contract_id = NEW.contract_id AND r.status = 'OBSERVADA' AND COALESCE(r.service_cost, 0) <= NEW.balance_pen;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_transport_request_lift_observations ON public.contract_budgets;
CREATE TRIGGER trg_transport_request_lift_observations AFTER UPDATE ON public.contract_budgets
  FOR EACH ROW EXECUTE FUNCTION public.transport_request_lift_observations();

-- ------------------------------------------------------------
-- 4. Cambios de estado de la solicitud
-- ------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public.transport_request_budget_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transport_request_lift_observations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_transport_request(uuid,jsonb,jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_transport_request_status(uuid,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request(uuid,jsonb,jsonb), public.set_transport_request_status(uuid,text,date)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
