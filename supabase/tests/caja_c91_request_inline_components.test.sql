-- Alta de variantes sin partida; conserva familia y bloquea la OT omitida.
BEGIN;
DO $test$
DECLARE actor uuid; root public.contracts%ROWTYPE; result jsonb; child uuid;
  definition text; rejected boolean; suffix text;
BEGIN
  FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.is_active LOOP
    PERFORM set_config('request.jwt.claim.sub',actor::text,true);
    PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
    EXIT WHEN public.is_tms_admin(); actor:=NULL;
  END LOOP;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C91 FAIL: falta administrador activo'; END IF;
  SELECT * INTO root FROM public.contracts c WHERE c.status='ACTIVO' AND c.parent_contract_id IS NULL
    AND c.type IN ('CONTRATO','OT_INDEPENDIENTE') AND c.client_id IS NOT NULL AND public.can_access_site(c.site_id)
    ORDER BY c.code LIMIT 1;
  IF root.id IS NULL THEN RAISE EXCEPTION 'CAJA C91 FAIL: falta OT madre activa con cliente'; END IF;
  suffix:='E'||(floor(random()*900000000)+100000000)::bigint::text;
  result:=public.create_transport_request_component(root.id,'ERROR',suffix);
  IF NOT coalesce((result->>'success')::boolean,false) THEN RAISE EXCEPTION 'CAJA C91 FAIL: alta %',result; END IF;
  child:=(result->>'id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=child AND c.parent_contract_id=root.id
      AND c.type='ERROR' AND c.site_id=root.site_id AND c.client_id=root.client_id AND c.created_by=actor AND c.code=root.code||'-'||suffix)
    OR EXISTS(SELECT 1 FROM public.contract_budgets b WHERE b.contract_id=child AND coalesce(b.allocated_pen,0)>0) THEN
    RAISE EXCEPTION 'CAJA C91 FAIL: no heredó familia o creó partida no autorizada';
  END IF;
  result:=public.create_transport_request_component(root.id,'ERROR',suffix);
  IF coalesce((result->>'success')::boolean,false) THEN RAISE EXCEPTION 'CAJA C91 FAIL: duplicó variante'; END IF;
  rejected:=false;
  BEGIN PERFORM public.create_transport_request_component(child,'ERROR','E999');
  EXCEPTION WHEN raise_exception THEN rejected:=SQLERRM LIKE 'Seleccione una OT madre%'; END;
  IF NOT rejected THEN RAISE EXCEPTION 'CAJA C91 FAIL: admitió hijo como madre'; END IF;
  rejected:=false;
  BEGIN PERFORM public.save_transport_request(NULL,jsonb_build_object('department','Logística'),'[]');
  EXCEPTION WHEN raise_exception THEN rejected:=SQLERRM LIKE 'Seleccione una OT madre%'; END;
  IF NOT rejected THEN RAISE EXCEPTION 'CAJA C91 FAIL: permite guardar solicitud sin madre'; END IF;
  IF has_function_privilege('anon','public.create_transport_request_component(uuid,text,text)','EXECUTE')
    OR has_function_privilege('anon','public.enforce_request_mother_client_write()','EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C91 FAIL: ejecución anónima';
  END IF;
  SELECT pg_get_functiondef('public.enforce_request_mother_client_write()'::regprocedure) INTO definition;
  IF position('current_user' IN definition)=0 OR NOT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.transport_requests'::regclass AND tgname='enforce_request_mother_client_write' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'CAJA C91 FAIL: falta control de escritura directa';
  END IF;
  RAISE EXCEPTION 'CAJA C91 PASS: variantes sin partida, madre obligatoria y accesos protegidos';
END $test$;
ROLLBACK;
