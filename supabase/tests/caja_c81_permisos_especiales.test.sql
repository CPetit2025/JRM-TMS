-- CAJA C81 — Permisos especiales en lugar de reglas por nombre de rol: «solo su cartera de OT» (cartera-propia) y
-- «validar conformidad de entregas» (entregas-validacion) se dan a cualquier rol; los roles base los conservan.
-- Bloque que siempre se revierte: no deja datos.
BEGIN;
CREATE FUNCTION pg_temp.c81_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; v_role uuid; v_site uuid; v_disp uuid; ok boolean;
  suffix text := upper(substr(gen_random_uuid()::text, 1, 6));
BEGIN
  -- T1: los roles base tienen su permiso especial (si existen)
  IF EXISTS (SELECT 1 FROM public.roles WHERE name = 'Administrador de Contratos' AND NOT permissions ? 'cartera-propia')
     OR EXISTS (SELECT 1 FROM public.roles WHERE name = 'Supervisor de Transporte' AND NOT permissions ? 'entregas-validacion')
     OR EXISTS (SELECT 1 FROM public.roles WHERE name = 'Auditor de Despacho' AND NOT permissions ? 'solo-documentos') THEN
    RAISE EXCEPTION 'CAJA C81 FAIL: rol base sin su permiso especial (T1)'; END IF;

  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_site FROM public.sites LIMIT 1;
  IF v_user IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C81 FAIL: falta perfil o sede de prueba'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C81 ' || suffix, '["despacho:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, v_site) ON CONFLICT DO NOTHING;

  -- T2: sin permisos especiales, un rol cualquiera no es «cartera propia» ni valida entregas
  PERFORM pg_temp.c81_user(v_user);
  ok := public.is_contract_administrator();
  PERFORM pg_temp.c81_user(NULL);
  IF ok THEN RAISE EXCEPTION 'CAJA C81 FAIL: cartera propia sin permiso (T2)'; END IF;

  -- T3: con cartera-propia queda limitado a su cartera como el Administrador de Contratos
  UPDATE public.roles SET permissions = '["despacho:read","cartera-propia"]' WHERE id = v_role;
  PERFORM pg_temp.c81_user(v_user);
  ok := public.is_contract_administrator();
  PERFORM pg_temp.c81_user(NULL);
  IF NOT ok THEN RAISE EXCEPTION 'CAJA C81 FAIL: cartera-propia no aplica (T3)'; END IF;

  -- T4: con entregas-validacion valida la conformidad de un despacho de su sede (si el módulo está instalado)
  IF to_regprocedure('public.delivery_can_review(uuid)') IS NOT NULL THEN
    EXECUTE (SELECT format('INSERT INTO public.dispatches (%s) VALUES (%s) RETURNING id',
               string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
               FROM jsonb_each(jsonb_build_object('dispatch_number', 'ZZ-C81-' || suffix, 'vehicle_plate', 'ZC81' || substr(suffix, 1, 3),
                 'status', 'PROGRAMADO', 'site_id', v_site, 'scheduled_date', current_date, 'scheduled_departure', now())) k
              WHERE EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'dispatches' AND c.column_name = k.key))
      INTO v_disp;
    PERFORM pg_temp.c81_user(v_user);
    ok := public.delivery_can_review(v_disp);
    PERFORM pg_temp.c81_user(NULL);
    IF ok THEN RAISE EXCEPTION 'CAJA C81 FAIL: valida entregas sin permiso (T4)'; END IF;
    UPDATE public.roles SET permissions = '["despacho:read","entregas-validacion"]' WHERE id = v_role;
    PERFORM pg_temp.c81_user(v_user);
    ok := public.delivery_can_review(v_disp);
    PERFORM pg_temp.c81_user(NULL);
    IF NOT ok THEN RAISE EXCEPTION 'CAJA C81 FAIL: entregas-validacion no aplica (T4)'; END IF;
  END IF;

  RAISE EXCEPTION 'CAJA C81 PASS (4/4) permisos especiales: cartera propia y validación de entregas asignables';
END $test$;
ROLLBACK;
