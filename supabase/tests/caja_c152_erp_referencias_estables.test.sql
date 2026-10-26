-- Contrato de las RPC usadas por la web: lote real de 100, modal y planes; sin escrituras empresariales.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
DO $test$
DECLARE actor uuid; codes text[]; result jsonb; started timestamptz; ref_ms numeric; modal_ms numeric; all_ms numeric; n int;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id JOIN auth.users u ON u.id=p.id
 WHERE p.is_active AND r.name='Administrador' ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C152 FAIL: falta cuenta administradora para verificar las referencias'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 SELECT ARRAY(SELECT DISTINCT c.code::text FROM public.contracts c WHERE NULLIF(btrim(c.code),'') IS NOT NULL AND public.can_access_site(c.site_id) ORDER BY 1 LIMIT 100) INTO codes;
 started:=clock_timestamp();result:=public.erp_ref_contratos(codes);ref_ms:=round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,1);
 SELECT count(*) INTO n FROM jsonb_object_keys(result->'filas');
 IF result->>'success' IS DISTINCT FROM 'true' OR (NOT COALESCE((result->>'sin_datos')::boolean,false) AND n<>cardinality(codes)) THEN RAISE EXCEPTION 'CAJA C152 FAIL: referencia incompleta o inválida'; END IF;
 started:=clock_timestamp();result:=public.erp_ref_sin_alta('{"limit":50,"solo_activas":true}');modal_ms:=round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,1);
 IF result->>'success' IS DISTINCT FROM 'true' OR jsonb_typeof(result->'filas')<>'array' THEN RAISE EXCEPTION 'CAJA C152 FAIL: modal sin alta activas'; END IF;
 started:=clock_timestamp();result:=public.erp_ref_sin_alta('{"limit":50,"solo_activas":false}');all_ms:=round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,1);
 IF result->>'success' IS DISTINCT FROM 'true' OR jsonb_typeof(result->'filas')<>'array' THEN RAISE EXCEPTION 'CAJA C152 FAIL: modal sin alta con todos los tipos'; END IF;
 IF greatest(ref_ms,modal_ms,all_ms)>=8000 THEN RAISE EXCEPTION 'CAJA C152 FAIL: supera presupuesto web (ms referencia %, modal activas %, todos %)',ref_ms,modal_ms,all_ms; END IF;
 IF has_function_privilege('anon','public.erp_ref_contratos(text[])','EXECUTE') OR has_function_privilege('anon','public.erp_ref_sin_alta(jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.erp_ot_actividad(text[])','EXECUTE') THEN RAISE EXCEPTION 'CAJA C152 FAIL: permisos de referencias expuestos'; END IF;
 RAISE EXCEPTION 'CAJA C152 PASS: referencias reales completas y privadas; códigos %, ms referencia %, modal activas %, todos %',cardinality(codes),ref_ms,modal_ms,all_ms;
END $test$;
ROLLBACK;
