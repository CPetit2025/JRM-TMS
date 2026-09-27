-- 20260928110000_f10_proveedores.sql
-- FASE 10 — Proveedores, talleres y garantías.
--
-- * Proveedores con tipo, SLA pactado y garantía de servicio por defecto. Se eliminan los puntajes
--   almacenados (rating/sla_score/sla_rating/avg_response_time_hours/total_services_completed/
--   provider_status) y su trigger defectuoso: los KPI se calculan desde las OT (vw_provider_performance).
-- * Tarifario por proveedor y cotizaciones por OT (aprobar una asigna el proveedor y rechaza las demás).
-- * Garantía de servicio al cerrar una OT de proveedor; vista unificada de garantías vigentes
--   (repuestos F7 + servicios).
-- * Regla: una OT no se aprueba si la unidad tiene garantías vigentes sin revisarlas
--   (review_work_order_warranty: RECLAMO_GARANTIA o NO_CUBIERTO).
-- * Retrabajo (reapertura TERMINADA/VALIDACION → EN_PROCESO), tiempo de atención y evaluación.
-- * RLS sin "todo permitido".

BEGIN;

-- ------------------------------------------------------------
-- 1. Proveedores
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_recalculate_provider_sla ON public.maintenance_work_orders;
DROP FUNCTION IF EXISTS public.trg_recalculate_provider_sla();

ALTER TABLE public.maintenance_providers
  ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'TALLER',
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS sla_hours numeric(8,2),
  ADD COLUMN IF NOT EXISTS default_warranty_days int,
  ADD COLUMN IF NOT EXISTS default_warranty_km int,
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS notes text;

UPDATE public.maintenance_providers SET status = CASE
  WHEN upper(COALESCE(status, provider_status, '')) IN ('SUSPENDIDO', 'INACTIVO') THEN upper(COALESCE(status, provider_status))
  WHEN is_active = false THEN 'INACTIVO' ELSE 'ACTIVO' END;
ALTER TABLE public.maintenance_providers
  DROP COLUMN IF EXISTS sla_score, DROP COLUMN IF EXISTS total_services_completed, DROP COLUMN IF EXISTS sla_rating,
  DROP COLUMN IF EXISTS avg_response_time_hours, DROP COLUMN IF EXISTS provider_status, DROP COLUMN IF EXISTS rating;
ALTER TABLE public.maintenance_providers ALTER COLUMN status SET DEFAULT 'ACTIVO';
ALTER TABLE public.maintenance_providers DROP CONSTRAINT IF EXISTS maintenance_providers_checks;
ALTER TABLE public.maintenance_providers ADD CONSTRAINT maintenance_providers_checks CHECK (
  status IN ('ACTIVO', 'SUSPENDIDO', 'INACTIVO')
  AND provider_type IN ('TALLER', 'REPUESTOS', 'SERVICIO_EXTERNO', 'LLANTERIA', 'GRUA', 'OTRO')
  AND (sla_hours IS NULL OR sla_hours > 0) AND (default_warranty_days IS NULL OR default_warranty_days > 0)
  AND (default_warranty_km IS NULL OR default_warranty_km > 0));

CREATE OR REPLACE FUNCTION public.normalize_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.ruc := regexp_replace(COALESCE(NEW.ruc, ''), '\D', '', 'g');
  IF length(NEW.ruc) <> 11 THEN
    RAISE EXCEPTION 'El RUC debe tener 11 dígitos';
  END IF;
  NEW.status := upper(COALESCE(NEW.status, 'ACTIVO'));
  NEW.provider_type := upper(COALESCE(NEW.provider_type, 'TALLER'));
  NEW.is_active := NEW.status = 'ACTIVO';
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_normalize_provider ON public.maintenance_providers;
CREATE TRIGGER trg_normalize_provider BEFORE INSERT OR UPDATE ON public.maintenance_providers
FOR EACH ROW EXECUTE FUNCTION public.normalize_provider();

-- ------------------------------------------------------------
-- 2. Tarifario y cotizaciones
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES public.maintenance_providers(id) ON DELETE CASCADE,
  service_name  text NOT NULL,
  unit          text NOT NULL DEFAULT 'SERVICIO',
  price         numeric(12,2) NOT NULL CHECK (price >= 0),
  valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  valid_to      date,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS idx_provider_rates_provider ON public.provider_rates (provider_id);

CREATE TABLE IF NOT EXISTS public.service_quotes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id  uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  provider_id    uuid NOT NULL REFERENCES public.maintenance_providers(id),
  amount         numeric(12,2) NOT NULL CHECK (amount >= 0),
  description    text,
  estimated_hours numeric(8,2),
  valid_until    date,
  file_url       text,
  status         text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')),
  decided_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  decision_notes text,
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_quote_approved ON public.service_quotes (work_order_id) WHERE status = 'APROBADA';

CREATE OR REPLACE FUNCTION public.decide_service_quote(p_quote_id uuid, p_decision text, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q  public.service_quotes%ROWTYPE;
  wo public.maintenance_work_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para decidir cotizaciones');
  END IF;
  SELECT * INTO q FROM public.service_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR q.status <> 'PENDIENTE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cotización inexistente o ya decidida');
  END IF;
  SELECT * INTO wo FROM public.maintenance_work_orders WHERE id = q.work_order_id FOR UPDATE;
  IF wo.status IN ('CERRADA', 'CANCELADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT está ' || wo.status);
  END IF;
  IF upper(p_decision) = 'APROBADA' THEN
    IF q.valid_until IS NOT NULL AND q.valid_until < (now() AT TIME ZONE 'America/Lima')::date THEN
      RETURN jsonb_build_object('success', false, 'error', 'La cotización venció el ' || q.valid_until);
    END IF;
    IF (SELECT status FROM public.maintenance_providers WHERE id = q.provider_id) <> 'ACTIVO' THEN
      RETURN jsonb_build_object('success', false, 'error', 'El proveedor no está activo');
    END IF;
    UPDATE public.service_quotes SET status = 'APROBADA', decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes WHERE id = q.id;
    UPDATE public.service_quotes SET status = 'RECHAZADA', decided_by = auth.uid(), decided_at = now(),
      decision_notes = 'Se aprobó otra cotización' WHERE work_order_id = q.work_order_id AND status = 'PENDIENTE';
    UPDATE public.maintenance_work_orders SET provider_id = q.provider_id, approved_quote_id = q.id WHERE id = q.work_order_id;
  ELSIF upper(p_decision) = 'RECHAZADA' THEN
    UPDATE public.service_quotes SET status = 'RECHAZADA', decided_by = auth.uid(), decided_at = now(), decision_notes = p_notes WHERE id = q.id;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Decisión inválida');
  END IF;
  RETURN jsonb_build_object('success', true, 'status', upper(p_decision));
END;
$$;
REVOKE ALL ON FUNCTION public.decide_service_quote(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_service_quote(uuid, text, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. OT: tiempos de atención, retrabajo y revisión de garantías
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS rework_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_quote_id uuid REFERENCES public.service_quotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS warranty_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS warranty_decision text CHECK (warranty_decision IN ('RECLAMO_GARANTIA', 'NO_CUBIERTO', 'SIN_GARANTIAS')),
  ADD COLUMN IF NOT EXISTS warranty_notes text,
  ADD COLUMN IF NOT EXISTS warranty_provider_id uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evaluated_at timestamptz;
ALTER TABLE public.maintenance_work_orders DROP CONSTRAINT IF EXISTS maintenance_work_orders_evaluation_check;
ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT maintenance_work_orders_evaluation_check
  CHECK (provider_evaluation_score IS NULL OR provider_evaluation_score BETWEEN 1 AND 5);

CREATE TABLE IF NOT EXISTS public.service_warranties (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id         uuid NOT NULL REFERENCES public.maintenance_providers(id),
  vehicle_id          uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  work_order_id       uuid NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
  scope               text,
  starts_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          date,
  odometer_at_close   numeric(12,2),
  km_limit            int,
  status              text NOT NULL DEFAULT 'ACTIVA' CHECK (status IN ('ACTIVA', 'RECLAMADA', 'ANULADA')),
  claimed_by_wo_id    uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  claimed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_warranty_wo ON public.service_warranties (work_order_id);

-- Garantías vigentes de la unidad (repuestos instalados + servicios)
CREATE OR REPLACE VIEW public.vw_active_warranties
WITH (security_invoker = true) AS
SELECT 'REPUESTO' AS warranty_kind, pw.id, pw.vehicle_id, pw.vehicle_plate, pw.provider_id, pw.provider_name,
       pw.internal_code || ' · ' || pw.part_name AS scope, pw.expires_at, pw.km_remaining, pw.work_order_id
FROM public.vw_part_warranties pw WHERE pw.warranty_status = 'VIGENTE'
UNION ALL
SELECT 'SERVICIO', sw.id, sw.vehicle_id, v.plate, sw.provider_id, p.business_name, COALESCE(sw.scope, wo.description),
       sw.expires_at,
       CASE WHEN sw.km_limit IS NOT NULL THEN sw.odometer_at_close + sw.km_limit - COALESCE(v.current_odometer, 0) END,
       sw.work_order_id
FROM public.service_warranties sw
JOIN public.vehicles v ON v.id = sw.vehicle_id
JOIN public.maintenance_providers p ON p.id = sw.provider_id
JOIN public.maintenance_work_orders wo ON wo.id = sw.work_order_id
WHERE sw.status = 'ACTIVA'
  AND (sw.expires_at IS NULL OR sw.expires_at >= (now() AT TIME ZONE 'America/Lima')::date)
  AND (sw.km_limit IS NULL OR COALESCE(v.current_odometer, 0) - COALESCE(sw.odometer_at_close, 0) <= sw.km_limit);
GRANT SELECT ON public.vw_active_warranties TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.work_order_provider_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_warranties text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Retrabajo: reapertura tras terminar/validar
    IF OLD.status IN ('TERMINADA', 'VALIDACION') AND NEW.status = 'EN_PROCESO' THEN
      NEW.rework_count := COALESCE(OLD.rework_count, 0) + 1;
    END IF;
    IF NEW.status = 'TERMINADA' AND NEW.finished_at IS NULL THEN
      NEW.finished_at := now();
    END IF;
    -- Regla: ¿existe garantía activa? antes de autorizar el gasto
    IF NEW.status = 'APROBADA' AND NEW.warranty_reviewed_at IS NULL THEN
      SELECT string_agg(w.warranty_kind || ': ' || w.scope || COALESCE(' (' || w.provider_name || ')', ''), '; ')
      INTO v_warranties FROM public.vw_active_warranties w WHERE w.vehicle_id = NEW.vehicle_id;
      IF v_warranties IS NOT NULL THEN
        RAISE EXCEPTION 'GARANTIA_ACTIVA: la unidad tiene garantías vigentes (%). Revíselas con review_work_order_warranty() antes de aprobar.', v_warranties
          USING ERRCODE = 'P0001';
      END IF;
      NEW.warranty_reviewed_at := now();
      NEW.warranty_decision := 'SIN_GARANTIAS';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_work_order_provider_lifecycle ON public.maintenance_work_orders;
CREATE TRIGGER trg_work_order_provider_lifecycle BEFORE UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.work_order_provider_lifecycle();

CREATE OR REPLACE FUNCTION public.review_work_order_warranty(
  p_work_order_id uuid, p_decision text, p_notes text, p_warranty_kind text DEFAULT NULL, p_warranty_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wo        public.maintenance_work_orders%ROWTYPE;
  v_provider uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  SELECT * INTO wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR wo.status <> 'BORRADOR' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se revisan garantías de una OT en BORRADOR');
  END IF;
  IF upper(p_decision) NOT IN ('RECLAMO_GARANTIA', 'NO_CUBIERTO') OR NULLIF(trim(p_notes), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique RECLAMO_GARANTIA o NO_CUBIERTO y el sustento');
  END IF;
  IF upper(p_decision) = 'RECLAMO_GARANTIA' THEN
    IF p_warranty_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique la garantía que se reclama');
    END IF;
    IF upper(p_warranty_kind) = 'SERVICIO' THEN
      UPDATE public.service_warranties SET status = 'RECLAMADA', claimed_by_wo_id = wo.id, claimed_at = now()
      WHERE id = p_warranty_id AND vehicle_id = wo.vehicle_id AND status = 'ACTIVA' RETURNING provider_id INTO v_provider;
    ELSE
      UPDATE public.part_warranties SET status = 'RECLAMADA', claimed_at = now(), claim_notes = p_notes
      WHERE id = p_warranty_id AND vehicle_id = wo.vehicle_id AND status = 'ACTIVA' RETURNING provider_id INTO v_provider;
    END IF;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Garantía no encontrada o no vigente para la unidad');
    END IF;
  END IF;
  UPDATE public.maintenance_work_orders SET warranty_reviewed_at = now(), warranty_decision = upper(p_decision),
    warranty_notes = p_notes, warranty_provider_id = v_provider WHERE id = wo.id;
  RETURN jsonb_build_object('success', true, 'decision', upper(p_decision));
END;
$$;
REVOKE ALL ON FUNCTION public.review_work_order_warranty(uuid, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_work_order_warranty(uuid, text, text, text, uuid) TO authenticated, service_role;

-- Garantía de servicio al cerrar una OT atendida por proveedor
CREATE OR REPLACE FUNCTION public.create_service_warranty_on_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.maintenance_providers%ROWTYPE;
BEGIN
  IF NEW.status = 'CERRADA' AND OLD.status IS DISTINCT FROM 'CERRADA' AND NEW.provider_id IS NOT NULL
     AND COALESCE(NEW.warranty_decision, '') <> 'RECLAMO_GARANTIA' THEN
    SELECT * INTO p FROM public.maintenance_providers WHERE id = NEW.provider_id;
    IF p.default_warranty_days IS NOT NULL OR p.default_warranty_km IS NOT NULL THEN
      INSERT INTO public.service_warranties (provider_id, vehicle_id, work_order_id, scope, expires_at, odometer_at_close, km_limit)
      VALUES (p.id, NEW.vehicle_id, NEW.id, NEW.description,
              CASE WHEN p.default_warranty_days IS NOT NULL THEN (now() AT TIME ZONE 'America/Lima')::date + p.default_warranty_days END,
              (SELECT current_odometer FROM public.vehicles WHERE id = NEW.vehicle_id), p.default_warranty_km)
      ON CONFLICT (work_order_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_create_service_warranty ON public.maintenance_work_orders;
CREATE TRIGGER trg_create_service_warranty AFTER UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW EXECUTE FUNCTION public.create_service_warranty_on_close();

-- Evaluación del trabajo del proveedor (una vez, OT cerrada)
CREATE OR REPLACE FUNCTION public.evaluate_provider_work(p_work_order_id uuid, p_score int, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE wo public.maintenance_work_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_cmms_permission('ot') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  SELECT * INTO wo FROM public.maintenance_work_orders WHERE id = p_work_order_id FOR UPDATE;
  IF NOT FOUND OR wo.status <> 'CERRADA' OR wo.provider_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo se evalúa una OT cerrada atendida por proveedor');
  END IF;
  IF wo.evaluated_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'La OT ya fue evaluada');
  END IF;
  IF p_score IS NULL OR p_score NOT BETWEEN 1 AND 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'La calificación va de 1 a 5');
  END IF;
  UPDATE public.maintenance_work_orders SET provider_evaluation_score = p_score, provider_evaluation_notes = p_notes, evaluated_at = now()
  WHERE id = wo.id;
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.evaluate_provider_work(uuid, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.evaluate_provider_work(uuid, int, text) TO authenticated, service_role;

-- La evaluación no se edita directamente (OT cerrada es inmutable desde el cliente, F4)

-- ------------------------------------------------------------
-- 4. Indicadores de desempeño (calculados, sin puntajes almacenados)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_provider_performance
WITH (security_invoker = true) AS
WITH wo AS (
  SELECT w.*, extract(epoch FROM w.finished_at - COALESCE(w.approved_at, w.created_at)) / 3600.0 AS attention_hours
  FROM public.maintenance_work_orders w WHERE w.provider_id IS NOT NULL AND w.status <> 'CANCELADA'
), base AS (
  SELECT p.id AS provider_id, p.business_name, p.ruc, p.provider_type, p.status, p.sla_hours, p.specialty,
    count(wo.id) AS work_orders,
    count(wo.id) FILTER (WHERE wo.status = 'CERRADA') AS closed_work_orders,
    round(avg(wo.attention_hours) FILTER (WHERE wo.finished_at IS NOT NULL)::numeric, 1) AS avg_attention_hours,
    count(wo.id) FILTER (WHERE wo.finished_at IS NOT NULL) AS finished_work_orders,
    count(wo.id) FILTER (WHERE wo.finished_at IS NOT NULL AND p.sla_hours IS NOT NULL AND wo.attention_hours <= p.sla_hours) AS within_sla,
    COALESCE(sum(wo.rework_count), 0) AS reworks,
    round(avg(wo.provider_evaluation_score)::numeric, 2) AS avg_score,
    COALESCE((SELECT sum(c.amount) FROM public.work_order_costs c JOIN public.maintenance_work_orders w2 ON w2.id = c.work_order_id
              WHERE w2.provider_id = p.id AND w2.status <> 'CANCELADA'), 0) AS total_spend,
    (SELECT count(*) FROM public.maintenance_work_orders w3 WHERE w3.warranty_provider_id = p.id AND w3.warranty_decision = 'RECLAMO_GARANTIA') AS warranty_claims,
    (SELECT count(*) FROM public.service_warranties sw WHERE sw.provider_id = p.id AND sw.status = 'ACTIVA') AS active_service_warranties
  FROM public.maintenance_providers p
  LEFT JOIN wo ON wo.provider_id = p.id
  GROUP BY p.id
)
SELECT b.*,
  CASE WHEN b.finished_work_orders > 0 AND b.sla_hours IS NOT NULL THEN round(100.0 * b.within_sla / b.finished_work_orders, 1) END AS sla_compliance_pct,
  CASE WHEN b.closed_work_orders > 0 THEN round(100.0 * (b.reworks + b.warranty_claims) / b.closed_work_orders, 1) END AS rework_rate_pct,
  CASE WHEN b.closed_work_orders > 0 THEN round(b.total_spend / b.closed_work_orders, 2) END AS avg_cost_per_work_order,
  -- Índice de calidad 0-100: 40% cumplimiento SLA, 30% calificación, 30% ausencia de retrabajos/reclamos
  CASE WHEN b.closed_work_orders > 0 THEN round(
      0.4 * COALESCE(CASE WHEN b.finished_work_orders > 0 AND b.sla_hours IS NOT NULL THEN 100.0 * b.within_sla / b.finished_work_orders END, 100)
    + 0.3 * COALESCE(b.avg_score / 5.0 * 100, 100)
    + 0.3 * GREATEST(0, 100 - 100.0 * (b.reworks + b.warranty_claims) / b.closed_work_orders), 1) END AS quality_index
FROM base b;
GRANT SELECT ON public.vw_provider_performance TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Enable all for authenticated on maintenance_providers" ON public.maintenance_providers;
CREATE POLICY providers_read ON public.maintenance_providers FOR SELECT TO authenticated
  USING (public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));
CREATE POLICY providers_write ON public.maintenance_providers FOR INSERT TO authenticated WITH CHECK (public.has_cmms_permission('flota'));
CREATE POLICY providers_update ON public.maintenance_providers FOR UPDATE TO authenticated
  USING (public.has_cmms_permission('flota')) WITH CHECK (public.has_cmms_permission('flota'));

ALTER TABLE public.provider_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY rates_read ON public.provider_rates FOR SELECT TO authenticated
  USING (public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));
CREATE POLICY rates_write ON public.provider_rates FOR ALL TO authenticated
  USING (public.has_cmms_permission('flota')) WITH CHECK (public.has_cmms_permission('flota'));

ALTER TABLE public.service_quotes ENABLE ROW LEVEL SECURITY;
CREATE POLICY quotes_read ON public.service_quotes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.maintenance_work_orders w WHERE w.id = work_order_id AND public.can_access_site(w.site_id)
                 AND public.has_cmms_read_permission('ot')));
CREATE POLICY quotes_insert ON public.service_quotes FOR INSERT TO authenticated
  WITH CHECK (status = 'PENDIENTE' AND EXISTS (SELECT 1 FROM public.maintenance_work_orders w WHERE w.id = work_order_id
              AND public.can_access_site(w.site_id) AND public.has_cmms_permission('ot')));

ALTER TABLE public.service_warranties ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_warranties_read ON public.service_warranties FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.vehicles v WHERE v.id = vehicle_id AND public.can_access_site(v.site_id)
                 AND (public.has_cmms_read_permission('ot') OR public.has_cmms_read_permission('flota'))));

-- Vista del gestor con datos de proveedor, garantía, retrabajo y evaluación
CREATE OR REPLACE VIEW public.vw_work_orders
WITH (security_invoker = true) AS
SELECT
  wo.id, wo.ot_code, wo.status, wo.order_type, wo.source_type, wo.source_id, wo.priority,
  wo.description, wo.diagnostic, wo.activities_performed, wo.tasks, wo.evidence_urls, wo.notes,
  wo.vehicle_id, v.plate AS vehicle_plate, v.type AS vehicle_type, v.status AS vehicle_status,
  wo.plan_id, mp.name AS plan_name,
  wo.provider_id, prov.business_name AS provider_name,
  wo.responsible_id, NULLIF(trim(concat_ws(' ', pr.first_name, pr.last_name)), '') AS responsible_name,
  wo.mechanic_id, NULLIF(trim(concat_ws(' ', pm.first_name, pm.last_name)), '') AS mechanic_name,
  wo.approved_by, wo.approved_at, wo.validated_at, wo.closed_at, wo.cancel_reason,
  wo.start_date, wo.estimated_end_date, wo.actual_end_date,
  wo.downtime_start, wo.downtime_end,
  COALESCE(wo.downtime_hours,
           CASE WHEN wo.downtime_start IS NOT NULL
                THEN round((extract(epoch FROM now() - wo.downtime_start) / 3600.0)::numeric, 2) END) AS downtime_hours,
  COALESCE(wo.labor_cost, 0) AS labor_cost, COALESCE(wo.parts_cost, 0) AS parts_cost,
  COALESCE(wo.services_cost, 0) AS services_cost, COALESCE(wo.total_cost, 0) AS total_cost,
  (SELECT count(*) FROM public.maintenance_requests r WHERE r.work_order_id = wo.id) AS linked_requests,
  wo.release_result, wo.site_id, wo.created_at, wo.updated_at,
  wo.finished_at, wo.rework_count, wo.warranty_decision, wo.warranty_notes, wo.warranty_provider_id,
  wo.provider_evaluation_score, wo.provider_evaluation_notes, wo.evaluated_at, wo.approved_quote_id
FROM public.maintenance_work_orders wo
JOIN public.vehicles v ON v.id = wo.vehicle_id
LEFT JOIN public.maintenance_plans mp ON mp.id = wo.plan_id
LEFT JOIN public.maintenance_providers prov ON prov.id = wo.provider_id
LEFT JOIN public.profiles pr ON pr.id = wo.responsible_id
LEFT JOIN public.profiles pm ON pm.id = wo.mechanic_id;

GRANT SELECT ON public.vw_work_orders TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
