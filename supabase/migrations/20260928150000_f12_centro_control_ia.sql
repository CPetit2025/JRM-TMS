-- 20260928150000_f12_centro_control_ia.sql
-- FASE 12 — Centro de Control, analítica e IA.
--
-- * Zona horaria de la base: America/Lima (CURRENT_DATE era UTC: desde las 19:00 de Lima ya era
--   "mañana" para vencimientos y fechas de negocio).
-- * get_cmms_kpis(periodo, placas): KPI calculados desde las fuentes reales (sin tablas de dashboard):
--   disponibilidad (indisponibilidad por OT fusionada sin doble conteo), MTTR, MTBF, backlog,
--   preventivo vs correctivo, costo/km, costo/hora, costo de mantenimiento por unidad, neumáticos,
--   TCO del periodo, fallas recurrentes y detalle por unidad.
-- * get_cmms_copilot_brief(): respuestas con datos reales para el Copiloto (bloqueadas y por qué,
--   mantenimiento que vence, unidad más costosa, fallas recurrentes, repuestos bajo mínimo, talleres
--   con más retrabajos) y detección de anomalías (picos de costo, tendencia de fallas, neumáticos,
--   documentos). SECURITY INVOKER: la IA solo ve lo que el usuario puede ver; nunca modifica datos.
-- * Se elimina ai_analysis_logs (vacía; solo la usaba el Copiloto simulado).

BEGIN;

ALTER DATABASE postgres SET timezone TO 'America/Lima';
SET LOCAL timezone TO 'America/Lima';

-- ------------------------------------------------------------
-- 1. KPI del CMMS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cmms_kpis(p_start date, p_end date, p_plates text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period   tstzrange := tstzrange((p_start::timestamp AT TIME ZONE 'America/Lima'), ((p_end + 1)::timestamp AT TIME ZONE 'America/Lima'), '[)');
  v_hours    numeric;
  v_result   jsonb;
BEGIN
  IF p_end < p_start THEN
    RAISE EXCEPTION 'Periodo inválido';
  END IF;
  v_hours := extract(epoch FROM upper(v_period) - lower(v_period)) / 3600.0;

  WITH units AS (
    SELECT v.id, v.plate, v.type, v.status, v.criticality, v.ownership_status
    FROM public.vehicles v
    WHERE v.status <> 'FUERA_DE_SERVICIO' AND (p_plates IS NULL OR v.plate = ANY (p_plates))
  ),
  -- Indisponibilidad: intervalos de OT fusionados por unidad (sin doble conteo) y recortados al periodo
  dt AS (
    SELECT wo.vehicle_id,
           range_agg(tstzrange(wo.downtime_start, COALESCE(wo.downtime_end, now()), '[)')) * tstzmultirange(v_period) AS mr
    FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id
    WHERE wo.downtime_start IS NOT NULL AND wo.status <> 'CANCELADA' AND COALESCE(wo.downtime_end, now()) > wo.downtime_start
    GROUP BY wo.vehicle_id
  ),
  dth AS (
    SELECT dt.vehicle_id, COALESCE(sum(extract(epoch FROM upper(r) - lower(r))) / 3600.0, 0) AS hours
    FROM dt LEFT JOIN LATERAL unnest(dt.mr) r ON true GROUP BY dt.vehicle_id
  ),
  fails AS (
    SELECT u.id AS vehicle_id, count(r.id) AS failures
    FROM units u JOIN public.maintenance_requests r ON r.vehicle_plate = u.plate
    WHERE r.status <> 'DESCARTADA' AND r.reported_at <@ v_period
    GROUP BY u.id
  ),
  usage AS (
    SELECT u.id AS vehicle_id,
           COALESCE(max(l.odometer_value) - min(l.odometer_value), 0) AS km,
           COALESCE(max(l.hours_value) - min(l.hours_value), 0) AS op_hours
    FROM units u JOIN public.vehicle_odometer_logs l ON l.vehicle_plate = u.plate
    WHERE l.created_at <@ v_period GROUP BY u.id
  ),
  costs AS (
    SELECT l.vehicle_id, sum(l.amount) AS total,
           sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO') AS maintenance
    FROM (SELECT vehicle_id, category, sum(amount) AS amount FROM public.vw_vehicle_cost_ledger
          WHERE cost_date <@ v_period AND vehicle_id IN (SELECT id FROM units) GROUP BY vehicle_id, category) l
    GROUP BY l.vehicle_id
  ),
  per_vehicle AS (
    SELECT u.plate, u.type, u.status, u.ownership_status,
           round(COALESCE(dth.hours, 0), 2) AS downtime_hours,
           round(100 * (1 - COALESCE(dth.hours, 0) / v_hours), 2) AS availability_pct,
           COALESCE(f.failures, 0) AS failures,
           CASE WHEN COALESCE(f.failures, 0) > 0 THEN round((v_hours - COALESCE(dth.hours, 0)) / f.failures, 1) END AS mtbf_hours,
           round(COALESCE(us.km, 0), 2) AS km, round(COALESCE(us.op_hours, 0), 2) AS op_hours,
           round(COALESCE(c.total, 0), 2) AS cost, round(COALESCE(c.maintenance, 0), 2) AS maintenance_cost,
           CASE WHEN COALESCE(us.km, 0) > 0 THEN round(COALESCE(c.total, 0) / us.km, 4) END AS cost_per_km
    FROM units u
    LEFT JOIN dth ON dth.vehicle_id = u.id
    LEFT JOIN fails f ON f.vehicle_id = u.id
    LEFT JOIN usage us ON us.vehicle_id = u.id
    LEFT JOIN costs c ON c.vehicle_id = u.id
  ),
  closed AS (
    SELECT wo.* FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id
    WHERE wo.status = 'CERRADA' AND wo.closed_at <@ v_period
  ),
  cat AS (
    SELECT l.category, sum(l.amount) AS amount FROM public.vw_vehicle_cost_ledger l
    WHERE l.cost_date <@ v_period AND l.vehicle_id IN (SELECT id FROM units) GROUP BY l.category
  ),
  backlog AS (
    SELECT count(*) AS open_requests, count(*) FILTER (WHERE b.severity = 'CRITICA') AS critical,
           round(avg(b.age_days), 1) AS avg_age_days, max(b.age_days) AS oldest_days
    FROM public.vw_maintenance_backlog b WHERE b.vehicle_plate IN (SELECT plate FROM units)
  ),
  recurrent AS (
    SELECT r.vehicle_plate, count(*) AS reports_90d,
           (SELECT string_agg(DISTINCT left(r2.description, 60), ' | ') FROM public.maintenance_requests r2
            WHERE r2.vehicle_plate = r.vehicle_plate AND r2.reported_at >= upper(v_period) - interval '90 days' AND r2.reported_at < upper(v_period)) AS descriptions
    FROM public.maintenance_requests r
    WHERE r.vehicle_plate IN (SELECT plate FROM units) AND r.status <> 'DESCARTADA'
      AND r.reported_at >= upper(v_period) - interval '90 days' AND r.reported_at < upper(v_period)
    GROUP BY r.vehicle_plate HAVING count(*) >= 3
  ),
  tires AS (
    SELECT round(avg(t.cost_per_km), 4) AS avg_cost_per_km, count(*) FILTER (WHERE t.tread_status IN ('CAMBIAR', 'POR_CAMBIAR')) AS to_change,
           count(*) AS installed
    FROM public.vw_tires t WHERE t.estado = 'INSTALADO' AND t.vehicle_plate IN (SELECT plate FROM units)
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', p_start, 'end', p_end, 'hours', round(v_hours, 2)),
    'units', (SELECT count(*) FROM units),
    'snapshot', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM units GROUP BY status) s),
    'availability_pct', (SELECT CASE WHEN count(*) > 0 THEN round(100 * (1 - COALESCE(sum(downtime_hours), 0) / (count(*) * v_hours)), 2) END FROM per_vehicle),
    'downtime_hours', (SELECT round(COALESCE(sum(downtime_hours), 0), 2) FROM per_vehicle),
    'failures', (SELECT COALESCE(sum(failures), 0) FROM per_vehicle),
    'mtbf_hours', (SELECT CASE WHEN sum(failures) > 0 THEN round((count(*) * v_hours - sum(downtime_hours)) / sum(failures), 1) END FROM per_vehicle),
    'mttr_hours', (SELECT round(avg(downtime_hours), 2) FROM closed WHERE order_type IN ('CORRECTIVA', 'EMERGENCIA') AND downtime_hours IS NOT NULL),
    'closed_work_orders', (SELECT count(*) FROM closed),
    'preventive_work_orders', (SELECT count(*) FROM closed WHERE order_type = 'PREVENTIVA'),
    'corrective_work_orders', (SELECT count(*) FROM closed WHERE order_type IN ('CORRECTIVA', 'EMERGENCIA')),
    'preventive_pct', (SELECT CASE WHEN count(*) FILTER (WHERE order_type IN ('PREVENTIVA', 'CORRECTIVA', 'EMERGENCIA')) > 0
                         THEN round(100.0 * count(*) FILTER (WHERE order_type = 'PREVENTIVA') / count(*) FILTER (WHERE order_type IN ('PREVENTIVA', 'CORRECTIVA', 'EMERGENCIA')), 1) END FROM closed),
    'open_work_orders', (SELECT count(*) FROM public.maintenance_work_orders wo JOIN units u ON u.id = wo.vehicle_id WHERE wo.status NOT IN ('CERRADA', 'CANCELADA')),
    'backlog', (SELECT to_jsonb(b) FROM backlog b),
    'costs', jsonb_build_object(
       'total', (SELECT round(COALESCE(sum(amount), 0), 2) FROM cat),
       'by_category', COALESCE((SELECT jsonb_object_agg(category, round(amount, 2)) FROM cat), '{}'::jsonb),
       'maintenance_per_unit', (SELECT CASE WHEN count(*) > 0 THEN round(COALESCE(sum(maintenance_cost), 0) / count(*), 2) END FROM per_vehicle),
       'km', (SELECT round(COALESCE(sum(km), 0), 2) FROM per_vehicle),
       'cost_per_km', (SELECT CASE WHEN sum(km) > 0 THEN round(sum(cost) FILTER (WHERE km > 0) / sum(km), 4) END FROM per_vehicle),
       'cost_per_hour', (SELECT CASE WHEN sum(op_hours) > 0 THEN round(sum(cost) FILTER (WHERE op_hours > 0) / sum(op_hours), 4) END FROM per_vehicle)),
    'tires', (SELECT to_jsonb(t) FROM tires t),
    'recurrent_failures', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.reports_90d DESC) FROM recurrent r), '[]'::jsonb),
    'per_vehicle', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.availability_pct, p.cost DESC) FROM per_vehicle p), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_cmms_kpis(date, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cmms_kpis(date, date, text[]) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Resumen para el Copiloto (datos reales + anomalías)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cmms_copilot_brief(p_plates text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_blocked jsonb := '[]'::jsonb;
  r         record;
  e         jsonb;
BEGIN
  -- ¿Qué unidades están bloqueadas / no disponibles y por qué?
  FOR r IN SELECT plate, status FROM public.vehicles
           WHERE (p_plates IS NULL OR plate = ANY (p_plates)) AND status <> 'FUERA_DE_SERVICIO'
           ORDER BY plate LIMIT 300 LOOP
    e := public.check_asset_eligibility(r.plate, 'RELEASE');
    IF r.status IN ('BLOQUEADA', 'MANTENIMIENTO', 'OBSERVADA') OR e->>'status' = 'NO_APTO' THEN
      v_blocked := v_blocked || jsonb_build_object('plate', r.plate, 'status', r.status, 'eligibility', e->>'status', 'motives', e->'motives');
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'blocked_or_unavailable', v_blocked,
    'maintenance_due', COALESCE((SELECT jsonb_agg(jsonb_build_object('plate', p.vehicle_plate, 'plan', p.plan_name, 'alert', p.alert_status,
                                  'driver', p.due_driver, 'projected_date', p.projected_due_date, 'open_work_order', p.open_work_order_code) ORDER BY p.projected_days NULLS LAST)
                                 FROM public.vw_maintenance_projections p
                                 WHERE p.alert_status <> 'NORMAL' AND (p_plates IS NULL OR p.vehicle_plate = ANY (p_plates))), '[]'::jsonb),
    'top_cost_units', COALESCE((SELECT jsonb_agg(x) FROM (
                                 SELECT jsonb_build_object('plate', l.plate, 'cost_365d', round(sum(l.amount), 2),
                                        'maintenance_365d', round(sum(l.amount) FILTER (WHERE l.category = 'MANTENIMIENTO'), 2)) AS x
                                 FROM (SELECT v.plate, cl.amount, cl.category FROM public.vw_vehicle_cost_ledger cl JOIN public.vehicles v ON v.id = cl.vehicle_id
                                       WHERE cl.cost_date >= now() - interval '365 days' AND (p_plates IS NULL OR v.plate = ANY (p_plates))) l
                                 GROUP BY l.plate ORDER BY sum(l.amount) DESC LIMIT 5) t), '[]'::jsonb),
    'recurrent_failures', COALESCE((SELECT jsonb_agg(jsonb_build_object('plate', vehicle_plate, 'reports_90d', n, 'last', last_desc) ORDER BY n DESC)
                                    FROM (SELECT vehicle_plate, count(*) n, (array_agg(description ORDER BY reported_at DESC))[1] last_desc
                                          FROM public.maintenance_requests
                                          WHERE status <> 'DESCARTADA' AND reported_at >= now() - interval '90 days'
                                            AND (p_plates IS NULL OR vehicle_plate = ANY (p_plates))
                                          GROUP BY vehicle_plate HAVING count(*) >= 3) q), '[]'::jsonb),
    'parts_below_minimum', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', internal_code, 'name', name, 'available', available,
                                     'minimum', minimum_stock, 'status', stock_status, 'replenishment', replenishment_status) ORDER BY available)
                                     FROM public.vw_spare_parts_stock WHERE is_active AND COALESCE(minimum_stock, 0) > 0
                                       AND stock_status IN ('BAJO_MINIMO', 'SIN_STOCK')), '[]'::jsonb),
    'provider_reworks', COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', business_name, 'reworks', reworks, 'warranty_claims', warranty_claims,
                                  'rework_rate_pct', rework_rate_pct, 'quality_index', quality_index) ORDER BY reworks + warranty_claims DESC)
                                  FROM public.vw_provider_performance WHERE reworks + warranty_claims > 0), '[]'::jsonb),
    'anomalies', COALESCE((
      -- Pico de costo: mantenimiento de 30 días > 2× el promedio mensual de los 180 días previos (y > S/ 500)
      SELECT jsonb_agg(a) FROM (
        SELECT jsonb_build_object('type', 'PICO_COSTO', 'plate', v.plate,
               'detail', 'Mantenimiento últimos 30 días S/ ' || round(c30, 2) || ' vs promedio mensual S/ ' || round(c180 / 6, 2)) AS a
        FROM (SELECT cl.vehicle_id,
                     sum(cl.amount) FILTER (WHERE cl.cost_date >= now() - interval '30 days') AS c30,
                     sum(cl.amount) FILTER (WHERE cl.cost_date < now() - interval '30 days' AND cl.cost_date >= now() - interval '210 days') AS c180
              FROM public.vw_vehicle_cost_ledger cl WHERE cl.category = 'MANTENIMIENTO' GROUP BY cl.vehicle_id) s
        JOIN public.vehicles v ON v.id = s.vehicle_id
        WHERE COALESCE(c30, 0) > 500 AND COALESCE(c30, 0) > 2 * COALESCE(c180, 0) / 6 AND (p_plates IS NULL OR v.plate = ANY (p_plates))
        UNION ALL
        -- Tendencia de fallas: ≥2 en 30 días y el doble del ritmo de los 90 días previos
        SELECT jsonb_build_object('type', 'TENDENCIA_FALLAS', 'plate', vehicle_plate,
               'detail', f30 || ' fallas en 30 días vs ' || round(f90 / 3.0, 1) || ' promedio por 30 días')
        FROM (SELECT vehicle_plate,
                     count(*) FILTER (WHERE reported_at >= now() - interval '30 days') AS f30,
                     count(*) FILTER (WHERE reported_at < now() - interval '30 days' AND reported_at >= now() - interval '120 days') AS f90
              FROM public.maintenance_requests WHERE status <> 'DESCARTADA' GROUP BY vehicle_plate) q
        WHERE f30 >= 2 AND f30 >= 2 * (f90 / 3.0) AND (p_plates IS NULL OR vehicle_plate = ANY (p_plates))
        UNION ALL
        SELECT jsonb_build_object('type', 'NEUMATICO_DESGASTE', 'plate', vehicle_plate,
               'detail', 'Neumático ' || codigo_interno || ' en ' || position || ' con cocada ' || cocada_actual || ' mm')
        FROM public.vw_tires WHERE estado = 'INSTALADO' AND tread_status = 'CAMBIAR' AND (p_plates IS NULL OR vehicle_plate = ANY (p_plates))
        UNION ALL
        SELECT jsonb_build_object('type', 'DOCUMENTO', 'plate', subject, 'detail', detail || ' ' || level || COALESCE(' (' || days_remaining || ' días)', ''))
        FROM public.vw_compliance_alerts WHERE alert_type = 'DOCUMENTO_VEHICULO' AND level IN ('VENCIDO', 'POR_VENCER')
          AND (p_plates IS NULL OR subject = ANY (p_plates))
      ) x), '[]'::jsonb),
    'disclaimer', 'La IA es asistiva: estas respuestas se calculan con datos reales y no modifican información. Las acciones pasan por las reglas del backend.'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_cmms_copilot_brief(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cmms_copilot_brief(text[]) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Limpieza del Copiloto simulado
-- ------------------------------------------------------------
DO $$ BEGIN
  IF to_regclass('public.ai_analysis_logs') IS NOT NULL AND EXISTS (SELECT 1 FROM public.ai_analysis_logs) THEN
    RAISE EXCEPTION 'ai_analysis_logs tiene datos: revisar antes de eliminarla';
  END IF;
END $$;
DROP TABLE IF EXISTS public.ai_analysis_logs;

NOTIFY pgrst, 'reload schema';

COMMIT;
