-- 20260928130000_f11_alquileres_tco.sql
-- FASE 11 — Contratos, alquileres y liquidación + TCO consolidado.
--
-- * Contratos de alquiler (seco) por activo y arrendador (carrier): tarifa mensual/diaria/horaria/
--   por km, km/horas incluidos, excesos, condiciones, renovación encadenada, sin traslapes.
-- * Liquidación persistida y aprobada: días, horas y km REALES del periodo (lecturas de odómetro/
--   horómetro, no km estimados de despachos), excesos, descuento por indisponibilidad imputable
--   (OT del periodo), penalidades, consumos y costos adicionales. Aprobada = inmutable. Una por periodo.
-- * Libro de costos por activo (vw_vehicle_cost_ledger): fuente única para el TCO — mantenimiento,
--   operación, combustible, neumáticos (costo/km × km en la unidad), multas, siniestros y alquiler.
--   vehicle_tco_analytics y vw_asset_tco se derivan del libro. Mantenimiento y liquidación no se
--   mezclan: cada uno aporta su línea al activo.

BEGIN;

-- ------------------------------------------------------------
-- 1. Contratos
-- ------------------------------------------------------------
ALTER TABLE public.vehicle_lease_contracts
  ADD COLUMN IF NOT EXISTS contract_code text,
  ADD COLUMN IF NOT EXISTS rate_type text NOT NULL DEFAULT 'MENSUAL',
  ADD COLUMN IF NOT EXISTS rate_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS included_hours numeric(10,2),
  ADD COLUMN IF NOT EXISTS excess_hour_rate numeric(12,2),
  ADD COLUMN IF NOT EXISTS discount_downtime boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS penalty_terms text,
  ADD COLUMN IF NOT EXISTS conditions text,
  ADD COLUMN IF NOT EXISTS parent_contract_id uuid REFERENCES public.vehicle_lease_contracts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES public.sites(id),
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

UPDATE public.vehicle_lease_contracts SET
  rate_type = 'MENSUAL', rate_amount = COALESCE(rate_amount, monthly_base_fee),
  status = upper(COALESCE(status, 'ACTIVO')),
  contract_code = COALESCE(contract_code, 'ALQ-' || to_char(created_at, 'YYMMDD') || '-' || upper(substr(id::text, 1, 4)));
UPDATE public.vehicle_lease_contracts c SET site_id = v.site_id FROM public.vehicles v WHERE v.id = c.vehicle_id AND c.site_id IS NULL;

ALTER TABLE public.vehicle_lease_contracts DROP CONSTRAINT IF EXISTS vehicle_lease_contracts_checks;
ALTER TABLE public.vehicle_lease_contracts ADD CONSTRAINT vehicle_lease_contracts_checks CHECK (
  rate_type IN ('MENSUAL', 'DIARIA', 'HORARIA', 'KM')
  AND status IN ('BORRADOR', 'ACTIVO', 'RENOVADO', 'TERMINADO', 'VENCIDO')
  AND rate_amount >= 0 AND COALESCE(excess_km_rate, 0) >= 0 AND COALESCE(excess_hour_rate, 0) >= 0
  AND (end_date IS NULL OR end_date >= start_date));
ALTER TABLE public.vehicle_lease_contracts ALTER COLUMN rate_amount SET NOT NULL;
ALTER TABLE public.vehicle_lease_contracts ALTER COLUMN start_date SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_contract_code ON public.vehicle_lease_contracts (contract_code);

CREATE OR REPLACE FUNCTION public.normalize_lease_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.rate_type := upper(COALESCE(NEW.rate_type, 'MENSUAL'));
  NEW.status := upper(COALESCE(NEW.status, 'ACTIVO'));
  NEW.rate_amount := COALESCE(NEW.rate_amount, NEW.monthly_base_fee);
  IF NEW.rate_type = 'MENSUAL' THEN NEW.monthly_base_fee := NEW.rate_amount; END IF;
  NEW.contract_code := COALESCE(NEW.contract_code, 'ALQ-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(gen_random_uuid()::text, 1, 4)));
  SELECT site_id INTO NEW.site_id FROM public.vehicles WHERE id = NEW.vehicle_id;
  NEW.created_by := COALESCE(NEW.created_by, auth.uid());
  NEW.updated_at := now();
  -- Un activo no puede tener dos contratos vigentes que se traslapen
  IF NEW.status = 'ACTIVO' AND EXISTS (
       SELECT 1 FROM public.vehicle_lease_contracts c
       WHERE c.vehicle_id = NEW.vehicle_id AND c.id <> NEW.id AND c.status = 'ACTIVO'
         AND daterange(c.start_date, COALESCE(c.end_date, 'infinity'::date), '[]') && daterange(NEW.start_date, COALESCE(NEW.end_date, 'infinity'::date), '[]')) THEN
    RAISE EXCEPTION 'La unidad ya tiene un contrato de alquiler vigente en ese periodo';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_lease_contract ON public.vehicle_lease_contracts;
CREATE TRIGGER trg_normalize_lease_contract BEFORE INSERT OR UPDATE ON public.vehicle_lease_contracts
FOR EACH ROW EXECUTE FUNCTION public.normalize_lease_contract();

-- El maestro refleja la propiedad del activo según sus contratos
CREATE OR REPLACE FUNCTION public.sync_vehicle_ownership_from_lease()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v uuid := COALESCE(NEW.vehicle_id, OLD.vehicle_id);
BEGIN
  UPDATE public.vehicles SET ownership_status = CASE
      WHEN EXISTS (SELECT 1 FROM public.vehicle_lease_contracts c WHERE c.vehicle_id = v AND c.status = 'ACTIVO') THEN 'ALQUILADO'
      WHEN ownership_status = 'ALQUILADO' THEN 'PROPIO' ELSE ownership_status END
  WHERE id = v;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_vehicle_ownership_from_lease ON public.vehicle_lease_contracts;
CREATE TRIGGER trg_sync_vehicle_ownership_from_lease AFTER INSERT OR UPDATE OF status OR DELETE ON public.vehicle_lease_contracts
FOR EACH ROW EXECUTE FUNCTION public.sync_vehicle_ownership_from_lease();

CREATE OR REPLACE FUNCTION public.renew_lease_contract(
  p_contract_id uuid, p_new_end date, p_rate_amount numeric DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c     public.vehicle_lease_contracts%ROWTYPE;
  v_new uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('flota') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  SELECT * INTO c FROM public.vehicle_lease_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND OR c.status <> 'ACTIVO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se renueva un contrato activo');
  END IF;
  IF c.end_date IS NULL OR p_new_end IS NULL OR p_new_end <= c.end_date THEN
    RETURN jsonb_build_object('success', false, 'error', 'La renovación requiere una fecha de término posterior a ' || COALESCE(c.end_date::text, 'la actual (indefinida)'));
  END IF;
  UPDATE public.vehicle_lease_contracts SET status = 'RENOVADO' WHERE id = c.id;
  INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, monthly_base_fee, included_km,
    excess_km_rate, guaranteed_km, included_hours, excess_hour_rate, discount_downtime, penalty_terms, conditions,
    start_date, end_date, status, parent_contract_id, notes)
  VALUES (c.vehicle_id, c.provider_id, c.contract_type, c.rate_type, COALESCE(p_rate_amount, c.rate_amount), COALESCE(p_rate_amount, c.rate_amount),
    c.included_km, c.excess_km_rate, c.guaranteed_km, c.included_hours, c.excess_hour_rate, c.discount_downtime, c.penalty_terms, c.conditions,
    c.end_date + 1, p_new_end, 'ACTIVO', c.id, p_notes)
  RETURNING id INTO v_new;
  RETURN jsonb_build_object('success', true, 'contract_id', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.renew_lease_contract(uuid, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renew_lease_contract(uuid, date, numeric, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Liquidación de alquiler seco
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lease_settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL REFERENCES public.vehicle_lease_contracts(id),
  vehicle_id         uuid NOT NULL REFERENCES public.vehicles(id),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  days               int NOT NULL,
  hours_used         numeric(10,2) NOT NULL DEFAULT 0,
  km_used            numeric(12,2) NOT NULL DEFAULT 0,
  downtime_days      numeric(8,2) NOT NULL DEFAULT 0,
  base_amount        numeric(12,2) NOT NULL,
  excess_km          numeric(12,2) NOT NULL DEFAULT 0,
  excess_km_amount   numeric(12,2) NOT NULL DEFAULT 0,
  excess_hours       numeric(10,2) NOT NULL DEFAULT 0,
  excess_hours_amount numeric(12,2) NOT NULL DEFAULT 0,
  downtime_discount  numeric(12,2) NOT NULL DEFAULT 0,
  other_discounts    numeric(12,2) NOT NULL DEFAULT 0,
  penalties          numeric(12,2) NOT NULL DEFAULT 0,
  consumptions       numeric(12,2) NOT NULL DEFAULT 0,
  additional_costs   numeric(12,2) NOT NULL DEFAULT 0,
  subtotal           numeric(12,2) NOT NULL,
  tax                numeric(12,2) NOT NULL,
  total              numeric(12,2) NOT NULL,
  status             text NOT NULL DEFAULT 'BORRADOR' CHECK (status IN ('BORRADOR', 'APROBADA', 'ANULADA')),
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes              text,
  created_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  approved_by        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at        timestamptz,
  CHECK (period_end >= period_start),
  CHECK (other_discounts >= 0 AND penalties >= 0 AND consumptions >= 0 AND additional_costs >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lease_settlement_period ON public.lease_settlements (contract_id, period_start, period_end) WHERE status <> 'ANULADA';

CREATE OR REPLACE FUNCTION public.calculate_lease_settlement(
  p_contract_id uuid, p_period_start date, p_period_end date,
  p_other_discounts numeric DEFAULT 0, p_penalties numeric DEFAULT 0, p_consumptions numeric DEFAULT 0, p_additional_costs numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c         public.vehicle_lease_contracts%ROWTYPE;
  v         public.vehicles%ROWTYPE;
  v_start   date;
  v_end     date;
  v_days    int;
  v_month_days int;
  v_km      numeric := 0;
  v_hours   numeric := 0;
  v_down    numeric := 0;
  v_base    numeric;
  v_daily   numeric;
  v_inc_km  numeric;
  v_inc_h   numeric;
  v_exc_km  numeric := 0;
  v_exc_h   numeric := 0;
  v_disc    numeric := 0;
  v_sub     numeric;
  v_tax     numeric;
BEGIN
  SELECT * INTO c FROM public.vehicle_lease_contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.can_access_site(c.site_id)
     AND (public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('caja-liquidaciones'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para consultar este contrato');
  END IF;
  SELECT * INTO v FROM public.vehicles WHERE id = c.vehicle_id;
  IF p_period_end < p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'Periodo inválido');
  END IF;
  -- Solo los días cubiertos por el contrato
  v_start := GREATEST(p_period_start, c.start_date);
  v_end := LEAST(p_period_end, COALESCE(c.end_date, p_period_end));
  IF v_end < v_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'El periodo no se cruza con la vigencia del contrato');
  END IF;
  v_days := v_end - v_start + 1;
  v_month_days := extract(day FROM (date_trunc('month', v_start) + interval '1 month - 1 day'))::int;

  -- Uso real del periodo (lecturas auditadas)
  SELECT COALESCE(max(odometer_value) - min(odometer_value), 0), COALESCE(max(hours_value) - min(hours_value), 0)
  INTO v_km, v_hours
  FROM public.vehicle_odometer_logs
  WHERE vehicle_plate = v.plate AND (created_at AT TIME ZONE 'America/Lima')::date BETWEEN v_start AND v_end;

  -- Indisponibilidad por mantenimiento dentro del periodo (OT con tiempo fuera de servicio)
  SELECT COALESCE(sum(extract(epoch FROM LEAST(COALESCE(downtime_end, now()), (v_end + 1)::timestamp AT TIME ZONE 'America/Lima')
                               - GREATEST(downtime_start, v_start::timestamp AT TIME ZONE 'America/Lima')) / 86400.0), 0)
  INTO v_down
  FROM public.maintenance_work_orders
  WHERE vehicle_id = c.vehicle_id AND downtime_start IS NOT NULL AND status <> 'CANCELADA'
    AND downtime_start < (v_end + 1)::timestamp AT TIME ZONE 'America/Lima'
    AND COALESCE(downtime_end, now()) > v_start::timestamp AT TIME ZONE 'America/Lima';
  v_down := round(GREATEST(v_down, 0), 2);

  v_daily := CASE c.rate_type WHEN 'MENSUAL' THEN c.rate_amount / v_month_days WHEN 'DIARIA' THEN c.rate_amount ELSE NULL END;
  v_base := CASE c.rate_type
    WHEN 'MENSUAL' THEN round(c.rate_amount * v_days / v_month_days, 2)
    WHEN 'DIARIA'  THEN round(c.rate_amount * v_days, 2)
    WHEN 'HORARIA' THEN round(c.rate_amount * v_hours, 2)
    WHEN 'KM'      THEN round(c.rate_amount * v_km, 2) END;

  -- Excesos sobre lo incluido (prorrateado al periodo en contratos mensuales)
  IF c.rate_type IN ('MENSUAL', 'DIARIA') THEN
    v_inc_km := CASE WHEN c.included_km IS NOT NULL THEN c.included_km * CASE WHEN c.rate_type = 'MENSUAL' THEN v_days::numeric / v_month_days ELSE 1 END END;
    v_inc_h  := CASE WHEN c.included_hours IS NOT NULL THEN c.included_hours * CASE WHEN c.rate_type = 'MENSUAL' THEN v_days::numeric / v_month_days ELSE 1 END END;
    IF v_inc_km IS NOT NULL AND c.excess_km_rate IS NOT NULL THEN v_exc_km := GREATEST(v_km - v_inc_km, 0); END IF;
    IF v_inc_h IS NOT NULL AND c.excess_hour_rate IS NOT NULL THEN v_exc_h := GREATEST(v_hours - v_inc_h, 0); END IF;
    IF c.discount_downtime AND v_daily IS NOT NULL THEN v_disc := round(LEAST(v_down, v_days) * v_daily, 2); END IF;
  END IF;

  v_sub := v_base + round(v_exc_km * COALESCE(c.excess_km_rate, 0), 2) + round(v_exc_h * COALESCE(c.excess_hour_rate, 0), 2)
           - v_disc - COALESCE(p_other_discounts, 0) + COALESCE(p_penalties, 0) + COALESCE(p_consumptions, 0) + COALESCE(p_additional_costs, 0);
  v_sub := GREATEST(v_sub, 0);
  v_tax := round(v_sub * 0.18, 2);

  RETURN jsonb_build_object('success', true,
    'contract_id', c.id, 'vehicle_id', c.vehicle_id, 'vehicle_plate', v.plate, 'rate_type', c.rate_type, 'rate_amount', c.rate_amount,
    'period_start', v_start, 'period_end', v_end, 'days', v_days, 'km_used', round(v_km, 2), 'hours_used', round(v_hours, 2),
    'downtime_days', v_down, 'base_amount', v_base,
    'included_km', round(v_inc_km, 2), 'excess_km', round(v_exc_km, 2), 'excess_km_amount', round(v_exc_km * COALESCE(c.excess_km_rate, 0), 2),
    'included_hours', round(v_inc_h, 2), 'excess_hours', round(v_exc_h, 2), 'excess_hours_amount', round(v_exc_h * COALESCE(c.excess_hour_rate, 0), 2),
    'downtime_discount', v_disc, 'other_discounts', COALESCE(p_other_discounts, 0), 'penalties', COALESCE(p_penalties, 0),
    'consumptions', COALESCE(p_consumptions, 0), 'additional_costs', COALESCE(p_additional_costs, 0),
    'subtotal', round(v_sub, 2), 'tax', v_tax, 'total', round(v_sub, 2) + v_tax);
END;
$$;
REVOKE ALL ON FUNCTION public.calculate_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_lease_settlement(
  p_contract_id uuid, p_period_start date, p_period_end date,
  p_other_discounts numeric DEFAULT 0, p_penalties numeric DEFAULT 0, p_consumptions numeric DEFAULT 0, p_additional_costs numeric DEFAULT 0,
  p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r    jsonb;
  v_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('flota') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para liquidar alquileres');
  END IF;
  IF (COALESCE(p_other_discounts, 0) > 0 OR COALESCE(p_penalties, 0) > 0 OR COALESCE(p_additional_costs, 0) > 0) AND NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sustente descuentos, penalidades o costos adicionales en las notas');
  END IF;
  r := public.calculate_lease_settlement(p_contract_id, p_period_start, p_period_end, p_other_discounts, p_penalties, p_consumptions, p_additional_costs);
  IF NOT (r->>'success')::boolean THEN
    RETURN r;
  END IF;
  BEGIN
    INSERT INTO public.lease_settlements (contract_id, vehicle_id, period_start, period_end, days, hours_used, km_used, downtime_days,
      base_amount, excess_km, excess_km_amount, excess_hours, excess_hours_amount, downtime_discount, other_discounts, penalties,
      consumptions, additional_costs, subtotal, tax, total, detail, notes, created_by)
    VALUES (p_contract_id, (r->>'vehicle_id')::uuid, (r->>'period_start')::date, (r->>'period_end')::date, (r->>'days')::int,
      (r->>'hours_used')::numeric, (r->>'km_used')::numeric, (r->>'downtime_days')::numeric, (r->>'base_amount')::numeric,
      (r->>'excess_km')::numeric, (r->>'excess_km_amount')::numeric, (r->>'excess_hours')::numeric, (r->>'excess_hours_amount')::numeric,
      (r->>'downtime_discount')::numeric, (r->>'other_discounts')::numeric, (r->>'penalties')::numeric, (r->>'consumptions')::numeric,
      (r->>'additional_costs')::numeric, (r->>'subtotal')::numeric, (r->>'tax')::numeric, (r->>'total')::numeric, r, p_notes, auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ya existe una liquidación para ese contrato y periodo');
  END;
  RETURN r || jsonb_build_object('settlement_id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.create_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.decide_lease_settlement(p_settlement_id uuid, p_decision text, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE s public.lease_settlements%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.is_tms_admin() OR public.has_cmms_permission('flota')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para aprobar liquidaciones');
  END IF;
  SELECT * INTO s FROM public.lease_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'BORRADOR' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se decide una liquidación en BORRADOR');
  END IF;
  IF upper(p_decision) = 'APROBADA' THEN
    IF s.created_by = auth.uid() AND NOT public.is_tms_admin() THEN
      RETURN jsonb_build_object('success', false, 'error', 'La liquidación debe aprobarla un usuario distinto a quien la elaboró');
    END IF;
    UPDATE public.lease_settlements SET status = 'APROBADA', approved_by = auth.uid(), approved_at = now(),
      notes = concat_ws(E'\n', notes, p_notes) WHERE id = s.id;
  ELSIF upper(p_decision) = 'ANULADA' AND NULLIF(trim(p_notes), '') IS NOT NULL THEN
    UPDATE public.lease_settlements SET status = 'ANULADA', notes = concat_ws(E'\n', notes, 'Anulada: ' || p_notes) WHERE id = s.id;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida (anular requiere motivo)');
  END IF;
  RETURN jsonb_build_object('success', true, 'status', upper(p_decision));
END;
$$;
REVOKE ALL ON FUNCTION public.decide_lease_settlement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_lease_settlement(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_lease_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Las liquidaciones se gestionan con create_lease_settlement / decide_lease_settlement' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'APROBADA' THEN
    RAISE EXCEPTION 'Una liquidación aprobada es inmutable' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_lease_settlement ON public.lease_settlements;
CREATE TRIGGER trg_guard_lease_settlement BEFORE INSERT OR UPDATE OR DELETE ON public.lease_settlements
FOR EACH ROW EXECUTE FUNCTION public.guard_lease_settlement();

-- ------------------------------------------------------------
-- 3. Libro de costos por activo (fuente única del TCO)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_vehicle_cost_ledger
WITH (security_invoker = true) AS
SELECT wo.vehicle_id, c.created_at AS cost_date, 'MANTENIMIENTO'::text AS category,
       CASE c.cost_type WHEN 'MANO_OBRA' THEN 'Mano de obra' WHEN 'REPUESTOS' THEN 'Repuestos' WHEN 'SERVICIOS' THEN 'Servicios externos' ELSE 'Otros' END AS subcategory,
       c.amount, 'OT ' || wo.ot_code AS reference, wo.id AS ref_id
FROM public.work_order_costs c JOIN public.maintenance_work_orders wo ON wo.id = c.work_order_id
WHERE wo.status <> 'CANCELADA'
UNION ALL
SELECT v.id, de.created_at,
       CASE WHEN upper(de.expense_type) IN ('COMBUSTIBLE', 'FUEL', 'DIESEL', 'GASOLINA') THEN 'COMBUSTIBLE' ELSE 'OPERACION' END,
       de.expense_type, de.amount, 'Despacho ' || d.dispatch_number, de.id
FROM public.dispatch_expenses de JOIN public.dispatches d ON d.id = de.dispatch_id JOIN public.vehicles v ON v.plate = d.vehicle_plate
WHERE de.status = 'APROBADO'
UNION ALL
-- Neumáticos: km recorridos en la unidad × costo por km del neumático (compra + reencauches)
SELECT m.vehicle_id, m.created_at, 'NEUMATICOS', t.codigo_interno, round(m.km_accumulated * tr.cost_per_km, 2), 'Neumático ' || t.codigo_interno, m.id
FROM public.tire_movements m JOIN public.tires t ON t.id = m.tire_id JOIN public.vw_tires tr ON tr.id = t.id
WHERE m.km_accumulated > 0 AND m.vehicle_id IS NOT NULL AND tr.cost_per_km IS NOT NULL
UNION ALL
SELECT f.vehicle_id, COALESCE(f.paid_at::timestamptz, f.updated_at), 'MULTAS', f.entity, COALESCE(f.paid_amount, f.amount), f.entity || ' ' || f.ticket_number, f.id
FROM public.traffic_fines f WHERE f.status = 'PAGADA' AND f.responsibility = 'EMPRESA'
UNION ALL
SELECT i.vehicle_id, i.occurred_at, 'SINIESTROS', i.incident_type, GREATEST(COALESCE(i.final_cost, i.estimated_cost, 0) - i.insurance_coverage, 0),
       'Siniestro ' || to_char(i.occurred_at, 'DD/MM/YYYY'), i.id
FROM public.vehicle_incidents i WHERE i.responsibility IN ('EMPRESA', 'CONDUCTOR', 'POR_DETERMINAR')
UNION ALL
SELECT s.vehicle_id, s.period_end::timestamptz, 'ALQUILER', 'Liquidación ' || c.contract_code, s.subtotal,
       c.contract_code || ' ' || to_char(s.period_start, 'DD/MM') || '–' || to_char(s.period_end, 'DD/MM/YYYY'), s.id
FROM public.lease_settlements s JOIN public.vehicle_lease_contracts c ON c.id = s.contract_id
WHERE s.status = 'APROBADA';
GRANT SELECT ON public.vw_vehicle_cost_ledger TO authenticated, service_role;

DROP VIEW IF EXISTS public.vehicle_tco_analytics;
CREATE VIEW public.vehicle_tco_analytics
WITH (security_invoker = true) AS
SELECT v.id AS vehicle_id, v.plate, v.type, v.ownership_status, v.current_odometer,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO'), 0) AS maintenance_cost,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'OPERACION'), 0) AS operating_cost,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'COMBUSTIBLE'), 0) AS fuel_cost,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'NEUMATICOS'), 0) AS tires_cost,
  COALESCE(sum(l.amount) FILTER (WHERE l.category IN ('MULTAS', 'SINIESTROS')), 0) AS compliance_cost,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'ALQUILER'), 0) AS lease_cost,
  round(COALESCE(vc.fixed_cost_per_km, 0) * COALESCE(v.current_odometer, 0), 2) AS fixed_cost,
  COALESCE(sum(l.amount), 0) AS total_tco,
  CASE WHEN COALESCE(v.current_odometer, 0) > 0 THEN round(COALESCE(sum(l.amount), 0) / v.current_odometer, 4) END AS cpk,
  CASE WHEN COALESCE(v.current_odometer, 0) > 0 THEN round(COALESCE(sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO'), 0) / v.current_odometer, 4) END AS maintenance_cpk,
  CASE WHEN COALESCE(v.current_hours, 0) > 0 THEN round(COALESCE(sum(l.amount), 0) / v.current_hours, 4) END AS cost_per_hour
FROM public.vehicles v
LEFT JOIN public.vw_vehicle_cost_ledger l ON l.vehicle_id = v.id
LEFT JOIN public.vehicle_costs vc ON upper(vc.vehicle_type) = v.type
GROUP BY v.id, vc.fixed_cost_per_km;
GRANT SELECT ON public.vehicle_tco_analytics TO authenticated, service_role;

DROP VIEW IF EXISTS public.vw_asset_tco;
CREATE VIEW public.vw_asset_tco
WITH (security_invoker = true) AS
SELECT v.plate AS placa, v.type AS tipo, v.ownership_status AS propiedad,
  extract(year FROM l.cost_date AT TIME ZONE 'America/Lima')::int AS anio,
  extract(month FROM l.cost_date AT TIME ZONE 'America/Lima')::int AS mes,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO'), 0) AS mantenimiento,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'COMBUSTIBLE'), 0) AS combustible,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'OPERACION'), 0) AS operacion,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'NEUMATICOS'), 0) AS neumaticos,
  COALESCE(sum(l.amount) FILTER (WHERE l.category IN ('MULTAS', 'SINIESTROS')), 0) AS cumplimiento,
  COALESCE(sum(l.amount) FILTER (WHERE l.category = 'ALQUILER'), 0) AS alquiler,
  sum(l.amount) AS total_tco,
  count(DISTINCT l.ref_id) FILTER (WHERE l.category = 'MANTENIMIENTO') AS lineas_mantenimiento
FROM public.vw_vehicle_cost_ledger l
JOIN public.vehicles v ON v.id = l.vehicle_id
GROUP BY v.plate, v.type, v.ownership_status, 4, 5;
GRANT SELECT ON public.vw_asset_tco TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. RLS
-- ------------------------------------------------------------
ALTER TABLE public.vehicle_lease_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_read ON public.vehicle_lease_contracts;
DROP POLICY IF EXISTS lease_write ON public.vehicle_lease_contracts;
CREATE POLICY lease_read ON public.vehicle_lease_contracts FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND (public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('caja-liquidaciones')));
CREATE POLICY lease_write ON public.vehicle_lease_contracts FOR ALL TO authenticated
  USING (public.has_cmms_permission('flota')) WITH CHECK (public.has_cmms_permission('flota'));

ALTER TABLE public.lease_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY settlements_read ON public.lease_settlements FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND public.can_access_site(v.site_id)
                 AND (public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('caja-liquidaciones'))));

NOTIFY pgrst, 'reload schema';

COMMIT;
