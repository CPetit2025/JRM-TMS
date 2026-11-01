-- Reingeniería Torre de Control y Control presupuestal · decisiones aprobadas el 01/11/2026
-- (docs/control-presupuestal/reingenieria-torre-control.md §11). Ninguna reescribe históricos.
-- D3  Viaje consolidado: el combustible de los km adicionales (dispatch_service_additions.extra_km, registrados al
--     agregar un servicio en ruta) va directo a la solicitud que los agregó; el resto, por peso. Aplica al combustible
--     estimado y al real de Caja imputado a toda la ruta. Se suma en la misma fila de la solicitud (sin otra imputación).
-- D5  Ruta propia: el reverso de la tarifa usa el flete final aprobado en Costos por ruta; si después se aprueba otro
--     flete final, el reverso se anula y se vuelve a imputar con el nuevo monto (el neto de la ruta sigue en cero).
-- D2  Combustible de Caja en ruta de tercero: se imputa (registrar no es aprobar) y queda pendiente como posible
--     duplicado con la tarifa contratada.
BEGIN;
SET LOCAL lock_timeout = '60s';

-- D3 (reescrita completa desde 20261126090000; misma firma y mismas reglas de redondeo)
CREATE OR REPLACE FUNCTION public.budget_allocate(p_kind text, p_dispatch_id uuid, p_expense_id uuid, p_request_id uuid, p_amount numeric,
 p_apply boolean, p_detail jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record; v_left numeric := round(p_amount, 2); v_amount numeric; v_n int; v_i int := 0; v_id uuid;
 v_km numeric; v_extra jsonb := '{}'::jsonb; v_extra_sum numeric := 0; v_den numeric := 1; v_base numeric := p_amount; v_x numeric;
BEGIN
 IF COALESCE(p_amount, 0) = 0 THEN RETURN; END IF;
 IF p_request_id IS NOT NULL THEN
  INSERT INTO public.cost_allocations(kind, dispatch_id, expense_id, request_id, contract_id, amount_pen, basis, detail)
  SELECT p_kind, p_dispatch_id, p_expense_id, t.id, t.contract_id, round(p_amount, 2), 'DIRECTO', COALESCE(p_detail, '{}'::jsonb)
  FROM public.transport_requests t WHERE t.id = p_request_id
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL AND p_apply THEN PERFORM public.budget_allocation_apply(v_id); END IF;
  RETURN;
 END IF;
 -- D3: parte del combustible por los km que agregó cada servicio (si los km extra superan el recorrido, se prorratea)
 IF p_kind = 'COMBUSTIBLE_ESTIMADO' OR (p_kind = 'CAJA' AND COALESCE(p_detail->>'expense_type', '') = 'COMBUSTIBLE') THEN
  SELECT COALESCE(NULLIF(x.actual_distance_km, 0), NULLIF(x.estimated_km, 0), NULLIF(to_jsonb(x)->>'estimated_distance_km', '')::numeric)
  INTO v_km FROM public.dispatches x WHERE x.id = p_dispatch_id;
  IF COALESCE(v_km, 0) > 0 THEN
   SELECT COALESCE(jsonb_object_agg(a.request_id, a.extra_km), '{}'::jsonb), COALESCE(sum(a.extra_km), 0) INTO v_extra, v_extra_sum
   FROM public.dispatch_service_additions a WHERE a.dispatch_id = p_dispatch_id AND a.extra_km > 0;
   v_den := GREATEST(v_km, v_extra_sum, 1);
   v_base := p_amount * (1 - v_extra_sum / v_den);
  END IF;
 END IF;
 SELECT count(*) INTO v_n FROM public.budget_route_shares(p_dispatch_id);
 -- El redondeo queda en la última parte: la suma imputada es exactamente el monto
 FOR s IN SELECT * FROM public.budget_route_shares(p_dispatch_id) ORDER BY request_id LOOP
  v_i := v_i + 1;
  v_x := COALESCE((v_extra->>s.request_id::text)::numeric, 0);
  v_amount := CASE WHEN v_i = v_n THEN v_left ELSE round(v_base * s.share + p_amount * v_x / v_den, 2) END;
  v_left := v_left - v_amount; v_id := NULL;
  INSERT INTO public.cost_allocations(kind, dispatch_id, expense_id, request_id, contract_id, amount_pen, basis, detail)
  VALUES (p_kind, p_dispatch_id, p_expense_id, s.request_id, s.contract_id, v_amount, s.basis, COALESCE(p_detail, '{}'::jsonb)
   || jsonb_build_object('share', round(s.share, 4)) || CASE WHEN v_x > 0 THEN jsonb_build_object('km_extra', v_x) ELSE '{}'::jsonb END)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL AND p_apply THEN PERFORM public.budget_allocation_apply(v_id); END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.budget_allocate(text,uuid,uuid,uuid,numeric,boolean,jsonb) FROM PUBLIC,anon,authenticated;

-- D5: el reverso de la tarifa usa el flete final ya aprobado (parche guardado)
DO $patch$
DECLARE def text := pg_get_functiondef('public.budget_route_close(uuid)'::regprocedure);
 o1 text := 'f.request_id, -f.amount_pen, true';
 n1 text := 'f.request_id, -COALESCE((SELECT st.final_applied_pen FROM public.dispatch_request_freight_stages st WHERE st.dispatch_id = p_dispatch_id AND st.request_id = f.request_id), f.amount_pen), true';
 o2 text := 'v_req, -d.freight_cost, true';
 n2 text := 'v_req, -COALESCE((SELECT st.final_applied_pen FROM public.dispatch_freight_stages st WHERE st.dispatch_id = p_dispatch_id), d.freight_cost), true';
BEGIN
 IF position('dispatch_request_freight_stages st WHERE st.dispatch_id = p_dispatch_id' IN def) > 0 THEN RETURN; END IF;
 IF position(o1 IN def) = 0 OR position(o2 IN def) = 0 THEN RAISE EXCEPTION 'budget_route_close cambió: revisar el parche del flete final (D5)'; END IF;
 EXECUTE replace(replace(def, o1, n1), o2, n2);
END $patch$;

-- D5: un flete final aprobado después del cierre de la ruta mueve el reverso de la tarifa
CREATE OR REPLACE FUNCTION public.budget_tariff_follow_final() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record;
BEGIN
 IF NEW.final_applied_pen IS NULL OR NEW.final_applied_pen IS NOT DISTINCT FROM OLD.final_applied_pen THEN RETURN NULL; END IF;
 SELECT c.id, c.request_id, c.amount_pen INTO a FROM public.cost_allocations c
 WHERE c.dispatch_id = NEW.dispatch_id AND c.kind = 'TARIFA_PROPIA' AND c.status <> 'ANULADO'
   AND (TG_TABLE_NAME = 'dispatch_freight_stages' OR c.request_id = (to_jsonb(NEW)->>'request_id')::uuid)
 ORDER BY c.created_at DESC LIMIT 1;
 IF NOT FOUND OR a.amount_pen = -NEW.final_applied_pen THEN RETURN NULL; END IF;
 PERFORM public.budget_allocation_void(a.id, 'Flete final aprobado en Costos por ruta');
 PERFORM public.budget_allocate('TARIFA_PROPIA', NEW.dispatch_id, NULL, a.request_id, -NEW.final_applied_pen, true,
  jsonb_build_object('flete_final', NEW.final_applied_pen));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.budget_tariff_follow_final() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS budget_tariff_follow_final ON public.dispatch_request_freight_stages;
CREATE TRIGGER budget_tariff_follow_final AFTER UPDATE OF final_applied_pen ON public.dispatch_request_freight_stages
 FOR EACH ROW EXECUTE FUNCTION public.budget_tariff_follow_final();
DROP TRIGGER IF EXISTS budget_tariff_follow_final ON public.dispatch_freight_stages;
CREATE TRIGGER budget_tariff_follow_final AFTER UPDATE OF final_applied_pen ON public.dispatch_freight_stages
 FOR EACH ROW EXECUTE FUNCTION public.budget_tariff_follow_final();

-- D2: pendiente «combustible en la tarifa» (parche guardado de budget_pending)
DO $patch$
DECLARE def text := pg_get_functiondef('public.budget_pending()'::regprocedure);
 o text := 'HAVING count(*) > 1) g)';
 n text := 'HAVING count(*) > 1) g
   UNION ALL
   -- D2: combustible de Caja en ruta de tercero; la tarifa contratada suele incluirlo
   SELECT ''COMBUSTIBLE_EN_TARIFA'', m.root, m.dispatch_id, m.id, ''Combustible de Caja en ruta de tercero: posible duplicado con la tarifa contratada'',
     m.consumed_pen, (m.moved_on::timestamp AT TIME ZONE ''America/Lima''), NULL,
     ''Confirmar con el transportista si su tarifa incluye combustible; si lo incluye, anular el gasto en Caja''
   FROM m WHERE m.source = ''CAJA'' AND m.consumed_pen <> 0 AND m.concept = ''Gasto de Caja · Combustible''
     AND NOT COALESCE((SELECT sc.own FROM public.budget_route_scope(m.dispatch_id) sc), true))';
BEGIN
 IF position('COMBUSTIBLE_EN_TARIFA' IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'budget_pending cambió: revisar el parche de combustible en tarifa (D2)'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
