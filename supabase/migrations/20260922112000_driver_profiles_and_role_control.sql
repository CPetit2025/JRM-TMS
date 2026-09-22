BEGIN;

-- The system administrator is already the only role allowed to mutate roles
-- through RLS. Remove the additional trigger that prevented that administrator
-- from managing the built-in roles.
DROP TRIGGER IF EXISTS guard_core_roles ON public.roles;
DROP FUNCTION IF EXISTS public.guard_core_roles();

INSERT INTO public.roles (id, name, description, permissions)
VALUES (
  gen_random_uuid(),
  'Conductor',
  'Acceso exclusivo al portal operativo y a la aplicación móvil.',
  '[]'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description;

-- Existing linked drivers were created without a role and their phone was only
-- kept in drivers. Make the profile shown in /usuarios reflect the master row.
UPDATE public.profiles p
SET first_name = d.first_name,
    last_name = d.last_name,
    document_number = d.document_number,
    phone = d.phone,
    username = coalesce(nullif(p.username, ''), u.email),
    employee_type = 'CONDUCTOR',
    role_id = (SELECT id FROM public.roles WHERE name = 'Conductor'),
    is_active = d.is_active,
    updated_at = now()
FROM public.drivers d
JOIN auth.users u ON u.id = d.profile_id
WHERE p.id = d.profile_id;

CREATE OR REPLACE FUNCTION public.sync_driver_to_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_id uuid;
  v_email text;
BEGIN
  IF NEW.profile_id IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_role_id FROM public.roles WHERE name = 'Conductor';
  SELECT email INTO v_email FROM auth.users WHERE id = NEW.profile_id;

  UPDATE public.profiles p
  SET first_name = NEW.first_name,
      last_name = NEW.last_name,
      document_number = NEW.document_number,
      phone = NEW.phone,
      username = coalesce(nullif(p.username, ''), v_email),
      employee_type = 'CONDUCTOR',
      role_id = v_role_id,
      is_active = NEW.is_active,
      updated_at = now()
  WHERE p.id = NEW.profile_id
    AND (p.first_name, p.last_name, p.document_number, p.phone,
         p.employee_type, p.role_id, p.is_active, p.username)
      IS DISTINCT FROM
        (NEW.first_name, NEW.last_name, NEW.document_number, NEW.phone,
         'CONDUCTOR'::varchar, v_role_id, NEW.is_active,
         coalesce(nullif(p.username, ''), v_email));

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_profile_to_driver()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.drivers d
  SET first_name = NEW.first_name,
      last_name = NEW.last_name,
      document_number = NEW.document_number,
      phone = NEW.phone,
      is_active = NEW.is_active,
      updated_at = now()
  WHERE d.profile_id = NEW.id
    AND (d.first_name, d.last_name, d.document_number, d.phone, d.is_active)
      IS DISTINCT FROM
        (NEW.first_name, NEW.last_name, NEW.document_number, NEW.phone, NEW.is_active);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_driver_to_profile ON public.drivers;
CREATE TRIGGER sync_driver_to_profile
  AFTER INSERT OR UPDATE OF profile_id, first_name, last_name, document_number, phone, is_active
  ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION public.sync_driver_to_profile();

DROP TRIGGER IF EXISTS sync_profile_to_driver ON public.profiles;
CREATE TRIGGER sync_profile_to_driver
  AFTER UPDATE OF first_name, last_name, document_number, phone, is_active
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_to_driver();

REVOKE ALL ON FUNCTION public.sync_driver_to_profile() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_profile_to_driver() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
