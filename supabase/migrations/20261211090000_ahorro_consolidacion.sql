-- Ahorro por consolidación de servicios (docs/control-presupuestal/ahorro-consolidacion.md, aprobado el 01/11/2026).
-- Indicador de eficiencia: no toca la partida ni el control presupuestal (costo sombra). Se calcula al leer.
-- · Servicio principal de una ruta con dos o más servicios: el de mayor valor independiente (no genera ahorro).
-- · Aprovechado: Ahorro = tarifa del tarifario (distrito + clase de unidad) − costo marginal.
--   Flota propia: combustible de los km extra + horas extra × (unidad + tripulación) + peajes del servicio.
--   Tercero: flete pagado por ese servicio + peajes (no hay combustible ni horas propias).
-- · Costos por hora: consolidation_hour_costs (Administrador o Gerencia, permiso control-presupuestal-autorizar).
BEGIN;
SET LOCAL lock_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.consolidation_hour_costs (
  key           text PRIMARY KEY CHECK (key ~ '^(UNIDAD|ROL):.+'),
  cost_per_hour numeric(12,2) NOT NULL CHECK (cost_per_hour >= 0),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.consolidation_hour_costs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.consolidation_hour_costs;
CREATE POLICY security_active_account ON public.consolidation_hour_costs AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.consolidation_hour_costs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consolidation_can_edit() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_tms_admin() OR public.has_tms_permission('control-presupuestal-autorizar')
$$;
REVOKE ALL ON FUNCTION public.consolidation_can_edit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.consolidation_hour_costs_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (public.is_tms_admin() OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 RETURN jsonb_build_object('success', true, 'can_edit', public.consolidation_can_edit(),
  'classes', COALESCE((SELECT jsonb_agg(c ORDER BY c) FROM (SELECT DISTINCT vehicle_class c FROM public.freight_rates WHERE is_active AND concept = 'FLETE' AND vehicle_class IS NOT NULL) x), '[]'::jsonb),
  'roles', '["CONDUCTOR","AYUDANTE","AUXILIAR","ESTIBADOR","MONTACARGUISTA","OPERADOR_GRUA","OTRO"]'::jsonb,
  'costs', COALESCE((SELECT jsonb_object_agg(key, cost_per_hour) FROM public.consolidation_hour_costs), '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.consolidation_hour_costs_get() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_hour_costs_get() TO authenticated;

-- p_cost NULL borra el costo
CREATE OR REPLACE FUNCTION public.consolidation_hour_cost_set(p_key text, p_cost numeric) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.consolidation_can_edit() THEN
  RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador o Gerencia definen los costos por hora');
 END IF;
 IF p_key IS NULL OR p_key !~ '^(UNIDAD|ROL):.+' THEN RETURN jsonb_build_object('success', false, 'error', 'Costo inválido'); END IF;
 IF p_cost IS NULL THEN DELETE FROM public.consolidation_hour_costs WHERE key = p_key; RETURN jsonb_build_object('success', true); END IF;
 IF p_cost < 0 OR p_cost <> round(p_cost, 2) THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el costo por hora con dos decimales'); END IF;
 INSERT INTO public.consolidation_hour_costs(key, cost_per_hour, updated_by) VALUES (p_key, p_cost, auth.uid())
 ON CONFLICT (key) DO UPDATE SET cost_per_hour = EXCLUDED.cost_per_hour, updated_by = auth.uid(), updated_at = now();
 RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.consolidation_hour_cost_set(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_hour_cost_set(text, numeric) TO authenticated;

-- Ahorro por servicio en rutas compartidas. Período por fecha de la ruta (Lima), o una OT (su familia), o un viaje.
CREATE OR REPLACE FUNCTION public.consolidation_savings(p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_contract uuid DEFAULT NULL, p_dispatch uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_family uuid[]; v_admin boolean := public.is_tms_admin(); v_out jsonb;
 v_kmpg numeric := COALESCE((SELECT NULLIF(to_jsonb(c)->>'default_km_per_gallon', '')::numeric FROM public.caja_settings c LIMIT 1), 10);
 v_price numeric := COALESCE((SELECT NULLIF(to_jsonb(c)->>'fuel_price_per_gallon', '')::numeric FROM public.caja_settings c LIMIT 1), 16);
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (v_admin OR public.budget_can_read()) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal');
 END IF;
 IF p_dispatch IS NULL AND (p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Indique un período válido de hasta 366 días');
 END IF;
 IF p_contract IS NOT NULL THEN
  v_family := public.budget_family(p_contract);
  IF v_family IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'OT no disponible'); END IF;
 END IF;

 WITH d AS MATERIALIZED (
   SELECT x.id, x.dispatch_number, x.vehicle_plate, x.driver_id,
     (COALESCE(x.scheduled_departure, (to_jsonb(x)->>'created_at')::timestamptz) AT TIME ZONE 'America/Lima')::date AS day,
     COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad,
     COALESCE(NULLIF(x.actual_distance_km, 0), NULLIF((to_jsonb(x)->>'estimated_distance_km')::numeric, 0)) AS km_route,
     NULLIF(x.actual_distance_km, 0) IS NULL AS km_estimated,
     GREATEST(EXTRACT(epoch FROM ((to_jsonb(x)->>'returned_at')::timestamptz - (to_jsonb(x)->>'departure_time')::timestamptz)) / 3600, 0) AS hours_route,
     COALESCE((SELECT NULLIF(to_jsonb(v)->>'expected_km_per_gallon', '')::numeric FROM public.vehicles v WHERE v.plate = x.vehicle_plate LIMIT 1), v_kmpg) AS kmpg,
     (SELECT r.vehicle_class FROM public.freight_rates r WHERE r.plate_number = x.vehicle_plate AND r.vehicle_class IS NOT NULL LIMIT 1) AS route_class
   FROM public.dispatches x
   WHERE x.status NOT IN ('PROGRAMADO','CANCELADO')
     AND (p_dispatch IS NULL OR x.id = p_dispatch)
     AND (p_dispatch IS NOT NULL OR (COALESCE(x.scheduled_departure, (to_jsonb(x)->>'created_at')::timestamptz) AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
     AND (v_admin OR public.can_access_site(x.site_id))),
 s AS MATERIALIZED (
   SELECT d.id AS dispatch_id, dr.transport_request_id AS request_id, COALESCE(dr.sequence_order, 0) AS seq, t.request_number, t.contract_id,
     COALESCE(to_jsonb(t)->>'request_type', 'DESPACHO') AS request_type,
     CASE WHEN to_jsonb(t)->>'request_type' = 'RECOJO' THEN to_jsonb(t)->>'pickup_district' ELSE to_jsonb(t)->>'delivery_district' END AS district,
     -- shortcut: peso estimado de la solicitud (sin componentes); usar los componentes si el estimado resulta poco fiable
     NULLIF((to_jsonb(t)->>'estimated_weight')::numeric, 0) AS weight,
     (SELECT (to_jsonb(c)->>'client_id')::uuid FROM public.contracts c WHERE c.id = t.contract_id) AS client_id,
     e.distance_km AS direct_km, e.duration_min AS direct_min, a.extra_km AS added_km, a.dispatch_id IS NOT NULL AS added
   FROM d JOIN public.dispatch_requests dr ON dr.dispatch_id = d.id
   JOIN public.transport_requests t ON t.id = dr.transport_request_id
   LEFT JOIN public.dispatch_route_estimates e ON e.dispatch_id = d.id AND e.request_id = dr.transport_request_id
   LEFT JOIN public.dispatch_service_additions a ON a.dispatch_id = d.id AND a.request_id = dr.transport_request_id
   WHERE COALESCE(to_jsonb(t)->>'attention_mode', '') <> 'RECOJO_CLIENTE'),
 n AS (SELECT dispatch_id, count(*) AS services FROM s GROUP BY 1),
 -- Clase de unidad que pide el peso (la menor con capacidad y tarifa al distrito); sin peso, la de la unidad de la ruta
 c AS (
   SELECT s.*, d.day, (SELECT k.vehicle_class FROM (SELECT r.vehicle_class, max((to_jsonb(r)->>'capacity_ton')::numeric) AS cap
       FROM public.freight_rates r WHERE r.is_active AND r.concept = 'FLETE' AND r.vehicle_class IS NOT NULL GROUP BY 1) k
       WHERE s.weight IS NOT NULL AND COALESCE(k.cap, 0) * 1000 >= s.weight
         AND public.tariff_pick('FLETE', k.vehicle_class, NULL, s.district, s.client_id, s.contract_id, d.day) IS NOT NULL
       ORDER BY k.cap LIMIT 1) AS wclass, d.route_class AS rclass
   FROM s JOIN d ON d.id = s.dispatch_id JOIN n ON n.dispatch_id = s.dispatch_id WHERE n.services >= 2),
 v AS (
   SELECT c.*, COALESCE(c.wclass, c.rclass) AS vclass, tp, CASE WHEN tp IS NULL THEN NULL ELSE round((tp->>'rate')::numeric
       * CASE WHEN tp->>'rate_basis' = 'TONELADA' THEN COALESCE(c.weight, 0) / 1000 ELSE 1 END, 2) END AS standalone
   FROM c CROSS JOIN LATERAL (SELECT public.tariff_pick('FLETE', COALESCE(c.wclass, c.rclass), NULL, c.district, c.client_id, c.contract_id, c.day) AS tp) z),
 p AS (SELECT v.*, row_number() OVER (PARTITION BY v.dispatch_id ORDER BY v.standalone DESC NULLS LAST, v.seq, v.request_id) = 1 AS principal FROM v),
 -- Lo extra de la ruta que se reparte entre los aprovechados programados juntos (los agregados traen su propio extra)
 r AS (
   SELECT p.dispatch_id,
     max(p.direct_km) FILTER (WHERE p.principal) AS principal_km, max(p.direct_min) FILTER (WHERE p.principal) AS principal_min,
     COALESCE(sum(p.added_km) FILTER (WHERE p.added AND NOT p.principal), 0) AS added_km,
     COALESCE(sum(p.direct_km) FILTER (WHERE NOT p.added AND NOT p.principal), 0) AS prog_km,
     count(*) FILTER (WHERE NOT p.added AND NOT p.principal) AS prog_n
   FROM p GROUP BY 1),
 m AS (
   SELECT p.*, d.dispatch_number, d.modalidad, d.km_estimated, d.kmpg, d.route_class, d.driver_id,
     CASE WHEN d.km_route > 0 AND d.hours_route > 0 THEN d.km_route / d.hours_route END AS speed,
     d.km_route, d.hours_route, r.principal_km, r.principal_min, r.added_km AS route_added_km,
     CASE WHEN r.prog_km > 0 THEN p.direct_km / r.prog_km WHEN r.prog_n > 0 THEN 1.0 / r.prog_n END AS share
   FROM p JOIN d ON d.id = p.dispatch_id JOIN r ON r.dispatch_id = p.dispatch_id),
 k AS (
   SELECT m.*,
     CASE WHEN m.principal THEN 0 WHEN m.added THEN COALESCE(m.added_km, 0)
          WHEN m.principal_km IS NULL OR m.km_route IS NULL THEN NULL
          ELSE GREATEST(m.km_route - m.principal_km - m.route_added_km, 0) * COALESCE(m.share, 0) END AS extra_km,
     CASE WHEN m.principal THEN 0 WHEN m.added THEN CASE WHEN m.speed > 0 THEN COALESCE(m.added_km, 0) / m.speed ELSE 0 END
          WHEN m.principal_min IS NULL OR m.hours_route = 0 THEN 0
          ELSE GREATEST(m.hours_route - m.principal_min / 60.0 - CASE WHEN m.speed > 0 THEN m.route_added_km / m.speed ELSE 0 END, 0) * COALESCE(m.share, 0) END AS extra_hours,
     (SELECT h.cost_per_hour FROM public.consolidation_hour_costs h WHERE h.key = 'UNIDAD:' || m.route_class) AS unit_cost,
     CASE WHEN m.driver_id IS NULL THEN 0 ELSE (SELECT h.cost_per_hour FROM public.consolidation_hour_costs h WHERE h.key = 'ROL:CONDUCTOR') END
       -- Un rol sin costo deja la tripulación sin valorizar (se marca), en lugar de sumar de menos
       + (SELECT CASE WHEN bool_or(h.cost_per_hour IS NULL) THEN NULL ELSE COALESCE(sum(h.cost_per_hour), 0) END
          FROM public.dispatch_crew cr LEFT JOIN public.consolidation_hour_costs h ON h.key = 'ROL:' || cr.crew_role
          WHERE cr.dispatch_id = m.dispatch_id AND cr.removed_at IS NULL) AS crew_cost,
     COALESCE((SELECT sum(COALESCE(e.approved_amount, e.amount)) FROM public.dispatch_expenses e WHERE e.dispatch_id = m.dispatch_id
               AND e.transport_request_id = m.request_id AND e.status = 'APROBADO' AND upper(e.expense_type) = 'PEAJE'), 0) AS tolls,
     (SELECT COALESCE(st.final_applied_pen, f.amount_pen) FROM public.dispatch_request_freight f
       LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
       WHERE f.dispatch_id = m.dispatch_id AND f.request_id = m.request_id AND f.status <> 'LIBERADO') AS freight_paid
   FROM m),
 f AS (
   SELECT k.*,
     round(CASE WHEN k.modalidad = 'TERCERO' THEN 0 ELSE COALESCE(k.extra_km, 0) / NULLIF(k.kmpg, 0) * v_price END, 2) AS fuel_cost,
     -- Con algún costo por hora sin cargar, las horas no suman (se marca): nunca un costo parcial
     round(CASE WHEN k.modalidad = 'TERCERO' OR k.unit_cost IS NULL OR k.crew_cost IS NULL THEN 0 ELSE COALESCE(k.extra_hours, 0) * (k.unit_cost + k.crew_cost) END, 2) AS hours_cost,
     k.modalidad <> 'TERCERO' AND k.extra_hours > 0 AND (k.unit_cost IS NULL OR k.crew_cost IS NULL) AS hours_cost_missing
   FROM k),
 res AS (
   SELECT f.*, CASE WHEN f.principal THEN 'PRINCIPAL' WHEN f.standalone IS NULL THEN 'SIN_TARIFA'
       WHEN f.modalidad <> 'TERCERO' AND f.extra_km IS NULL THEN 'SIN_KM' ELSE 'VALORIZADO' END AS state,
     round(CASE WHEN f.modalidad = 'TERCERO' THEN COALESCE(f.freight_paid, 0) ELSE f.fuel_cost + f.hours_cost END + f.tolls, 2) AS marginal,
     oc.code AS contract_code, rc.id AS root_id, rc.code AS root_code, cl.business_name AS client
   FROM f LEFT JOIN public.contracts oc ON oc.id = f.contract_id
   LEFT JOIN public.contracts rc ON rc.id = public.contract_root_id(f.contract_id)
   LEFT JOIN public.clients cl ON cl.id = f.client_id
   WHERE v_family IS NULL OR f.contract_id = ANY (v_family))
 SELECT jsonb_build_object('success', true, 'as_of', now(), 'from', p_from, 'to', p_to,
   'services_total', (SELECT COALESCE(sum(n.services), 0) FROM n WHERE v_family IS NULL
                      OR EXISTS (SELECT 1 FROM s WHERE s.dispatch_id = n.dispatch_id AND s.contract_id = ANY (v_family))),
   'leveraged', (SELECT count(*) FROM res WHERE NOT principal),
   'saving_total', (SELECT COALESCE(sum(standalone - marginal) FILTER (WHERE state = 'VALORIZADO'), 0) FROM res),
   'hours_cost_missing', (SELECT bool_or(hours_cost_missing) FROM res),
   'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
       'dispatch_id', dispatch_id, 'dispatch_number', dispatch_number, 'date', day, 'modalidad', modalidad,
       'request_id', request_id, 'request_number', request_number, 'request_type', request_type,
       'contract_id', contract_id, 'contract_code', contract_code, 'root_id', root_id, 'root_code', root_code, 'client', client,
       'district', district, 'weight_kg', weight, 'vehicle_class', vclass, 'class_by_weight', wclass IS NOT NULL,
       'principal', principal, 'added', added, 'state', state, 'standalone_pen', standalone,
       'direct_km', direct_km, 'extra_km', round(extra_km, 1), 'extra_hours', round(extra_hours, 2), 'km_estimated', km_estimated,
       'fuel_pen', fuel_cost, 'hours_pen', hours_cost, 'hours_cost_missing', hours_cost_missing, 'tolls_pen', tolls,
       'freight_paid_pen', CASE WHEN modalidad = 'TERCERO' THEN freight_paid END, 'marginal_pen', CASE WHEN NOT principal THEN marginal END,
       'saving_pen', CASE WHEN state = 'VALORIZADO' THEN round(standalone - marginal, 2) END)
     ORDER BY day DESC, dispatch_number, principal DESC, seq) FROM res), '[]'::jsonb))
 INTO v_out;
 RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.consolidation_savings(date, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_savings(date, date, uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
