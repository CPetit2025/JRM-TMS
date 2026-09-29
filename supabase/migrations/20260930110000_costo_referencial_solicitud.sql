-- ============================================================
-- SOLICITUDES — Costo referencial (lo calcula el tarifario; el usuario no lo edita)
-- ============================================================
--  * El costo de la solicitud (flete y montos de descarga) es referencial: lo calcula el servidor con quote_transport
--    a partir de la OT, el destino, el peso y los recursos de descarga declarados. El Administrador de Contratos solo
--    lo visualiza. El costo real del flete se define al programar en Despacho.
--  * Un cambio directo de service_cost queda bloqueado (se conserva el valor calculado), salvo para el Administrador
--    del sistema o dentro del cálculo del tarifario.
--  * El ajuste manual con motivo (set_request_cost_quote MANUAL) queda solo para el Administrador.
BEGIN;

-- ------------------------------------------------------------
-- 1. Guardia: nadie edita el costo a mano
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transport_request_cost_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
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
DROP TRIGGER IF EXISTS transport_request_cost_guard ON public.transport_requests;
CREATE TRIGGER transport_request_cost_guard BEFORE INSERT OR UPDATE OF service_cost ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.transport_request_cost_guard();

-- ------------------------------------------------------------
-- 2. Cálculo del costo referencial de una solicitud
-- ------------------------------------------------------------
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
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo se calcula antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;
  IF r.contract_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud no tiene contrato'); END IF;

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
    status = CASE WHEN v_cost > COALESCE(b.balance_pen, 0) THEN 'OBSERVADA'
                  WHEN status = 'OBSERVADA' THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
    budget_shortfall = GREATEST(v_cost - COALESCE(b.balance_pen, 0), 0),
    budget_observation = CASE WHEN v_cost > COALESCE(b.balance_pen, 0)
      THEN 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga, referencial)' END
  WHERE id = p_request_id;
  PERFORM set_config('tms.tariff_apply', '', true);

  RETURN jsonb_build_object('success', true, 'quote', q, 'service_cost', COALESCE((q->>'freight_total')::numeric, 0),
    'unloading_estimate_pen', v_total, 'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;

-- ------------------------------------------------------------
-- 3. Ajuste manual con motivo: solo Administrador
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_request_cost_quote(p_request_id uuid, p_breakdown jsonb, p_source text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF upper(COALESCE(p_source, '')) = 'MANUAL' AND NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo de la solicitud es referencial: lo calcula el tarifario');
  END IF;
  IF upper(COALESCE(p_source, '')) <> 'MANUAL' THEN
    RETURN public.apply_request_tariff(p_request_id);
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del ajuste');
  END IF;
  UPDATE public.transport_requests SET cost_breakdown = p_breakdown, cost_source = 'MANUAL', cost_override_reason = trim(p_reason)
  WHERE id = p_request_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.transport_request_cost_guard(), public.apply_request_tariff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_request_tariff(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
