-- CAJA C29 — Notificaciones dirigidas por rol:
--   T1 quien tiene "despacho" ve el aviso de despacho y no el de caja; T2 quien tiene "caja-aprobacion" ve el de caja y no
--   el de despacho; T3 un usuario sin esos permisos solo ve el aviso dirigido a él (solicitante); T4 silenciar una
--   categoría la oculta; T5 marcar como leída; T6 sin duplicados (misma clave); T7 los disparadores de solicitud generan el
--   aviso de nueva y de observada (tabla temporal, no se tocan datos reales); T8 los disparadores existen en las tablas
--   presentes. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

CREATE TEMP TABLE zz_c29_req (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, department text, created_by uuid);
CREATE TRIGGER zz_c29_trg AFTER INSERT OR UPDATE ON zz_c29_req FOR EACH ROW EXECUTE FUNCTION public.notif_trg_solicitud();

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; r_d uuid; r_c uuid; r_n uuid; r jsonb; v_fail text[] := '{}'; v_pass int := 0; g bigint; n int; rid uuid;
  has_t boolean := true;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C29 despacho', '["despacho"]') RETURNING id INTO r_d;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C29 caja', '["caja-aprobacion:write"]') RETURNING id INTO r_c;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C29 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.notif_state SET last_refresh = now() WHERE id = 1;   -- sin avisos por tiempo durante la prueba

  PERFORM public.notif_emit('DESPACHO_PROGRAMADO', 'zz-c29-d1', 'ZZ C29 despacho', 'prueba', '/despacho');
  g := public.notif_emit('GASTO_POR_APROBAR', 'zz-c29-g1', 'ZZ C29 gasto', 'prueba', '/caja/aprobaciones');
  PERFORM public.notif_emit('SOLICITUD_OBSERVADA', 'zz-c29-s1', 'ZZ C29 solicitud', 'prueba', '/solicitudes', v_user);
  UPDATE public.profiles SET is_active = true WHERE id = v_user;

  -- T1
  UPDATE public.profiles SET role_id = r_d WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.notif_list(NULL, 200); PERFORM pg_temp.as_user(NULL);
  IF r::text LIKE '%ZZ C29 despacho%' AND r::text NOT LIKE '%ZZ C29 gasto%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 despacho'::text; END IF;

  -- T2 y T5
  UPDATE public.profiles SET role_id = r_c WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.notif_list(NULL, 200); PERFORM pg_temp.as_user(NULL);
  IF r::text LIKE '%ZZ C29 gasto%' AND r::text NOT LIKE '%ZZ C29 despacho%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 caja'::text; END IF;
  PERFORM pg_temp.as_user(v_user); PERFORM public.notif_mark_read(ARRAY[g]); r := public.notif_list('CAJA', 200); PERFORM pg_temp.as_user(NULL);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r -> 'items') x WHERE (x ->> 'id')::bigint = g AND (x ->> 'leida')::boolean) THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || 'T5 leída'::text; END IF;

  -- T3
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.notif_list(NULL, 200); PERFORM pg_temp.as_user(NULL);
  IF r::text LIKE '%ZZ C29 solicitud%' AND r::text NOT LIKE '%ZZ C29 gasto%' AND r::text NOT LIKE '%ZZ C29 despacho%' THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T3 solicitante: ' || left(r::text, 200)); END IF;

  -- T4
  UPDATE public.profiles SET role_id = r_d WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); PERFORM public.notif_set_pref('DESPACHO', true); r := public.notif_list(NULL, 200); PERFORM pg_temp.as_user(NULL);
  IF r::text NOT LIKE '%ZZ C29 despacho%' THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T4 silenciar'::text; END IF;

  -- T6
  PERFORM public.notif_emit('DESPACHO_PROGRAMADO', 'zz-c29-d1', 'ZZ C29 despacho bis', 'prueba', '/despacho');
  SELECT count(*) INTO n FROM public.notifications WHERE dedupe_key = 'zz-c29-d1';
  IF n = 1 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 duplicados: ' || n); END IF;

  -- T7: disparador de solicitud (tabla temporal)
  INSERT INTO zz_c29_req (status, department, created_by) VALUES ('PENDIENTE', 'ZZ C29 área', v_user) RETURNING id INTO rid;
  UPDATE zz_c29_req SET status = 'OBSERVADA' WHERE id = rid;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = 'sol-new-' || rid AND evento = 'SOLICITUD_NUEVA')
     AND EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key LIKE 'sol-' || rid || '-OBSERVADA-%' AND target_user = v_user)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T7 disparador'::text; END IF;

  -- T8
  SELECT bool_and(EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t.trg AND tgrelid = to_regclass('public.' || t.tbl)))
  INTO has_t FROM (VALUES ('transport_requests', 'notif_solicitud'), ('dispatches', 'notif_despacho'), ('trip_advances', 'notif_anticipo'),
    ('dispatch_expenses', 'notif_gasto'), ('vehicle_failures', 'notif_falla'), ('maintenance_work_orders', 'notif_ot')) t(tbl, trg)
  WHERE to_regclass('public.' || t.tbl) IS NOT NULL;
  IF COALESCE(has_t, true) THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 disparadores'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C29 PASS (%/8)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C29 FAIL (%/8): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
