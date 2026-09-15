-- 00048_add_tracking_links.sql
-- Añadir campos de seguimiento a la tabla de despachos

ALTER TABLE public.dispatches 
ADD COLUMN IF NOT EXISTS tracking_token UUID UNIQUE,
ADD COLUMN IF NOT EXISTS tracking_pin TEXT,
ADD COLUMN IF NOT EXISTS tracking_expires_at TIMESTAMPTZ;

-- RPC para generar el token de seguimiento seguro
CREATE OR REPLACE FUNCTION generate_tracking_link(p_dispatch_id UUID)
RETURNS TABLE (
  token UUID,
  pin TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_token UUID;
  v_pin TEXT;
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- Generar valores aleatorios
  v_token := gen_random_uuid();
  -- PIN de 4 dígitos aleatorio
  v_pin := lpad(floor(random() * 10000)::text, 4, '0');
  v_expires_at := NOW() + INTERVAL '24 hours';

  -- Actualizar el despacho
  UPDATE public.dispatches
  SET 
    tracking_token = v_token,
    tracking_pin = v_pin,
    tracking_expires_at = v_expires_at
  WHERE id = p_dispatch_id;

  RETURN QUERY SELECT v_token, v_pin, v_expires_at;
END;
$$;

-- RPC para obtener la información de seguimiento público
-- Retorna JSON para manejar múltiples relaciones sin crear tipos compuestos complejos
CREATE OR REPLACE FUNCTION get_public_tracking_info(p_token UUID, p_pin TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_dispatch RECORD;
  v_result JSONB;
BEGIN
  -- Buscar el despacho que coincide y no ha expirado
  SELECT d.id, d.dispatch_number, d.driver_name, d.vehicle_plate, d.status, d.scheduled_departure, d.estimated_distance_km
  INTO v_dispatch
  FROM public.dispatches d
  WHERE d.tracking_token = p_token 
    AND d.tracking_pin = p_pin
    AND d.tracking_expires_at > NOW();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tracking link is invalid, expired, or incorrect PIN.';
  END IF;

  -- Construir el JSON de respuesta con OTs adjuntas
  SELECT jsonb_build_object(
    'id', v_dispatch.id,
    'dispatch_number', v_dispatch.dispatch_number,
    'driver_name', v_dispatch.driver_name,
    'vehicle_plate', v_dispatch.vehicle_plate,
    'status', v_dispatch.status,
    'scheduled_departure', v_dispatch.scheduled_departure,
    'estimated_distance_km', v_dispatch.estimated_distance_km,
    'requests', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', tr.id,
            'request_number', tr.request_number,
            'pickup_address', tr.pickup_address,
            'delivery_address', tr.delivery_address,
            'status', tr.status
          )
        )
        FROM public.dispatch_requests dr
        JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
        WHERE dr.dispatch_id = v_dispatch.id
      ), 
      '[]'::jsonb
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
