-- Pruebas C66 — Rendimiento del Gantt APT con la data completa (incidente: statement timeout en /apt/gantt).
-- T1 la vista inicial (sin filtros) responde como usuario autenticado dentro de 2 s (límite del rol: 8 s; lee el resumen precalculado);
-- T2 la serie de saldo conserva el cálculo: cada punto = movimientos sin fecha + movimientos hasta esa fecha;
-- T3 el resumen precalculado (apt_gantt_lotes) devuelve lo mismo que el cálculo en vivo, con y sin filtros.
-- Termina en error para forzar ROLLBACK: "CAJA C66 PASS/FAIL".
BEGIN;
CREATE FUNCTION pg_temp.c66_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; v_role uuid; q jsonb; t0 timestamptz; ms numeric; v_to date; expected numeric; got numeric; f jsonb; filtro jsonb; fast jsonb[] := '{}'; i int;
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
  AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C66 FAIL: falta perfil para probar'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C66 Gantt '||substr(gen_random_uuid()::text,1,8),'["apt:read"]') RETURNING id INTO v_role;
 UPDATE public.profiles SET is_active=true,role_id=v_role WHERE id=actor;
 PERFORM pg_temp.c66_user(actor);
 t0 := clock_timestamp();
 q := public.apt_gantt('{}',25,0);
 ms := round(extract(epoch FROM clock_timestamp()-t0)*1000);
 PERFORM pg_temp.c66_user(NULL);
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C66 FAIL: %', q->>'error'; END IF;
 IF ms > 2000 THEN RAISE EXCEPTION 'CAJA C66 FAIL (T1): vista inicial % ms con % lotes', ms, q->>'total'; END IF;
 IF COALESCE(q->>'vacio','false')='false' AND jsonb_array_length(q->'serie')>0 THEN
  v_to := (q->>'hasta')::date;
  SELECT round(COALESCE(sum(kg),0)/1000,3) INTO expected FROM (
    SELECT kg_in AS kg FROM public.apt_flow_layers WHERE fecha IS NULL OR fecha<=v_to
    UNION ALL SELECT -kg FROM public.apt_flow_exits WHERE fecha<=v_to) m;
  got := (q->'serie'->-1->>'saldo_tn')::numeric;
  IF abs(got-expected) > 0.001 THEN RAISE EXCEPTION 'CAJA C66 FAIL (T2): serie al % = % vs %', v_to, got, expected; END IF;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'apt_uploads_gantt_meta' AND tgrelid = 'public.apt_uploads'::regclass)
    OR (SELECT data_max FROM public.apt_gantt_meta WHERE id=1) IS DISTINCT FROM (SELECT max(fecha) FROM public.apt_movements WHERE active AND valid) THEN
  RAISE EXCEPTION 'CAJA C66 FAIL (T3): rango de datos del Gantt no sigue a las cargas';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.apt_gantt_meta m JOIN public.apt_flow_state s ON s.id=1 WHERE m.flow_rebuilt_at = s.rebuilt_at) THEN
  RAISE EXCEPTION 'CAJA C66 FAIL (T3): resumen precalculado desactualizado respecto del último recálculo';
 END IF;
 PERFORM pg_temp.c66_user(actor);
 FOREACH filtro IN ARRAY ARRAY['{}','{"almacen":"540"}','{"estado":"PARCIAL"}','{"solo_criticos":true}']::jsonb[] LOOP
  fast := fast || public.apt_gantt(filtro,25,0);
 END LOOP;
 PERFORM pg_temp.c66_user(NULL);
 UPDATE public.apt_gantt_meta SET flow_rebuilt_at = NULL WHERE id=1;
 PERFORM pg_temp.c66_user(actor);
 i := 0;
 FOREACH filtro IN ARRAY ARRAY['{}','{"almacen":"540"}','{"estado":"PARCIAL"}','{"solo_criticos":true}']::jsonb[] LOOP
  i := i + 1; f := public.apt_gantt(filtro,25,0);
  IF f IS DISTINCT FROM fast[i] THEN RAISE EXCEPTION 'CAJA C66 FAIL (T3): precalculado difiere del cálculo en vivo con %', filtro; END IF;
 END LOOP;
 PERFORM pg_temp.c66_user(NULL);
 RAISE EXCEPTION 'CAJA C66 PASS (3/3) Gantt APT % ms · % lotes · serie % · precalculado = en vivo', ms, q->>'total', jsonb_array_length(q->'serie');
END $test$;
ROLLBACK;
