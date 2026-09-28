-- ============================================================
-- CAJA DE TRANSPORTE — C3: Tarifario, presupuesto, reglas, combustible y reportes
-- ============================================================
-- (docs/caja/03-c3-tarifario-combustible-reportes.md)
--   * Tarifario de viáticos por ruta ⇒ presupuesto del viaje (combustible, peajes, alimentación, hospedaje).
--   * Reglas: gasto por encima del presupuesto de su categoría y hospedaje en viaje sin pernocte.
--   * Combustible: facturas de grifo con crédito conciliadas contra las cargas; rendimiento por carga y por unidad.
--   * Reportes: rentabilidad por viaje (flete vs costo real), presupuesto vs real y cuenta contable por categoría.
BEGIN;

-- ------------------------------------------------------------
-- 1. Permisos
-- ------------------------------------------------------------
UPDATE public.roles
SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["caja-combustible"]'::jsonb) p)
WHERE name = 'Jefe de Distribución';

CREATE OR REPLACE FUNCTION public.has_caja_read_access()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.has_tms_read_permission('caja') OR public.has_tms_read_permission('caja-gastos')
      OR public.has_tms_read_permission('caja-aprobacion') OR public.has_tms_read_permission('caja-liquidaciones')
      OR public.has_tms_read_permission('caja-fondos') OR public.has_tms_read_permission('caja-anticipos')
      OR public.has_tms_read_permission('caja-combustible') OR public.has_tms_read_permission('caja-tarifario');
$$;

-- ------------------------------------------------------------
-- 2. Parámetros, cuentas contables y tarifario
-- ------------------------------------------------------------
ALTER TABLE public.caja_settings
  ADD COLUMN IF NOT EXISTS fuel_price_per_gallon numeric(8,2) NOT NULL DEFAULT 16 CHECK (fuel_price_per_gallon > 0),
  ADD COLUMN IF NOT EXISTS budget_tolerance_pct  numeric(5,2) NOT NULL DEFAULT 10 CHECK (budget_tolerance_pct BETWEEN 0 AND 100);

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS account_code text,
  ADD COLUMN IF NOT EXISTS budget_key   text NOT NULL DEFAULT 'OTROS' CHECK (budget_key IN ('COMBUSTIBLE', 'PEAJE', 'ALIMENTACION', 'HOSPEDAJE', 'OTROS'));
UPDATE public.expense_categories SET budget_key = CASE
  WHEN code = 'COMBUSTIBLE' THEN 'COMBUSTIBLE' WHEN code = 'PEAJE' THEN 'PEAJE'
  WHEN code IN ('ALIMENTACION', 'VIATICOS') THEN 'ALIMENTACION' WHEN code = 'HOSPEDAJE' THEN 'HOSPEDAJE' ELSE 'OTROS' END;
-- Plan contable general empresarial (PCGE) como referencia; editable en /caja/tarifario
UPDATE public.expense_categories SET account_code = CASE
  WHEN code = 'COMBUSTIBLE' THEN '6591' WHEN code = 'PEAJE' THEN '6311' WHEN code IN ('ALIMENTACION', 'VIATICOS', 'HOSPEDAJE') THEN '6312'
  WHEN code IN ('REPUESTOS', 'LLANTAS_PARCHADO') THEN '6343' WHEN code IN ('ALQUILER_EQUIPO') THEN '6352'
  WHEN code IN ('CUADRILLA_ESTIBA', 'MANIOBRAS') THEN '6329' ELSE '6599' END
WHERE account_code IS NULL;

CREATE TABLE IF NOT EXISTS public.route_allowance_rates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  origin                text,
  destination           text,
  distance_km           numeric(10,2) NOT NULL CHECK (distance_km > 0),   -- solo ida
  round_trip            boolean NOT NULL DEFAULT true,
  days                  int NOT NULL DEFAULT 1 CHECK (days >= 1),
  nights                int NOT NULL DEFAULT 0 CHECK (nights >= 0),
  toll_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (toll_amount >= 0),  -- peajes del recorrido completo
  toll_by_type          jsonb NOT NULL DEFAULT '{}'::jsonb,                        -- {"TRACTO": 420} según ejes
  meal_per_day          numeric(12,2) NOT NULL DEFAULT 0 CHECK (meal_per_day >= 0),
  lodging_per_night     numeric(12,2) NOT NULL DEFAULT 0 CHECK (lodging_per_night >= 0),
  other_amount          numeric(12,2) NOT NULL DEFAULT 0 CHECK (other_amount >= 0),
  fuel_price_per_gallon numeric(8,2) CHECK (fuel_price_per_gallon IS NULL OR fuel_price_per_gallon > 0),
  is_active             boolean NOT NULL DEFAULT true,
  notes                 text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid()
);

CREATE TABLE IF NOT EXISTS public.trip_budgets (
  dispatch_id uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
  rate_id     uuid REFERENCES public.route_allowance_rates(id) ON DELETE SET NULL,
  breakdown   jsonb NOT NULL DEFAULT '{}'::jsonb,
  total       numeric(12,2) NOT NULL DEFAULT 0,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Presupuesto de un viaje según la tarifa y la unidad (rendimiento esperado y tipo)
CREATE OR REPLACE FUNCTION public.calculate_trip_budget(p_rate_id uuid, p_vehicle_plate text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r     public.route_allowance_rates%ROWTYPE;
  cfg   public.caja_settings%ROWTYPE;
  v     record;
  km    numeric;
  kmpg  numeric;
  price numeric;
  gal   numeric;
  b     jsonb;
BEGIN
  SELECT * INTO r FROM public.route_allowance_rates WHERE id = p_rate_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Tarifa no encontrada'); END IF;
  SELECT * INTO cfg FROM public.caja_settings WHERE id;
  SELECT type, expected_km_per_gallon INTO v FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
  km := r.distance_km * CASE WHEN r.round_trip THEN 2 ELSE 1 END;
  kmpg := COALESCE(v.expected_km_per_gallon, cfg.default_km_per_gallon);
  price := COALESCE(r.fuel_price_per_gallon, cfg.fuel_price_per_gallon);
  gal := round(km / kmpg, 2);
  b := jsonb_build_object(
    'COMBUSTIBLE', round(gal * price, 2),
    'PEAJE', COALESCE((r.toll_by_type->>v.type)::numeric, r.toll_amount),
    'ALIMENTACION', round(r.meal_per_day * r.days, 2),
    'HOSPEDAJE', round(r.lodging_per_night * r.nights, 2),
    'OTROS', r.other_amount);
  RETURN jsonb_build_object('success', true, 'breakdown', b,
    'total', (SELECT sum(value::numeric) FROM jsonb_each_text(b)),
    'km', km, 'gallons', gal, 'km_per_gallon', kmpg, 'fuel_price', price, 'rate', r.name, 'days', r.days, 'nights', r.nights);
END $$;

CREATE OR REPLACE FUNCTION public.set_trip_budget(p_dispatch_id uuid, p_rate_id uuid DEFAULT NULL, p_breakdown jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d     record;
  calc  jsonb;
  b     jsonb := p_breakdown;
  total numeric;
BEGIN
  IF NOT (public.has_tms_permission('caja-anticipos') OR public.has_tms_permission('caja-tarifario')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para presupuestar viajes');
  END IF;
  SELECT id, vehicle_plate, site_id INTO d FROM public.dispatches WHERE id = p_dispatch_id;
  IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho no disponible'); END IF;
  IF public.caja_trip_is_settled(p_dispatch_id) THEN RETURN jsonb_build_object('success', false, 'error', 'El viaje ya fue liquidado'); END IF;
  IF b IS NULL THEN
    IF p_rate_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Elija una tarifa o ingrese el presupuesto'); END IF;
    calc := public.calculate_trip_budget(p_rate_id, d.vehicle_plate);
    IF NOT (calc->>'success')::boolean THEN RETURN calc; END IF;
    b := calc->'breakdown';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(b) WHERE key NOT IN ('COMBUSTIBLE', 'PEAJE', 'ALIMENTACION', 'HOSPEDAJE', 'OTROS')
             OR value !~ '^[0-9]+(\.[0-9]+)?$') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Presupuesto inválido: use COMBUSTIBLE, PEAJE, ALIMENTACION, HOSPEDAJE u OTROS con montos positivos');
  END IF;
  total := COALESCE((SELECT sum(value::numeric) FROM jsonb_each_text(b)), 0);
  INSERT INTO public.trip_budgets (dispatch_id, rate_id, breakdown, total)
  VALUES (p_dispatch_id, p_rate_id, b, total)
  ON CONFLICT (dispatch_id) DO UPDATE SET rate_id = EXCLUDED.rate_id, breakdown = EXCLUDED.breakdown, total = EXCLUDED.total,
    updated_by = auth.uid(), updated_at = now();
  RETURN jsonb_build_object('success', true, 'breakdown', b, 'total', total);
END $$;

-- ------------------------------------------------------------
-- 3. Reglas adicionales: presupuesto por categoría y hospedaje sin pernocte
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_extra_expense_alerts(e public.dispatch_expenses)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a       jsonb := '[]'::jsonb;
  cfg     public.caja_settings%ROWTYPE;
  tb      public.trip_budgets%ROWTYPE;
  v_key   text;
  v_bud   numeric;
  v_spent numeric;
  v_nights int;
  w_start date;
  w_end   date;
BEGIN
  IF e.dispatch_id IS NULL THEN RETURN a; END IF;
  SELECT * INTO cfg FROM public.caja_settings WHERE id;
  SELECT * INTO tb FROM public.trip_budgets WHERE dispatch_id = e.dispatch_id;
  SELECT budget_key INTO v_key FROM public.expense_categories WHERE code = e.expense_type;
  v_key := COALESCE(v_key, 'OTROS');
  IF tb.dispatch_id IS NOT NULL THEN
    v_bud := NULLIF(tb.breakdown->>v_key, '')::numeric;
    SELECT COALESCE(sum(COALESCE(x.approved_amount, x.amount)), 0) INTO v_spent
    FROM public.dispatch_expenses x LEFT JOIN public.expense_categories c ON c.code = x.expense_type
    WHERE x.dispatch_id = e.dispatch_id AND x.id <> e.id AND x.status <> 'RECHAZADO' AND COALESCE(c.budget_key, 'OTROS') = v_key;
    v_spent := v_spent + e.amount;
    IF v_bud IS NOT NULL AND v_spent > v_bud * (1 + cfg.budget_tolerance_pct / 100) THEN
      a := a || jsonb_build_object('code', 'SOBRE_PRESUPUESTO', 'level', 'MEDIA',
        'message', 'Acumulado de ' || lower(v_key) || ' en el viaje S/ ' || v_spent || ' supera el presupuesto S/ ' || v_bud
                   || CASE WHEN cfg.budget_tolerance_pct > 0 THEN ' (+' || cfg.budget_tolerance_pct || '%)' ELSE '' END);
    END IF;
  END IF;
  IF v_key = 'HOSPEDAJE' THEN
    SELECT r.nights INTO v_nights FROM public.route_allowance_rates r WHERE r.id = tb.rate_id;
    SELECT window_start, window_end INTO w_start, w_end FROM public.caja_dispatch_window(e.dispatch_id);
    -- La ventana incluye ±1 día: salida y retorno el mismo día ⇒ amplitud 2
    IF v_nights = 0 OR (w_end IS NOT NULL AND w_end - w_start <= 2) THEN
      a := a || jsonb_build_object('code', 'HOSPEDAJE_SIN_PERNOCTE', 'level', 'MEDIA', 'message', 'Hospedaje en un viaje sin pernocte');
    END IF;
  END IF;
  RETURN a;
END $$;

-- ------------------------------------------------------------
-- 4. Combustible: facturas de grifo y conciliación
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fuel_station_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id         uuid NOT NULL REFERENCES public.fuel_stations(id),
  document_series    text NOT NULL,
  document_number    text NOT NULL,
  issue_date         date NOT NULL,
  period_start       date NOT NULL,
  period_end         date NOT NULL CHECK (period_end >= period_start),
  amount             numeric(12,2) NOT NULL CHECK (amount > 0),
  gallons            numeric(12,2) CHECK (gallons IS NULL OR gallons > 0),
  loads_amount       numeric(12,2),
  loads_gallons      numeric(12,2),
  loads_count        int,
  difference_amount  numeric(12,2),
  status             text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'CONCILIADA', 'CON_DIFERENCIAS')),
  notes              text,
  reconciled_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reconciled_at      timestamptz,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (station_id, document_series, document_number)
);
ALTER TABLE public.dispatch_expenses ADD COLUMN IF NOT EXISTS fuel_invoice_id uuid REFERENCES public.fuel_station_invoices(id) ON DELETE SET NULL;

-- Cruza la factura del periodo con las cargas registradas (no rechazadas) del grifo que no estén en otra factura
CREATE OR REPLACE FUNCTION public.reconcile_fuel_invoice(p_invoice_id uuid, p_accept_difference boolean DEFAULT false, p_notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f      public.fuel_station_invoices%ROWTYPE;
  v_amt  numeric;
  v_gal  numeric;
  v_n    int;
  v_diff numeric;
  v_st   text;
BEGIN
  IF NOT public.has_tms_permission('caja-combustible') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para conciliar combustible');
  END IF;
  SELECT * INTO f FROM public.fuel_station_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Factura no encontrada'); END IF;
  IF f.status = 'CONCILIADA' THEN RETURN jsonb_build_object('success', false, 'error', 'La factura ya está conciliada'); END IF;
  PERFORM set_config('caja.review', 'on', true);
  UPDATE public.dispatch_expenses SET fuel_invoice_id = NULL WHERE fuel_invoice_id = f.id;
  UPDATE public.dispatch_expenses SET fuel_invoice_id = f.id
  WHERE fuel_station_id = f.station_id AND expense_type = 'COMBUSTIBLE' AND status <> 'RECHAZADO' AND fuel_invoice_id IS NULL
    AND expense_date BETWEEN f.period_start AND f.period_end;
  PERFORM set_config('caja.review', '', true);
  SELECT COALESCE(sum(amount), 0), COALESCE(sum(fuel_gallons), 0), count(*) INTO v_amt, v_gal, v_n
  FROM public.dispatch_expenses WHERE fuel_invoice_id = f.id;
  v_diff := round(f.amount - v_amt, 2);
  v_st := CASE WHEN abs(v_diff) <= 1 AND (f.gallons IS NULL OR abs(f.gallons - v_gal) <= 0.5) THEN 'CONCILIADA' ELSE 'CON_DIFERENCIAS' END;
  IF v_st = 'CON_DIFERENCIAS' AND p_accept_difference THEN
    IF NULLIF(trim(p_notes), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Explique la diferencia para aceptarla');
    END IF;
    v_st := 'CONCILIADA';
  END IF;
  UPDATE public.fuel_station_invoices SET loads_amount = v_amt, loads_gallons = v_gal, loads_count = v_n, difference_amount = v_diff,
    status = v_st, notes = COALESCE(NULLIF(trim(p_notes), ''), notes),
    reconciled_by = CASE WHEN v_st = 'CONCILIADA' THEN auth.uid() END, reconciled_at = CASE WHEN v_st = 'CONCILIADA' THEN now() END
  WHERE id = f.id;
  RETURN jsonb_build_object('success', true, 'status', v_st, 'loads_amount', v_amt, 'loads_gallons', v_gal, 'loads_count', v_n, 'difference', v_diff);
END $$;

-- Rendimiento por carga: km desde la carga anterior de la unidad / galones repuestos
CREATE OR REPLACE VIEW public.vw_fuel_efficiency WITH (security_invoker = true) AS
WITH loads AS (
  SELECT e.id, e.vehicle_plate, e.dispatch_id, e.expense_date, e.created_at, e.amount, e.fuel_gallons, e.fuel_odometer, e.status,
         e.fuel_station_id, e.paid_by, e.driver_id,
         lag(e.fuel_odometer) OVER (PARTITION BY e.vehicle_plate ORDER BY e.expense_date, e.created_at) AS prev_odometer
  FROM public.dispatch_expenses e
  WHERE e.expense_type = 'COMBUSTIBLE' AND e.status <> 'RECHAZADO' AND e.fuel_gallons > 0 AND e.fuel_odometer IS NOT NULL
)
SELECT l.*, l.fuel_odometer - l.prev_odometer AS km_since_prev,
       CASE WHEN l.prev_odometer IS NOT NULL AND l.fuel_odometer > l.prev_odometer THEN round((l.fuel_odometer - l.prev_odometer) / l.fuel_gallons, 2) END AS km_per_gallon,
       round(l.amount / l.fuel_gallons, 2) AS price_per_gallon,
       COALESCE(v.expected_km_per_gallon, (SELECT default_km_per_gallon FROM public.caja_settings WHERE id)) AS expected_km_per_gallon,
       s.name AS station_name
FROM loads l
LEFT JOIN public.vw_caja_units v ON v.plate = l.vehicle_plate
LEFT JOIN public.fuel_stations s ON s.id = l.fuel_station_id;

CREATE OR REPLACE VIEW public.vw_vehicle_fuel_summary WITH (security_invoker = true) AS
SELECT f.vehicle_plate,
       count(*) AS loads, sum(f.fuel_gallons) AS gallons, sum(f.amount) AS amount,
       round(sum(f.amount) / NULLIF(sum(f.fuel_gallons), 0), 2) AS avg_price_per_gallon,
       sum(f.km_since_prev) FILTER (WHERE f.km_per_gallon IS NOT NULL) AS km,
       round(sum(f.km_since_prev) FILTER (WHERE f.km_per_gallon IS NOT NULL) / NULLIF(sum(f.fuel_gallons) FILTER (WHERE f.km_per_gallon IS NOT NULL), 0), 2) AS km_per_gallon,
       max(f.expected_km_per_gallon) AS expected_km_per_gallon,
       round(sum(f.amount) FILTER (WHERE f.km_per_gallon IS NOT NULL) / NULLIF(sum(f.km_since_prev) FILTER (WHERE f.km_per_gallon IS NOT NULL), 0), 3) AS fuel_cost_per_km,
       max(f.expense_date) AS last_load_date
FROM public.vw_fuel_efficiency f
WHERE f.expense_date >= (now() AT TIME ZONE 'America/Lima')::date - 90
GROUP BY f.vehicle_plate;

-- ------------------------------------------------------------
-- 5. Reportes
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_trip_profitability WITH (security_invoker = true) AS
WITH x AS (
  SELECT e.dispatch_id, COALESCE(c.budget_key, 'OTROS') AS k, COALESCE(c.ledger_category, 'OPERACION') AS lc,
         COALESCE(e.approved_amount, e.amount) AS amt, e.is_billable
  FROM public.dispatch_expenses e LEFT JOIN public.expense_categories c ON c.code = e.expense_type
  WHERE e.status = 'APROBADO' AND e.dispatch_id IS NOT NULL
), agg AS (
  SELECT dispatch_id,
         sum(amt) AS expenses,
         sum(amt) FILTER (WHERE k = 'COMBUSTIBLE') AS fuel,
         sum(amt) FILTER (WHERE k = 'PEAJE') AS tolls,
         sum(amt) FILTER (WHERE k IN ('ALIMENTACION', 'HOSPEDAJE')) AS per_diem,
         sum(amt) FILTER (WHERE k = 'OTROS' AND lc = 'OPERACION') AS other_ops,
         sum(amt) FILTER (WHERE lc IN ('MANTENIMIENTO', 'NEUMATICOS')) AS maintenance,
         sum(amt) FILTER (WHERE is_billable) AS billable
  FROM x GROUP BY dispatch_id
)
SELECT t.id AS dispatch_id, t.dispatch_number, t.vehicle_plate, t.driver_id, t.status, t.departure_at, t.returned_at, t.site_id, t.contract_id,
       COALESCE(t.freight, 0) AS freight, t.km,
       COALESCE(a.expenses, 0) AS expenses, COALESCE(a.fuel, 0) AS fuel, COALESCE(a.tolls, 0) AS tolls, COALESCE(a.per_diem, 0) AS per_diem,
       COALESCE(a.other_ops, 0) AS other_ops, COALESCE(a.maintenance, 0) AS maintenance, COALESCE(a.billable, 0) AS billable,
       b.total AS budget, b.breakdown AS budget_breakdown,
       COALESCE(t.freight, 0) + COALESCE(a.billable, 0) - COALESCE(a.expenses, 0) AS margin,
       CASE WHEN COALESCE(t.freight, 0) + COALESCE(a.billable, 0) > 0
            THEN round((COALESCE(t.freight, 0) + COALESCE(a.billable, 0) - COALESCE(a.expenses, 0)) / (COALESCE(t.freight, 0) + COALESCE(a.billable, 0)) * 100, 1) END AS margin_pct,
       CASE WHEN t.km > 0 THEN round(COALESCE(a.expenses, 0) / t.km, 3) END AS cost_per_km,
       s.status AS settlement_status
FROM public.vw_caja_trips t
LEFT JOIN agg a ON a.dispatch_id = t.id
LEFT JOIN public.trip_budgets b ON b.dispatch_id = t.id
LEFT JOIN public.trip_settlements s ON s.dispatch_id = t.id;

CREATE OR REPLACE VIEW public.vw_trip_budget_vs_actual WITH (security_invoker = true) AS
SELECT b.dispatch_id, k.key AS category, NULLIF(k.value, '')::numeric AS budget,
       COALESCE((SELECT sum(COALESCE(e.approved_amount, e.amount)) FROM public.dispatch_expenses e
                 LEFT JOIN public.expense_categories c ON c.code = e.expense_type
                 WHERE e.dispatch_id = b.dispatch_id AND e.status = 'APROBADO' AND COALESCE(c.budget_key, 'OTROS') = k.key), 0) AS actual
FROM public.trip_budgets b CROSS JOIN LATERAL jsonb_each_text(b.breakdown) k;

-- ------------------------------------------------------------
-- 6. RLS
-- ------------------------------------------------------------
ALTER TABLE public.route_allowance_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fuel_station_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.route_allowance_rates, public.trip_budgets, public.fuel_station_invoices FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.route_allowance_rates, public.fuel_station_invoices TO authenticated;
GRANT SELECT ON public.trip_budgets TO authenticated;
DROP POLICY IF EXISTS route_rates_read ON public.route_allowance_rates;
DROP POLICY IF EXISTS route_rates_write ON public.route_allowance_rates;
DROP POLICY IF EXISTS trip_budgets_read ON public.trip_budgets;
DROP POLICY IF EXISTS fuel_invoices_read ON public.fuel_station_invoices;
DROP POLICY IF EXISTS fuel_invoices_write ON public.fuel_station_invoices;
DROP POLICY IF EXISTS expense_categories_admin ON public.expense_categories;
CREATE POLICY route_rates_read ON public.route_allowance_rates FOR SELECT TO authenticated USING (public.has_caja_read_access());
CREATE POLICY route_rates_write ON public.route_allowance_rates FOR ALL TO authenticated
  USING (public.has_tms_permission('caja-tarifario')) WITH CHECK (public.has_tms_permission('caja-tarifario'));
CREATE POLICY trip_budgets_read ON public.trip_budgets FOR SELECT TO authenticated
  USING (public.has_caja_read_access() AND EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = dispatch_id AND public.can_access_site(d.site_id)));
CREATE POLICY fuel_invoices_read ON public.fuel_station_invoices FOR SELECT TO authenticated USING (public.has_caja_read_access());
-- Registrar la factura; la conciliación (estado) solo por reconcile_fuel_invoice
CREATE POLICY fuel_invoices_write ON public.fuel_station_invoices FOR INSERT TO authenticated
  WITH CHECK (public.has_tms_permission('caja-combustible') AND status = 'PENDIENTE');
-- Categorías: límites, comprobante obligatorio y cuenta contable (Administrador o tarifario)
CREATE POLICY expense_categories_admin ON public.expense_categories FOR ALL TO authenticated
  USING (public.has_tms_permission('caja-tarifario')) WITH CHECK (public.has_tms_permission('caja-tarifario'));
GRANT SELECT ON public.vw_fuel_efficiency, public.vw_vehicle_fuel_summary, public.vw_trip_profitability, public.vw_trip_budget_vs_actual TO authenticated;

CREATE OR REPLACE FUNCTION public.update_caja_settings(
  p_double_approval_threshold numeric, p_settlement_due_hours int,
  p_default_km_per_gallon numeric, p_fuel_efficiency_tolerance_pct numeric,
  p_fuel_price_per_gallon numeric DEFAULT NULL, p_budget_tolerance_pct numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador cambia los parámetros de caja');
  END IF;
  UPDATE public.caja_settings SET
    double_approval_threshold = NULLIF(p_double_approval_threshold, 0),
    settlement_due_hours = COALESCE(p_settlement_due_hours, settlement_due_hours),
    default_km_per_gallon = COALESCE(p_default_km_per_gallon, default_km_per_gallon),
    fuel_efficiency_tolerance_pct = COALESCE(p_fuel_efficiency_tolerance_pct, fuel_efficiency_tolerance_pct),
    fuel_price_per_gallon = COALESCE(p_fuel_price_per_gallon, fuel_price_per_gallon),
    budget_tolerance_pct = COALESCE(p_budget_tolerance_pct, budget_tolerance_pct),
    updated_at = now(), updated_by = auth.uid()
  WHERE id;
  RETURN jsonb_build_object('success', true);
END $$;
DROP FUNCTION IF EXISTS public.update_caja_settings(numeric, int, numeric, numeric);

-- Parámetros de combustible de la unidad (Caja no escribe el maestro de flota)
CREATE OR REPLACE FUNCTION public.set_vehicle_fuel_params(p_plate text, p_tank_capacity numeric, p_expected_km_per_gallon numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid;
BEGIN
  IF NOT public.has_tms_permission('caja-combustible') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para configurar combustible');
  END IF;
  SELECT site_id INTO v_site FROM public.vehicles WHERE plate = upper(trim(p_plate));
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no disponible'); END IF;
  IF (p_tank_capacity IS NOT NULL AND p_tank_capacity <= 0) OR (p_expected_km_per_gallon IS NOT NULL AND p_expected_km_per_gallon <= 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los valores deben ser mayores a 0');
  END IF;
  UPDATE public.vehicles SET fuel_tank_capacity_gal = p_tank_capacity, expected_km_per_gallon = p_expected_km_per_gallon WHERE plate = upper(trim(p_plate));
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.calculate_trip_budget(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_trip_budget(uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reconcile_fuel_invoice(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_caja_settings(numeric, int, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_vehicle_fuel_params(text, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.caja_extra_expense_alerts(public.dispatch_expenses) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_trip_budget(uuid, text), public.set_trip_budget(uuid, uuid, jsonb),
  public.reconcile_fuel_invoice(uuid, boolean, text), public.update_caja_settings(numeric, int, numeric, numeric, numeric, numeric),
  public.set_vehicle_fuel_params(text, numeric, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
