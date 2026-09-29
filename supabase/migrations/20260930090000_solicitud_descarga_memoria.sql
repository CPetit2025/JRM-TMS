-- ============================================================
-- SOLICITUDES — Descarga declarada (Sí/No) y memoria de solicitudes anteriores
-- ============================================================
--  * Toda solicitud nueva responde si requiere descarga especial (montacargas, grúa, estiba, otros):
--    unloading_required = true/false (NULL = solicitud antigua sin respuesta). Las líneas sin monto también se
--    guardan: indican el recurso aunque todavía no esté cotizado.
--  * get_unloading_history: solicitudes anteriores al mismo destino, del mismo cliente en el distrito o de la misma OT,
--    con lo que necesitaron (estimado, planificado y costo real) para alertar y usar como referencia.
BEGIN;

ALTER TABLE public.transport_requests ADD COLUMN IF NOT EXISTS unloading_required boolean;

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
    INSERT INTO public.transport_unloading_costs (transport_request_id, contract_id, concept, description, estimated_pen, created_by)
    VALUES (p_request_id, r.contract_id, upper(v_item->>'concept'), NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, auth.uid());
    v_total := v_total + v_amount;
  END LOOP;

  -- La partida debe cubrir flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := r.service_cost + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  IF v_cost > COALESCE(b.balance_pen, 0) THEN
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

CREATE OR REPLACE FUNCTION public.norm_address(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(lower(translate(COALESCE(p, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '[^a-z0-9]+', '', 'g'), '');
$$;

-- Historial de descarga para una nueva solicitud (máximo 5, la coincidencia más cercana primero)
CREATE OR REPLACE FUNCTION public.get_unloading_history(p_contract_id uuid, p_delivery_district text, p_delivery_address text,
  p_exclude_request uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_client uuid; v_addr text := public.norm_address(p_delivery_address); v_dist text := public.norm_address(p_delivery_district);
BEGIN
  IF NOT (public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho')
          OR public.has_tms_read_permission('contratos-servicios')) THEN
    RETURN '[]'::jsonb;
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_contract(p_contract_id, false) THEN RETURN '[]'::jsonb; END IF;
  SELECT (to_jsonb(c)->>'client_id')::uuid INTO v_client FROM public.contracts c WHERE c.id = p_contract_id;

  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY x.score DESC, x.created_at DESC)
    FROM (
      SELECT t.id, t.request_number, t.status, t.created_at, t.unloading_required,
             to_jsonb(t)->>'required_date' AS required_date,
             concat_ws(' · ', to_jsonb(t)->>'delivery_address', to_jsonb(t)->>'delivery_district') AS delivery,
             CASE WHEN v_addr IS NOT NULL AND public.norm_address(to_jsonb(t)->>'delivery_address') = v_addr THEN 3
                  WHEN v_dist IS NOT NULL AND public.norm_address(to_jsonb(t)->>'delivery_district') = v_dist
                       AND v_client IS NOT NULL AND (to_jsonb(ct)->>'client_id')::uuid = v_client THEN 2
                  ELSE 1 END AS score,
             (SELECT jsonb_agg(jsonb_build_object('concept', u.concept, 'description', u.description,
                 'estimated_pen', u.estimated_pen, 'planned_pen', u.planned_pen, 'actual_pen', u.actual_pen, 'status', u.status)
                 ORDER BY u.created_at)
              FROM public.transport_unloading_costs u WHERE u.transport_request_id = t.id AND u.status <> 'ANULADO') AS lines
      FROM public.transport_requests t
      LEFT JOIN public.contracts ct ON ct.id = t.contract_id
      WHERE t.id IS DISTINCT FROM p_exclude_request
        AND (t.contract_id = p_contract_id
             OR (v_client IS NOT NULL AND (to_jsonb(ct)->>'client_id')::uuid = v_client
                 AND (public.norm_address(to_jsonb(t)->>'delivery_address') = v_addr
                      OR public.norm_address(to_jsonb(t)->>'delivery_district') = v_dist)))
        AND (t.unloading_required IS NOT NULL
             OR EXISTS (SELECT 1 FROM public.transport_unloading_costs u WHERE u.transport_request_id = t.id AND u.status <> 'ANULADO'))
      ORDER BY score DESC, t.created_at DESC
      LIMIT 5
    ) x), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.get_unloading_history(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unloading_history(uuid, text, text, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
