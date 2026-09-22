-- Tower reporting is the sole global operational exception for contract admins.
-- It deliberately omits budgets, costs, requesters and personal event authors.
CREATE OR REPLACE FUNCTION public.get_tower_responsibles()
RETURNS TABLE(user_id uuid, full_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_tms_admin() OR
    public.has_tms_read_permission('torre-control') OR
    public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo')) THEN
    RAISE EXCEPTION 'Sin acceso a Torre de Control';
  END IF;
  RETURN QUERY SELECT DISTINCT p.id,
    trim(concat_ws(' ',p.first_name,p.last_name))::text
  FROM public.contract_user_assignments a JOIN public.profiles p ON p.id=a.user_id
  JOIN public.contracts c ON c.id=a.contract_id
  WHERE a.active AND a.role='ADMIN_CONTRATO' AND public.can_access_site(c.site_id)
  ORDER BY 2,1;
END $$;

CREATE OR REPLACE FUNCTION public.get_tower_dispatches(
  p_date date DEFAULT NULL,p_responsible uuid DEFAULT NULL,p_status text DEFAULT 'ACTIVOS'
) RETURNS TABLE (
  id uuid, dispatch_number text, driver_name text, vehicle_plate text,
  status text, estimated_distance_km numeric, scheduled_departure timestamptz,
  dispatch_requests jsonb, dispatch_events jsonb, contract_codes text[],
  responsible_names text[]
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR p_status NOT IN
    ('ACTIVOS','HISTORIAL','TODOS','PROGRAMADO') OR NOT (public.is_tms_admin() OR
    public.has_tms_read_permission('torre-control') OR
    public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo')) THEN
    RAISE EXCEPTION 'Sin acceso a Torre de Control';
  END IF;
  RETURN QUERY
  SELECT d.id,d.dispatch_number::text,d.driver_name::text,d.vehicle_plate::text,
    d.status::text,d.estimated_distance_km,d.scheduled_departure,
    coalesce(requests.items,'[]'::jsonb),coalesce(events.items,'[]'::jsonb),
    coalesce(portfolio.codes,ARRAY[]::text[]),
    coalesce(portfolio.responsibles,ARRAY[]::text[])
  FROM public.dispatches d
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('status',dr.status,
      'transport_request_id',r.id,'transport_requests',jsonb_build_object(
        'request_number',r.request_number,'pickup_address',r.pickup_address,
        'delivery_address',r.delivery_address)) ORDER BY dr.sequence_order) AS items
    FROM public.dispatch_requests dr JOIN public.transport_requests r ON r.id=dr.transport_request_id
    WHERE dr.dispatch_id=d.id
  ) requests ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('event_type',e.event_type,
      'description',e.description,'created_at',e.created_at,
      'created_by','Operación') ORDER BY e.created_at) AS items
    FROM public.dispatch_events e WHERE e.dispatch_id=d.id
  ) events ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT c.code::text) FILTER (WHERE c.id IS NOT NULL) AS codes,
      array_agg(DISTINCT trim(concat_ws(' ',p.first_name,p.last_name)))
        FILTER (WHERE p.id IS NOT NULL) AS responsibles,
      array_agg(DISTINCT a.user_id) FILTER (WHERE a.user_id IS NOT NULL) AS responsible_ids
    FROM (SELECT d.contract_id AS contract_id UNION
      SELECT r.contract_id FROM public.dispatch_requests dr
      JOIN public.transport_requests r ON r.id=dr.transport_request_id
      WHERE dr.dispatch_id=d.id) links
    LEFT JOIN public.contracts c ON c.id=public.contract_root_id(links.contract_id)
    LEFT JOIN public.contract_user_assignments a ON a.contract_id=c.id
      AND a.active AND a.role='ADMIN_CONTRATO'
    LEFT JOIN public.profiles p ON p.id=a.user_id
  ) portfolio ON true
  WHERE public.can_access_site(d.site_id)
    AND (p_date IS NULL OR d.scheduled_departure::date=p_date)
    AND (p_status='TODOS' OR
      (p_status='ACTIVOS' AND d.status NOT IN ('LIQUIDADO','ENTREGADO')) OR
      (p_status='HISTORIAL' AND d.status IN ('LIQUIDADO','ENTREGADO')) OR
      d.status=p_status)
    AND (p_responsible IS NULL OR p_responsible=ANY(portfolio.responsible_ids))
  ORDER BY d.scheduled_departure DESC LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION public.get_tower_responsibles(),
  public.get_tower_dispatches(date,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_tower_responsibles(),
  public.get_tower_dispatches(date,uuid,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
