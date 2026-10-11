-- Corrige 20261011030000: la tabla del historial de roles heredó los privilegios por defecto de Supabase para
-- authenticated (incluidos TRUNCATE y TRIGGER, que C55 prohíbe). Solo se lee; las filas las escribe el disparador.
BEGIN;
REVOKE ALL ON public.role_permission_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.role_permission_changes TO authenticated;
GRANT ALL ON public.role_permission_changes TO service_role;
COMMIT;
