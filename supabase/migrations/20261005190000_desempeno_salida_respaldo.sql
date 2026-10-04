-- ============================================================
-- Desempeño por rol: salida real de respaldo
-- ============================================================
-- En producción el historial de estados del despacho recién empieza (dispatch_events no tenía cambios de estado
-- recuperables), así que los viajes anteriores no tenían salida real. El checklist de salida ya guarda
-- dispatches.departure_time (f6_inspecciones): se usa cuando no hay registro EN CURSO en kpi_dispatch_log.
-- Se recrea la vista porque se agrega una columna (salida_checklist).
BEGIN;

DROP VIEW IF EXISTS public.kpi_despachos_v;
CREATE OR REPLACE VIEW public.kpi_despachos_v AS
SELECT z.*,
  COALESCE((SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo IN ('EN_CURSO', 'EN CURSO', 'EN RUTA', 'EN_RUTA')), z.salida_checklist) AS salida_at,
  COALESCE((SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo = 'ENTREGADO'), z.llegada) AS entrega_at,
  (SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo IN ('LIQUIDADO', 'CERRADO')) AS cierre_at,
  (SELECT min(NULLIF(to_jsonb(t) ->> 'required_date', '')::date) FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id WHERE r.dispatch_id = z.id) AS requerida,
  (SELECT min(NULLIF(to_jsonb(t) ->> 'approved_at', '')::timestamptz) FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id WHERE r.dispatch_id = z.id) AS aprobada_at
FROM (
  SELECT d.id, j ->> 'dispatch_number' AS numero, upper(COALESCE(j ->> 'status', '')) AS estado,
         public.kpi_uuid(j ->> 'driver_id') AS driver_id, j ->> 'vehicle_plate' AS placa,
         public.kpi_uuid(j ->> 'created_by') AS creado_por, NULLIF(j ->> 'created_at', '')::timestamptz AS creado_at,
         COALESCE(NULLIF(j ->> 'scheduled_departure', '')::timestamptz, NULLIF(j ->> 'scheduled_date', '')::timestamptz) AS programado,
         COALESCE((j ->> 'docs_required')::boolean, false) AS docs_required,
         NULLIF(j ->> 'docs_ready_at', '')::timestamptz AS docs_ready_at, public.kpi_uuid(j ->> 'docs_ready_by') AS docs_ready_by,
         NULLIF(j ->> 'docs_reissue_at', '')::timestamptz AS docs_reissue_at,
         NULLIF(j ->> 'start_odometer', '')::numeric AS odo_ini, NULLIF(j ->> 'end_odometer', '')::numeric AS odo_fin,
         NULLIF(NULLIF(j ->> 'actual_distance_km', '')::numeric, 0) AS km_gps,
         NULLIF(j ->> 'arrival_time', '')::timestamptz AS llegada,
         NULLIF(j ->> 'departure_time', '')::timestamptz AS salida_checklist
  FROM (SELECT d0.id, to_jsonb(d0) AS j FROM public.dispatches d0) d
) z;
REVOKE ALL ON public.kpi_despachos_v FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
