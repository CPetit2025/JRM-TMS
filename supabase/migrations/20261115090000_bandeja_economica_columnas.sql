-- Bandeja del cierre económico: agrega por ruta el cliente, la unidad (propia o tercero), los servicios (tipo de solicitud y
-- atención), las órdenes de referencia (OC/OS/RQ) y desde cuándo está lista para el cierre (para los días pendientes).
-- Misma función que 20261111110000_cierre_economico_bandeja, reescrita completa con los campos nuevos.
BEGIN;

CREATE OR REPLACE FUNCTION public.economic_closure_queue(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.economic_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al cierre económico'); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN RETURN jsonb_build_object('success', false, 'error', 'Período inválido (máximo 366 días)'); END IF;
 RETURN jsonb_build_object('success', true,
  'can_validate', public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico'),
  'can_approve', public.has_tms_permission('cierre-economico'),
  'settings', public.economic_settings_get(),
  'routes', COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id', x.id, 'dispatch_number', x.dispatch_number, 'status', x.status,
     'departure', x.scheduled_departure, 'plate', x.vehicle_plate,
     'modalidad', COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END),
     'carrier', (SELECT to_jsonb(c)->>'business_name' FROM public.carriers c WHERE c.id = NULLIF(to_jsonb(x)->>'carrier_id', '')::uuid),
     'ready_at', COALESCE(to_jsonb(x)->>'operational_closed_at', to_jsonb(x)->>'returned_at', x.scheduled_departure::text),
     'contracts', (SELECT string_agg(DISTINCT c.code, ', ') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
        JOIN public.contracts c ON c.id = t.contract_id WHERE dr.dispatch_id = x.id),
     'requests', (SELECT string_agg(t.request_number::text, ', ' ORDER BY t.request_number) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = x.id),
     'references', (SELECT string_agg(DISTINCT (to_jsonb(t)->>'reference_type') || ' ' || (to_jsonb(t)->>'reference_number'), ', ')
        FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
        WHERE dr.dispatch_id = x.id AND NULLIF(to_jsonb(t)->>'reference_number', '') IS NOT NULL),
     'clients', (SELECT string_agg(DISTINCT cl.business_name, ', ') FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id
        JOIN public.clients cl ON cl.id = NULLIF(to_jsonb(t)->>'client_id', '')::uuid WHERE dr.dispatch_id = x.id),
     'services', (SELECT jsonb_agg(jsonb_build_object('request_type', t.request_type, 'attention_mode', t.attention_mode) ORDER BY t.request_number)
        FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = x.id),
     'state', public.economic_route_state(x.id), 'items', public.economic_route_items(x.id),
     'doc_status', public.economic_documentary_status(x.id), 'last', public.economic_last_activity(x.id))
     ORDER BY x.scheduled_departure DESC, x.id)
   FROM public.dispatches x
   WHERE x.status IN ('LIQUIDADO','CERRADO','RETORNO_COMPLETADO','ENTREGADO','CIERRE_OPERATIVO')
     AND (x.site_id IS NULL OR public.can_access_site(x.site_id))
     AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.economic_closure_queue(date,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_closure_queue(date,date) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
