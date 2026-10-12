-- Isolated transaction: source ERP rows untouched; derived synthetic rows and role changes roll back.
BEGIN;
CREATE FUNCTION pg_temp.c88_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; role_id_test uuid; q jsonb; lot text:='ZZ C88 '||substr(gen_random_uuid()::text,1,8);
 base_layer bigint; base_exit bigint; built timestamptz; after_built timestamptz;
BEGIN
 IF has_function_privilege('anon','public.apt_operational_summary(jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C88 FAIL: anonymous summary access'; END IF;
 q:=public.apt_operational_summary('{}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C88 FAIL: missing identity'; END IF;
 SELECT p.id INTO actor FROM public.profiles p WHERE p.id IN(SELECT id FROM auth.users)
  AND p.id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C88 FAIL: no active test actor available'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C88 '||substr(gen_random_uuid()::text,1,8),'["apt:read"]') RETURNING id INTO role_id_test;
 UPDATE public.profiles SET is_active=true,role_id=role_id_test WHERE id=actor;
 SELECT COALESCE(max(id),0)+10 INTO base_layer FROM public.apt_flow_layers;
 SELECT COALESCE(max(id),0)+10 INTO base_exit FROM public.apt_flow_exits;
 UPDATE public.apt_flow_state SET cutoff='2026-01-03',data_min='2026-01-01',rebuilt_at=clock_timestamp() WHERE id=1;
 SELECT rebuilt_at INTO built FROM public.apt_flow_state WHERE id=1;
 INSERT INTO public.apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente) VALUES
  (base_layer,'647',lot,'P','PRODUCCION','2026-01-01',10000,5000,5000,'ZZ C88 Client'),
  (base_layer+1,'647',lot,'P','INICIAL',NULL,2000,0,2000,'ZZ C88 Client');
 -- Raw exit client intentionally missing: client filtering must conserve the selected inventory cohort.
 INSERT INTO public.apt_flow_exits(id,almacen,lote,producto,tipo,fecha,kg,documento) VALUES
  (base_exit,'647',lot,'P','DESPACHO','2026-01-02',4000,'ZZC88-G'),
  (base_exit+1,'647',lot,'P','CONSUMO','2026-01-03',1000,'ZZC88-C');
 INSERT INTO public.apt_flow_pieces(es_saldo,layer_id,root_id,almacen,lote,producto,fecha_origen,fecha_llegada,kg,origen,layer_tipo,root_almacen,root_lote) VALUES
  (true,base_layer,base_layer,'647',lot,'P','2026-01-01','2026-01-01',5000,'PRODUCCION','PRODUCCION','647',lot),
  (true,base_layer+1,base_layer+1,'647',lot,'P',NULL,NULL,2000,'INICIAL_647','INICIAL','647',lot);
 PERFORM pg_temp.c88_user(actor);
 q:=public.apt_operational_summary(jsonb_build_object('lote',lot,'desde','2026-01-01','hasta','2026-01-03','clientes',jsonb_build_array('ZZ C88 Client'),'limit',1));
 IF (q->>'success')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'CAJA C88 FAIL: authorized summary %',q; END IF;
 IF (q#>>'{kpis,stock_tn}')::numeric<>7 OR (q#>>'{kpis,dispatch_tn}')::numeric<>4
  OR (q#>>'{kpis,consumption_tn}')::numeric<>1 OR (q#>>'{kpis,production_tn}')::numeric<>10
  OR (q#>>'{kpis,inferred_opening_tn}')::numeric<>2 OR (q#>>'{kpis,unknown_origin_stock_tn}')::numeric<>2
  OR (q#>>'{kpis,weighted_age_days}')::numeric<>2 OR (q#>>'{kpis,average_stock_tn}')::numeric<>9
  OR abs((q#>>'{kpis,turnover}')::numeric-4.0/9)>0.001
  OR (q->>'total')::integer<>1 OR jsonb_array_length(q->'rows')<>1
  OR q#>>'{meta,physical_reconciliation}'<>'NO_VERIFICADA' THEN
  RAISE EXCEPTION 'CAJA C88 FAIL: balance/mean inventory/unknown origin/client cohort %',q; END IF;
 q:=public.apt_operational_summary(jsonb_build_object('lote',lot,'cutoff','2026-01-02','desde','2026-01-01'));
 IF (q#>>'{kpis,stock_tn}')::numeric<>8 OR q#>>'{kpis,weighted_age_days}' IS NOT NULL
  OR q#>>'{kpis,inferred_opening_tn}' IS NOT NULL OR q#>>'{meta,age_basis}'<>'NO_DISPONIBLE' THEN
  RAISE EXCEPTION 'CAJA C88 FAIL: historic composition invented %',q; END IF;
 q:=public.apt_operational_summary('{"desde":"2025-12-31"}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C88 FAIL: period outside coverage'; END IF;
 q:=public.apt_operational_summary('{"cliente":"silently ignored"}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C88 FAIL: unsupported filter ignored'; END IF;
 PERFORM pg_temp.c88_user(NULL);
 UPDATE public.profiles SET is_active=false WHERE id=actor;
 PERFORM pg_temp.c88_user(actor);
 q:=public.apt_operational_summary('{}');
 IF (q->>'success')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'CAJA C88 FAIL: inactive profile'; END IF;
 PERFORM pg_temp.c88_user(NULL);
 SELECT rebuilt_at INTO after_built FROM public.apt_flow_state WHERE id=1;
 IF after_built IS DISTINCT FROM built THEN RAISE EXCEPTION 'CAJA C88 FAIL: read changed flow state'; END IF;
 RAISE EXCEPTION 'CAJA C88 PASS: cohort balance, daily-average turnover, explicit inferred opening, historical unknowns, bounded filters, anon/inactive authorization and read-only model';
END $test$;
ROLLBACK;
