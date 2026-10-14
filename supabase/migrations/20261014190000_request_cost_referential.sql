-- Costo de la solicitud de transporte: solo referencial; no condiciona hasta el armado de ruta.
-- · La solicitud ya no queda OBSERVADA por «Partida insuficiente» (registro, recálculo ni aprobación).
-- · Aprobar ya no reserva el referencial en la partida: el armado de ruta valida y reserva el flete real de cada OT
--   con la unidad asignada (validate_mixed_dispatch / reserve_mixed_dispatch, sin cambios).
-- · Sin unidad ni placa, el referencial deja de tomar la tarifa más alta: usa la más baja al destino y devuelve el rango.

-- 1. Aprobación sin reserva ni bloqueo por el referencial (se conserva el resto del motor de aprobación)
DO $patch$
DECLARE sig regprocedure := 'public.transport_request_budget_sync()'::regprocedure; def text; head text;
  p_check int; p_start int; p_res int; p_end int; tail text;
BEGIN
  def := pg_get_functiondef(sig);
  IF position('Aprobación sin reserva' IN def) > 0 THEN RETURN; END IF;
  p_check := position('IF b.id IS NULL OR b.balance_pen < v_cost THEN' IN def);
  p_res := position('NEW.reserved_pen := v_cost;' IN def);
  IF p_check = 0 OR p_res = 0 OR p_res < p_check THEN RAISE EXCEPTION 'Motor de aprobación no reconocido'; END IF;
  -- Inicio: el «IF v_cost > 0 THEN» inmediatamente anterior a la verificación de saldo
  head := left(def, p_check - 1);
  p_start := length(head) - position(reverse('IF v_cost > 0 THEN') IN reverse(head)) - length('IF v_cost > 0 THEN') + 2;
  IF position('IF v_cost > 0 THEN' IN substr(def, p_start)) <> 1 THEN RAISE EXCEPTION 'Motor de aprobación no reconocido (inicio)'; END IF;
  -- Fin: el «END IF;» que cierra ese bloque, después de registrar la reserva
  tail := substr(def, p_res);
  p_end := p_res + position('END IF;' IN tail) + length('END IF;') - 1;
  def := left(def, p_start - 1)
    || '-- Aprobación sin reserva: el saldo de la partida se valida y reserva al armar la ruta con el flete real'
    || substr(def, p_end);
  EXECUTE def;
END $patch$;

-- 2. En la etapa de solicitud el referencial no observa por partida (último disparador BEFORE de transport_requests)
CREATE OR REPLACE FUNCTION public.request_reference_cost_free() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.contract_id IS NOT NULL AND NEW.status = 'OBSERVADA'
     AND COALESCE(NEW.budget_observation, '') LIKE 'Partida insuficiente%' THEN
    NEW.status := CASE WHEN TG_OP = 'UPDATE' AND OLD.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'REPROGRAMADA')
                       THEN OLD.status ELSE 'PENDIENTE DE APROBACIÓN' END;
    NEW.budget_shortfall := 0;
    NEW.budget_observation := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.request_reference_cost_free() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zzzz_request_reference_cost_free ON public.transport_requests;
CREATE TRIGGER zzzz_request_reference_cost_free BEFORE INSERT OR UPDATE ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.request_reference_cost_free();

-- 3. Referencial sin unidad definida: tarifa más baja al destino (no la más alta) y rango mínimo–máximo
CREATE OR REPLACE FUNCTION public.tariff_pick_min(p_concept text, p_district text, p_client uuid, p_contract uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(x) FROM (
    SELECT r.id, r.concept, r.rate, r.rate_basis, r.scope, r.client_price, r.vehicle_class, r.plate_number, r.district,
           to_jsonb(r)->>'zone' AS zone
    FROM public.freight_rates r
    WHERE r.is_active AND r.concept = p_concept
      AND p_date >= r.valid_from AND (r.valid_to IS NULL OR p_date <= r.valid_to)
      AND (r.scope = 'GENERAL' OR (r.scope = 'CLIENTE' AND r.client_id = p_client) OR (r.scope = 'CONTRATO' AND r.contract_id = p_contract))
      AND public.norm_address(r.district) = public.norm_address(p_district)
    ORDER BY CASE r.scope WHEN 'CONTRATO' THEN 3 WHEN 'CLIENTE' THEN 2 ELSE 1 END DESC, r.rate ASC
    LIMIT 1) x;
$$;
REVOKE ALL ON FUNCTION public.tariff_pick_min(text, text, uuid, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tariff_pick_min(text, text, uuid, uuid, date) TO service_role;

DO $patch$
DECLARE sig regprocedure := 'public.quote_transport(uuid,jsonb,numeric,text,text,jsonb,date)'::regprocedure; def text; changed text;
  o_decl text := $o$  v_client_ok    boolean := true;$o$;
  n_decl text := $n$  v_client_ok    boolean := true;
  v_range_min numeric;
  v_range_max numeric;
  t_max      jsonb;$n$;
  o_pick text := $o$    t := public.tariff_pick('FLETE', v_class, v_plate, d, v_client, p_contract_id, p_date);$o$;
  n_pick text := $n$    -- Sin unidad ni placa (solicitud): la tarifa más baja al destino y el rango; la unidad se define al armar la ruta
    IF v_class IS NULL AND v_plate IS NULL THEN
      t := public.tariff_pick_min('FLETE', d, v_client, p_contract_id, p_date);
      t_max := public.tariff_pick('FLETE', NULL, NULL, d, v_client, p_contract_id, p_date);
      IF t IS NOT NULL THEN
        v_range_min := GREATEST(COALESCE(v_range_min, 0), (t->>'rate')::numeric * CASE WHEN t->>'rate_basis' = 'TONELADA' THEN COALESCE(p_weight_kg, 0) / 1000 ELSE 1 END);
        v_range_max := GREATEST(COALESCE(v_range_max, 0), (t_max->>'rate')::numeric * CASE WHEN t_max->>'rate_basis' = 'TONELADA' THEN COALESCE(p_weight_kg, 0) / 1000 ELSE 1 END);
      END IF;
    ELSE
      t := public.tariff_pick('FLETE', v_class, v_plate, d, v_client, p_contract_id, p_date);
    END IF;$n$;
  o_ret text := $o$    'missing', to_jsonb(v_missing), 'quoted_at', now(), 'quote_date', p_date);$o$;
  n_ret text := $n$    'missing', to_jsonb(v_missing), 'quoted_at', now(), 'quote_date', p_date,
    'freight_referential', v_class IS NULL AND v_plate IS NULL,
    'freight_range', CASE WHEN v_range_min IS NOT NULL THEN jsonb_build_object('min', round(v_range_min, 2), 'max', round(v_range_max, 2)) END);$n$;
BEGIN
  def := pg_get_functiondef(sig);
  IF position('tariff_pick_min' IN def) > 0 THEN RETURN; END IF;
  IF position(o_decl IN def) = 0 OR position(o_pick IN def) = 0 OR position(o_ret IN def) = 0 THEN
    RAISE EXCEPTION 'Cotizador de transporte no reconocido'; END IF;
  changed := replace(replace(replace(def, o_decl, n_decl), o_pick, n_pick), o_ret, n_ret);
  EXECUTE changed;
END $patch$;

-- 4. Reservas por el referencial de solicitudes aprobadas que aún no están en una ruta: se liberan
DO $release$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.id, t.contract_id, t.reserved_pen FROM public.transport_requests t
    WHERE t.status IN ('APROBADA', 'REPROGRAMADA') AND COALESCE(t.reserved_pen, 0) > 0 AND t.contract_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
                      WHERE dr.transport_request_id = t.id AND d.status <> 'CANCELADO')
    FOR UPDATE OF t LOOP
    BEGIN
      UPDATE public.contract_budgets SET reserved_pen = GREATEST(reserved_pen - r.reserved_pen, 0), updated_at = now()
       WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
      UPDATE public.transport_requests SET reserved_pen = 0 WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Reserva no liberada en %: %', r.id, SQLERRM;
    END;
  END LOOP;
END $release$;

-- 5. Solicitudes OBSERVADAS solo por «Partida insuficiente» vuelven a pendiente de aprobación
DO $observed$
DECLARE r record;
BEGIN
  FOR r IN SELECT t.id FROM public.transport_requests t
    WHERE t.status = 'OBSERVADA' AND t.contract_id IS NOT NULL AND COALESCE(t.budget_observation, '') LIKE 'Partida insuficiente%' LOOP
    BEGIN
      UPDATE public.transport_requests SET status = 'PENDIENTE DE APROBACIÓN', budget_shortfall = 0, budget_observation = NULL WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Solicitud % sin cambio: %', r.id, SQLERRM;
    END;
  END LOOP;
END $observed$;
NOTIFY pgrst, 'reload schema';
