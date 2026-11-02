-- Flete referencial manual sin tarifa: si el tarifario no tiene flete para el destino/unidad, la solicitud puede indicar
-- un monto referencial manual (mayor a cero) con motivo obligatorio, igual que la descarga sin tarifa. Con tarifa manda el
-- tarifario. Recojos y recojo por el cliente siguen sin valorizar flete.
--  * save_transport_request_full envuelve la versión instalada (como 20261017120000) y pasa el monto manual a
--    apply_request_tariff por una variable de la transacción, antes de la aprobación automática.
--  * apply_request_tariff (reescrita completa desde 20261105090000) usa el manual solo cuando el flete tarifado es 0; en
--    recálculos sin guardado conserva el manual ya registrado (cost_source = 'MANUAL').
BEGIN;
SET LOCAL lock_timeout='60s';

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
  v_cfg     jsonb;
  v_manual  numeric;
  v_reason  text;
  v_freight numeric;
  v_source  text := 'TARIFARIO';
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

  IF r.j->>'attention_mode'='RECOJO_CLIENTE' OR r.j->>'request_type'='RECOJO' THEN
    q := q || jsonb_build_object('freight_total',0,'total',COALESCE((q->>'unloading_total')::numeric,0),'client_total',NULL,'vehicle_class',NULL,'vehicle_class_suggested',false,'missing',COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'missing') e WHERE e#>>'{}' NOT ILIKE '%flete%' AND e#>>'{}' NOT ILIKE '%parada adicional%'),'[]'::jsonb),'attention_mode',r.j->>'attention_mode','pickup_freight_not_valued',r.j->>'request_type'='RECOJO','lines',
      COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'lines') e
        WHERE e->>'concept' NOT IN ('FLETE','PARADA_ADICIONAL')),'[]'::jsonb));
  ELSE
    -- Flete sin tarifa: monto manual del guardado en curso o, en un recálculo, el manual ya registrado
    v_cfg := NULLIF(current_setting('tms.manual_freight', true), '')::jsonb;
    IF v_cfg IS NOT NULL THEN
      v_manual := NULLIF((v_cfg->>'amount')::numeric, 0); v_reason := NULLIF(btrim(COALESCE(v_cfg->>'reason', '')), '');
    ELSIF r.j->>'cost_source' = 'MANUAL' THEN
      v_manual := NULLIF((r.j->>'service_cost')::numeric, 0); v_reason := NULLIF(btrim(COALESCE(r.j->>'cost_override_reason', '')), '');
    END IF;
    IF COALESCE((q->>'freight_total')::numeric, 0) = 0 AND v_manual > 0 AND length(COALESCE(v_reason, '')) >= 3 THEN
      v_source := 'MANUAL';
      q := q || jsonb_build_object('freight_total', v_manual, 'total', v_manual + COALESCE((q->>'unloading_total')::numeric, 0),
        'freight_source', 'MANUAL', 'freight_manual_reason', v_reason);
    END IF;
  END IF;
  v_freight := COALESCE((q->>'freight_total')::numeric, 0);
  PERFORM set_config('tms.tariff_apply', 'on', true);
  -- Montos de descarga desde el tarifario. Sin tarifa: se marca tariff_missing y se conserva el
  -- costo referencial manual (con motivo); sin manual queda en 0 = por cotizar, no "costo cero".
  FOR l IN SELECT id, concept, estimated_pen, estimated_source FROM public.transport_unloading_costs
           WHERE transport_request_id = p_request_id AND status = 'ESTIMADO' LOOP
    v_amount := NULL;
    SELECT (e->>'unit_rate')::numeric INTO v_amount FROM jsonb_array_elements(q->'lines') e WHERE e->>'concept' = l.concept LIMIT 1;
    IF l.estimated_source = 'MANUAL' THEN
      UPDATE public.transport_unloading_costs SET tariff_missing = v_amount IS NULL WHERE id = l.id;
      v_total := v_total + COALESCE(l.estimated_pen, 0);
    ELSE
      UPDATE public.transport_unloading_costs SET estimated_pen = COALESCE(v_amount, 0),
        estimated_source = CASE WHEN v_amount IS NULL THEN NULL ELSE 'TARIFA' END, tariff_missing = v_amount IS NULL, manual_reason = NULL
      WHERE id = l.id;
      v_total := v_total + COALESCE(v_amount, 0);
    END IF;
  END LOOP;

  -- Partida: flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := v_freight + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.transport_requests SET
    service_cost = v_freight, unloading_estimate_pen = v_total,
    cost_breakdown = q, cost_source = v_source, cost_override_reason = CASE WHEN v_source = 'MANUAL' THEN v_reason END,
    status = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0) THEN 'OBSERVADA'
                  WHEN status = 'OBSERVADA' AND (budget_shortfall>0 OR budget_observation LIKE 'Partida insuficiente%') THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
    budget_shortfall = CASE WHEN r.contract_id IS NULL THEN 0 ELSE GREATEST(v_cost - COALESCE(b.balance_pen, 0), 0) END,
    budget_observation = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0)
      THEN 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga, referencial)' END
  WHERE id = p_request_id;
  PERFORM set_config('tms.tariff_apply', '', true);

  RETURN jsonb_build_object('success', true, 'quote', q, 'service_cost', v_freight,
    'unloading_estimate_pen', v_total, 'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;
REVOKE ALL ON FUNCTION public.apply_request_tariff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_request_tariff(uuid) TO authenticated, service_role;

-- Se envuelve la versión instalada sin cambiar su firma (producción puede diferir del repositorio)
DO $mig$
BEGIN
  IF to_regprocedure('public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'save_transport_request_full no está instalada';
  END IF;
  IF to_regprocedure('public.save_transport_request_full_before_manual_freight(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) RENAME TO save_transport_request_full_before_manual_freight;
  END IF;
END $mig$;
REVOKE ALL ON FUNCTION public.save_transport_request_full_before_manual_freight(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full_before_manual_freight(uuid, jsonb, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.save_transport_request_full(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_amount numeric; v_reason text; v_result jsonb;
BEGIN
  v_amount := NULLIF(btrim(COALESCE(p_payload->>'freight_manual_pen', '')), '')::numeric;
  v_reason := btrim(COALESCE(p_payload->>'freight_manual_reason', ''));
  IF v_amount < 0 THEN RAISE EXCEPTION 'El flete referencial manual no puede ser negativo'; END IF;
  IF v_amount > 0 AND length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Indique el motivo del flete referencial manual (sin tarifa)';
  END IF;
  PERFORM set_config('tms.manual_freight', jsonb_build_object('amount', COALESCE(v_amount, 0), 'reason', v_reason)::text, true);
  v_result := public.save_transport_request_full_before_manual_freight(p_request_id, p_payload, p_components, p_unloading);
  PERFORM set_config('tms.manual_freight', '', true);
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
