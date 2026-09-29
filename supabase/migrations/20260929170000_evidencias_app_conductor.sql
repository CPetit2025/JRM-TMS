-- ============================================================
-- Evidencias del app del conductor visibles en la web
-- ============================================================
-- Las fotos del app (entregas, checklist, guías de cierre, odómetro, fallas, gastos, anticipos) se guardan en
-- el bucket privado driver_evidence. Hasta ahora solo Caja y Despacho (escritura) podían leerlas y la web no
-- las mostraba. Aquí: 1) lectura para quien opera o supervisa (Despacho, Monitoreo, Caja, Mantenimiento),
-- 2) el bucket acepta PDF y audio (las fallas graban audio y las guías pueden ser PDF),
-- 3) funciones que reúnen todas las evidencias de un despacho o de una unidad.
-- Las columnas de tablas antiguas se leen con to_jsonb(...) (el esquema de producción difiere del repo).
BEGIN;

CREATE OR REPLACE FUNCTION public.can_view_driver_evidence()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo')
      OR public.has_tms_read_permission('torre-control') OR public.has_caja_read_access()
      OR public.has_cmms_read_permission('fallas') OR public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot');
$$;
REVOKE ALL ON FUNCTION public.can_view_driver_evidence() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_driver_evidence() TO authenticated, service_role;

-- Tipos admitidos: fotos, PDF (guías, comprobantes) y audio (fallas)
UPDATE storage.buckets SET allowed_mime_types = (
  SELECT array_agg(DISTINCT t) FROM unnest(COALESCE(allowed_mime_types, '{}'::text[]) || ARRAY[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf',
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a']) t)
WHERE id = 'driver_evidence' AND allowed_mime_types IS NOT NULL;

DROP POLICY IF EXISTS driver_evidence_ops_read ON storage.objects;
CREATE POLICY driver_evidence_ops_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'driver_evidence' AND public.can_view_driver_evidence());

-- Evidencias de un despacho: entregas por parada, checklist, guías de cierre, odómetro, fallas, gastos y anticipos
CREATE OR REPLACE FUNCTION public.get_dispatch_evidence(p_dispatch_id uuid)
RETURNS TABLE (kind text, label text, path text, taken_at timestamptz, ref_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  SELECT x.id, x.site_id, to_jsonb(x) AS j INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
  IF NOT FOUND OR NOT public.can_view_driver_evidence() OR NOT public.can_access_site(d.site_id) THEN RETURN; END IF;

  RETURN QUERY
  SELECT 'ENTREGA'::text, COALESCE('Entrega · ' || (tr.j->>'requester_name'), 'Parada ' || COALESCE(s.j->>'stop_type', '')),
         s.j->>'photo_url', NULLIF(COALESCE(s.j->>'arrival_time', s.j->>'created_at'), '')::timestamptz, s.id
  FROM (SELECT r.id, to_jsonb(r) AS j FROM public.route_stops_log r WHERE r.dispatch_id = p_dispatch_id) s
  LEFT JOIN LATERAL (SELECT to_jsonb(t) AS j FROM public.transport_requests t WHERE t.id::text = s.j->>'transport_request_id') tr ON true
  WHERE NULLIF(s.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'CHECKLIST', 'Checklist de la unidad', c.j->>'photo_url', NULLIF(c.j->>'created_at', '')::timestamptz, c.id
  FROM (SELECT k.id, to_jsonb(k) AS j FROM public.driver_checklists k WHERE k.dispatch_id = p_dispatch_id) c
  WHERE NULLIF(c.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'GUIA', 'Guía / documento de cierre', COALESCE(g.value->>'path', g.value #>> '{}'), NULL::timestamptz, NULL::uuid
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.j->'liquidation_data'->'guias') = 'array' THEN d.j->'liquidation_data'->'guias' ELSE '[]'::jsonb END) g
  UNION ALL
  SELECT 'ODOMETRO', 'Odómetro · ' || COALESCE(o.j->>'source_event', ''), o.j->>'photo_url', NULLIF(o.j->>'created_at', '')::timestamptz, o.id
  FROM (SELECT v.id, to_jsonb(v) AS j FROM public.vehicle_odometer_logs v WHERE v.dispatch_id = p_dispatch_id) o
  WHERE NULLIF(o.j->>'photo_url', '') IS NOT NULL
  UNION ALL
  SELECT 'FALLA', 'Falla · ' || left(COALESCE(m.j->>'description', ''), 60), p.value #>> '{}', NULLIF(m.j->>'reported_at', '')::timestamptz, m.id
  FROM (SELECT r.id, to_jsonb(r) AS j FROM public.maintenance_requests r WHERE r.dispatch_id = p_dispatch_id) m
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(m.j->'photo_url', m.j->'audio_url')
    || CASE WHEN jsonb_typeof(m.j->'evidence') = 'array' THEN m.j->'evidence' ELSE '[]'::jsonb END) p
  WHERE NULLIF(p.value #>> '{}', '') IS NOT NULL
  UNION ALL
  SELECT 'GASTO', 'Gasto · ' || e.expense_type || ' S/ ' || e.amount, e.receipt_url, e.created_at, e.id
  FROM public.dispatch_expenses e WHERE e.dispatch_id = p_dispatch_id AND NULLIF(e.receipt_url, '') IS NOT NULL
  UNION ALL
  SELECT 'ANTICIPO', 'Anticipo ' || a.code, a.evidence_url, a.requested_at, a.id
  FROM public.trip_advances a WHERE (a.dispatch_id = p_dispatch_id OR a.context_dispatch_id = p_dispatch_id) AND NULLIF(a.evidence_url, '') IS NOT NULL;
END $$;

-- Evidencias recientes de una unidad (fallas, checklist, odómetro, gastos y anticipos de la placa)
CREATE OR REPLACE FUNCTION public.get_vehicle_evidence(p_plate text, p_limit int DEFAULT 60)
RETURNS TABLE (kind text, label text, path text, taken_at timestamptz, ref_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_plate text := upper(trim(p_plate));
  v_site  uuid;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE plate = v_plate;
  IF NOT FOUND OR NOT public.can_view_driver_evidence() OR (v_site IS NOT NULL AND NOT public.can_access_site(v_site)) THEN RETURN; END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT 'FALLA'::text, 'Falla · ' || left(COALESCE(m.j->>'description', ''), 60), p.value #>> '{}',
           NULLIF(m.j->>'reported_at', '')::timestamptz AS at, m.id
    FROM (SELECT r.id, to_jsonb(r) AS j FROM public.maintenance_requests r WHERE r.vehicle_plate = v_plate) m
    CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(m.j->'photo_url', m.j->'audio_url')
      || CASE WHEN jsonb_typeof(m.j->'evidence') = 'array' THEN m.j->'evidence' ELSE '[]'::jsonb END) p
    WHERE NULLIF(p.value #>> '{}', '') IS NOT NULL
    UNION ALL
    SELECT 'CHECKLIST', 'Checklist de la unidad', c.j->>'photo_url', NULLIF(c.j->>'created_at', '')::timestamptz, c.id
    FROM (SELECT k.id, to_jsonb(k) AS j FROM public.driver_checklists k WHERE upper(k.vehicle_plate) = v_plate) c
    WHERE NULLIF(c.j->>'photo_url', '') IS NOT NULL
    UNION ALL
    SELECT 'ODOMETRO', 'Odómetro · ' || COALESCE(o.j->>'source_event', ''), o.j->>'photo_url', NULLIF(o.j->>'created_at', '')::timestamptz, o.id
    FROM (SELECT v.id, to_jsonb(v) AS j FROM public.vehicle_odometer_logs v WHERE v.vehicle_plate = v_plate) o
    WHERE NULLIF(o.j->>'photo_url', '') IS NOT NULL
    UNION ALL
    SELECT 'GASTO', 'Gasto · ' || e.expense_type || ' S/ ' || e.amount, e.receipt_url, e.created_at, e.id
    FROM public.dispatch_expenses e WHERE e.vehicle_plate = v_plate AND NULLIF(e.receipt_url, '') IS NOT NULL
    UNION ALL
    SELECT 'ANTICIPO', 'Anticipo ' || a.code, a.evidence_url, a.requested_at, a.id
    FROM public.trip_advances a WHERE a.vehicle_plate = v_plate AND NULLIF(a.evidence_url, '') IS NOT NULL
  ) x ORDER BY x.at DESC NULLS LAST LIMIT GREATEST(COALESCE(p_limit, 60), 1);
END $$;

REVOKE ALL ON FUNCTION public.get_dispatch_evidence(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_vehicle_evidence(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_evidence(uuid), public.get_vehicle_evidence(text, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
