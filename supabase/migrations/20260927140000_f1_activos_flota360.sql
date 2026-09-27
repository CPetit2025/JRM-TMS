-- 20260927140000_f1_activos_flota360.sql
-- FASE 1 — Maestro de activos y Flota 360°.
--
-- * Identidad única: la placa (o código para equipos sin placa) no cambia desde el cliente;
--   internal_code único; no se elimina un activo con historia (se da de baja: FUERA_DE_SERVICIO).
-- * Una sola fuente por dato: current_odometer (current_mileage queda como espejo legado) y
--   weight_capacity/volume_capacity (capacity_* como espejo). Odómetro/horómetro no retroceden.
-- * Auditoría de cambios del maestro en vehicle_history_logs (escrita solo por el servidor:
--   antes cualquier usuario podía insertar registros de auditoría).
-- * vehicle_tco_analytics recreada (la versión aplicada falló en silencio y la ficha la consultaba).
-- * get_fleet_360_view: ficha consolidada (estado, elegibilidad, fallas, OT, preventivos,
--   inspecciones, neumáticos, documentos, costos, lecturas, viajes, evidencias e historial).

BEGIN;

-- ------------------------------------------------------------
-- 1. Datos del maestro
-- ------------------------------------------------------------
UPDATE public.vehicles SET
  current_odometer = COALESCE(current_odometer, current_mileage, 0),
  weight_capacity  = COALESCE(weight_capacity, capacity_weight),
  volume_capacity  = COALESCE(volume_capacity, capacity_volume),
  internal_code    = NULLIF(trim(internal_code), '');

CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_internal_code
  ON public.vehicles (upper(internal_code)) WHERE internal_code IS NOT NULL;

ALTER TABLE public.vehicles DROP CONSTRAINT IF EXISTS vehicles_readings_check;
ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_readings_check
  CHECK (COALESCE(current_odometer, 0) >= 0 AND COALESCE(current_hours, 0) >= 0);

CREATE OR REPLACE FUNCTION public.normalize_vehicle_master()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.plate := upper(trim(NEW.plate));
  NEW.internal_code := NULLIF(upper(trim(NEW.internal_code)), '');
  -- Espejos legados (una sola fuente: current_odometer / weight_capacity / volume_capacity)
  IF TG_OP = 'UPDATE' AND NEW.current_mileage IS DISTINCT FROM OLD.current_mileage
     AND NEW.current_odometer IS NOT DISTINCT FROM OLD.current_odometer THEN
    NEW.current_odometer := NEW.current_mileage;
  END IF;
  NEW.current_mileage := round(COALESCE(NEW.current_odometer, 0))::int;
  NEW.weight_capacity := COALESCE(NEW.weight_capacity, NEW.capacity_weight);
  NEW.capacity_weight := NEW.weight_capacity;
  NEW.volume_capacity := COALESCE(NEW.volume_capacity, NEW.capacity_volume);
  NEW.capacity_volume := NEW.volume_capacity;

  IF TG_OP = 'UPDATE' AND current_user IN ('authenticated', 'anon') THEN
    IF NEW.plate IS DISTINCT FROM OLD.plate THEN
      RAISE EXCEPTION 'La placa/código es la identidad del activo y no se modifica' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(NEW.current_odometer, 0) < COALESCE(OLD.current_odometer, 0) THEN
      RAISE EXCEPTION 'El odómetro no puede retroceder (% → %)', OLD.current_odometer, NEW.current_odometer USING ERRCODE = '22023';
    END IF;
    IF COALESCE(NEW.current_hours, 0) < COALESCE(OLD.current_hours, 0) THEN
      RAISE EXCEPTION 'El horómetro no puede retroceder (% → %)', OLD.current_hours, NEW.current_hours USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_vehicle_master ON public.vehicles;
CREATE TRIGGER trg_normalize_vehicle_master
BEFORE INSERT OR UPDATE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.normalize_vehicle_master();

-- ------------------------------------------------------------
-- 2. Auditoría del maestro
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_vehicle_master()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  k     text;
  fields text[] := ARRAY['internal_code', 'serial_number', 'type', 'brand', 'model', 'year', 'weight_capacity',
                         'volume_capacity', 'current_odometer', 'current_hours', 'criticality', 'ownership_status',
                         'responsible_id', 'current_location', 'soat_expiration', 'technical_review_expiration',
                         'carrier_id', 'site_id', 'is_active'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
    VALUES (NEW.plate, auth.uid(), 'alta', NULL, NEW.type || ' ' || COALESCE(NEW.brand, '') || ' ' || COALESCE(NEW.model, ''), 'Alta del activo');
    RETURN NULL;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH k IN ARRAY fields LOOP
    IF v_old->k IS DISTINCT FROM v_new->k THEN
      INSERT INTO public.vehicle_history_logs (vehicle_plate, changed_by, field_changed, old_value, new_value, change_reason)
      VALUES (NEW.plate, auth.uid(), k, v_old->>k, v_new->>k, 'Actualización del maestro');
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_vehicle_master ON public.vehicles;
CREATE TRIGGER trg_audit_vehicle_master
AFTER INSERT OR UPDATE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.audit_vehicle_master();

-- La auditoría la escribe el servidor; nadie la edita ni la inserta desde el cliente
DROP POLICY IF EXISTS history_logs_write ON public.vehicle_history_logs;
DROP POLICY IF EXISTS history_logs_read ON public.vehicle_history_logs;
CREATE POLICY history_logs_read ON public.vehicle_history_logs FOR SELECT TO authenticated USING (
  public.is_tms_admin() OR EXISTS (
    SELECT 1 FROM public.vehicles v
    WHERE v.plate = vehicle_history_logs.vehicle_plate
      AND public.can_access_site(v.site_id) AND public.has_cmms_read_permission('flota')));

-- Un activo con historia no se elimina: se da de baja
CREATE OR REPLACE FUNCTION public.guard_vehicle_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.maintenance_work_orders WHERE vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.maintenance_requests WHERE vehicle_plate = OLD.plate)
     OR EXISTS (SELECT 1 FROM public.dispatches WHERE vehicle_plate = OLD.plate OR vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM public.inspections WHERE vehicle_plate = OLD.plate) THEN
    RAISE EXCEPTION 'El activo % tiene historial operativo: márquelo FUERA_DE_SERVICIO en lugar de eliminarlo', OLD.plate
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_vehicle_delete ON public.vehicles;
CREATE TRIGGER trg_guard_vehicle_delete
BEFORE DELETE ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.guard_vehicle_delete();

-- ------------------------------------------------------------
-- 3. Costos por activo (TCO base; F11/F12 agregan alquiler y KPIs)
-- ------------------------------------------------------------
DROP VIEW IF EXISTS public.vehicle_tco_analytics;
CREATE VIEW public.vehicle_tco_analytics
WITH (security_invoker = true) AS
SELECT
  v.id AS vehicle_id,
  v.plate,
  COALESCE(op.operating_cost, 0)   AS operating_cost,
  COALESCE(op.fuel_cost, 0)        AS fuel_cost,
  COALESCE(mt.maintenance_cost, 0) AS maintenance_cost,
  round(COALESCE(vc.fixed_cost_per_km, 0) * COALESCE(v.current_odometer, 0), 2) AS fixed_cost,
  round(COALESCE(op.operating_cost, 0) + COALESCE(mt.maintenance_cost, 0)
        + COALESCE(vc.fixed_cost_per_km, 0) * COALESCE(v.current_odometer, 0), 2) AS total_tco,
  CASE WHEN COALESCE(v.current_odometer, 0) > 0 THEN
    round((COALESCE(op.operating_cost, 0) + COALESCE(mt.maintenance_cost, 0)
           + COALESCE(vc.fixed_cost_per_km, 0) * v.current_odometer) / v.current_odometer, 4)
  END AS cpk,
  CASE WHEN COALESCE(v.current_odometer, 0) > 0 THEN round(COALESCE(mt.maintenance_cost, 0) / v.current_odometer, 4) END AS maintenance_cpk
FROM public.vehicles v
LEFT JOIN public.vehicle_costs vc ON upper(vc.vehicle_type) = v.type
LEFT JOIN (
  SELECT d.vehicle_plate,
         sum(de.amount) AS operating_cost,
         sum(de.amount) FILTER (WHERE upper(de.expense_type) IN ('COMBUSTIBLE', 'FUEL', 'DIESEL', 'GASOLINA')) AS fuel_cost
  FROM public.dispatch_expenses de
  JOIN public.dispatches d ON d.id = de.dispatch_id
  WHERE de.status = 'APROBADO'
  GROUP BY d.vehicle_plate
) op ON op.vehicle_plate = v.plate
LEFT JOIN (
  SELECT wo.vehicle_id, sum(c.amount) AS maintenance_cost
  FROM public.work_order_costs c
  JOIN public.maintenance_work_orders wo ON wo.id = c.work_order_id
  WHERE wo.status <> 'CANCELADA'
  GROUP BY wo.vehicle_id
) mt ON mt.vehicle_id = v.id;

GRANT SELECT ON public.vehicle_tco_analytics TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Ficha Flota 360° (SECURITY INVOKER: respeta RLS de cada fuente)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_fleet_360_view(varchar);
CREATE FUNCTION public.get_fleet_360_view(p_plate text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v public.vehicles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.vehicles WHERE plate = upper(trim(p_plate));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'vehicle', to_jsonb(v) || jsonb_build_object(
      'carrier_name', (SELECT business_name FROM public.carriers WHERE id = v.carrier_id),
      'responsible_name', (SELECT NULLIF(trim(concat_ws(' ', first_name, last_name)), '') FROM public.profiles WHERE id = v.responsible_id)),
    'eligibility', public.check_asset_eligibility(v.plate, 'RELEASE'),
    'costs', (SELECT to_jsonb(t) FROM public.vehicle_tco_analytics t WHERE t.vehicle_id = v.id),
    'open_requests', COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.priority_score DESC)
                               FROM public.vw_maintenance_backlog b WHERE b.vehicle_plate = v.plate), '[]'::jsonb),
    'requests_history', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.reported_at DESC) FROM (
                               SELECT id, description, severity, status, source, reported_at, closed_at, photo_url
                               FROM public.maintenance_requests WHERE vehicle_plate = v.plate
                               ORDER BY reported_at DESC LIMIT 30) r), '[]'::jsonb),
    'work_orders', COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC) FROM (
                               SELECT id, ot_code, status, order_type, priority, description, total_cost, downtime_hours,
                                      downtime_start, closed_at, created_at, evidence_urls
                               FROM public.vw_work_orders WHERE vehicle_id = v.id ORDER BY created_at DESC LIMIT 30) w), '[]'::jsonb),
    'preventive', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.vw_maintenance_projections p WHERE p.vehicle_plate = v.plate), '[]'::jsonb),
    'inspections', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.date DESC) FROM (
                               SELECT i.id, i.date, i.global_result, t.name AS template_name, t.type AS template_type
                               FROM public.inspections i LEFT JOIN public.checklist_templates t ON t.id = i.template_id
                               WHERE i.vehicle_plate = v.plate ORDER BY i.date DESC LIMIT 20) i), '[]'::jsonb),
    'tires', COALESCE((SELECT jsonb_agg(to_jsonb(tr) ORDER BY tr.posicion_actual) FROM (
                               SELECT id, codigo_interno, marca, modelo, medida, posicion_actual, cocada_actual,
                                      cocada_original, total_km_travelled, estado, costo
                               FROM public.tires WHERE current_vehicle_plate = v.plate OR vehiculo_actual_id = v.id) tr), '[]'::jsonb),
    'documents', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.expiration_date) FROM public.vw_document_alerts d
                           WHERE d.vehicle_plate = v.plate), '[]'::jsonb),
    'readings', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC) FROM (
                               SELECT odometer_value, source_event, status, created_at, photo_url
                               FROM public.vehicle_odometer_logs WHERE vehicle_plate = v.plate
                               ORDER BY created_at DESC LIMIT 20) o), '[]'::jsonb),
    'dispatches', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC) FROM (
                               SELECT id, dispatch_number, status, scheduled_departure, driver_name, actual_distance_km, created_at
                               FROM public.dispatches WHERE vehicle_plate = v.plate ORDER BY created_at DESC LIMIT 15) d), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.created_at DESC) FROM (
                               SELECT h.field_changed, h.old_value, h.new_value, h.change_reason, h.created_at,
                                      NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS changed_by_name
                               FROM public.vehicle_history_logs h LEFT JOIN public.profiles p ON p.id = h.changed_by
                               WHERE h.vehicle_plate = v.plate ORDER BY h.created_at DESC LIMIT 60) h), '[]'::jsonb),
    'photos', COALESCE((SELECT jsonb_agg(url) FROM (
                               SELECT photo_url AS url FROM public.maintenance_requests WHERE vehicle_plate = v.plate AND photo_url IS NOT NULL
                               UNION ALL
                               SELECT jsonb_array_elements_text(evidence_urls) FROM public.maintenance_work_orders
                               WHERE vehicle_id = v.id AND jsonb_typeof(evidence_urls) = 'array') ph), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_fleet_360_view(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fleet_360_view(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
