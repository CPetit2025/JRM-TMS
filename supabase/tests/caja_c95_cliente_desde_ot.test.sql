-- CAJA C95 — Alta de OT: registrar el cliente desde el modal. Valida RUC, no duplica, reactiva y respeta permisos.
BEGIN;
DO $test$
DECLARE actor uuid; v_ruc text; base text; d int; r jsonb; r2 jsonb; n bigint;
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  EXIT WHEN public.is_tms_admin(); actor:=NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C95 FAIL: falta administrador activo'; END IF;
 -- RUC válido nuevo: prefijo 20 + 8 dígitos al azar + dígito verificador
 LOOP
  base:='20'||lpad((floor(random()*100000000))::bigint::text,8,'0');
  v_ruc:=NULL;
  FOR d IN 0..9 LOOP IF public.is_valid_ruc(base||d) THEN v_ruc:=base||d; EXIT; END IF; END LOOP;
  EXIT WHEN v_ruc IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.clients c WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id',to_jsonb(c)->>'ruc'))=v_ruc);
 END LOOP;

 -- T1: registra el cliente nuevo con los datos de SUNAT
 r:=public.register_contract_client(v_ruc,'ZZ C95 CLIENTE S.A.C.','Av. Prueba 123',NULL,NULL,NULL,'ACTIVO / HABIDO');
 IF (r->>'success')<>'true' OR (r->>'existing')<>'false' OR NOT EXISTS(SELECT 1 FROM public.clients c WHERE c.id=(r->>'id')::uuid AND COALESCE((to_jsonb(c)->>'is_active')::boolean,true) AND c.sunat_status='ACTIVO / HABIDO') THEN
  RAISE EXCEPTION 'CAJA C95 FAIL: alta del cliente (T1) %',r; END IF;
 -- T2: el mismo RUC no se duplica: devuelve el existente y lo reactiva
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='is_active') THEN
  EXECUTE 'UPDATE public.clients SET is_active=false WHERE id=$1' USING (r->>'id')::uuid; END IF;
 r2:=public.register_contract_client(v_ruc,'OTRO NOMBRE');
 SELECT count(*) INTO n FROM public.clients c WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id',to_jsonb(c)->>'ruc'))=v_ruc;
 IF (r2->>'existing')<>'true' OR r2->>'id'<>r->>'id' OR n<>1 OR NOT (SELECT COALESCE((to_jsonb(c)->>'is_active')::boolean,true) FROM public.clients c WHERE c.id=(r->>'id')::uuid) THEN
  RAISE EXCEPTION 'CAJA C95 FAIL: duplicado o reactivación (T2) %',r2; END IF;
 -- T3: RUC con dígito verificador inválido se rechaza con mensaje
 r:=public.register_contract_client(base||((right(v_ruc,1)::int+1)%10),'ZZ C95 INVALIDO');
 IF (r->>'success')<>'false' OR r->>'error' NOT LIKE '%RUC%' THEN RAISE EXCEPTION 'CAJA C95 FAIL: RUC inválido aceptado (T3) %',r; END IF;
 -- T4: anónimos no pueden ejecutarla
 IF has_function_privilege('anon','public.register_contract_client(text,text,text,text,text,text,text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C95 FAIL: expuesta a anónimos (T4)'; END IF;
 RAISE EXCEPTION 'CAJA C95 PASS (4/4) cliente desde el alta de OT: RUC SUNAT, sin duplicados, reactivación y permisos';
END $test$;
ROLLBACK;
