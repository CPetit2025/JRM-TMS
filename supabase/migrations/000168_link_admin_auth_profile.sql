BEGIN;

-- The legacy profile with this username has no matching Auth user. It must not
-- retain an active administrator role or claim the login identifier.
UPDATE public.profiles p
SET role_id = NULL, is_active = false, username = NULL
WHERE lower(p.username) = 'cpetit@jrmsac.com.pe'
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id);

-- Authorization follows the Auth identity that actually signs in.
UPDATE public.profiles p
SET role_id = (SELECT id FROM public.roles WHERE name = 'Administrador'),
    username = u.email,
    employee_type = 'ADMINISTRATIVO',
    is_active = true
FROM auth.users u
WHERE p.id = u.id AND lower(u.email) = 'cpetit@jrmsac.com.pe';

COMMIT;
