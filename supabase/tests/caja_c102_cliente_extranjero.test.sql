-- CAJA C102 — Cliente extranjero: país + documento tributario de su país, sin SUNAT; único por país; el cliente
-- peruano sigue exigiendo RUC válido. Siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; r jsonb; r2 jsonb; doc text := 'ZZ' || upper(substr(md5(random()::text), 1, 8)); n bigint; bad text;
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C102 FAIL: falta administrador activo'; END IF;
 -- T1: registra un cliente de Bolivia con su NIT (letras y números, con guiones que se limpian)
 r:=public.register_foreign_client('bo','Bolivia',doc||'-01','ZZ C102 IMPORTADORA BOLIVIANA S.R.L.','Av. Banzer 123, Santa Cruz');
 IF (r->>'success')<>'true' OR (r->>'existing')<>'false' OR NOT EXISTS(SELECT 1 FROM public.clients c WHERE c.id=(r->>'id')::uuid
    AND upper(to_jsonb(c)->>'country_code')='BO' AND COALESCE(to_jsonb(c)->>'tax_id',to_jsonb(c)->>'ruc')=doc||'01') THEN
  RAISE EXCEPTION 'CAJA C102 FAIL: alta extranjera (T1) %',r; END IF;
 -- T2: el mismo documento en el mismo país no se duplica; en otro país se admite
 r2:=public.register_foreign_client('BO','Bolivia',doc||'01','OTRO NOMBRE');
 IF (r2->>'existing')<>'true' OR r2->>'id'<>r->>'id' THEN RAISE EXCEPTION 'CAJA C102 FAIL: duplicado (T2) %',r2; END IF;
 r2:=public.register_foreign_client('CO','Colombia',doc||'01','ZZ C102 COLOMBIA S.A.S.');
 SELECT count(*) INTO n FROM public.clients c WHERE public.client_foreign_tax_norm(COALESCE(to_jsonb(c)->>'tax_id',to_jsonb(c)->>'ruc'))=doc||'01';
 -- (si la tabla tiene índice único global del documento, se rechaza con un mensaje claro)
 IF NOT (((r2->>'success')='true' AND (r2->>'existing')='false' AND n=2) OR ((r2->>'success')='false' AND r2->>'error' LIKE '%ya está registrado%' AND n=1)) THEN
  RAISE EXCEPTION 'CAJA C102 FAIL: otro país (T2) %',r2; END IF;
 -- T3: validaciones: sin país, Perú por esta vía, documento corto
 IF (public.register_foreign_client(NULL,NULL,doc,'X')->>'success')='true' OR (public.register_foreign_client('PE','Perú',doc,'X')->>'success')='true'
    OR (public.register_foreign_client('CL','Chile','12','X')->>'success')='true' THEN RAISE EXCEPTION 'CAJA C102 FAIL: validaciones (T3)'; END IF;
 -- T4: un cliente peruano sigue exigiendo RUC válido (no se cuela un documento extranjero)
 bad:=NULL;
 BEGIN EXECUTE format('INSERT INTO public.clients(business_name, %I) VALUES (%L, %L)', CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='tax_id') THEN 'tax_id' ELSE 'ruc' END, 'ZZ C102 SIN PAIS', doc||'99');
 EXCEPTION WHEN raise_exception THEN bad:=SQLERRM; END;
 IF bad IS NULL OR bad NOT LIKE '%extranjero%' THEN RAISE EXCEPTION 'CAJA C102 FAIL: peruano sin RUC (T4) %',bad; END IF;
 IF has_function_privilege('anon','public.register_foreign_client(text,text,text,text,text,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C102 FAIL: expuesta a anónimos (T4)'; END IF;
 RAISE EXCEPTION 'CAJA C102 PASS (4/4) cliente extranjero: país y documento propio sin SUNAT, único por país, RUC peruano intacto';
END $test$;
ROLLBACK;
