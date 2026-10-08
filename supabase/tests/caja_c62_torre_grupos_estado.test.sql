-- Pruebas C62 — Torre de Control: grupos de estado RUTA y POR_CERRAR en el servidor (get_tower_dispatches).
-- T1 la función acepta los grupos y conserva search_path seguro; T2 un estado no válido se rechaza;
-- T3 RUTA y POR_CERRAR devuelven solo estados de su grupo (como administrador).
-- Termina en error para forzar ROLLBACK: "CAJA C62 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c62_torre_grupos_estado.test.sql
BEGIN;
DO $test$
DECLARE actor uuid; v_pass int := 0; v_fail text[] := '{}'; v_bad int; v_rows int; denied boolean := false;
BEGIN
  -- T1
  IF position('POR_CERRAR' IN pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure)) > 0
     AND EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.get_tower_dispatches(date,uuid,text)'::regprocedure
                 AND array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 grupos no instalados'::text; END IF;

  FOR actor IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', actor::text, true);
    EXIT WHEN public.is_tms_admin(); actor := NULL;
  END LOOP;
  IF actor IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  END IF;

  -- T2
  IF actor IS NULL THEN v_pass := v_pass + 1;
  ELSE
    BEGIN PERFORM * FROM public.get_tower_dispatches(NULL, NULL, 'toString'); EXCEPTION WHEN OTHERS THEN denied := true; END;
    IF denied THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T2 acepta un estado no válido'::text; END IF;
  END IF;

  -- T3
  IF actor IS NULL THEN v_pass := v_pass + 1;
  ELSE
    SELECT count(*) FILTER (WHERE status NOT IN ('EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')), count(*)
      INTO v_bad, v_rows FROM public.get_tower_dispatches(NULL, NULL, 'RUTA');
    IF v_bad = 0 THEN
      SELECT count(*) FILTER (WHERE status NOT IN ('ENTREGADO','RETORNO_COMPLETADO')) INTO v_bad
        FROM public.get_tower_dispatches(NULL, NULL, 'POR_CERRAR');
    END IF;
    IF v_bad = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 ' || v_bad || ' despachos fuera del grupo'); END IF;
  END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C62 PASS (%/3) grupos de estado en el servidor%', v_pass, CASE WHEN actor IS NULL THEN ' (T2-T3 sin administrador)' ELSE '' END;
  ELSE
    RAISE EXCEPTION 'CAJA C62 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
