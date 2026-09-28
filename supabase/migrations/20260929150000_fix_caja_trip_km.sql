-- En producción dispatches.actual_distance_km es NOT NULL DEFAULT 0: mientras el viaje no tenga
-- recorrido GPS la vista tomaba 0 km y nunca usaba el km estimado (sin costo por km ni rendimiento).
-- Un valor 0 ahora se trata como "sin dato" y se pasa al siguiente origen.
BEGIN;
CREATE OR REPLACE VIEW public.vw_caja_trips WITH (security_barrier = true) AS
SELECT d.id, d.dispatch_number, upper(d.vehicle_plate) AS vehicle_plate, d.status, d.driver_id, d.site_id, d.created_at,
       COALESCE(NULLIF(to_jsonb(d)->>'departure_time', ''), NULLIF(to_jsonb(d)->>'scheduled_departure', ''), to_jsonb(d)->>'scheduled_date')::timestamptz AS departure_at,
       COALESCE(NULLIF(to_jsonb(d)->>'returned_at', ''), NULLIF(to_jsonb(d)->>'arrival_time', ''))::timestamptz AS returned_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', tr.id, 'label', COALESCE(tr.requester_name, 'OT ' || left(tr.id::text, 8))))
                 FROM public.dispatch_requests dr JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
                 WHERE dr.dispatch_id = d.id), '[]'::jsonb) AS requests,
       NULLIF(to_jsonb(d)->>'freight_cost', '')::numeric AS freight,
       COALESCE(NULLIF(NULLIF(to_jsonb(d)->>'actual_distance_km', '')::numeric, 0),
                NULLIF(NULLIF(to_jsonb(d)->>'estimated_km', '')::numeric, 0),
                NULLIF(NULLIF(to_jsonb(d)->>'estimated_distance_km', '')::numeric, 0)) AS km,
       NULLIF(to_jsonb(d)->>'contract_id', '')::uuid AS contract_id
FROM public.dispatches d
WHERE public.has_caja_read_access() AND public.can_access_site(d.site_id);
REVOKE ALL ON public.vw_caja_trips FROM anon, authenticated;
GRANT SELECT ON public.vw_caja_trips TO authenticated;
COMMIT;
