-- Transactional acceptance check for contract portfolio access.
-- Run with: npx supabase db query --linked --file scripts/verify-contract-portfolio.sql
-- All fixture role and assignment changes are rolled back.
BEGIN;
DO $$
DECLARE v_users uuid[]; v_a uuid; v_b uuid; v_admin uuid; v_role uuid;
DECLARE v_roots uuid[]; v_root1 uuid; v_root2 uuid; v_created uuid; v_site uuid;
DECLARE v_req1 uuid; v_req2 uuid; v_exp1 uuid; v_exp2 uuid;
DECLARE v_denied boolean := false;
BEGIN
  SELECT array_agg(id) INTO v_users FROM (
    SELECT p.id FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
    JOIN public.user_site_access usa ON usa.user_id=p.id
    WHERE p.is_active AND r.name <> 'Administrador' AND coalesce(p.employee_type,'') <> 'CONDUCTOR'
    ORDER BY p.id LIMIT 2) candidates;
  IF cardinality(v_users) <> 2 THEN RAISE EXCEPTION 'Need two active staff test users'; END IF;
  v_a := v_users[1]; v_b := v_users[2];
  SELECT id INTO v_role FROM public.roles WHERE name='Administrador de Contratos';
  SELECT p.id INTO v_admin FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
    WHERE p.is_active AND r.name='Administrador' LIMIT 1;
  SELECT array_agg(id) INTO v_roots FROM (SELECT id FROM public.contracts
    WHERE parent_contract_id IS NULL AND status='ACTIVO' ORDER BY id LIMIT 2) roots;
  IF cardinality(v_roots) <> 2 THEN RAISE EXCEPTION 'Need two active root OTs'; END IF;
  v_root1 := v_roots[1]; v_root2 := v_roots[2];
  SELECT site_id INTO v_site FROM public.contracts WHERE id=v_root1;
  UPDATE public.profiles SET role_id=v_role WHERE id IN (v_a,v_b);
  INSERT INTO public.contract_user_assignments(contract_id,user_id,role,assigned_by)
    VALUES(v_root1,v_a,'ADMIN_CONTRATO',v_admin);
  INSERT INTO public.transport_requests(request_number,site_id,contract_id,status,pickup_address,delivery_address,required_date)
    VALUES('SEC-REQ-' || substr(gen_random_uuid()::text,1,12),v_site,v_root1,'PENDIENTE','Origen','Destino',now())
    RETURNING id INTO v_req1;
  INSERT INTO public.transport_requests(request_number,site_id,contract_id,status,pickup_address,delivery_address,required_date)
    VALUES('SEC-REQ-' || substr(gen_random_uuid()::text,1,12),v_site,v_root2,'PENDIENTE','Origen','Destino',now())
    RETURNING id INTO v_req2;
  INSERT INTO public.expense_records(category,total_amount,contract_id)
    VALUES('SECURITY_DRYRUN',1,v_root1) RETURNING id INTO v_exp1;
  INSERT INTO public.expense_records(category,total_amount,contract_id)
    VALUES('SECURITY_DRYRUN',1,v_root2) RETURNING id INTO v_exp2;
  PERFORM set_config('request.jwt.claim.sub',v_a::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF NOT public.has_assigned_contract(v_root1) THEN RAISE EXCEPTION 'Assigned root invisible'; END IF;
  IF public.has_assigned_contract(v_root2) THEN RAISE EXCEPTION 'Foreign root assigned'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=v_root1) OR
    EXISTS(SELECT 1 FROM public.contracts WHERE id=v_root2) THEN
    RAISE EXCEPTION 'Contract RLS incorrect';
  END IF;
  IF EXISTS(SELECT 1 FROM public.vw_contracts_dashboard WHERE id=v_root2) THEN
    RAISE EXCEPTION 'Contract view bypasses RLS';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=v_req1) OR
    EXISTS(SELECT 1 FROM public.transport_requests WHERE id=v_req2) THEN
    RAISE EXCEPTION 'Request RLS incorrect';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.expense_records WHERE id=v_exp1) OR
    EXISTS(SELECT 1 FROM public.expense_records WHERE id=v_exp2) THEN
    RAISE EXCEPTION 'Expense RLS incorrect';
  END IF;
  IF (SELECT count(*) FROM public.get_transport_request_summaries(ARRAY[v_req1,v_req2])) <> 1 THEN
    RAISE EXCEPTION 'Request summaries leak foreign requests';
  END IF;
  BEGIN
    PERFORM 1 FROM public.get_transport_request_component_options(v_root2,NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%OT no disponible para este usuario%' THEN v_denied:=true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Foreign request components exposed'; END IF;
  v_denied := false;
  BEGIN
    PERFORM public.set_transport_request_status(v_req2,'CANCELADA',NULL);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%Solicitud no disponible%' THEN v_denied:=true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Foreign request status changed'; END IF;
  v_denied := false;
  BEGIN
    PERFORM public.save_transport_request(NULL,
      jsonb_build_object('contract_id',v_root2),
      jsonb_build_array(jsonb_build_object('contract_id',v_root2)));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%OT madre asignada%' THEN v_denied:=true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Foreign request creation allowed'; END IF;
  v_denied := false;
  BEGIN
    PERFORM public.register_contract_service(v_root2,'SECURITY_DRYRUN','Prueba',0,current_date);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%OT no asignada%' THEN v_denied:=true;
    ELSE RAISE; END IF;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'Foreign contract service created'; END IF;
  PERFORM 1 FROM public.get_tower_dispatches(NULL,NULL,'TODOS') LIMIT 1;
  SELECT public.create_portfolio_contract(jsonb_build_object(
    'code','SECURITY-DRYRUN-' || substr(gen_random_uuid()::text,1,8),
    'type','OT_INDEPENDIENTE','site_id',v_site),0) INTO v_created;
  IF NOT public.has_assigned_contract(v_created,true) THEN
    RAISE EXCEPTION 'Creator assignment missing';
  END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',v_admin::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.reassign_contract_administrator(v_root1,v_b,'Prueba transaccional');
  IF NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=v_root2) THEN
    RAISE EXCEPTION 'System admin lost global visibility';
  END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub',v_a::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF public.has_assigned_contract(v_root1) OR EXISTS(SELECT 1 FROM public.contracts WHERE id=v_root1) THEN
    RAISE EXCEPTION 'Former owner kept access';
  END IF;
  PERFORM set_config('request.jwt.claim.sub',v_b::text,true);
  IF NOT public.has_assigned_contract(v_root1) OR NOT EXISTS(SELECT 1 FROM public.contracts WHERE id=v_root1) THEN
    RAISE EXCEPTION 'New owner lacks access';
  END IF;
  EXECUTE 'RESET ROLE';
  IF (SELECT count(*) FROM public.contract_user_assignments WHERE contract_id=v_root1 AND role='ADMIN_CONTRATO') <> 2 THEN
    RAISE EXCEPTION 'Reassignment history missing';
  END IF;
END $$;



ROLLBACK;
