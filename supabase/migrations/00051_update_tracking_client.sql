-- Update RPC to include client_name in tracking requests
CREATE OR REPLACE FUNCTION get_public_daily_tracking_info(p_token UUID, p_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_planning_date DATE;
  v_result JSONB;
BEGIN
  -- Validar el token y pin
  SELECT planning_date INTO v_planning_date
  FROM public.daily_tracking_links
  WHERE tracking_token = p_token 
    AND tracking_pin = p_pin
    AND expires_at > NOW();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tracking link is invalid, expired, or incorrect PIN.';
  END IF;

  -- Construir el JSON de respuesta con todos los despachos de ese día
  SELECT jsonb_build_object(
    'planning_date', v_planning_date,
    'dispatches', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', d.id,
            'dispatch_number', d.dispatch_number,
            'driver_name', d.driver_name,
            'vehicle_plate', d.vehicle_plate,
            'status', d.status,
            'scheduled_departure', d.scheduled_departure,
            'estimated_distance_km', d.estimated_distance_km,
            'requests', COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', tr.id,
                    'request_number', tr.request_number,
                    'pickup_address', tr.pickup_address,
                    'delivery_address', tr.delivery_address,
                    'status', tr.status,
                    'client_name', c.business_name
                  )
                )
                FROM public.dispatch_requests dr
                JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
                LEFT JOIN public.contracts ct ON tr.contract_id = ct.id
                LEFT JOIN public.clients c ON ct.client_id = c.id
                WHERE dr.dispatch_id = d.id
              ), 
              '[]'::jsonb
            )
          )
        )
        FROM public.dispatches d
        WHERE DATE(d.scheduled_departure) = v_planning_date
      ),
      '[]'::jsonb
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
