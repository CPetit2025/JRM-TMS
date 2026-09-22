-- Transactional acceptance check for linked driver accounts.
-- Run with: npx supabase db query --linked --file scripts/verify-driver-profile-sync.sql
BEGIN;

DO $$
DECLARE
  v_driver_id uuid;
  v_profile_id uuid;
  v_phone text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Conductor' AND permissions = '[]'::jsonb) THEN
    RAISE EXCEPTION 'El rol Conductor no existe o tiene permisos de módulos';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.drivers d
    JOIN public.profiles p ON p.id = d.profile_id
    LEFT JOIN public.roles r ON r.id = p.role_id
    WHERE p.employee_type IS DISTINCT FROM 'CONDUCTOR'
       OR r.name IS DISTINCT FROM 'Conductor'
       OR p.phone IS DISTINCT FROM d.phone
       OR p.is_active IS DISTINCT FROM d.is_active
  ) THEN
    RAISE EXCEPTION 'Existen conductores vinculados con perfiles desincronizados';
  END IF;

  SELECT id, profile_id, phone INTO v_driver_id, v_profile_id, v_phone
    FROM public.drivers WHERE profile_id IS NOT NULL ORDER BY id LIMIT 1;
  IF v_driver_id IS NULL THEN RETURN; END IF;

  UPDATE public.drivers SET phone = '999999998' WHERE id = v_driver_id;
  IF (SELECT phone FROM public.profiles WHERE id = v_profile_id) IS DISTINCT FROM '999999998' THEN
    RAISE EXCEPTION 'El teléfono no se sincronizó de conductor a perfil';
  END IF;

  UPDATE public.profiles SET phone = '999999997' WHERE id = v_profile_id;
  IF (SELECT phone FROM public.drivers WHERE id = v_driver_id) IS DISTINCT FROM '999999997' THEN
    RAISE EXCEPTION 'El teléfono no se sincronizó de perfil a conductor';
  END IF;

  UPDATE public.drivers SET phone = v_phone WHERE id = v_driver_id;
END $$;

ROLLBACK;
