-- Regresión del timeout de /contratos/servicios: consultar el bloque real de 200 servicios.
-- Solo lectura empresarial; los claims de prueba se revierten con la excepción PASS.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
DO $test$
DECLARE actor uuid; ids uuid[]; context jsonb; result jsonb; started timestamptz;
 elapsed_ms numeric; expected int; actual int; unique_services int;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id JOIN auth.users u ON u.id=p.id
 WHERE p.is_active AND r.name='Administrador' ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C218 FAIL: falta cuenta administradora para verificar tonelaje'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 SELECT ARRAY(SELECT s.id FROM public.contract_services s ORDER BY s.created_at DESC,s.id LIMIT 200) INTO ids;
 context:=public.get_service_registry_context(ids);
 SELECT count(*) INTO expected FROM jsonb_array_elements(context) c JOIN public.contract_services s ON s.id=(c->>'service_id')::uuid
 WHERE NULLIF(btrim(concat_ws(',',s.referral_guide,
   (SELECT string_agg(g,',') FROM jsonb_array_elements_text(c->'guide_numbers') g)),', '),'') IS NOT NULL;
 started:=clock_timestamp();
 SELECT COALESCE(jsonb_agg(to_jsonb(w)),'[]'::jsonb) INTO result FROM public.get_service_registry_weight(ids) w;
 elapsed_ms:=round((extract(epoch FROM clock_timestamp()-started)*1000)::numeric,1);
 actual:=jsonb_array_length(result);
 SELECT count(DISTINCT e->>'service_id') INTO unique_services FROM jsonb_array_elements(result) e;
 IF actual<>expected OR actual<>unique_services THEN RAISE EXCEPTION 'CAJA C218 FAIL: peso incompleto o servicios duplicados (% / %)',actual,expected; END IF;
 IF elapsed_ms>=8000 THEN RAISE EXCEPTION 'CAJA C218 FAIL: tonelaje supera presupuesto web: % ms',elapsed_ms; END IF;
 IF has_function_privilege('anon','public.get_service_registry_weight(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'CAJA C218 FAIL: tonelaje expuesto a anon'; END IF;
 RAISE EXCEPTION 'CAJA C218 PASS: tonelaje real por lote privado y completo; servicios %, con guía %, tiempo % ms',cardinality(ids),actual,elapsed_ms;
END $test$;
ROLLBACK;
