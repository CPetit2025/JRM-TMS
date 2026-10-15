-- CAJA C105 — Margen operativo ampliable de la partida (80 % por defecto): por OT o por cliente, con motivo,
-- vencimiento e historial; la OT prevalece sobre el cliente y al revocar vuelve al margen anterior. Siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; other uuid; v_site uuid; v_client uuid; ct uuid; sub uuid; r jsonb; bad text; n int;
  pass int := 0; fails text[] := '{}';
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  EXIT WHEN public.is_tms_admin(); actor := NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C105 FAIL: falta administrador activo'; END IF;
 SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
 SELECT id INTO v_client FROM public.clients ORDER BY id LIMIT 1;
 INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES ('ZZ-C105-OT', 'CONTRATO', 'ACTIVO', v_site, v_client) RETURNING id INTO ct;
 INSERT INTO public.contracts (code, type, status, site_id, client_id, parent_contract_id) VALUES ('ZZ-C105-SUB', 'CONTRATO', 'ACTIVO', v_site, v_client, ct) RETURNING id INTO sub;
 UPDATE public.contract_budgets SET allocated_pen = 1000 WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE';
 IF NOT FOUND THEN INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (ct, 'PARTIDA_TRANSPORTE', 1000); END IF;
 -- Otra OT del mismo cliente con ampliación de cliente vigente previa: se aísla la prueba
 UPDATE public.transport_margin_overrides SET active = false WHERE active AND (client_id = v_client OR contract_id = ct);
 PERFORM public.transport_margin_refresh(ct, NULL);

 -- T1: por defecto 80 % operativo
 IF public.transport_operating_pct(sub) = 80 AND (SELECT balance_pen FROM public.contract_budgets WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE') = 800
 THEN pass := pass + 1; ELSE fails := fails || 'T1 80 % por defecto'::text; END IF;

 -- T2: validaciones (margen fuera de rango, motivo corto, vencimiento pasado) y permisos
 IF (public.set_transport_margin(ct, 'OT', 80, 'Motivo suficiente')->>'success') = 'false'
    AND (public.set_transport_margin(ct, 'OT', 101, 'Motivo suficiente')->>'success') = 'false'
    AND (public.set_transport_margin(ct, 'OT', 85, 'corto')->>'success') = 'false'
    AND (public.set_transport_margin(ct, 'OT', 85, 'Motivo suficiente', current_date - 5)->>'success') = 'false'
 THEN pass := pass + 1; ELSE fails := fails || 'T2 validaciones'::text; END IF;
 SELECT p.id INTO other FROM public.profiles p JOIN auth.users u ON u.id = p.id JOIN public.roles ro ON ro.id = p.role_id
  WHERE p.is_active AND lower(btrim(ro.name)) NOT IN ('administrador', 'jefe de distribución', 'jefe de distribucion') LIMIT 50;
 IF other IS NOT NULL THEN
  PERFORM set_config('request.jwt.claim.sub', other::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  IF NOT public.is_tms_admin() AND (public.set_transport_margin(ct, 'OT', 85, 'Sin permiso para esto')->>'success') = 'true' THEN
   fails := fails || 'T2 permiso'::text; END IF;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
 END IF;

 -- T3: ampliación por OT al 85 %: la familia (subcontrato) usa el mismo margen y la reserva de 840 cabe
 r := public.set_transport_margin(sub, 'OT', 85, 'Cliente X: mayor gasto operativo por acceso a mina');
 BEGIN UPDATE public.contract_budgets SET reserved_pen = 840 WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE'; bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF (r->>'success') = 'true' AND public.transport_operating_pct(sub) = 85 AND bad IS NULL
    AND (SELECT balance_pen FROM public.contract_budgets WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE') = 10
    AND (public.get_transport_margin(sub)->>'source') = 'OT'
 THEN pass := pass + 1; ELSE fails := fails || ('T3 OT 85 %: ' || COALESCE(r::text, '∅') || ' ' || COALESCE(bad, '')); END IF;

 -- T4: ampliación de cliente al 90 %: la de la OT prevalece; al revocar la OT rige la del cliente
 IF v_client IS NOT NULL THEN
  r := public.set_transport_margin(ct, 'CLIENTE', 90, 'Cliente X: campaña con accesos especiales');
  IF public.transport_operating_pct(ct) <> 85 THEN fails := fails || 'T4 OT prevalece'::text; END IF;
  r := public.revoke_transport_margin((public.get_transport_margin(ct)->'current'->>'id')::uuid, 'Se cerró la casuística de la OT');
  IF (r->>'success') = 'true' AND public.transport_operating_pct(ct) = 90
     AND (SELECT balance_pen FROM public.contract_budgets WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE') = 60
     AND (public.get_transport_margin(ct)->>'source') = 'CLIENTE'
  THEN pass := pass + 1; ELSE fails := fails || ('T4 cliente: ' || COALESCE(r::text, '∅')); END IF;
  r := public.revoke_transport_margin((public.get_transport_margin(ct)->'current'->>'id')::uuid, 'Fin de la campaña del cliente');
 ELSE pass := pass + 1; END IF;

 -- T5: sin ampliación vuelve al 80 %: lo ya reservado se conserva, pero no se puede reservar más
 BEGIN UPDATE public.contract_budgets SET reserved_pen = 850 WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE'; bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF public.transport_operating_pct(ct) = 80 AND bad LIKE '%margen operativo%80 %%'
    AND (SELECT reserved_pen = 840 AND balance_pen = -40 FROM public.contract_budgets WHERE contract_id = ct AND concept = 'PARTIDA_TRANSPORTE')
    AND jsonb_array_length(public.get_transport_margin(ct)->'history') >= 2
 THEN pass := pass + 1; ELSE fails := fails || ('T5 revocado: ' || COALESCE(bad, '∅')); END IF;

 -- T6: una ampliación vencida no rige y el proceso diario la desactiva
 INSERT INTO public.transport_margin_overrides(scope, contract_id, operating_pct, reason, valid_until, created_by)
 VALUES ('OT', ct, 95, 'Ampliación de prueba ya vencida', (now() AT TIME ZONE 'America/Lima')::date - 1, actor);
 n := public.transport_margin_expire();
 IF public.transport_operating_pct(ct) = 80 AND n >= 1 AND NOT EXISTS (SELECT 1 FROM public.transport_margin_overrides WHERE contract_id = ct AND active)
 THEN pass := pass + 1; ELSE fails := fails || 'T6 vencimiento'::text; END IF;

 IF has_function_privilege('anon', 'public.set_transport_margin(uuid,text,numeric,text,date)', 'EXECUTE') THEN fails := fails || 'anon'::text; END IF;
 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C105 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C105 PASS (6/6) margen operativo ampliable: 80 %% por defecto, OT y cliente con motivo, prioridad OT, revocación, vencimiento e historial';
END $test$;
ROLLBACK;
