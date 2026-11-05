UPDATE public.profiles
SET role_id = (SELECT id FROM public.roles WHERE name = 'Administrador')
WHERE id IN (
    SELECT id FROM auth.users WHERE lower(email) = 'cpetit@jrmsac.com.pe'
);
