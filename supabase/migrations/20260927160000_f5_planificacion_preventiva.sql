-- 20260927160000_f5_planificacion_preventiva.sql
-- FASE 5 — Planificación preventiva.
--
-- * Planes por kilometraje, horómetro, fecha o combinación (vence lo primero que ocurra).
-- * Vencimientos derivados en la BD (next_due_*) desde la última ejecución; línea base = lectura
--   real del activo al crear el plan. Validación contra odómetro/horómetro reales.
-- * Lecturas desde fuente autorizada: register_asset_reading (monotónico, auditado); tasa de uso
--   diaria para proyectar vencimientos por km/horas.
-- * vw_maintenance_projections: alertas NORMAL/PRÓXIMO/URGENTE/VENCIDO, fecha proyectada y
--   horizonte 30/60/90, OT abierta del plan.
-- * generate_preventive_wo idempotente (una OT abierta por plan) y run_preventive_scheduler
--   ejecutado por pg_cron en la BD (no depende del frontend), con bitácora de corridas.

BEGIN;

-- ------------------------------------------------------------
-- 1. Planes
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_plans DROP CONSTRAINT IF EXISTS maintenance_plans_frequencies_check;
ALTER TABLE public.maintenance_plans ADD CONSTRAINT maintenance_plans_frequencies_check CHECK (
  (frequency_km IS NULL OR frequency_km > 0) AND (frequency_days IS NULL OR frequency_days > 0)
  AND (frequency_hours IS NULL OR frequency_hours > 0)
  AND COALESCE(frequency_km, frequency_days, frequency_hours) IS NOT NULL);

CREATE OR REPLACE FUNCTION public.normalize_maintenance_plan()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v public.vehicles%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  NEW.name := trim(NEW.name);
  NEW.activity_description := COALESCE(NULLIF(trim(NEW.activity_description), ''), NEW.name);
  NEW.standard_tasks := COALESCE(NEW.standard_tasks, '[]'::jsonb);
  NEW.expected_parts := COALESCE(NEW.expected_parts, '[]'::jsonb);
  NEW.updated_at := now();

  IF NEW.vehicle_plate IS NOT NULL THEN
    NEW.vehicle_plate := upper(trim(NEW.vehicle_plate));
    SELECT * INTO v FROM public.vehicles WHERE plate = NEW.vehicle_plate;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unidad no registrada: %', NEW.vehicle_plate;
    END IF;
    NEW.vehicle_type := v.type;
    NEW.site_id := v.site_id;

    -- Línea base: la lectura real al crear el plan (si no se informa la última ejecución)
    IF TG_OP = 'INSERT' THEN
      NEW.last_performed_km    := COALESCE(NEW.last_performed_km, NEW.last_performed_odometer, v.current_odometer, 0);
      NEW.last_performed_hours := COALESCE(NEW.last_performed_hours, v.current_hours, 0);
      NEW.last_performed_date  := COALESCE(NEW.last_performed_date, v_today);
    END IF;
    IF NEW.last_performed_km > COALESCE(v.current_odometer, 0) THEN
      RAISE EXCEPTION 'La última ejecución (% km) supera el odómetro real de la unidad (% km)', NEW.last_performed_km, v.current_odometer;
    END IF;
    IF NEW.frequency_hours IS NOT NULL AND NEW.last_performed_hours > COALESCE(v.current_hours, 0) THEN
      RAISE EXCEPTION 'La última ejecución (% h) supera el horómetro real (% h)', NEW.last_performed_hours, v.current_hours;
    END IF;
  END IF;
  -- Tolerancia de 1 día: clientes en UTC ven "mañana" desde las 19:00 de Lima
  IF NEW.last_performed_date > v_today + 1 THEN
    RAISE EXCEPTION 'La fecha de última ejecución no puede ser futura';
  END IF;

  NEW.last_performed_odometer := NEW.last_performed_km;
  NEW.next_due_km       := CASE WHEN NEW.frequency_km IS NOT NULL THEN NEW.last_performed_km + NEW.frequency_km END;
  NEW.next_due_odometer := NEW.next_due_km;
  NEW.next_due_date     := CASE WHEN NEW.frequency_days IS NOT NULL THEN NEW.last_performed_date + NEW.frequency_days END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_maintenance_plan ON public.maintenance_plans;
CREATE TRIGGER trg_normalize_maintenance_plan
BEFORE INSERT OR UPDATE ON public.maintenance_plans
FOR EACH ROW EXECUTE FUNCTION public.normalize_maintenance_plan();

-- Reaplicar la normalización a los planes existentes
UPDATE public.maintenance_plans SET updated_at = now();

-- ------------------------------------------------------------
-- 2. Lecturas autorizadas y tasa de uso
-- ------------------------------------------------------------
ALTER TABLE public.vehicle_odometer_logs
  ADD COLUMN IF NOT EXISTS hours_value numeric(10,2);

CREATE OR REPLACE FUNCTION public.register_asset_reading(
  p_vehicle_plate text,
  p_odometer      numeric DEFAULT NULL,
  p_hours         numeric DEFAULT NULL,
  p_source        text    DEFAULT 'MANTENIMIENTO',
  p_notes         text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate)) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada');
  END IF;
  -- Fuente autorizada: mantenimiento/flota de la sede, o el conductor con un viaje activo de la unidad
  IF auth.uid() IS NOT NULL AND NOT (
       (public.can_access_site(v.site_id) AND (public.has_cmms_permission('flota') OR public.has_cmms_permission('ot')))
       OR EXISTS (SELECT 1 FROM public.dispatches d JOIN public.drivers dr ON dr.id = d.driver_id
                  WHERE d.vehicle_plate = v.plate AND dr.profile_id = auth.uid()
                    AND d.status NOT IN ('CERRADO', 'LIQUIDADO', 'CANCELADO', 'RETORNO_COMPLETADO'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No es una fuente autorizada para esta unidad');
  END IF;
  IF p_odometer IS NULL AND p_hours IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Informe odómetro u horómetro');
  END IF;
  IF p_odometer IS NOT NULL AND p_odometer < COALESCE(v.current_odometer, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El odómetro no puede retroceder (actual ' || v.current_odometer || ')');
  END IF;
  IF p_hours IS NOT NULL AND p_hours < COALESCE(v.current_hours, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El horómetro no puede retroceder (actual ' || v.current_hours || ')');
  END IF;

  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, hours_value, source_event, status, notes, created_by)
  VALUES (v.plate, COALESCE(p_odometer, v.current_odometer), p_hours, upper(COALESCE(p_source, 'MANTENIMIENTO')), 'VALIDADO', p_notes, auth.uid());

  UPDATE public.vehicles SET
    current_odometer = COALESCE(p_odometer, current_odometer),
    current_hours    = COALESCE(p_hours, current_hours)
  WHERE id = v.id;

  RETURN jsonb_build_object('success', true, 'odometer', COALESCE(p_odometer, v.current_odometer), 'hours', COALESCE(p_hours, v.current_hours));
END;
$$;

REVOKE ALL ON FUNCTION public.register_asset_reading(text, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_asset_reading(text, numeric, numeric, text, text) TO authenticated, service_role;

DROP POLICY IF EXISTS odometer_logs_read ON public.vehicle_odometer_logs;
CREATE POLICY odometer_logs_read ON public.vehicle_odometer_logs FOR SELECT TO authenticated USING (
  public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.vehicles v WHERE v.plate = vehicle_odometer_logs.vehicle_plate
      AND public.can_access_site(v.site_id) AND public.has_cmms_read_permission('flota')));

-- Tasa de uso (últimos 30 días de lecturas; respaldo: promedio declarado del vehículo)
CREATE OR REPLACE VIEW public.vw_asset_usage_rate
WITH (security_invoker = true) AS
SELECT
  v.plate,
  COALESCE(
    (SELECT CASE WHEN max(l.created_at) - min(l.created_at) >= interval '3 days'
                 THEN (max(l.odometer_value) - min(l.odometer_value))
                      / GREATEST(extract(epoch FROM max(l.created_at) - min(l.created_at)) / 86400.0, 1) END
     FROM public.vehicle_odometer_logs l
     WHERE l.vehicle_plate = v.plate AND l.created_at >= now() - interval '30 days' AND l.odometer_value IS NOT NULL),
    NULLIF(v.average_daily_km, 0)::numeric) AS avg_daily_km,
  (SELECT CASE WHEN max(l.created_at) - min(l.created_at) >= interval '3 days'
               THEN (max(l.hours_value) - min(l.hours_value))
                    / GREATEST(extract(epoch FROM max(l.created_at) - min(l.created_at)) / 86400.0, 1) END
   FROM public.vehicle_odometer_logs l
   WHERE l.vehicle_plate = v.plate AND l.created_at >= now() - interval '30 days' AND l.hours_value IS NOT NULL) AS avg_daily_hours
FROM public.vehicles v;

GRANT SELECT ON public.vw_asset_usage_rate TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Proyecciones y alertas
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_maintenance_projections;
CREATE VIEW public.vw_maintenance_projections
WITH (security_invoker = true) AS
WITH base AS (
  SELECT
    p.id AS plan_id, p.vehicle_plate, p.name AS plan_name, p.activity_description,
    p.frequency_km, p.frequency_days, p.frequency_hours,
    p.last_performed_km, p.last_performed_date, p.last_performed_hours,
    p.next_due_km, p.next_due_date, p.next_due_hours,
    p.standard_tasks, p.expected_parts, p.site_id,
    v.id AS vehicle_id, v.type AS vehicle_type, v.status AS vehicle_status,
    v.current_odometer, v.current_hours,
    u.avg_daily_km, u.avg_daily_hours,
    (now() AT TIME ZONE 'America/Lima')::date AS today
  FROM public.maintenance_plans p
  JOIN public.vehicles v ON v.plate = p.vehicle_plate
  LEFT JOIN public.vw_asset_usage_rate u ON u.plate = v.plate
  WHERE p.is_active = true
), calc AS (
  SELECT b.*,
    CASE WHEN b.next_due_km IS NOT NULL THEN b.next_due_km - COALESCE(b.current_odometer, 0) END AS km_remaining,
    CASE WHEN b.next_due_date IS NOT NULL THEN b.next_due_date - b.today END AS days_remaining,
    CASE WHEN b.next_due_hours IS NOT NULL AND b.frequency_hours IS NOT NULL THEN b.next_due_hours - COALESCE(b.current_hours, 0) END AS hours_remaining
  FROM base b
), proj AS (
  SELECT c.*,
    LEAST(
      c.next_due_date,
      CASE WHEN c.km_remaining IS NOT NULL AND c.avg_daily_km > 0 THEN c.today + ceil(GREATEST(c.km_remaining, 0) / c.avg_daily_km)::int END,
      CASE WHEN c.hours_remaining IS NOT NULL AND c.avg_daily_hours > 0 THEN c.today + ceil(GREATEST(c.hours_remaining, 0) / c.avg_daily_hours)::int END
    ) AS projected_due_date
  FROM calc c
)
SELECT
  pr.plan_id, pr.vehicle_plate, pr.vehicle_id, pr.vehicle_type, pr.vehicle_status, pr.plan_name, pr.activity_description,
  pr.frequency_km, pr.frequency_days, pr.frequency_hours,
  pr.last_performed_km, pr.last_performed_date, pr.last_performed_hours,
  pr.next_due_km, pr.next_due_date, pr.next_due_hours,
  pr.current_odometer, pr.current_hours, pr.km_remaining, pr.days_remaining, pr.hours_remaining,
  round(pr.avg_daily_km, 1) AS avg_daily_km, round(pr.avg_daily_hours, 2) AS avg_daily_hours,
  pr.projected_due_date,
  pr.projected_due_date - pr.today AS projected_days,
  CASE
    WHEN (pr.km_remaining IS NOT NULL AND pr.km_remaining <= 0) OR (pr.days_remaining IS NOT NULL AND pr.days_remaining <= 0)
      OR (pr.hours_remaining IS NOT NULL AND pr.hours_remaining <= 0) THEN 'VENCIDO'
    WHEN pr.projected_due_date - pr.today <= 30 THEN '30'
    WHEN pr.projected_due_date - pr.today <= 60 THEN '60'
    WHEN pr.projected_due_date - pr.today <= 90 THEN '90'
    ELSE '+90' END AS projection_bucket,
  CASE
    WHEN (pr.km_remaining IS NOT NULL AND pr.km_remaining <= 0) OR (pr.days_remaining IS NOT NULL AND pr.days_remaining <= 0)
      OR (pr.hours_remaining IS NOT NULL AND pr.hours_remaining <= 0) THEN 'VENCIDO'
    WHEN (pr.projected_due_date - pr.today <= 7)
      OR (pr.km_remaining IS NOT NULL AND pr.km_remaining <= pr.frequency_km * 0.10)
      OR (pr.hours_remaining IS NOT NULL AND pr.hours_remaining <= pr.frequency_hours * 0.10) THEN 'URGENTE'
    WHEN (pr.projected_due_date - pr.today <= 30)
      OR (pr.km_remaining IS NOT NULL AND pr.km_remaining <= pr.frequency_km * 0.25)
      OR (pr.hours_remaining IS NOT NULL AND pr.hours_remaining <= pr.frequency_hours * 0.25) THEN 'PRÓXIMO'
    ELSE 'NORMAL' END AS alert_status,
  CASE
    WHEN pr.km_remaining IS NOT NULL AND pr.km_remaining <= 0 THEN 'KILOMETRAJE'
    WHEN pr.hours_remaining IS NOT NULL AND pr.hours_remaining <= 0 THEN 'HOROMETRO'
    WHEN pr.days_remaining IS NOT NULL AND pr.days_remaining <= 0 THEN 'FECHA'
    WHEN pr.projected_due_date = pr.next_due_date THEN 'FECHA'
    WHEN pr.km_remaining IS NOT NULL AND pr.avg_daily_km > 0 THEN 'KILOMETRAJE'
    WHEN pr.hours_remaining IS NOT NULL THEN 'HOROMETRO'
    ELSE 'FECHA' END AS due_driver,
  wo.id AS open_work_order_id, wo.ot_code AS open_work_order_code, wo.status AS open_work_order_status,
  pr.standard_tasks, pr.expected_parts, pr.site_id
FROM proj pr
LEFT JOIN LATERAL (
  SELECT id, ot_code, status FROM public.maintenance_work_orders
  WHERE plan_id = pr.plan_id AND status NOT IN ('CERRADA', 'CANCELADA')
  ORDER BY created_at DESC LIMIT 1
) wo ON true;

GRANT SELECT ON public.vw_maintenance_projections TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Generación de OT preventiva (idempotente)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.generate_preventive_wo(uuid);
CREATE FUNCTION public.generate_preventive_wo(p_plan_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_proj  record;
  v_plan  public.maintenance_plans%ROWTYPE;
  v_wo    uuid;
  v_start date;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('planes') OR public.has_cmms_permission('ot')) THEN
    RAISE EXCEPTION 'Sin permiso para generar OT preventivas' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plan FROM public.maintenance_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT v_plan.is_active THEN
    RAISE EXCEPTION 'Plan inexistente o inactivo';
  END IF;
  IF v_plan.vehicle_plate IS NULL THEN
    RAISE EXCEPTION 'El plan % no está asignado a una unidad', v_plan.name;
  END IF;

  SELECT id INTO v_wo FROM public.maintenance_work_orders
  WHERE plan_id = p_plan_id AND status NOT IN ('CERRADA', 'CANCELADA') LIMIT 1;
  IF v_wo IS NOT NULL THEN
    RETURN v_wo;   -- ya existe una OT abierta para el plan
  END IF;

  SELECT * INTO v_proj FROM public.vw_maintenance_projections WHERE plan_id = p_plan_id;
  v_start := GREATEST((now() AT TIME ZONE 'America/Lima')::date,
                      COALESCE(v_proj.projected_due_date, (now() AT TIME ZONE 'America/Lima')::date));

  INSERT INTO public.maintenance_work_orders (
    ot_code, vehicle_plate, type, order_type, source_type, source_id, plan_id, priority,
    description, tasks, status, start_date, site_id
  ) VALUES (
    'OT-PM-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5)),
    v_plan.vehicle_plate, 'PREVENTIVO', 'PREVENTIVA', 'PLAN', v_plan.id, v_plan.id,
    CASE WHEN v_proj.alert_status IN ('VENCIDO', 'URGENTE') THEN 'ALTA' ELSE 'NORMAL' END,
    'Preventivo: ' || v_plan.name || COALESCE(' — ' || NULLIF(v_plan.activity_description, v_plan.name), '')
      || ' (' || COALESCE(v_proj.alert_status, 'PLAN') || ' por ' || COALESCE(v_proj.due_driver, 'FECHA') || ')',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('text', COALESCE(t->>'description', t->>'text', t #>> '{}'), 'done', false))
              FROM jsonb_array_elements(v_plan.standard_tasks) t), '[]'::jsonb),
    'BORRADOR', v_start, v_plan.site_id
  ) RETURNING id INTO v_wo;

  RETURN v_wo;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_preventive_wo(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_preventive_wo(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Programador en la BD (pg_cron) con bitácora
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.preventive_scheduler_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at      timestamptz NOT NULL DEFAULT now(),
  triggered_by text NOT NULL DEFAULT 'CRON',
  evaluated   int NOT NULL DEFAULT 0,
  generated   int NOT NULL DEFAULT 0,
  details     jsonb NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE public.preventive_scheduler_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_runs_read ON public.preventive_scheduler_runs;
CREATE POLICY scheduler_runs_read ON public.preventive_scheduler_runs FOR SELECT TO authenticated
USING (public.has_cmms_read_permission('planes'));

CREATE OR REPLACE FUNCTION public.run_preventive_scheduler(p_triggered_by text DEFAULT 'CRON')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r         record;
  v_wo      uuid;
  v_eval    int := 0;
  v_gen     int := 0;
  v_details jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('planes') OR public.has_cmms_permission('ot')) THEN
    RAISE EXCEPTION 'Sin permiso para ejecutar el programador' USING ERRCODE = '42501';
  END IF;

  FOR r IN SELECT plan_id, vehicle_plate, plan_name, alert_status FROM public.vw_maintenance_projections
           WHERE alert_status IN ('VENCIDO', 'URGENTE') AND open_work_order_id IS NULL LOOP
    v_eval := v_eval + 1;
    BEGIN
      v_wo := public.generate_preventive_wo(r.plan_id);
      v_gen := v_gen + 1;
      v_details := v_details || jsonb_build_object('plan', r.plan_name, 'plate', r.vehicle_plate, 'alert', r.alert_status, 'work_order_id', v_wo);
    EXCEPTION WHEN OTHERS THEN
      v_details := v_details || jsonb_build_object('plan', r.plan_name, 'plate', r.vehicle_plate, 'error', SQLERRM);
    END;
  END LOOP;

  INSERT INTO public.preventive_scheduler_runs (triggered_by, evaluated, generated, details)
  VALUES (COALESCE(p_triggered_by, 'CRON'), v_eval, v_gen, v_details);

  RETURN jsonb_build_object('evaluated', v_eval, 'generated', v_gen, 'details', v_details);
END;
$$;

REVOKE ALL ON FUNCTION public.run_preventive_scheduler(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_preventive_scheduler(text) TO authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
-- 06:00 hora de Lima (11:00 UTC), todos los días
SELECT cron.schedule('cmms-preventive-scheduler', '0 11 * * *', $cron$SELECT public.run_preventive_scheduler('CRON')$cron$);

NOTIFY pgrst, 'reload schema';

COMMIT;
