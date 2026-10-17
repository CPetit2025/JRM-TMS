-- ============================================================
-- Ingreso de solicitantes de transporte (Administración de Contratos, Logística, Almacén y demás áreas)
-- ============================================================
-- 1. profiles.area: área que declara quien se registra; la Nueva solicitud la usa como área solicitante por defecto.
-- 2. Rol base «Solicitante de Transporte»: registra y consulta todas las solicitudes (visión general de la operación),
--    sin cartera de OT ni administración. El Administrador de Contratos conserva su rol y su cartera.
-- 3. Menú: /usuarios muestra cuántos registros esperan aprobación (inactivos, sin rol y sin conductor vinculado).
-- La función del menú se modifica sobre la versión instalada (producción puede diferir del repositorio).
BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS area text;

INSERT INTO public.roles (name, description, permissions)
SELECT 'Solicitante de Transporte',
       'Áreas que piden transporte: registra solicitudes y consulta todas las solicitudes y la Torre de Control.',
       '["dashboard", "solicitudes:write", "torre-control:read"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.roles WHERE lower(btrim(name)) = 'solicitante de transporte');

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.menu_pending_counts()'::regprocedure);
  v_anchor constant text := $a$  RETURN jsonb_build_object('success', true, 'counts', v);$a$;
  v_block constant text := $b$  -- Registros públicos esperando aprobación (inactivos, sin rol y sin conductor vinculado)
  IF public.menu_has_permission('usuarios') THEN
    BEGIN
      EXECUTE format($q$SELECT count(*) FROM public.profiles p WHERE p.is_active IS NOT TRUE AND p.role_id IS NULL %s$q$,
        CASE WHEN public.menu_col_exists('drivers', 'profile_id') THEN 'AND NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id)' ELSE '' END) INTO n;
      IF n > 0 THEN v := v || jsonb_build_object('/usuarios', jsonb_build_object('n', n, 'tono', 'warn', 'texto', n || ' registros esperando aprobación')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

$b$;
BEGIN
  IF position('/usuarios' IN v_def) > 0 THEN RETURN; END IF;
  IF position(v_anchor IN v_def) = 0 THEN RAISE EXCEPTION 'menu_pending_counts: no se encontró el punto de inserción'; END IF;
  EXECUTE replace(v_def, v_anchor, v_block || v_anchor);
END $mig$;

REVOKE ALL ON FUNCTION public.menu_pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.menu_pending_counts() TO authenticated, service_role;

COMMIT;
