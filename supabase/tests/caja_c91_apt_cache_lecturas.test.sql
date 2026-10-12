-- CAJA C91 — Caché de lecturas APT: el RPC público devuelve lo mismo que el cálculo en vivo, pagina desde la caché,
-- se invalida al cambiar la versión de datos y mantiene el acceso. Datos sintéticos; bloque que siempre se revierte.
BEGIN;
CREATE FUNCTION pg_temp.c91_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM set_config('request.jwt.claim.sub',COALESCE(p_user::text,''),true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
 PERFORM set_config('role',CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END,true);
END $$;
-- Cálculo en vivo de referencia: misma identidad, sin el rol authenticated (no puede ejecutarlo directamente).
CREATE FUNCTION pg_temp.c91_claims(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_temp.c91_user(p_user);
 PERFORM set_config('role','none',true);
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
DO $test$
DECLARE actor uuid; v_role uuid; lot text:='ZZC91'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 base_layer bigint; q jsonb; live jsonb; cached jsonb; f jsonb; n integer; v1 text; v2 text;
BEGIN
 -- T1: el cálculo en vivo, la caché y el precalentado no son RPC públicos; los RPC conservan su acceso
 IF has_function_privilege('authenticated','public.apt_dashboard_live(jsonb,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.apt_operational_summary_live(jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.apt_read_cached(text,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.apt_read_cache_warm()','EXECUTE')
  OR has_function_privilege('anon','public.apt_dashboard(jsonb,text)','EXECUTE')
  OR has_function_privilege('anon','public.apt_operational_summary(jsonb)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.apt_dashboard(jsonb,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.apt_operational_summary(jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: privilegios de lectura APT (T1)'; END IF;

 SELECT p.id INTO actor FROM public.profiles p WHERE p.id IN(SELECT id FROM auth.users)
  AND p.id NOT IN(SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C91 FAIL: falta un perfil de prueba'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C91 '||lot,'["apt:read"]') RETURNING id INTO v_role;
 UPDATE public.profiles SET is_active=true,role_id=v_role WHERE id=actor;
 SELECT COALESCE(max(id),0)+10 INTO base_layer FROM public.apt_flow_layers;
 UPDATE public.apt_flow_state SET cutoff='2026-01-03',data_min='2026-01-01',rebuilt_at=clock_timestamp() WHERE id=1;
 INSERT INTO public.apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente) VALUES
  (base_layer,'647',lot||'-A','P','PRODUCCION','2026-01-01',3000,0,3000,'ZZ C91'),
  (base_layer+1,'647',lot||'-B','P','PRODUCCION','2026-01-01',2000,0,2000,'ZZ C91'),
  (base_layer+2,'647',lot||'-C','P','PRODUCCION','2026-01-02',1000,0,1000,'ZZ C91');
 f:=jsonb_build_object('lote',lot,'desde','2026-01-01','hasta','2026-01-03');

 -- T2: sin identidad no hay datos ni se guarda nada
 PERFORM pg_temp.c91_user(NULL);
 IF (public.apt_operational_summary(f)->>'success') IS DISTINCT FROM 'false'
  OR (public.apt_dashboard(jsonb_build_object('lote',lot),'dia')->>'success') IS DISTINCT FROM 'false' THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: lectura sin identidad (T2)'; END IF;

 -- T3: página 2 de 1 fila desde la caché = página 2 del cálculo en vivo; la caché guarda el cohorte completo una vez
 PERFORM pg_temp.c91_user(actor);
 q:=public.apt_operational_summary(f||'{"limit":1,"offset":1}');
 PERFORM pg_temp.c91_claims(actor);
 live:=public.apt_operational_summary_live(f||'{"limit":1,"offset":1}');
 PERFORM pg_temp.c91_user(NULL);
 IF (q->>'success') IS DISTINCT FROM 'true' OR q->'rows' IS DISTINCT FROM live->'rows' OR q->'kpis' IS DISTINCT FROM live->'kpis'
  OR (q->>'total')::integer<>3 OR (q->>'limit')::integer<>1 OR (q->>'offset')::integer<>1 OR q#>>'{rows,0,lote}'<>lot||'-B' THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: página desde caché (T3) % vs %',q->'rows',live->'rows'; END IF;
 SELECT count(*) INTO n FROM public.apt_read_cache WHERE fn='apt_operational_summary' AND key_hash=md5(jsonb_build_object('p',f)::text);
 IF n<>1 THEN RAISE EXCEPTION 'CAJA C91 FAIL: resumen no guardado una sola vez (T3)'; END IF;

 -- T4: el tablero desde la caché es idéntico al cálculo en vivo y la segunda lectura no recalcula
 PERFORM pg_temp.c91_user(actor);
 q:=public.apt_dashboard(jsonb_build_object('lote',lot),'dia');
 PERFORM pg_temp.c91_claims(actor);
 live:=public.apt_dashboard_live(jsonb_build_object('lote',lot),'dia');
 SELECT built_at::text INTO v1 FROM public.apt_read_cache WHERE fn='apt_dashboard' AND params=jsonb_build_object('p',jsonb_build_object('lote',lot),'grain','dia');
 PERFORM pg_temp.c91_user(actor);
 cached:=public.apt_dashboard(jsonb_build_object('lote',lot),'dia');
 PERFORM pg_temp.c91_claims(actor);
 SELECT built_at::text INTO v2 FROM public.apt_read_cache WHERE fn='apt_dashboard' AND params=jsonb_build_object('p',jsonb_build_object('lote',lot),'grain','dia');
 PERFORM pg_temp.c91_user(NULL);
 IF (q->>'success') IS DISTINCT FROM 'true' OR q IS DISTINCT FROM live OR cached IS DISTINCT FROM live OR v1 IS NULL OR v1<>v2 THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: tablero desde caché (T4)'; END IF;

 -- T5: un recálculo del flujo cambia la versión y la siguiente lectura usa los datos nuevos
 v1:=public.apt_read_cache_version();
 INSERT INTO public.apt_flow_layers(id,almacen,lote,producto,tipo,fecha,kg_in,kg_out,kg_saldo,cliente) VALUES
  (base_layer+3,'647',lot||'-D','P','PRODUCCION','2026-01-03',500,0,500,'ZZ C91');
 UPDATE public.apt_flow_state SET rebuilt_at=clock_timestamp()+interval '1 second' WHERE id=1;
 v2:=public.apt_read_cache_version();
 PERFORM pg_temp.c91_user(actor);
 q:=public.apt_operational_summary(f||'{"limit":10}');
 PERFORM pg_temp.c91_user(NULL);
 IF v1=v2 OR (q->>'total')::integer<>4 THEN RAISE EXCEPTION 'CAJA C91 FAIL: invalidación por versión (T5) total %',q->>'total'; END IF;

 -- T6: filtros inválidos responden con su validación y no se guardan
 PERFORM pg_temp.c91_user(actor);
 q:=public.apt_operational_summary('{"cliente":"x"}');
 live:=public.apt_operational_summary('{"limit":"abc"}');
 PERFORM pg_temp.c91_user(NULL);
 IF (q->>'success') IS DISTINCT FROM 'false' OR (live->>'success') IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM public.apt_read_cache WHERE params->'p' ? 'cliente') THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: validación de filtros (T6)'; END IF;

 -- T7: un filtro que superó el límite de la petición queda en cola, el precalentado lo calcula y una clave
 -- larga (100 clientes de 200 caracteres) se guarda sin superar el límite del índice
 PERFORM pg_temp.c91_user(actor);
 q:=public.apt_read_cache_request('apt_operational_summary',jsonb_build_object('p',f||jsonb_build_object('clientes',
   (SELECT jsonb_agg(repeat('Z',190)||g) FROM generate_series(1,100) g),'limit',25,'offset',0)));
 PERFORM pg_temp.c91_user(NULL);
 IF (q->>'success') IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.apt_read_cache_requests WHERE fn='apt_operational_summary') THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: solicitud de cálculo (T7) %',q; END IF;
 n:=public.apt_read_cache_claim();
 IF n<>1 OR NOT EXISTS(SELECT 1 FROM public.apt_read_cache_requests WHERE attempts=1 AND claimed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: turno de la cola (T7)'; END IF;
 PERFORM public.apt_read_cache_warm();
 IF EXISTS(SELECT 1 FROM public.apt_read_cache_requests WHERE params->'p' ? 'clientes')
  OR NOT EXISTS(SELECT 1 FROM public.apt_read_cache WHERE fn='apt_operational_summary' AND params->'p' ? 'clientes') THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: precalentado de la solicitud (T7)'; END IF;
 IF has_function_privilege('anon','public.apt_read_cache_request(text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C91 FAIL: solicitud expuesta a anónimos (T7)'; END IF;

 RAISE EXCEPTION 'CAJA C91 PASS (7/7) caché APT: mismo resultado que el cálculo en vivo, paginación, invalidación por versión, cola de cálculo, claves largas y acceso';
END $test$;
ROLLBACK;
