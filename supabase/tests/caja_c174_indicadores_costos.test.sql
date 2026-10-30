-- C174: indicadores de costos de servicios (Etapa 6) — instalados, consultables y sin acceso anónimo.
BEGIN;
DO $$
DECLARE v jsonb;
BEGIN
 IF to_regprocedure('public.service_cost_indicators(date,date)') IS NULL THEN RAISE EXCEPTION 'CAJA C174 FAIL: falta service_cost_indicators'; END IF;
 IF has_function_privilege('anon','public.service_cost_indicators(date,date)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C174 FAIL: acceso anónimo a los indicadores'; END IF;
 -- Con un administrador activo se ejecuta la consulta completa sobre los datos reales (columnas y tablas de producción)
 PERFORM set_config('request.jwt.claim.sub', (SELECT p.id::text FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
   WHERE r.name = 'Administrador' AND p.is_active LIMIT 1), true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', current_setting('request.jwt.claim.sub', true), 'role', 'authenticated')::text, true);
 v := public.service_cost_indicators(current_date - 90, current_date);
 IF v IS NULL OR v->>'success' IS NULL THEN RAISE EXCEPTION 'CAJA C174 FAIL: respuesta inválida'; END IF;
 IF (v->>'success')::boolean AND (v->'totals' IS NULL OR jsonb_typeof(v->'by_contract') <> 'array') THEN RAISE EXCEPTION 'CAJA C174 FAIL: indicadores incompletos'; END IF;
 RAISE EXCEPTION 'CAJA C174 PASS: indicadores de costos instalados y protegidos';
END $$;
ROLLBACK;
