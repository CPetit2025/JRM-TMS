-- ============================================================
-- DESPACHO F4 — Tripulación (ayudantes / auxiliares) y costos de descarga amarrados a la partida
-- ============================================================
-- Reglas del negocio (docs/despacho/04-f4-tripulacion-descarga.md):
--  * Transporte asigna al despacho la tripulación (ayudantes, auxiliares, estibadores, montacarguista, operador de
--    grúa) desde Trabajadores. Un trabajador no puede estar en dos despachos activos a la vez.
--  * Costos de descarga por solicitud (montacargas, grúa, estiba, otros):
--      1. Contratos los ESTIMA en la solicitud: suman al costo que se valida y reserva al aprobar (F2).
--      2. Transporte los PLANIFICA al programar: el monto planificado se reserva en la partida del contrato.
--      3. El costo REAL se consume de la partida: al aprobarse en Caja el gasto de descarga del viaje
--         (ALQUILER_EQUIPO, CUADRILLA_ESTIBA) o al registrarlo Despacho/Contratos con factura. Cada gasto de Caja
--         consume una sola vez (sin duplicar); si Caja revierte la aprobación, el consumo se revierte.
--  * Si la parada sale del despacho o el despacho se cancela, la reserva planificada se libera.
BEGIN;

-- ------------------------------------------------------------
-- 1. Tripulación del despacho
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_crew (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  crew_role   text NOT NULL CHECK (crew_role IN ('AYUDANTE', 'AUXILIAR', 'ESTIBADOR', 'MONTACARGUISTA', 'OPERADOR_GRUA', 'OTRO')),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  removed_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_crew_one_active ON public.dispatch_crew(dispatch_id, profile_id) WHERE removed_at IS NULL;
ALTER TABLE public.dispatch_crew ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_crew_read ON public.dispatch_crew;
CREATE POLICY dispatch_crew_read ON public.dispatch_crew FOR SELECT TO authenticated
  USING (public.can_view_dispatch_documents(dispatch_id));
REVOKE ALL ON public.dispatch_crew FROM anon;
GRANT SELECT ON public.dispatch_crew TO authenticated;

-- Trabajadores que pueden ir como tripulación (puestos del maestro de Trabajadores, sin conductores)
CREATE OR REPLACE FUNCTION public.list_crew_candidates()
RETURNS TABLE (profile_id uuid, full_name text, employee_type text, busy_dispatch text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.has_tms_read_permission('despacho') THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), to_jsonb(p)->>'employee_type',
         (SELECT d.dispatch_number FROM public.dispatch_crew c JOIN public.dispatches d ON d.id = c.dispatch_id
          WHERE c.profile_id = p.id AND c.removed_at IS NULL
            AND d.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1)
  FROM public.profiles p
  WHERE COALESCE(p.is_active, true)
    AND COALESCE(to_jsonb(p)->>'employee_type', '') IN ('Auxiliar de Transporte', 'Auxiliar de Despacho', 'Lider de Recepcion - APT',
      'Montacarguista', 'Operador de Grua Estacional', 'Ayudante', 'Estibador')
  ORDER BY 2;
END $$;

-- Nombres de la tripulación (para el app del conductor y la web)
CREATE OR REPLACE FUNCTION public.get_dispatch_crew(p_dispatch_id uuid)
RETURNS TABLE (id uuid, profile_id uuid, full_name text, employee_type text, crew_role text, assigned_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.can_view_dispatch_documents(p_dispatch_id) THEN RETURN; END IF;
  RETURN QUERY
  SELECT c.id, c.profile_id, trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')),
         to_jsonb(p)->>'employee_type', c.crew_role, c.assigned_at
  FROM public.dispatch_crew c JOIN public.profiles p ON p.id = c.profile_id
  WHERE c.dispatch_id = p_dispatch_id AND c.removed_at IS NULL ORDER BY c.assigned_at;
END $$;

-- Reemplaza la tripulación del despacho: p_crew = [{profile_id, crew_role}]
CREATE OR REPLACE FUNCTION public.set_dispatch_crew(p_dispatch_id uuid, p_crew jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d       record;
  v_item  jsonb;
  v_prof  uuid;
  v_role  text;
  v_busy  text;
  v_name  text;
  v_ids   uuid[] := '{}';
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Supervisor de Transporte asigna la tripulación');
  END IF;
  SELECT x.id, x.status, x.site_id, x.driver_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La tripulación se asigna mientras el despacho está programado');
  END IF;
  IF p_crew IS NULL OR jsonb_typeof(p_crew) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tripulación inválida');
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_crew) LOOP
    v_prof := NULLIF(v_item->>'profile_id', '')::uuid;
    v_role := upper(COALESCE(NULLIF(v_item->>'crew_role', ''), 'AYUDANTE'));
    IF v_role NOT IN ('AYUDANTE', 'AUXILIAR', 'ESTIBADOR', 'MONTACARGUISTA', 'OPERADOR_GRUA', 'OTRO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Función de tripulación inválida: ' || v_role);
    END IF;
    SELECT trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')) INTO v_name
    FROM public.profiles p WHERE p.id = v_prof AND COALESCE(p.is_active, true);
    IF v_name IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Trabajador inexistente o inactivo'); END IF;
    IF EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = v_prof) THEN
      RETURN jsonb_build_object('success', false, 'error', v_name || ' es el conductor del despacho');
    END IF;
    SELECT x.dispatch_number INTO v_busy FROM public.dispatch_crew c JOIN public.dispatches x ON x.id = c.dispatch_id
    WHERE c.profile_id = v_prof AND c.removed_at IS NULL AND c.dispatch_id <> p_dispatch_id
      AND x.status IN ('PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO') LIMIT 1;
    IF v_busy IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', v_name || ' ya está asignado al despacho ' || v_busy);
    END IF;
    v_ids := v_ids || v_prof;
    UPDATE public.dispatch_crew SET crew_role = v_role
    WHERE dispatch_id = p_dispatch_id AND profile_id = v_prof AND removed_at IS NULL;
    IF NOT FOUND THEN
      INSERT INTO public.dispatch_crew (dispatch_id, profile_id, crew_role, assigned_by) VALUES (p_dispatch_id, v_prof, v_role, auth.uid());
    END IF;
  END LOOP;

  UPDATE public.dispatch_crew SET removed_at = now(), removed_by = auth.uid()
  WHERE dispatch_id = p_dispatch_id AND removed_at IS NULL AND NOT (profile_id = ANY (v_ids));
  RETURN jsonb_build_object('success', true, 'crew', cardinality(v_ids));
END $$;

-- ------------------------------------------------------------
-- 2. Costos de descarga
-- ------------------------------------------------------------
ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS unloading_estimate_pen numeric(15,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.transport_unloading_costs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  dispatch_id          uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
  contract_id          uuid NOT NULL,
  concept              text NOT NULL CHECK (concept IN ('MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS')),
  description          text,
  estimated_pen        numeric(15,2) NOT NULL DEFAULT 0 CHECK (estimated_pen >= 0),
  planned_pen          numeric(15,2) CHECK (planned_pen >= 0),
  actual_pen           numeric(15,2) CHECK (actual_pen >= 0),
  status               text NOT NULL DEFAULT 'ESTIMADO' CHECK (status IN ('ESTIMADO', 'PLANIFICADO', 'CONSUMIDO', 'ANULADO')),
  contract_service_id  uuid,
  expense_id           uuid,
  provider_name        text,
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  planned_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  planned_at           timestamptz,
  consumed_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  consumed_at          timestamptz,
  void_reason          text
);
CREATE INDEX IF NOT EXISTS transport_unloading_costs_request_idx ON public.transport_unloading_costs(transport_request_id);
CREATE INDEX IF NOT EXISTS transport_unloading_costs_dispatch_idx ON public.transport_unloading_costs(dispatch_id);
-- Un gasto de Caja consume una sola línea (sin duplicar)
CREATE UNIQUE INDEX IF NOT EXISTS transport_unloading_costs_expense_key ON public.transport_unloading_costs(expense_id) WHERE expense_id IS NOT NULL;

ALTER TABLE public.transport_unloading_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transport_unloading_costs_read ON public.transport_unloading_costs;
CREATE POLICY transport_unloading_costs_read ON public.transport_unloading_costs FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('solicitudes')
    OR public.has_tms_read_permission('contratos-servicios') OR public.has_caja_read_access());
DROP POLICY IF EXISTS transport_unloading_costs_portfolio ON public.transport_unloading_costs;
CREATE POLICY transport_unloading_costs_portfolio ON public.transport_unloading_costs AS RESTRICTIVE FOR SELECT TO authenticated
  USING (NOT public.is_contract_administrator() OR public.has_assigned_contract(contract_id, false));
REVOKE ALL ON public.transport_unloading_costs FROM anon;
GRANT SELECT ON public.transport_unloading_costs TO authenticated;

CREATE OR REPLACE FUNCTION public.unloading_service_type(p_concept text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_concept WHEN 'MONTACARGAS' THEN 'MONTACARGA' WHEN 'GRUA' THEN 'GRUA' WHEN 'ESTIBA' THEN 'ESTIBA' ELSE 'OTROS' END;
$$;
CREATE OR REPLACE FUNCTION public.unloading_concept_label(p_concept text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_concept WHEN 'MONTACARGAS' THEN 'Montacargas' WHEN 'GRUA' THEN 'Grúa' WHEN 'ESTIBA' THEN 'Estiba' ELSE 'Otros' END;
$$;

-- 2.1 Estimación en la solicitud (Contratos). p_items = [{concept, description, estimated_pen}]
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
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los costos de descarga se estiman antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;
  IF r.contract_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'La solicitud no tiene contrato');
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
    IF v_amount = 0 THEN CONTINUE; END IF;
    INSERT INTO public.transport_unloading_costs (transport_request_id, contract_id, concept, description, estimated_pen, created_by)
    VALUES (p_request_id, r.contract_id, upper(v_item->>'concept'), NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, auth.uid());
    v_total := v_total + v_amount;
  END LOOP;

  -- La partida debe cubrir flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := r.service_cost + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  IF v_cost > COALESCE(b.balance_pen, 0) THEN
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total, status = 'OBSERVADA',
      budget_shortfall = v_cost - COALESCE(b.balance_pen, 0),
      budget_observation = 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga)'
    WHERE id = p_request_id;
  ELSE
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total,
      status = CASE WHEN status = 'OBSERVADA' THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
      budget_shortfall = 0, budget_observation = NULL
    WHERE id = p_request_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'unloading_estimate_pen', v_total,
    'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;

-- 2.2 F2 con descarga: la aprobación reserva flete + descarga estimada; el levantamiento también la considera
CREATE OR REPLACE FUNCTION public.transport_request_budget_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       public.contract_budgets%ROWTYPE;
  v_cost  numeric := COALESCE(NEW.service_cost, 0) + COALESCE(NEW.unloading_estimate_pen, 0);
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

  -- Entra a APROBADA: reserva el costo estimado (flete + descarga); sin saldo queda OBSERVADA
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

CREATE OR REPLACE FUNCTION public.transport_request_lift_observations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.concept <> 'PARTIDA_TRANSPORTE' OR NEW.balance_pen <= COALESCE(OLD.balance_pen, 0) THEN RETURN NULL; END IF;
  UPDATE public.transport_requests r SET status = 'PENDIENTE DE APROBACIÓN', budget_shortfall = 0, budget_observation = NULL, updated_at = now()
  WHERE r.contract_id = NEW.contract_id AND r.status = 'OBSERVADA'
    AND COALESCE(r.service_cost, 0) + COALESCE(r.unloading_estimate_pen, 0) <= NEW.balance_pen;
  RETURN NULL;
END $$;

-- 2.3 Planificación en el despacho (Transporte): reserva lo planificado.
--     p_items = [{id?, request_id, concept, description, planned_pen}] — la lista completa del despacho
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
  SELECT x.id, x.status, x.site_id, x.contract_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
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
  IF b.id IS NULL AND jsonb_array_length(p_items) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'El contrato no tiene partida de transporte');
  END IF;
  IF v_delta > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Saldo insuficiente en la partida de transporte para la descarga: disponible S/ '
      || COALESCE(b.balance_pen, 0) || ', requerido S/ ' || round(v_delta, 2) || '. Amplíe la partida.');
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
        planned_pen, status, created_by, planned_by, planned_at)
      SELECT v_req, p_dispatch_id, COALESCE(t.contract_id, v_ctr), upper(v_item->>'concept'),
        NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, 'PLANIFICADO', auth.uid(), auth.uid(), now()
      FROM public.transport_requests t WHERE t.id = v_req;
    END IF;
  END LOOP;
  IF b.id IS NOT NULL AND v_delta <> 0 THEN
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen + v_delta, 0), updated_at = now() WHERE id = b.id;
  END IF;
  RETURN jsonb_build_object('success', true, 'reserved_delta', v_delta);
END $$;

-- 2.4 Consumo del costo real (uso interno): pasa la línea a CONSUMIDO, registra el servicio y mueve reserva → consumo
CREATE OR REPLACE FUNCTION public.unloading_consume(p_line_id uuid, p_amount numeric, p_expense_id uuid, p_provider text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  l      public.transport_unloading_costs%ROWTYPE;
  d      record;
  v_svc  uuid;
BEGIN
  SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
  SELECT x.dispatch_number, x.vehicle_plate, x.driver_name INTO d FROM public.dispatches x WHERE x.id = l.dispatch_id;
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

-- 2.5 Costo real con factura (Despacho o Contratos)
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
  IF v_extra > COALESCE(b.balance_pen, 0) AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Saldo insuficiente en la partida de transporte: disponible S/ '
      || COALESCE(b.balance_pen, 0) || ', excede lo planificado en S/ ' || round(v_extra, 2) || '. Amplíe la partida.');
  END IF;
  PERFORM public.unloading_consume(p_line_id, p_amount, NULL, p_provider);
  RETURN jsonb_build_object('success', true);
END $$;

-- 2.6 Anular una descarga planificada que no se realizará (libera la reserva)
CREATE OR REPLACE FUNCTION public.void_unloading_cost(p_line_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.transport_unloading_costs%ROWTYPE;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo Transporte anula costos de descarga planificados');
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo');
  END IF;
  SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
  IF NOT FOUND OR l.status <> 'PLANIFICADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se anulan descargas planificadas sin costo real');
  END IF;
  UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - COALESCE(l.planned_pen, 0), 0), updated_at = now()
  WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.transport_unloading_costs SET status = 'ANULADO', void_reason = trim(p_reason) WHERE id = p_line_id;
  RETURN jsonb_build_object('success', true);
END $$;

-- 2.7 Gastos de Caja de descarga (ALQUILER_EQUIPO, CUADRILLA_ESTIBA): al aprobarse consumen la partida una sola vez
CREATE OR REPLACE FUNCTION public.caja_unloading_expense_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  l        public.transport_unloading_costs%ROWTYPE;
  v_ctr    uuid;
  v_req    uuid;
  v_amount numeric;
  v_line   uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.dispatch_id IS NULL
     OR upper(COALESCE(NEW.expense_type, '')) NOT IN ('ALQUILER_EQUIPO', 'CUADRILLA_ESTIBA') THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'APROBADO' THEN
    IF EXISTS (SELECT 1 FROM public.transport_unloading_costs WHERE expense_id = NEW.id) THEN RETURN NULL; END IF;
    v_amount := COALESCE((to_jsonb(NEW)->>'approved_amount')::numeric, NEW.amount);
    -- La línea planificada del mismo tipo en el despacho (la de monto más cercano); si no hay, se crea una no planificada
    SELECT * INTO l FROM public.transport_unloading_costs
    WHERE dispatch_id = NEW.dispatch_id AND status = 'PLANIFICADO' AND expense_id IS NULL
      AND concept = ANY (CASE WHEN upper(NEW.expense_type) = 'ALQUILER_EQUIPO' THEN ARRAY['MONTACARGAS', 'GRUA'] ELSE ARRAY['ESTIBA'] END)
    ORDER BY abs(COALESCE(planned_pen, 0) - v_amount), planned_at, id LIMIT 1 FOR UPDATE;  -- la más parecida al gasto
    IF FOUND THEN
      v_line := l.id;
    ELSE
      SELECT x.contract_id INTO v_ctr FROM public.dispatches x WHERE x.id = NEW.dispatch_id;
      SELECT r.transport_request_id, COALESCE(v_ctr, t.contract_id) INTO v_req, v_ctr
      FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
      WHERE r.dispatch_id = NEW.dispatch_id ORDER BY t.request_number LIMIT 1;
      IF v_ctr IS NULL OR v_req IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.contract_budgets WHERE contract_id = v_ctr AND concept = 'PARTIDA_TRANSPORTE') THEN
        RETURN NULL;  -- viaje sin contrato/partida: el gasto queda solo en Caja
      END IF;
      INSERT INTO public.transport_unloading_costs (transport_request_id, dispatch_id, contract_id, concept, description, status, created_by)
      VALUES (v_req, NEW.dispatch_id, v_ctr, CASE WHEN upper(NEW.expense_type) = 'ALQUILER_EQUIPO' THEN 'MONTACARGAS' ELSE 'ESTIBA' END,
        'No planificado · gasto de Caja', 'ESTIMADO', auth.uid())
      RETURNING id INTO v_line;
    END IF;
    PERFORM public.unloading_consume(v_line, v_amount, NEW.id, to_jsonb(NEW)->>'provider_name');

  ELSIF OLD.status = 'APROBADO' THEN
    -- Caja revirtió la aprobación: se anula el servicio y se devuelve el consumo (la reserva planificada se restituye)
    SELECT * INTO l FROM public.transport_unloading_costs WHERE expense_id = NEW.id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE public.contract_services SET status = 'ANULADO' WHERE id = l.contract_service_id;
    UPDATE public.contract_budgets SET consumed_pen = GREATEST(consumed_pen - COALESCE(l.actual_pen, 0), 0),
      reserved_pen = reserved_pen + CASE WHEN l.planned_pen IS NOT NULL THEN l.planned_pen ELSE 0 END, updated_at = now()
    WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.transport_unloading_costs SET status = CASE WHEN planned_pen IS NOT NULL THEN 'PLANIFICADO' ELSE 'ANULADO' END,
      actual_pen = NULL, expense_id = NULL, contract_service_id = NULL, consumed_by = NULL, consumed_at = NULL,
      void_reason = CASE WHEN planned_pen IS NULL THEN 'Caja revirtió la aprobación del gasto' ELSE void_reason END
    WHERE id = l.id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS caja_unloading_expense_sync ON public.dispatch_expenses;
CREATE TRIGGER caja_unloading_expense_sync AFTER UPDATE OF status ON public.dispatch_expenses
  FOR EACH ROW EXECUTE FUNCTION public.caja_unloading_expense_sync();

-- 2.8 Parada que sale del despacho (reprogramación o cancelación): libera su descarga planificada y la tripulación
CREATE OR REPLACE FUNCTION public.dispatch_unloading_release_stop()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l record;
BEGIN
  FOR l IN SELECT * FROM public.transport_unloading_costs
    WHERE dispatch_id = OLD.dispatch_id AND transport_request_id = OLD.transport_request_id AND status = 'PLANIFICADO' FOR UPDATE
  LOOP
    UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - COALESCE(l.planned_pen, 0), 0), updated_at = now()
    WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.transport_unloading_costs SET status = CASE WHEN estimated_pen > 0 THEN 'ESTIMADO' ELSE 'ANULADO' END,
      dispatch_id = CASE WHEN estimated_pen > 0 THEN NULL ELSE dispatch_id END, planned_pen = NULL, planned_by = NULL, planned_at = NULL
    WHERE id = l.id;
  END LOOP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS dispatch_unloading_release_stop ON public.dispatch_requests;
CREATE TRIGGER dispatch_unloading_release_stop AFTER DELETE ON public.dispatch_requests
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_unloading_release_stop();

CREATE OR REPLACE FUNCTION public.dispatch_crew_release_on_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'CANCELADO' AND OLD.status IS DISTINCT FROM 'CANCELADO' THEN
    UPDATE public.dispatch_crew SET removed_at = now(), removed_by = auth.uid() WHERE dispatch_id = NEW.id AND removed_at IS NULL;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS dispatch_crew_release_on_cancel ON public.dispatches;
CREATE TRIGGER dispatch_crew_release_on_cancel AFTER UPDATE OF status ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_crew_release_on_cancel();

-- ------------------------------------------------------------
-- 3. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.list_crew_candidates(), public.get_dispatch_crew(uuid), public.set_dispatch_crew(uuid, jsonb),
  public.save_request_unloading_costs(uuid, jsonb), public.plan_dispatch_unloading(uuid, jsonb),
  public.register_unloading_actual(uuid, numeric, text), public.void_unloading_cost(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_crew_candidates(), public.get_dispatch_crew(uuid), public.set_dispatch_crew(uuid, jsonb),
  public.save_request_unloading_costs(uuid, jsonb), public.plan_dispatch_unloading(uuid, jsonb),
  public.register_unloading_actual(uuid, numeric, text), public.void_unloading_cost(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.unloading_consume(uuid, numeric, uuid, text), public.caja_unloading_expense_sync(),
  public.dispatch_unloading_release_stop(), public.dispatch_crew_release_on_cancel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unloading_consume(uuid, numeric, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
