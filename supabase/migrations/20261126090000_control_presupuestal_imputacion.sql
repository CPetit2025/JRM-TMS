-- Control presupuestal de transporte por OT · etapa 2: imputación de Caja y combustible (docs/control-presupuestal).
-- R5  Comprometer (reserved_pen) sigue bloqueado sobre el tope; ejecutar (consumed_pen) nunca se bloquea: un gasto
--     real siempre se registra (el desvío lo gestiona la etapa 4).
-- B1  Gastos de Caja aprobados de la ruta (combustible, peajes, viáticos/alimentación, hospedaje, estacionamiento,
--     maniobras, otros) se imputan a la OT; alquiler de equipo y cuadrilla de estiba siguen su vínculo actual (R8).
-- D1  Flota propia: al programar se compromete la tarifa; al cerrar la ruta (LIQUIDADO/CERRADO) la OT pasa a consumir
--     los costos variables reales en lugar de la tarifa (reverso de la tarifa + gastos de Caja + combustible).
-- D2  Sin carga de combustible en la ruta: estimado = km × precio / rendimiento de la unidad, marcado «estimado»;
--     una carga real posterior lo reemplaza.
-- D3  Reparto entre las OT de la ruta por peso declarado; sin peso en todas, partes iguales. Gasto asignado a una
--     solicitud: directo. Solicitudes sin OT: su parte no se imputa (operación interna).
-- D5  Tercero: el flete contratado incluye su combustible; un gasto de Caja en su ruta es extraordinario y va directo.
-- D7  Solo rutas con salida desde la activación (economic_settings.budget_imputation_since).
-- Cada imputación queda en cost_allocations (clave única por origen y solicitud: sin duplicados).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Saldo de la partida: solo un aumento del comprometido se bloquea sobre el límite (R5)
-- ------------------------------------------------------------
DO $patch$
DECLARE sig regprocedure := 'public.transport_budget_balance()'::regprocedure; def text;
 o text := 'COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>v_old';
 n text := 'COALESCE(NEW.reserved_pen,0)>COALESCE(OLD.reserved_pen,0)';  -- en un INSERT, OLD es nulo
BEGIN
 def := pg_get_functiondef(sig);
 IF position(n IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'Saldo de partida no reconocido: revisar antes de migrar'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;
-- Lo mismo en la verificación de la familia (gasto registrado en un subcontrato)
DO $patch$
DECLARE sig regprocedure := 'public.transport_family_refresh()'::regprocedure; def text;
 o1 text := 'v_increase:=COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>0;';
 n1 text := 'v_increase:=COALESCE(NEW.reserved_pen,0)>0;';
 o2 text := 'v_increase:=COALESCE(NEW.reserved_pen,0)+COALESCE(NEW.consumed_pen,0)>COALESCE(OLD.reserved_pen,0)+COALESCE(OLD.consumed_pen,0);';
 n2 text := 'v_increase:=COALESCE(NEW.reserved_pen,0)>COALESCE(OLD.reserved_pen,0);';
BEGIN
 def := pg_get_functiondef(sig);
 IF position(n2 IN def) > 0 THEN RETURN; END IF;
 IF position(o1 IN def) = 0 OR position(o2 IN def) = 0 THEN RAISE EXCEPTION 'Verificación de la partida consolidada no reconocida: revisar antes de migrar'; END IF;
 EXECUTE replace(replace(def, o1, n1), o2, n2);
END $patch$;

-- ------------------------------------------------------------
-- 2. Activación e imputaciones
-- ------------------------------------------------------------
ALTER TABLE public.economic_settings ADD COLUMN IF NOT EXISTS budget_imputation_since timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.cost_allocations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('CAJA','COMBUSTIBLE_ESTIMADO','TARIFA_PROPIA')),
  dispatch_id  uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  expense_id   uuid REFERENCES public.dispatch_expenses(id) ON DELETE SET NULL,
  request_id   uuid,
  contract_id  uuid,
  amount_pen   numeric(15,2) NOT NULL,
  basis        text NOT NULL CHECK (basis IN ('DIRECTO','PESO','IGUAL')),
  status       text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','APLICADO','ANULADO')),
  applied_to   uuid,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz,
  voided_at    timestamptz
);
-- Regla C55: FK cubiertas por índices no parciales
CREATE INDEX IF NOT EXISTS cost_allocations_dispatch_idx ON public.cost_allocations(dispatch_id);
CREATE INDEX IF NOT EXISTS cost_allocations_expense_idx ON public.cost_allocations(expense_id);
CREATE INDEX IF NOT EXISTS cost_allocations_contract_idx ON public.cost_allocations(contract_id);
CREATE UNIQUE INDEX IF NOT EXISTS cost_allocations_expense_key ON public.cost_allocations(expense_id, request_id) WHERE status <> 'ANULADO' AND expense_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cost_allocations_route_key ON public.cost_allocations(kind, dispatch_id, request_id) WHERE status <> 'ANULADO' AND kind <> 'CAJA';
ALTER TABLE public.cost_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.cost_allocations;
CREATE POLICY security_active_account ON public.cost_allocations AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.cost_allocations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.economic_settings_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record;
BEGIN
 SELECT deviation_pct, deviation_pen, max_pending_days, budget_alert_pct, budget_cap_pct, budget_imputation_since INTO s FROM public.economic_settings WHERE id;
 RETURN jsonb_build_object('deviation_pct', COALESCE(s.deviation_pct, 10), 'deviation_pen', COALESCE(s.deviation_pen, 100),
  'max_pending_days', COALESCE(s.max_pending_days, 7), 'budget_alert_pct', COALESCE(s.budget_alert_pct, 70),
  'budget_cap_pct', COALESCE(s.budget_cap_pct, 80), 'budget_imputation_since', s.budget_imputation_since);
END $$;
REVOKE ALL ON FUNCTION public.economic_settings_get() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_settings_get() TO authenticated;

-- Reparto de un costo de la ruta entre sus solicitudes (D3). Las solicitudes sin OT reciben su parte, que no se imputa.
-- shortcut: peso declarado de la solicitud; sumar el peso de guía ERP y por componente cuando estén vinculados de forma confiable.
CREATE OR REPLACE FUNCTION public.budget_route_shares(p_dispatch_id uuid)
RETURNS TABLE(request_id uuid, contract_id uuid, share numeric, basis text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH r AS (SELECT t.id, t.contract_id, NULLIF(to_jsonb(t)->>'estimated_weight', '')::numeric AS kg
            FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
  m AS (SELECT count(*) AS n, bool_and(COALESCE(kg, 0) > 0) AS weighted, sum(kg) AS total FROM r)
 SELECT r.id, r.contract_id, CASE WHEN m.weighted THEN r.kg / m.total ELSE 1.0 / m.n END, CASE WHEN m.weighted THEN 'PESO' ELSE 'IGUAL' END
 FROM r, m
$$;
REVOKE ALL ON FUNCTION public.budget_route_shares(uuid) FROM PUBLIC,anon,authenticated;

-- Aplica o anula una imputación sobre la partida (OT raíz dueña del saldo)
CREATE OR REPLACE FUNCTION public.budget_allocation_apply(p_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record; v_owner uuid;
BEGIN
 SELECT * INTO a FROM public.cost_allocations WHERE id = p_id FOR UPDATE;
 IF NOT FOUND OR a.status <> 'PENDIENTE' THEN RETURN; END IF;
 v_owner := CASE WHEN a.contract_id IS NOT NULL THEN public.contract_budget_owner(a.contract_id) END;
 IF v_owner IS NOT NULL AND a.amount_pen <> 0 THEN
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen + a.amount_pen, updated_at = now() WHERE contract_id = v_owner AND concept = 'PARTIDA_TRANSPORTE';
 END IF;
 UPDATE public.cost_allocations SET status = 'APLICADO', applied_to = v_owner, applied_at = now() WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.budget_allocation_apply(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.budget_allocation_void(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM public.cost_allocations WHERE id = p_id FOR UPDATE;
 IF NOT FOUND OR a.status = 'ANULADO' THEN RETURN; END IF;
 IF a.status = 'APLICADO' AND a.applied_to IS NOT NULL AND a.amount_pen <> 0 THEN
  UPDATE public.contract_budgets SET consumed_pen = consumed_pen - a.amount_pen, updated_at = now() WHERE contract_id = a.applied_to AND concept = 'PARTIDA_TRANSPORTE';
 END IF;
 UPDATE public.cost_allocations SET status = 'ANULADO', voided_at = now(), detail = detail || jsonb_build_object('void_reason', p_reason) WHERE id = p_id;
END $$;
REVOKE ALL ON FUNCTION public.budget_allocation_void(uuid,text) FROM PUBLIC,anon,authenticated;

-- Reparte un monto de la ruta y crea sus imputaciones (aplicadas si p_apply)
CREATE OR REPLACE FUNCTION public.budget_allocate(p_kind text, p_dispatch_id uuid, p_expense_id uuid, p_request_id uuid, p_amount numeric,
 p_apply boolean, p_detail jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record; v_left numeric := round(p_amount, 2); v_amount numeric; v_n int; v_i int := 0; v_id uuid;
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
 SELECT count(*) INTO v_n FROM public.budget_route_shares(p_dispatch_id);
 -- El redondeo queda en la última parte: la suma imputada es exactamente el monto
 FOR s IN SELECT * FROM public.budget_route_shares(p_dispatch_id) ORDER BY request_id LOOP
  v_i := v_i + 1;
  v_amount := CASE WHEN v_i = v_n THEN v_left ELSE round(p_amount * s.share, 2) END;
  v_left := v_left - v_amount; v_id := NULL;
  INSERT INTO public.cost_allocations(kind, dispatch_id, expense_id, request_id, contract_id, amount_pen, basis, detail)
  VALUES (p_kind, p_dispatch_id, p_expense_id, s.request_id, s.contract_id, v_amount, s.basis, COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('share', round(s.share, 4)))
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL AND p_apply THEN PERFORM public.budget_allocation_apply(v_id); END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.budget_allocate(text,uuid,uuid,uuid,numeric,boolean,jsonb) FROM PUBLIC,anon,authenticated;

-- ¿La ruta entra al control (D7) y es de flota propia (D1)?
CREATE OR REPLACE FUNCTION public.budget_route_scope(p_dispatch_id uuid, OUT in_scope boolean, OUT own boolean, OUT closed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(x.scheduled_departure, now()) >= (SELECT budget_imputation_since FROM public.economic_settings WHERE id),
  COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) <> 'TERCERO',
  x.status IN ('LIQUIDADO','CERRADO')
 FROM public.dispatches x WHERE x.id = p_dispatch_id
$$;
REVOKE ALL ON FUNCTION public.budget_route_scope(uuid) FROM PUBLIC,anon,authenticated;

-- ------------------------------------------------------------
-- 3. Gasto de Caja aprobado → imputación (y su reverso si deja de estar aprobado o cambia el monto)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.budget_expense_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record; sc record; v_amount numeric; v_was boolean; v_is boolean;
BEGIN
 v_was := TG_OP = 'UPDATE' AND OLD.status = 'APROBADO';
 v_is := NEW.status = 'APROBADO' AND NEW.dispatch_id IS NOT NULL
  AND upper(COALESCE(NEW.expense_type, '')) IN ('COMBUSTIBLE','PEAJE','ALIMENTACION','VIATICOS','HOSPEDAJE','ESTACIONAMIENTO','MANIOBRAS','OTROS');
 v_amount := COALESCE(NEW.approved_amount, NEW.amount, 0);
 IF v_was AND v_is AND COALESCE(OLD.approved_amount, OLD.amount, 0) = v_amount AND OLD.dispatch_id IS NOT DISTINCT FROM NEW.dispatch_id
    AND OLD.transport_request_id IS NOT DISTINCT FROM NEW.transport_request_id THEN RETURN NULL; END IF;
 IF v_was THEN
  FOR a IN SELECT id FROM public.cost_allocations WHERE expense_id = NEW.id AND status <> 'ANULADO' LOOP
   PERFORM public.budget_allocation_void(a.id, 'Gasto de Caja sin aprobar o corregido');
  END LOOP;
 END IF;
 IF NOT v_is OR v_amount <= 0 THEN RETURN NULL; END IF;
 SELECT * INTO sc FROM public.budget_route_scope(NEW.dispatch_id);
 IF NOT COALESCE(sc.in_scope, false) THEN RETURN NULL; END IF;
 -- Combustible real de la ruta propia: reemplaza al estimado (D2)
 IF sc.own AND upper(NEW.expense_type) = 'COMBUSTIBLE' THEN
  FOR a IN SELECT id FROM public.cost_allocations WHERE dispatch_id = NEW.dispatch_id AND kind = 'COMBUSTIBLE_ESTIMADO' AND status <> 'ANULADO' LOOP
   PERFORM public.budget_allocation_void(a.id, 'Reemplazado por la carga real de combustible');
  END LOOP;
 END IF;
 -- Ruta propia abierta: queda pendiente hasta el cierre (la tarifa sigue comprometida); tercero o ruta cerrada: se aplica
 PERFORM public.budget_allocate('CAJA', NEW.dispatch_id, NEW.id,
  CASE WHEN EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id = NEW.dispatch_id AND dr.transport_request_id = NEW.transport_request_id)
   THEN NEW.transport_request_id END,
  v_amount, NOT sc.own OR sc.closed,
  jsonb_build_object('expense_type', upper(NEW.expense_type), 'is_billable', COALESCE(NEW.is_billable, false), 'own', sc.own));
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 -- Nunca bloquea la aprobación de Caja: el gasto queda sin imputar y se reporta
 RAISE WARNING 'Gasto % no imputado a la OT: %', NEW.id, SQLERRM;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.budget_expense_sync() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS budget_expense_sync ON public.dispatch_expenses;
CREATE TRIGGER budget_expense_sync AFTER INSERT OR UPDATE OF status, approved_amount, amount, dispatch_id, transport_request_id ON public.dispatch_expenses
 FOR EACH ROW EXECUTE FUNCTION public.budget_expense_sync();

-- ------------------------------------------------------------
-- 4. Cierre de una ruta propia (D1): reverso de la tarifa, gastos pendientes y combustible estimado (D2).
--    Disparador diferido: corre cuando el cierre ya pasó la tarifa de comprometido a ejecutado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.budget_route_close(p_dispatch_id uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; sc record; a record; f record; v_km numeric; v_kmpg numeric; v_price numeric; v_fuel numeric; v_req uuid;
BEGIN
 SELECT * INTO sc FROM public.budget_route_scope(p_dispatch_id);
 IF NOT COALESCE(sc.in_scope, false) OR NOT sc.own OR NOT sc.closed THEN RETURN; END IF;
 IF EXISTS (SELECT 1 FROM public.cost_allocations WHERE dispatch_id = p_dispatch_id AND kind = 'TARIFA_PROPIA' AND status <> 'ANULADO') THEN RETURN; END IF;
 SELECT x.id, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost, x.vehicle_plate,
   COALESCE(NULLIF(x.actual_distance_km, 0), NULLIF(x.estimated_km, 0), NULLIF(to_jsonb(x)->>'estimated_distance_km', '')::numeric) AS km
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 -- Tarifa: deja de ser el ejecutado de la OT
 IF EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id) THEN
  FOR f IN SELECT r.request_id, r.amount_pen FROM public.dispatch_request_freight r
           WHERE r.dispatch_id = p_dispatch_id AND r.status <> 'LIBERADO' AND r.contract_id IS NOT NULL AND r.amount_pen > 0 LOOP
   PERFORM public.budget_allocate('TARIFA_PROPIA', p_dispatch_id, NULL, f.request_id, -f.amount_pen, true, '{}'::jsonb);
  END LOOP;
 ELSIF d.freight_cost > 0 AND d.contract_id IS NOT NULL THEN
  SELECT t.id INTO v_req FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
  WHERE dr.dispatch_id = p_dispatch_id AND t.contract_id = d.contract_id ORDER BY t.id LIMIT 1;
  IF v_req IS NOT NULL THEN PERFORM public.budget_allocate('TARIFA_PROPIA', p_dispatch_id, NULL, v_req, -d.freight_cost, true, '{}'::jsonb); END IF;
 END IF;
 -- Gastos de Caja aprobados durante la ruta
 FOR a IN SELECT id FROM public.cost_allocations WHERE dispatch_id = p_dispatch_id AND status = 'PENDIENTE' LOOP
  PERFORM public.budget_allocation_apply(a.id);
 END LOOP;
 -- Combustible estimado si no hubo carga real en la ruta
 IF NOT EXISTS (SELECT 1 FROM public.cost_allocations WHERE dispatch_id = p_dispatch_id AND kind = 'CAJA' AND status <> 'ANULADO'
     AND detail->>'expense_type' = 'COMBUSTIBLE') AND COALESCE(d.km, 0) > 0 THEN
  SELECT COALESCE((SELECT NULLIF(to_jsonb(v)->>'expected_km_per_gallon', '')::numeric FROM public.vehicles v WHERE v.plate = d.vehicle_plate LIMIT 1),
    (SELECT NULLIF(to_jsonb(c)->>'default_km_per_gallon', '')::numeric FROM public.caja_settings c LIMIT 1), 10),
   COALESCE((SELECT NULLIF(to_jsonb(c)->>'fuel_price_per_gallon', '')::numeric FROM public.caja_settings c LIMIT 1), 16)
  INTO v_kmpg, v_price;
  v_fuel := round(d.km / v_kmpg * v_price, 2);
  PERFORM public.budget_allocate('COMBUSTIBLE_ESTIMADO', p_dispatch_id, NULL, NULL, v_fuel, true,
   jsonb_build_object('km', d.km, 'km_per_gallon', v_kmpg, 'price_per_gallon', v_price, 'estimado', true));
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.budget_route_close(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.budget_route_close_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 BEGIN
  PERFORM public.budget_route_close(NEW.id);
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Costos reales de la ruta % no imputados: %', NEW.id, SQLERRM;
 END;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.budget_route_close_trigger() FROM PUBLIC,anon,authenticated;
-- shortcut: una ruta que se reabre después de cerrada conserva sus imputaciones; revisar si se habilita reabrir rutas.
DROP TRIGGER IF EXISTS budget_route_close ON public.dispatches;
CREATE CONSTRAINT TRIGGER budget_route_close AFTER UPDATE OF status ON public.dispatches DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.status IN ('LIQUIDADO','CERRADO') AND OLD.status NOT IN ('LIQUIDADO','CERRADO'))
 EXECUTE FUNCTION public.budget_route_close_trigger();

-- Lectura: costos imputados de una ruta (detalle para el control presupuestal y la consulta de Finanzas)
CREATE OR REPLACE FUNCTION public.budget_route_allocations(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record;
BEGIN
 IF NOT (public.has_tms_read_permission('cierre-economico') OR public.has_tms_read_permission('despacho')
   OR public.has_tms_read_permission('contratos-servicios') OR public.has_tms_read_permission('caja') OR public.has_tms_read_permission('ot')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 RETURN jsonb_build_object('success', true, 'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', a.kind, 'status', a.status, 'amount_pen', a.amount_pen,
   'basis', a.basis, 'request_number', t.request_number, 'contract_code', c.code, 'detail', a.detail, 'created_at', a.created_at) ORDER BY a.created_at, a.kind)
  FROM public.cost_allocations a LEFT JOIN public.transport_requests t ON t.id = a.request_id LEFT JOIN public.contracts c ON c.id = a.contract_id
  WHERE a.dispatch_id = p_dispatch_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.budget_route_allocations(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_route_allocations(uuid) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
