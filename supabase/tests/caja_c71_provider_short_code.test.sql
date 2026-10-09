-- Real issuer, unique codes and private permissions; the final exception rolls back all fixtures.
BEGIN;
CREATE FUNCTION pg_temp.c71_ins(p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 EXECUTE (SELECT format('INSERT INTO public.dispatches (%s) VALUES (%s) RETURNING id',
   string_agg(quote_ident(k.key),','),string_agg(quote_nullable(k.value #>> '{}'),',')) FROM jsonb_each(p_cols) k
   WHERE EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name='dispatches' AND c.column_name=k.key)) INTO v_id;
 RETURN v_id;
END $$;
DO $$ DECLARE d uuid; site uuid; actor uuid; code text; r jsonb; i integer; BEGIN
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF site IS NULL THEN RAISE EXCEPTION 'CAJA C71 FAIL: falta sede'; END IF;
 SELECT id INTO actor FROM public.profiles LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C71 FAIL: falta perfil'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 d:=pg_temp.c71_ins(jsonb_build_object('id',gen_random_uuid(),'dispatch_number','ZZ-C71-'||gen_random_uuid()::text,
   'vehicle_plate','ZZ71'||substr(gen_random_uuid()::text,1,6),'status','PROGRAMADO','site_id',site,
   'scheduled_departure',now(),'modalidad','TERCERO','docs_required',false));
 SELECT access_code INTO code FROM public.dispatch_tercero_enlaces WHERE dispatch_id=d AND revoked_at IS NULL;
 IF code IS NULL OR code !~ '^[a-z0-9]{4}$' THEN RAISE EXCEPTION 'CAJA C71 FAIL: generación automática'; END IF;
 FOR i IN 1..20 LOOP
   r:=public.delivery_issue_access_core(d);
   IF r->>'codigo' !~ '^[a-z0-9]{4}$' OR r->>'codigo'=code OR length(r->>'token')<>64 THEN
     RAISE EXCEPTION 'CAJA C71 FAIL: formato o reutilización'; END IF;
   code:=r->>'codigo';
 END LOOP;
 IF (SELECT count(*) FROM public.dispatch_tercero_enlaces WHERE dispatch_id=d AND revoked_at IS NULL)<>1
    OR has_function_privilege('anon','public.delivery_issue_access_core(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','public.delivery_issue_access_core(uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C71 FAIL: renovación o permisos'; END IF;
 RAISE EXCEPTION 'CAJA C71 PASS: códigos de 4 caracteres, renovación, unicidad y emisor privado';
END $$;
ROLLBACK;
