-- Tabla de enlaces diarios
CREATE TABLE IF NOT EXISTS public.daily_tracking_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    planning_date DATE NOT NULL UNIQUE,
    tracking_token UUID NOT NULL UNIQUE,
    tracking_pin TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS en la nueva tabla (aunque se accederá vía Security Definer)
ALTER TABLE public.daily_tracking_links ENABLE ROW LEVEL SECURITY;

-- RPC para generar el token de seguimiento seguro por día
CREATE OR REPLACE FUNCTION generate_daily_tracking_link(p_date DATE)
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
  v_existing_id UUID;
BEGIN
  v_token := gen_random_uuid();
  v_pin := lpad(floor(random() * 10000)::text, 4, '0');
  v_expires_at := NOW() + INTERVAL '24 hours';

  -- Buscar si ya existe un link para esa fecha
  SELECT id INTO v_existing_id FROM public.daily_tracking_links WHERE planning_date = p_date;

  IF v_existing_id IS NOT NULL THEN
    -- Renovar link existente
    UPDATE public.daily_tracking_links
    SET 
      tracking_token = v_token,
      tracking_pin = v_pin,
      expires_at = v_expires_at
    WHERE id = v_existing_id;
  ELSE
    -- Crear nuevo link
    INSERT INTO public.daily_tracking_links (planning_date, tracking_token, tracking_pin, expires_at)
    VALUES (p_date, v_token, v_pin, v_expires_at);
  END IF;

  RETURN QUERY SELECT v_token, v_pin, v_expires_at;
END;
$$;

-- RPC para obtener la información de seguimiento público de forma segura
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
                    'status', tr.status
                  )
                )
                FROM public.dispatch_requests dr
                JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
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
