-- C221 FAIL «column cl.commercial_name does not exist»: clients no tiene commercial_name en producción.
-- Se lee con to_jsonb(cl) (queda NULL si no existe). Revisadas las demás columnas que usa la función: existen.
CREATE OR REPLACE FUNCTION public.wms_feed_solicitudes(p_key text, p_known_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.integration_key_ok('wms', p_key) THEN
    RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'request_number', r.request_number,
      'request_type', upper(coalesce(r.request_type, 'DESPACHO')),
      'attention_mode', j->>'attention_mode', 'status', r.status,
      'required_date', r.required_date, 'required_at', j->>'required_at', 'created_at', r.created_at,
      'requester_name', r.requester_name, 'pickup_address', r.pickup_address, 'delivery_address', r.delivery_address,
      'reference_number', j->>'reference_number', 'purchase_order', j->>'purchase_order',
      'site_code', (SELECT s.code FROM public.sites s WHERE s.id = r.site_id),
      'client', (SELECT jsonb_build_object('id', cl.id, 'business_name', cl.business_name, 'ruc', (to_jsonb(cl)->>'tax_id'),
                   'commercial_name', (to_jsonb(cl)->>'commercial_name'))
                 FROM public.clients cl WHERE cl.id = coalesce((j->>'client_id')::uuid, c.client_id)),
      'contract', jsonb_build_object('id', c.id, 'code', c.code, 'type', c.type::text, 'client_id', c.client_id),
      'components', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', rc.id, 'requested_weight_kg', rc.requested_weight_kg,
                 'requested_volume_m3', rc.requested_volume_m3,
                 'contract', jsonb_build_object('id', cc.id, 'code', cc.code, 'type', cc.type::text, 'client_id', cc.client_id)))
        FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id = rc.component_contract_id
        WHERE rc.request_id = r.id), '[]'::jsonb),
      'dispatch', (SELECT jsonb_build_object('id', d.id, 'number', d.dispatch_number, 'vehicle_plate', d.vehicle_plate,
                     'driver_name', d.driver_name, 'status', d.status, 'scheduled_departure', d.scheduled_departure)
                   FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
                   WHERE dr.transport_request_id = r.id AND d.status <> 'CANCELADO'
                   ORDER BY dr.created_at DESC LIMIT 1),
      -- Asignada antes del corte: el WMS cierra su tarea pendiente («Solicitud asignada antes del flujo con WMS»).
      'legacy_flow', EXISTS (SELECT 1 FROM public.request_wms_release_overrides o
                             WHERE o.transport_request_id = r.id AND o.created_by IS NULL)
    ) ORDER BY r.created_at)
    FROM public.transport_requests r
    CROSS JOIN LATERAL to_jsonb(r) j
    JOIN public.contracts c ON c.id = r.contract_id
    WHERE r.id = ANY(coalesce(p_known_ids, '{}'))
       OR (upper(coalesce(r.request_type, 'DESPACHO')) = 'DESPACHO'
           AND upper(r.status) IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE DE APROBACION', 'APROBADA',
                                   'APROBADO', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA'))
  ), '[]'::jsonb);
END $function$;
