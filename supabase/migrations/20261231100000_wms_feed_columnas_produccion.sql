-- C221 falló en producción: clients no tiene ruc (producción difiere del repo). Columnas opcionales de clientes y OT
-- se leen con to_jsonb; misma firma, permisos y comportamiento.
CREATE OR REPLACE FUNCTION public.wms_feed_solicitudes(p_key text, p_known_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
      'client', (SELECT jsonb_build_object('id', cl.id, 'business_name', to_jsonb(cl)->>'business_name', 'ruc', to_jsonb(cl)->>'ruc',
                   'commercial_name', to_jsonb(cl)->>'commercial_name')
                 FROM public.clients cl WHERE cl.id = coalesce((j->>'client_id')::uuid, (to_jsonb(c)->>'client_id')::uuid)),
      'contract', jsonb_build_object('id', c.id, 'code', c.code, 'type', to_jsonb(c)->>'type', 'client_id', to_jsonb(c)->>'client_id'),
      'components', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', rc.id, 'requested_weight_kg', rc.requested_weight_kg,
                 'requested_volume_m3', rc.requested_volume_m3,
                 'contract', jsonb_build_object('id', cc.id, 'code', cc.code, 'type', to_jsonb(cc)->>'type', 'client_id', to_jsonb(cc)->>'client_id')))
        FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id = rc.component_contract_id
        WHERE rc.request_id = r.id), '[]'::jsonb)
    ) ORDER BY r.created_at)
    FROM public.transport_requests r
    CROSS JOIN LATERAL to_jsonb(r) j
    JOIN public.contracts c ON c.id = r.contract_id
    WHERE r.id = ANY(coalesce(p_known_ids, '{}'))
       OR (upper(coalesce(r.request_type, 'DESPACHO')) = 'DESPACHO'
           AND upper(r.status) IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE DE APROBACION', 'APROBADA',
                                   'APROBADO', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA'))
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) TO anon, authenticated;
