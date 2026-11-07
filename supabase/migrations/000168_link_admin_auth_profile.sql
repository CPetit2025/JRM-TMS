BEGIN;

-- The legacy profile with this username has no matching Auth user. It must not
-- retain an active administrator role or claim the login identifier.
UPDATE public.profiles p
SET role_id = NULL, is_active = false
WHERE lower(p.email) = 'cpetit@jrmsac.com.pe'
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

-- Authorization follows the Auth identity that actually signs in.
UPDATE public.profiles p
SET role_id = (SELECT id FROM public.roles WHERE name = 'Administrador'),
    email = u.email,
    is_active = true
FROM auth.users u
WHERE p.id = u.id AND lower(u.email) = 'cpetit@jrmsac.com.pe';

COMMIT;
