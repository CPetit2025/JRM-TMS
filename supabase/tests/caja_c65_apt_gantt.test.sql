BEGIN;
CREATE FUNCTION pg_temp.c65_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; v_role uuid; q jsonb; lot text; expected numeric; past date; cut date; built timestamptz; after_built timestamptz;
BEGIN
 IF has_function_privilege('anon','public.apt_gantt(jsonb,integer,integer)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C65 FAIL: RPC pública'; END IF;
 q:=public.apt_gantt('{}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C65 FAIL: sin identidad autorizada'; END IF;
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users)
  AND id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C65 FAIL: falta perfil para probar permiso'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C65 Gantt '||substr(gen_random_uuid()::text,1,8),'["apt:read"]') RETURNING id INTO v_role;
 UPDATE public.profiles SET is_active=true,role_id=v_role WHERE id=actor;
 SELECT cutoff,rebuilt_at INTO cut,built FROM public.apt_flow_state WHERE id=1;
 SELECT lote INTO lot FROM public.apt_flow_layers ORDER BY kg_saldo DESC,lote LIMIT 1;
 PERFORM pg_temp.c65_user(actor);
 q:=public.apt_gantt(jsonb_build_object('lote_exacto',lot),1,0);
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C65 FAIL: permiso APT'; END IF;
 IF cut IS NOT NULL AND lot IS NOT NULL THEN
  PERFORM pg_temp.c65_user(NULL);
  SELECT round(COALESCE(sum(kg_saldo),0)/1000,3) INTO expected FROM public.apt_flow_layers WHERE lote=lot;
  IF abs((q#>>'{kpis,saldo_tn}')::numeric-expected)>0.001 THEN RAISE EXCEPTION 'CAJA C65 FAIL: saldo actual no concilia % vs %',q#>>'{kpis,saldo_tn}',expected; END IF;
  past:=cut-1;
  IF past >= (SELECT data_min FROM public.apt_flow_state WHERE id=1) THEN
   SELECT round(COALESCE(sum(GREATEST(l.kg_in-COALESCE(a.kg,0),0)),0)/1000,3) INTO expected
   FROM public.apt_flow_layers l LEFT JOIN (SELECT a.layer_id,sum(a.kg) AS kg FROM public.apt_flow_alloc a
    JOIN public.apt_flow_exits e ON e.id=a.exit_id WHERE e.fecha<=past GROUP BY a.layer_id) a ON a.layer_id=l.id
   WHERE l.lote=lot AND (l.fecha IS NULL OR l.fecha<=past);
   PERFORM pg_temp.c65_user(actor);
   q:=public.apt_gantt(jsonb_build_object('lote_exacto',lot,'corte',past),1,0);
   IF abs((q#>>'{kpis,saldo_tn}')::numeric-expected)>0.001 OR q->>'age_basis'<>'ALMACEN' THEN RAISE EXCEPTION 'CAJA C65 FAIL: corte histórico o base de edad'; END IF;
  END IF;
 END IF;
 PERFORM pg_temp.c65_user(actor);
 q:=public.apt_gantt('{"corte":"fecha incorrecta"}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C65 FAIL: fecha inválida'; END IF;
 PERFORM pg_temp.c65_user(NULL);
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 PERFORM pg_temp.c65_user(actor);
 q:=public.apt_gantt('{}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C65 FAIL: perfil desactivado'; END IF;
 PERFORM pg_temp.c65_user(NULL);
 SELECT rebuilt_at INTO after_built FROM public.apt_flow_state WHERE id=1;
 IF after_built IS DISTINCT FROM built THEN RAISE EXCEPTION 'CAJA C65 FAIL: consulta reconstruyó modelo'; END IF;
 RAISE EXCEPTION 'CAJA C65 PASS: permiso APT/anon/inactivo, saldo actual e histórico, fecha inválida y modelo intacto';
END $test$;
ROLLBACK;
