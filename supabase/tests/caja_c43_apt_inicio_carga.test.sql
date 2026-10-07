-- El error final fuerza ROLLBACK, como exige el arnés de producción.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  definition text; user_id uuid; old_id uuid; new_id uuid; result jsonb;
BEGIN
  SELECT pg_get_functiondef('public.apt_upload_begin(text)'::regprocedure) INTO definition;
  IF position('APT_BEGIN_NO_CLEANUP' IN definition) = 0
     OR definition ~* '\mDELETE\s+FROM\s+(public\.)?apt_uploads\M' THEN
    RAISE EXCEPTION 'CAJA C43 FAIL: el inicio conserva la limpieza bloqueante';
  END IF;

  SELECT p.id INTO user_id FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.is_active AND p.id IN (SELECT id FROM auth.users)
      AND (r.name IN ('Administrador', 'Jefe de Distribución')
      OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['apt-carga', 'apt-carga:write'])
    ORDER BY p.id LIMIT 1;
  IF user_id IS NULL THEN RAISE EXCEPTION 'CAJA C43 FAIL: falta perfil con permiso APT'; END IF;

  INSERT INTO public.apt_uploads(file_name, created_at)
    VALUES ('ZZ C43 abandonada', now() - interval '2 days') RETURNING id INTO old_id;
  PERFORM pg_temp.as_user(user_id);
  result := public.apt_upload_begin('  ZZ C43 nueva.xlsx  ');
  PERFORM pg_temp.as_user(NULL);
  new_id := (result ->> 'id')::uuid;
  IF result ->> 'success' IS DISTINCT FROM 'true'
     OR NOT EXISTS (SELECT 1 FROM public.apt_uploads WHERE id = new_id
       AND file_name = 'ZZ C43 nueva.xlsx' AND created_by = user_id AND status = 'CARGANDO')
     OR NOT EXISTS (SELECT 1 FROM public.apt_uploads WHERE id = old_id AND status = 'CARGANDO') THEN
    RAISE EXCEPTION 'CAJA C43 FAIL: creación, propietario o conservación de cargas anteriores';
  END IF;

  -- JWT sin un perfil registrado: no autoriza escrituras ni limpia la carga vieja.
  PERFORM pg_temp.as_user(gen_random_uuid());
  result := public.apt_upload_begin('ZZ C43 prohibida');
  PERFORM pg_temp.as_user(NULL);
  IF result ->> 'success' IS DISTINCT FROM 'false'
     OR EXISTS (SELECT 1 FROM public.apt_uploads WHERE file_name = 'ZZ C43 prohibida') THEN
    RAISE EXCEPTION 'CAJA C43 FAIL: autorización del inicio de carga';
  END IF;
  RAISE EXCEPTION 'CAJA C43 PASS (3/3): inicio sin limpieza, propietario y autorización';
END $test$;
