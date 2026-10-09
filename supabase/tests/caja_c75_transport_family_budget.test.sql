BEGIN;
CREATE FUNCTION pg_temp.ins(p_table text,p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; BEGIN
 EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id',p_table,
 string_agg(quote_ident(k.key),', '),string_agg(quote_nullable(k.value #>> '{}'),', ')) FROM jsonb_each(p_cols) k
 WHERE EXISTS(SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema='public' AND ic.table_name=p_table AND ic.column_name=k.key)) INTO v_id;
 RETURN v_id;
END $$;
DO $test$
DECLARE actor uuid; site uuid; v_role uuid; mother uuid; sub uuid; err uuid; nested uuid; unrelated uuid;
 r jsonb; bad boolean; b record; suffix text:=replace(gen_random_uuid()::text,'-','');
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) LIMIT 1;
 SELECT site_id INTO site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C75 FAIL: faltan perfil y sede'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C75 '||suffix,'["ot","clientes","contratos-servicios"]') RETURNING id INTO v_role;
 UPDATE public.profiles SET role_id=v_role,is_active=true WHERE id=actor;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 r:=public.create_contract(jsonb_build_object('code','ZZ-C75-'||suffix,'type','CONTRATO','site_id',site),1000);
 IF r->>'success'<>'true' THEN RAISE EXCEPTION 'CAJA C75 FAIL: alta madre %',r; END IF;
 mother:=(r->>'id')::uuid;
 r:=public.create_contract(jsonb_build_object('code','ZZ-C75-'||suffix||'-S01','type','SUBCONTRATO','parent_contract_id',mother),200);
 IF r->>'success'<>'true' THEN RAISE EXCEPTION 'CAJA C75 FAIL: alta sub %',r; END IF;
 sub:=(r->>'id')::uuid;
 r:=public.create_contract(jsonb_build_object('code','ZZ-C75-'||suffix||'-E014','type','ERROR','parent_contract_id',mother),300);
 IF r->>'success'<>'true' THEN RAISE EXCEPTION 'CAJA C75 FAIL: alta error %',r; END IF;
 err:=(r->>'id')::uuid;
 SELECT * INTO b FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE';
 IF b.allocated_pen<>1500 OR b.own_allocated_pen<>1000 OR b.balance_pen<>1200 THEN RAISE EXCEPTION 'CAJA C75 FAIL: madre1000+sub200+error300 %',row_to_json(b); END IF;
 IF (SELECT allocated_pen FROM public.vw_contracts_dashboard WHERE id=mother)<>1500 THEN RAISE EXCEPTION 'CAJA C75 FAIL: resumen no consolidado'; END IF;
 IF public.contract_budget_owner(err)<>mother THEN RAISE EXCEPTION 'CAJA C75 FAIL: error consume otra partida'; END IF;
 -- Error bajo subcontrato: cuenta una sola vez, independientemente del código.
 nested:=pg_temp.ins('contracts',jsonb_build_object('code','ZZ-C75-'||suffix||'-S01-E01','type','ERROR','parent_contract_id',sub,'site_id',site,'status','ACTIVO'));
 INSERT INTO public.contract_budgets(contract_id,concept,allocated_pen) VALUES(nested,'PARTIDA_TRANSPORTE',100);
 IF (SELECT allocated_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>1600 THEN RAISE EXCEPTION 'CAJA C75 FAIL: descendiente duplicado o ausente'; END IF;
 -- Gastos históricos en hijo y nuevas reservas en raíz consumen el mismo límite.
 UPDATE public.contract_budgets SET consumed_pen=40 WHERE contract_id=err AND concept='PARTIDA_TRANSPORTE';
 UPDATE public.contract_budgets SET reserved_pen=1100 WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE';
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>140 THEN RAISE EXCEPTION 'CAJA C75 FAIL: pierde gasto histórico'; END IF;
 PERFORM public.register_contract_service(err,'OTROS','ZZ C75 gasto del error',50,current_date);
 IF (SELECT balance_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>90 OR
 NOT EXISTS(SELECT 1 FROM public.contract_services WHERE contract_id=err AND budget_contract_id=mother AND amount_pen=50) THEN
  RAISE EXCEPTION 'CAJA C75 FAIL: gasto del error no descuenta la misma familia';
 END IF;

 bad:=false; BEGIN UPDATE public.contract_budgets SET reserved_pen=1241 WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE'; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C75 FAIL: consume utilidad'; END IF;
 bad:=false; BEGIN UPDATE public.contract_budgets SET reserved_pen=150 WHERE contract_id=sub AND concept='PARTIDA_TRANSPORTE'; EXCEPTION WHEN raise_exception THEN bad:=true; END;
 IF NOT bad THEN RAISE EXCEPTION 'CAJA C75 FAIL: doble gasto por hijo'; END IF;
 UPDATE public.contract_budgets SET reserved_pen=0 WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE';
 UPDATE public.contract_budgets SET own_allocated_pen=1600 WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE';
 IF (SELECT allocated_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>2200 THEN RAISE EXCEPTION 'CAJA C75 FAIL: edición aporte igual al antiguo total'; END IF;
 UPDATE public.contract_budgets SET allocated_pen=350 WHERE contract_id=err AND concept='PARTIDA_TRANSPORTE';
 UPDATE public.contract_budgets SET updated_at=now() WHERE contract_id=err AND concept='PARTIDA_TRANSPORTE';
 IF (SELECT allocated_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>2250 THEN RAISE EXCEPTION 'CAJA C75 FAIL: edita y refresca con duplicación'; END IF;
 DELETE FROM public.contract_budgets WHERE contract_id=nested AND concept='PARTIDA_TRANSPORTE';
 IF (SELECT allocated_pen FROM public.contract_budgets WHERE contract_id=mother AND concept='PARTIDA_TRANSPORTE')<>2150 THEN RAISE EXCEPTION 'CAJA C75 FAIL: eliminación no refresca'; END IF;
 IF has_function_privilege('anon','public.transport_family_totals(uuid)','EXECUTE') OR has_function_privilege('authenticated','public.transport_family_refresh()','EXECUTE') THEN RAISE EXCEPTION 'CAJA C75 FAIL: permisos públicos'; END IF;
 RAISE EXCEPTION 'CAJA C75 PASS: alta real madre+sub+error, anidación, aporte propio, saldo 80%%, histórico, reserva y no duplicación';
END $test$;
ROLLBACK;
