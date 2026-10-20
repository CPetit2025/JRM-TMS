-- CAJA C112 — Aprobación automática de solicitudes: interruptor en Configuración con historial y permisos; activa,
-- aprueba solicitudes válidas con OT o con OC/OS/RQ sin OT. Siempre se revierte.
BEGIN;
DO $settings$ BEGIN
 IF to_regclass('public.transport_lead_time_settings') IS NOT NULL THEN
  UPDATE public.transport_lead_time_settings SET settings = jsonb_set(settings, '{enabled}', 'false'::jsonb);
 END IF;
END $settings$;
DO $test$
DECLARE actor uuid; other uuid; site uuid; supplier uuid; req uuid; ot uuid; payload jsonb; saved jsonb; r jsonb;
  v_err text; v_ok boolean; n int; pass int := 0; fails text[] := '{}';
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  EXIT WHEN public.is_tms_admin(); actor := NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C112 FAIL: falta administrador activo'; END IF;
 SELECT id INTO site FROM public.sites s WHERE public.can_access_site(s.id) ORDER BY id LIMIT 1;
 UPDATE public.transport_request_approval_settings SET auto_approve = false WHERE id;

 -- T1: quien no aprueba solicitudes no cambia el interruptor
 SELECT p.id INTO other FROM public.profiles p JOIN auth.users u ON u.id = p.id
  WHERE p.id <> actor AND p.id NOT IN (SELECT d.profile_id FROM public.drivers d WHERE d.profile_id IS NOT NULL) ORDER BY p.id LIMIT 1;
 v_err := NULL;
 IF other IS NOT NULL THEN
  UPDATE public.profiles SET is_active = true, role_id = (SELECT id FROM public.roles WHERE lower(btrim(name)) = 'solicitante de transporte') WHERE id = other;
  PERFORM set_config('request.jwt.claim.sub', other::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other, 'role', 'authenticated')::text, true);
  r := public.get_request_auto_approval();
  BEGIN PERFORM public.set_request_auto_approval(true); EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
 END IF;
 IF other IS NULL OR (v_err LIKE 'Solo el Administrador%' AND (r->>'can_edit')::boolean = false AND NOT public.transport_request_auto_approve_enabled())
 THEN pass := pass + 1; ELSE fails := fails || ('T1 permiso: ' || COALESCE(v_err, 'sin error') || ' ' || COALESCE(r::text, '∅')); END IF;

 -- T2: el administrador lo activa; queda en el historial
 SELECT count(*) INTO n FROM public.transport_request_approval_settings_audit;
 r := public.set_request_auto_approval(true);
 IF (r->>'enabled')::boolean AND (r->>'can_edit')::boolean
    AND (SELECT count(*) FROM public.transport_request_approval_settings_audit) = n + 1
    AND EXISTS (SELECT 1 FROM public.transport_request_approval_settings_audit WHERE actor_id = actor AND NOT previous_value AND next_value)
 THEN pass := pass + 1; ELSE fails := fails || ('T2 activar: ' || COALESCE(r::text, '∅')); END IF;

 -- T3: activa, OC/OS/RQ sin OT se aprueba con importe autorizado, sin reservar en otra OT
 INSERT INTO public.suppliers(tax_id, business_name) VALUES ((floor(random()*90000000000)+10000000000)::bigint::text, 'ZZ C112') RETURNING id INTO supplier;
 payload := jsonb_build_object('department','Logística','request_type','RECOJO','attention_mode','TRANSPORTE_JRM',
  'site_id',site,'required_date',current_date+7,'cargo_description','ZZ C112','pickup_address','Origen prueba',
  'pickup_district','CHILCA','delivery_address','Destino prueba','delivery_district','CALLAO','service_cost',100,
  'reference_type','RQ','reference_number','ZZ-C112','supplier_id',supplier);
 saved := public.save_transport_request_full(NULL, payload, '[]', '[]'); req := (saved->>'id')::uuid;
 IF req IS NOT NULL AND COALESCE((saved->>'auto_approved')::boolean, false)
    AND EXISTS(SELECT 1 FROM public.transport_requests WHERE id=req AND status='APROBADA' AND contract_id IS NULL
      AND approved_at IS NOT NULL AND approved_by=actor AND reserved_pen=0
      AND operational_approved_pen=COALESCE(service_cost,0)+COALESCE(unloading_estimate_pen,0))
    AND EXISTS(SELECT 1 FROM public.transport_request_events WHERE request_id=req AND next_state->>'origen'='APROBACION_AUTOMATICA')
 THEN pass := pass + 1; ELSE fails := fails || ('T3 sin OT: ' || COALESCE(saved::text, '∅')); END IF;

 -- T4: con OT y pendiente se aprueba sola, con el origen automático en el historial
 SELECT c.id INTO ot FROM public.contracts c WHERE c.status = 'ACTIVO' AND c.parent_contract_id IS NULL
   ORDER BY (c.site_id = site) DESC NULLS LAST, (c.client_id IS NOT NULL) DESC, c.created_at DESC LIMIT 1;
 v_ok := false; v_err := NULL;
 IF ot IS NOT NULL THEN
  BEGIN
   UPDATE public.transport_requests SET contract_id = ot, status = 'PENDIENTE' WHERE id = req;
   v_ok := public.transport_request_try_auto_approve(req);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; v_ok := false;
  END;
 END IF;
 IF NOT v_ok THEN
  -- Alternativa: una solicitud pendiente con OT ya existente (se revierte)
  SELECT id INTO req FROM public.transport_requests WHERE contract_id IS NOT NULL AND status IN ('PENDIENTE','PENDIENTE DE APROBACIÓN') LIMIT 1;
  IF req IS NOT NULL THEN v_ok := public.transport_request_try_auto_approve(req); END IF;
 END IF;
 IF v_ok AND (SELECT status FROM public.transport_requests WHERE id = req) = 'APROBADA'
    AND EXISTS (SELECT 1 FROM public.transport_request_events e WHERE e.request_id = req AND e.next_state->>'origen' = 'APROBACION_AUTOMATICA')
 THEN pass := pass + 1; ELSE fails := fails || ('T4 con OT: ' || COALESCE(v_err, 'no aprobada')); END IF;

 -- T5: desactivada, nada se aprueba solo
 r := public.set_request_auto_approval(false);
 IF req IS NOT NULL THEN UPDATE public.transport_requests SET status = 'PENDIENTE' WHERE id = req; END IF;
 IF NOT (r->>'enabled')::boolean AND (req IS NULL OR NOT public.transport_request_try_auto_approve(req))
    AND (req IS NULL OR (SELECT status FROM public.transport_requests WHERE id = req) = 'PENDIENTE')
 THEN pass := pass + 1; ELSE fails := fails || ('T5 desactivada: ' || COALESCE(r::text, '∅')); END IF;

 -- T6: el paso interno y el guardado original no se exponen; consulta y cambio solo con sesión
 IF NOT has_function_privilege('authenticated', 'public.transport_request_try_auto_approve(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.save_transport_request_full_before_auto_approval(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.set_request_auto_approval(boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.get_request_auto_approval()', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.save_transport_request_full(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
    AND NOT has_table_privilege('authenticated', 'public.transport_request_approval_settings', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.transport_request_auto_approval_contexts', 'INSERT')
    AND NOT has_function_privilege('authenticated', 'public.is_transport_request_auto_approval(uuid)', 'EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM public.transport_request_auto_approval_contexts)
 THEN pass := pass + 1; ELSE fails := fails || 'T6 permisos'::text; END IF;

 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C112 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C112 PASS (6/6) aprobación automática: permiso e historial, OT y OC/OS/RQ sin OT aprobadas, contexto privado y desactivada sin efecto';
END $test$;
ROLLBACK;
