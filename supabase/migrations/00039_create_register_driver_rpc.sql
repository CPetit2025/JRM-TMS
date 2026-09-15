-- RPC function to register a driver, bypassing PostgREST schema cache issues
CREATE OR REPLACE FUNCTION public.register_driver(
  p_auth_user_id UUID,
  p_dni TEXT,
  p_first_name TEXT,
  p_last_name TEXT,
  p_phone TEXT,
  p_license_number TEXT,
  p_pin TEXT,
  p_carrier_id UUID
) RETURNS UUID AS $$
DECLARE
  v_driver_id UUID;
BEGIN
  -- Check if driver already exists with this DNI
  SELECT id INTO v_driver_id FROM public.drivers WHERE document_number = p_dni;
  
  IF v_driver_id IS NOT NULL THEN
    -- Link existing driver to the new auth user and update info
    UPDATE public.drivers SET
      profile_id = p_auth_user_id,
      first_name = p_first_name,
      last_name = p_last_name,
      phone = NULLIF(p_phone, ''),
      license_number = p_license_number,
      pin = p_pin,
      carrier_id = p_carrier_id
    WHERE id = v_driver_id;
  ELSE
    -- Create new driver record
    INSERT INTO public.drivers (
      carrier_id,
      profile_id,
      document_number,
      first_name,
      last_name,
      phone,
      license_number,
      license_category,
      pin,
      is_active
    ) VALUES (
      p_carrier_id,
      p_auth_user_id,
      p_dni,
      p_first_name,
      p_last_name,
      NULLIF(p_phone, ''),
      p_license_number,
      'A-I',
      p_pin,
      true
    ) RETURNING id INTO v_driver_id;
  END IF;
  
  RETURN v_driver_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Allow anonymous and authenticated users to call this function
GRANT EXECUTE ON FUNCTION public.register_driver TO anon, authenticated;
