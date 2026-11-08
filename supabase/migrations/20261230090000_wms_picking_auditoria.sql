-- Picking, consolidación LPN, auditoría en paralelo y Packing List liberado.
-- Reutiliza wh_tasks / wh_packages / wh_lpns / wh_scan_events. Agrega solo: sincronización de solicitudes TMS,
-- estado de auditoría por LPN, historial de auditoría, versiones de Packing List y evidencias.

-- 1. Sincronización TMS -> WMS ------------------------------------------------------------------------------
ALTER TABLE public.wh_tasks ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

CREATE TABLE IF NOT EXISTS public.wh_tms_sync_state (
  id integer PRIMARY KEY CHECK (id = 1),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_count integer,
  last_error text
);
INSERT INTO public.wh_tms_sync_state(id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE public.wh_tms_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_tms_sync_state FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS wh_transport_request_sync ON public.transport_requests;
CREATE TRIGGER wh_transport_request_sync AFTER INSERT OR UPDATE OF status, request_type ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.wh_sync_transport_request();

CREATE OR REPLACE FUNCTION public.wh_any_warehouse_permission()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.wh_has_permission(ARRAY['almacen-lectura','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor','almacen-auditoria'])
$$;

CREATE OR REPLACE FUNCTION public.wh_profile_name(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.email) FROM public.profiles p WHERE p.id = p_id
$$;

-- Reserva un turno de sincronización (como máximo uno por minuto, sin carreras entre pestañas) y devuelve las
-- solicitudes que el WMS ya conoce y siguen abiertas, para que el TMS informe su estado actual. NULL = no toca.
CREATE OR REPLACE FUNCTION public.wh_tms_sync_claim(p_force boolean DEFAULT false)
RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  UPDATE public.wh_tms_sync_state SET last_run_at = now()
   WHERE id = 1 AND (last_run_at IS NULL OR last_run_at < now() - CASE WHEN p_force THEN interval '10 seconds' ELSE interval '60 seconds' END);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT array_agg(transport_request_id) FROM public.wh_tasks WHERE status NOT IN ('LOADED','RECONCILED','CANCELLED')), '{}');
END $$;

CREATE OR REPLACE FUNCTION public.wh_tms_sync_fail(p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  UPDATE public.wh_tms_sync_state SET last_error = left(coalesce(p_message, 'Error'), 500) WHERE id = 1;
END $$;

-- Copia idempotente (por id del TMS) de solicitudes, clientes, OT y componentes. El disparador crea/actualiza la tarea.
CREATE OR REPLACE FUNCTION public.wh_tms_sync_apply(p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; c jsonb; v_site uuid; v_n integer := 0; v_contract uuid; v_client uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Formato de sincronización inválido'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_site := coalesce((SELECT id FROM public.sites WHERE code = r->>'site_code'), public.primary_site_id());
    v_client := NULL;
    IF r->'client'->>'id' IS NOT NULL THEN
      v_client := (r->'client'->>'id')::uuid;
      INSERT INTO public.clients(id, business_name, ruc, commercial_name)
      VALUES (v_client, coalesce(r->'client'->>'business_name', 'Cliente TMS'),
        CASE WHEN EXISTS (SELECT 1 FROM public.clients x WHERE x.ruc = coalesce(r->'client'->>'ruc', v_client::text) AND x.id <> v_client)
             THEN left(coalesce(r->'client'->>'ruc', '') || '-' || left(v_client::text, 8), 20) ELSE left(coalesce(r->'client'->>'ruc', v_client::text), 20) END,
        r->'client'->>'commercial_name')
      ON CONFLICT (id) DO UPDATE SET business_name = EXCLUDED.business_name, commercial_name = EXCLUDED.commercial_name;
    END IF;
    FOR c IN SELECT r->'contract' UNION ALL SELECT e->'contract' FROM jsonb_array_elements(coalesce(r->'components', '[]')) e LOOP
      CONTINUE WHEN c->>'id' IS NULL;
      v_contract := (c->>'id')::uuid;
      INSERT INTO public.contracts(id, code, type, client_id, site_id)
      VALUES (v_contract,
        CASE WHEN EXISTS (SELECT 1 FROM public.contracts x WHERE x.code = c->>'code' AND x.id <> v_contract) THEN (c->>'code') || '-' || left(v_contract::text, 8) ELSE c->>'code' END,
        CASE WHEN c->>'type' IN ('CONTRATO','SUBCONTRATO','OT_INDEPENDIENTE','ERROR','GARANTIA') THEN (c->>'type')::public.contract_type ELSE 'CONTRATO' END,
        (SELECT id FROM public.clients WHERE id = (c->>'client_id')::uuid), v_site)
      ON CONFLICT (id) DO UPDATE SET client_id = coalesce(EXCLUDED.client_id, public.contracts.client_id);
    END LOOP;
    INSERT INTO public.transport_requests(id, request_number, request_type, attention_mode, status, required_date, required_at, created_at,
      requester_name, pickup_address, delivery_address, reference_number, purchase_order, contract_id, client_id, site_id)
    VALUES ((r->>'id')::uuid, r->>'request_number', coalesce(r->>'request_type', 'DESPACHO'),
      CASE WHEN r->>'attention_mode' IN ('TRANSPORTE_JRM','RECOJO_CLIENTE') THEN r->>'attention_mode' END, r->>'status',
      (r->>'required_date')::date, (r->>'required_at')::timestamptz, coalesce((r->>'created_at')::timestamptz, now()),
      r->>'requester_name', r->>'pickup_address', r->>'delivery_address', r->>'reference_number', r->>'purchase_order',
      (r->'contract'->>'id')::uuid, v_client, v_site)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, request_type = EXCLUDED.request_type, required_date = EXCLUDED.required_date,
      required_at = EXCLUDED.required_at, requester_name = EXCLUDED.requester_name, pickup_address = EXCLUDED.pickup_address,
      delivery_address = EXCLUDED.delivery_address, reference_number = EXCLUDED.reference_number, purchase_order = EXCLUDED.purchase_order,
      contract_id = EXCLUDED.contract_id, client_id = EXCLUDED.client_id, updated_at = now()
    WHERE (public.transport_requests.status, public.transport_requests.required_date, public.transport_requests.required_at,
           public.transport_requests.delivery_address, public.transport_requests.contract_id, public.transport_requests.client_id)
      IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.required_date, EXCLUDED.required_at, EXCLUDED.delivery_address, EXCLUDED.contract_id, EXCLUDED.client_id);
    INSERT INTO public.transport_request_components(id, request_id, component_contract_id, requested_weight_kg, requested_volume_m3)
    SELECT (e->>'id')::uuid, (r->>'id')::uuid, (e->'contract'->>'id')::uuid, (e->>'requested_weight_kg')::numeric, (e->>'requested_volume_m3')::numeric
      FROM jsonb_array_elements(coalesce(r->'components', '[]')) e
    ON CONFLICT (id) DO UPDATE SET requested_weight_kg = EXCLUDED.requested_weight_kg, requested_volume_m3 = EXCLUDED.requested_volume_m3;
    DELETE FROM public.transport_request_components WHERE request_id = (r->>'id')::uuid
      AND id NOT IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(coalesce(r->'components', '[]')) e);
    UPDATE public.wh_tasks SET contract_id = (r->'contract'->>'id')::uuid
     WHERE transport_request_id = (r->>'id')::uuid AND contract_id IS DISTINCT FROM (r->'contract'->>'id')::uuid AND status = 'PENDING';
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_tms_sync_state SET last_ok_at = now(), last_count = v_n, last_error = NULL WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'requests', v_n);
END $$;

-- La toma exige una solicitud aprobada en TMS y registra quién y cuándo (además del bloqueo de fila ya existente).
CREATE OR REPLACE FUNCTION public.wh_assign_task(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para asignar tareas'; END IF;
  IF t.status IN ('LOADED','RECONCILED','CANCELLED') THEN RAISE EXCEPTION 'No se puede asignar una tarea cerrada'; END IF;
  IF upper(t.request_status) NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada en TMS'; END IF;
  IF t.assigned_picker IS NOT NULL AND t.assigned_picker <> auth.uid() AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'La tarea ya está asignada a otro operador';
  END IF;
  IF t.assigned_picker IS DISTINCT FROM auth.uid() THEN
    UPDATE public.wh_tasks SET assigned_picker = auth.uid(), assigned_at = now(), updated_by = auth.uid() WHERE id = t.id;
    INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
    VALUES (t.site_id, t.id, 'TASK_ASSIGNED', t.task_code, jsonb_build_object('previous', t.assigned_picker), auth.uid(), gen_random_uuid());
  END IF;
  RETURN jsonb_build_object('task_id', t.id, 'assigned_picker', auth.uid(), 'assigned', true);
END $$;

-- 2. Auditoría por LPN y Packing List ------------------------------------------------------------------------
ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS audit_status text NOT NULL DEFAULT 'PENDIENTE';
ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS audit_rev integer NOT NULL DEFAULT 0;
ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS audited_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS audited_at timestamptz;
ALTER TABLE public.wh_lpns DROP CONSTRAINT IF EXISTS wh_lpns_audit_status_check;
ALTER TABLE public.wh_lpns ADD CONSTRAINT wh_lpns_audit_status_check CHECK (audit_status IN ('PENDIENTE','APROBADO','OBSERVADO','RECHAZADO'));
CREATE INDEX IF NOT EXISTS wh_lpns_task_idx ON public.wh_lpns(task_id) WHERE status <> 'VOID';

CREATE TABLE IF NOT EXISTS public.wh_lpn_audits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lpn_id uuid NOT NULL REFERENCES public.wh_lpns(id),
  task_id uuid NOT NULL REFERENCES public.wh_tasks(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  audit_rev integer NOT NULL,
  result text NOT NULL CHECK (result IN ('APROBADO','OBSERVADO','RECHAZADO','COMENTARIO','REINICIADO')),
  package_code text,
  comment text,
  evidence_paths text[] NOT NULL DEFAULT '{}',
  override_reason text,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_lpn_audits_task_idx ON public.wh_lpn_audits(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wh_lpn_audits_lpn_idx ON public.wh_lpn_audits(lpn_id, created_at DESC);
DROP TRIGGER IF EXISTS wh_lpn_audits_immutable ON public.wh_lpn_audits;
CREATE TRIGGER wh_lpn_audits_immutable BEFORE UPDATE OR DELETE ON public.wh_lpn_audits FOR EACH ROW EXECUTE FUNCTION public.wh_reject_scan_mutation();

CREATE SEQUENCE IF NOT EXISTS public.wh_packing_list_seq;
CREATE TABLE IF NOT EXISTS public.wh_packing_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.wh_tasks(id),
  transport_request_id uuid NOT NULL REFERENCES public.transport_requests(id),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  packing_list_number text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('LIBERADO','REEMPLAZADO')),
  snapshot jsonb NOT NULL,
  released_by uuid NOT NULL REFERENCES public.profiles(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  override_reason text,
  replaced_at timestamptz,
  replaced_reason text,
  print_count integer NOT NULL DEFAULT 0,
  tms_reported_at timestamptz,
  UNIQUE (task_id, version),
  UNIQUE (packing_list_number, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_packing_lists_one_current ON public.wh_packing_lists(task_id) WHERE status = 'LIBERADO';

ALTER TABLE public.wh_lpn_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wh_packing_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_lpn_audits, public.wh_packing_lists FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wh_lpn_audits, public.wh_packing_lists TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_lpn_audits;
CREATE POLICY security_active_account ON public.wh_lpn_audits AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_lpn_audits_read ON public.wh_lpn_audits;
CREATE POLICY wh_lpn_audits_read ON public.wh_lpn_audits FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.wh_any_warehouse_permission());
DROP POLICY IF EXISTS security_active_account ON public.wh_packing_lists;
CREATE POLICY security_active_account ON public.wh_packing_lists AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_packing_lists_read ON public.wh_packing_lists;
CREATE POLICY wh_packing_lists_read ON public.wh_packing_lists FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.wh_any_warehouse_permission());

-- Toda modificación de composición deja sin efecto el Packing List vigente de la tarea (queda en historial).
CREATE OR REPLACE FUNCTION public.wh_invalidate_release(p_task_id uuid, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.wh_packing_lists SET status = 'REEMPLAZADO', replaced_at = now(), replaced_reason = p_reason, tms_reported_at = NULL
   WHERE task_id = p_task_id AND status = 'LIBERADO'
$$;

-- ¿Participó el usuario en la preparación de la tarea (o del LPN)? Base de la regla de no autoaprobación.
CREATE OR REPLACE FUNCTION public.wh_user_prepared(p_task_id uuid, p_lpn_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.wh_tasks WHERE id = p_task_id AND assigned_picker = auth.uid())
      OR EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = p_task_id AND (p_lpn_id IS NULL OR id = p_lpn_id) AND created_by = auth.uid())
      OR EXISTS (SELECT 1 FROM public.wh_scan_events e JOIN public.wh_packages p ON p.id = e.package_id
                 WHERE e.task_id = p_task_id AND e.event_type = 'PICK' AND e.operator_id = auth.uid()
                   AND (p_lpn_id IS NULL OR p.lpn_id = p_lpn_id))
$$;

-- Escanear varios paquetes recogidos -> un LPN cerrado en una sola transacción. Reintento con el mismo
-- p_client_event_id devuelve el mismo LPN (sin duplicar).
CREATE OR REPLACE FUNCTION public.wh_consolidate_lpn(p_task_id uuid, p_package_codes text[], p_client_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; v_codes text[]; v_code text; v_id uuid := gen_random_uuid();
  v_lpn text; v_qty numeric := 0; v_kg numeric := 0; v_n integer := 0; v_prev uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF p_client_event_id IS NOT NULL THEN
    SELECT lpn_id INTO v_prev FROM public.wh_scan_events WHERE site_id = t.site_id AND client_event_id = p_client_event_id AND event_type = 'LPN_CONSOLIDATE';
    IF v_prev IS NOT NULL THEN
      RETURN (SELECT jsonb_build_object('id', id, 'lpn_code', lpn_code, 'package_count', package_count, 'quantity', quantity, 'weight_kg', weight_kg, 'duplicate_retry', true) FROM public.wh_lpns WHERE id = v_prev);
    END IF;
  END IF;
  IF t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'La tarea no está en preparación'; END IF;
  SELECT array_agg(DISTINCT trim(x)) INTO v_codes FROM unnest(p_package_codes) x WHERE nullif(trim(x), '') IS NOT NULL;
  IF coalesce(array_length(v_codes, 1), 0) = 0 THEN RAISE EXCEPTION 'Seleccione al menos un paquete'; END IF;
  v_lpn := 'LPN-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 8));
  INSERT INTO public.wh_lpns(id, lpn_code, site_id, task_id, status, created_by, closed_by, closed_at)
  VALUES (v_id, v_lpn, t.site_id, t.id, 'CLOSED', auth.uid(), auth.uid(), now());
  FOREACH v_code IN ARRAY v_codes LOOP
    SELECT * INTO p FROM public.wh_packages WHERE package_code = v_code AND site_id = t.site_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'El paquete % no existe en este almacén', v_code; END IF;
    IF p.task_id IS DISTINCT FROM t.id THEN RAISE EXCEPTION 'El paquete % no fue recogido para esta tarea', v_code; END IF;
    IF p.lpn_id IS NOT NULL THEN RAISE EXCEPTION 'El paquete % ya está en el LPN %', v_code, (SELECT lpn_code FROM public.wh_lpns WHERE id = p.lpn_id); END IF;
    IF p.status <> 'PICKED' THEN RAISE EXCEPTION 'El paquete % no está recogido (estado %)', v_code, p.status; END IF;
    UPDATE public.wh_packages SET status = 'PACKED', lpn_id = v_id WHERE id = p.id;
    IF p.task_line_id IS NOT NULL THEN UPDATE public.wh_task_lines SET packed_qty = packed_qty + p.quantity WHERE id = p.task_line_id; END IF;
    INSERT INTO public.wh_scan_events(site_id, task_id, package_id, lpn_id, event_type, scanned_code, operator_id, client_event_id)
    VALUES (t.site_id, t.id, p.id, v_id, CASE WHEN v_n = 0 THEN 'LPN_CONSOLIDATE' ELSE 'LPN_ADD' END, v_code, auth.uid(),
            CASE WHEN v_n = 0 THEN coalesce(p_client_event_id, gen_random_uuid()) ELSE gen_random_uuid() END);
    v_qty := v_qty + p.quantity; v_kg := v_kg + coalesce(p.weight_kg, 0); v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_lpns SET package_count = v_n, quantity = v_qty, weight_kg = v_kg WHERE id = v_id;
  PERFORM public.wh_invalidate_release(t.id, 'Nuevo LPN ' || v_lpn);
  RETURN jsonb_build_object('id', v_id, 'lpn_code', v_lpn, 'package_count', v_n, 'quantity', v_qty, 'weight_kg', v_kg);
END $$;

-- Saca un paquete de su LPN (y opcionalmente lo devuelve a stock). Un LPN aprobado solo lo modifica supervisión;
-- el LPN modificado vuelve a auditoría; los demás LPN conservan su aprobación.
CREATE OR REPLACE FUNCTION public.wh_lpn_remove_package(p_lpn_id uuid, p_package_code text, p_release boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE; t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; v_left integer;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE = '42501'; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) THEN RAISE EXCEPTION 'LPN no disponible'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = l.task_id FOR UPDATE;
  IF l.status NOT IN ('OPEN','CLOSED') OR t.status NOT IN ('PICKING','PACKING','READY_FOR_LOAD') THEN RAISE EXCEPTION 'El LPN ya no se puede modificar'; END IF;
  IF l.audit_status = 'APROBADO' AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'El LPN ya fue aprobado: solo supervisión puede modificarlo';
  END IF;
  SELECT * INTO p FROM public.wh_packages WHERE package_code = trim(p_package_code) AND lpn_id = l.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'El paquete no pertenece a este LPN'; END IF;
  UPDATE public.wh_packages SET lpn_id = NULL,
    status = CASE WHEN p_release THEN 'AVAILABLE' ELSE 'PICKED' END,
    task_id = CASE WHEN p_release THEN NULL ELSE task_id END,
    task_line_id = CASE WHEN p_release THEN NULL ELSE task_line_id END
   WHERE id = p.id;
  IF p.task_line_id IS NOT NULL THEN
    UPDATE public.wh_task_lines SET packed_qty = greatest(packed_qty - p.quantity, 0),
      picked_qty = CASE WHEN p_release THEN greatest(picked_qty - p.quantity, 0) ELSE picked_qty END
     WHERE id = p.task_line_id;
  END IF;
  UPDATE public.wh_lpns SET package_count = package_count - 1, quantity = quantity - p.quantity, weight_kg = weight_kg - coalesce(p.weight_kg, 0),
    audit_status = 'PENDIENTE', audit_rev = audit_rev + 1, audited_by = NULL, audited_at = NULL,
    status = CASE WHEN package_count - 1 = 0 THEN 'VOID' ELSE status END,
    void_reason = CASE WHEN package_count - 1 = 0 THEN trim(p_reason) ELSE void_reason END
   WHERE id = l.id RETURNING package_count INTO v_left;
  IF l.audit_status <> 'PENDIENTE' THEN
    INSERT INTO public.wh_lpn_audits(lpn_id, task_id, site_id, audit_rev, result, package_code, comment, actor_id)
    VALUES (l.id, l.task_id, l.site_id, l.audit_rev + 1, 'REINICIADO', p.package_code, 'Composición modificada: ' || trim(p_reason), auth.uid());
  END IF;
  INSERT INTO public.wh_scan_events(site_id, task_id, package_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (l.site_id, l.task_id, p.id, l.id, 'LPN_REMOVE', p.package_code,
          jsonb_build_object('reason', trim(p_reason), 'released_to_stock', p_release, 'previous_audit', l.audit_status), auth.uid(), gen_random_uuid());
  IF t.status = 'READY_FOR_LOAD' THEN UPDATE public.wh_tasks SET status = 'PICKING', updated_by = auth.uid() WHERE id = t.id; END IF;
  PERFORM public.wh_invalidate_release(t.id, 'Cambio en ' || l.lpn_code || ': ' || trim(p_reason));
  RETURN jsonb_build_object('success', true, 'lpn_code', l.lpn_code, 'remaining', v_left);
END $$;

-- Deshace la consolidación completa: los paquetes vuelven a "recogido" y el LPN queda anulado (con historial).
CREATE OR REPLACE FUNCTION public.wh_lpn_undo(p_lpn_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text; v_n integer := 0;
BEGIN
  FOR v_code IN SELECT package_code FROM public.wh_packages WHERE lpn_id = p_lpn_id ORDER BY package_code LOOP
    PERFORM public.wh_lpn_remove_package(p_lpn_id, v_code, false, p_reason);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION 'El LPN no tiene paquetes'; END IF;
  RETURN jsonb_build_object('success', true, 'packages', v_n);
END $$;

-- Primera impresión de la etiqueta LPN (las siguientes usan wh_reprint_lpn_label con motivo).
CREATE OR REPLACE FUNCTION public.wh_print_lpn_label(p_lpn_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status <> 'CLOSED' THEN RAISE EXCEPTION 'LPN no disponible para imprimir'; END IF;
  IF l.print_count > 0 THEN RAISE EXCEPTION 'La etiqueta ya se imprimió: use reimpresión con motivo'; END IF;
  UPDATE public.wh_lpns SET print_count = 1 WHERE id = l.id;
  INSERT INTO public.wh_scan_events(site_id, task_id, lpn_id, event_type, scanned_code, operator_id, client_event_id)
  VALUES (l.site_id, l.task_id, l.id, 'LPN_PRINT', l.lpn_code, auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('lpn_code', l.lpn_code, 'print_count', 1);
END $$;

-- Aprobar / observar / rechazar / comentar un LPN, con evidencias. Quien preparó no aprueba salvo supervisión con motivo.
CREATE OR REPLACE FUNCTION public.wh_audit_lpn(p_lpn_id uuid, p_result text, p_comment text DEFAULT NULL, p_package_code text DEFAULT NULL,
  p_evidence_paths text[] DEFAULT '{}', p_override_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE; t public.wh_tasks%ROWTYPE; v_result text := upper(trim(p_result)); v_override text := nullif(trim(p_override_reason), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de auditoría' USING ERRCODE = '42501'; END IF;
  IF v_result NOT IN ('APROBADO','OBSERVADO','RECHAZADO','COMENTARIO') THEN RAISE EXCEPTION 'Resultado de auditoría no reconocido'; END IF;
  IF v_result IN ('OBSERVADO','RECHAZADO') AND nullif(trim(p_comment), '') IS NULL THEN RAISE EXCEPTION 'Describa la observación o el motivo del rechazo'; END IF;
  IF v_result = 'COMENTARIO' AND nullif(trim(p_comment), '') IS NULL AND coalesce(array_length(p_evidence_paths, 1), 0) = 0 THEN RAISE EXCEPTION 'Agregue un comentario o una foto'; END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status <> 'CLOSED' THEN RAISE EXCEPTION 'LPN no disponible para auditoría'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = l.task_id;
  IF t.status NOT IN ('PICKING','PACKING','READY_FOR_LOAD') THEN RAISE EXCEPTION 'La tarea no está en preparación'; END IF;
  IF v_result <> 'COMENTARIO' AND public.wh_user_prepared(t.id, l.id) THEN
    IF v_override IS NULL OR NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
      RAISE EXCEPTION 'No puede auditar un LPN que usted preparó (requiere supervisión con motivo)';
    END IF;
  END IF;
  IF p_package_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_packages WHERE lpn_id = l.id AND package_code = trim(p_package_code)) THEN
    RAISE EXCEPTION 'El paquete indicado no pertenece al LPN';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_evidence_paths, '{}')) x WHERE x NOT LIKE l.id::text || '/%' OR x LIKE '%..%') THEN
    RAISE EXCEPTION 'Evidencia no corresponde al LPN';
  END IF;
  IF v_result <> 'COMENTARIO' THEN
    UPDATE public.wh_lpns SET audit_status = v_result, audited_by = auth.uid(), audited_at = now() WHERE id = l.id;
  END IF;
  INSERT INTO public.wh_lpn_audits(lpn_id, task_id, site_id, audit_rev, result, package_code, comment, evidence_paths, override_reason, actor_id)
  VALUES (l.id, l.task_id, l.site_id, l.audit_rev, v_result, nullif(trim(p_package_code), ''), nullif(trim(p_comment), ''),
          coalesce(p_evidence_paths, '{}'), CASE WHEN v_result <> 'COMENTARIO' AND public.wh_user_prepared(t.id, l.id) THEN v_override END, auth.uid());
  RETURN jsonb_build_object('success', true, 'lpn_code', l.lpn_code, 'audit_status', CASE WHEN v_result = 'COMENTARIO' THEN l.audit_status ELSE v_result END);
END $$;

-- LPN de una tarea con sus paquetes y su historial de auditoría (nombres incluidos): una sola lectura para
-- la ventana de picking, la de auditoría y el Packing List preliminar.
CREATE OR REPLACE FUNCTION public.wh_task_lpns(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_site uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT site_id INTO v_site FROM public.wh_tasks WHERE id = p_task_id;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) OR NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  RETURN jsonb_build_object(
    'lpns', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'lpn_code', l.lpn_code, 'status', l.status, 'package_count', l.package_count, 'quantity', l.quantity,
        'weight_kg', l.weight_kg, 'print_count', l.print_count, 'audit_status', l.audit_status, 'audit_rev', l.audit_rev,
        'audited_by_name', public.wh_profile_name(l.audited_by), 'audited_at', l.audited_at, 'created_at', l.created_at,
        'created_by_name', public.wh_profile_name(l.created_by), 'void_reason', l.void_reason,
        'packages', coalesce((SELECT jsonb_agg(jsonb_build_object('package_code', p.package_code, 'product_code', p.source_product_code,
            'description', p.description, 'lot', p.source_lot, 'document', p.source_document_no, 'contract_code', p.source_contract_code,
            'quantity', p.quantity, 'unit', p.unit, 'weight_kg', p.weight_kg) ORDER BY p.package_code)
          FROM public.wh_packages p WHERE p.lpn_id = l.id), '[]'::jsonb),
        'audits', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'result', a.result, 'audit_rev', a.audit_rev, 'package_code', a.package_code,
            'comment', a.comment, 'evidence_paths', a.evidence_paths, 'override_reason', a.override_reason,
            'actor_name', public.wh_profile_name(a.actor_id), 'created_at', a.created_at) ORDER BY a.created_at DESC)
          FROM public.wh_lpn_audits a WHERE a.lpn_id = l.id), '[]'::jsonb)
      ) ORDER BY l.created_at) FROM public.wh_lpns l WHERE l.task_id = p_task_id AND l.status <> 'VOID'), '[]'::jsonb),
    'loose', coalesce((SELECT jsonb_agg(jsonb_build_object('package_code', p.package_code, 'product_code', p.source_product_code,
        'description', p.description, 'lot', p.source_lot, 'quantity', p.quantity, 'unit', p.unit, 'weight_kg', p.weight_kg) ORDER BY p.updated_at DESC)
      FROM public.wh_packages p WHERE p.task_id = p_task_id AND p.status = 'PICKED' AND p.lpn_id IS NULL), '[]'::jsonb),
    'packing_lists', coalesce((SELECT jsonb_agg(jsonb_build_object('id', pl.id, 'packing_list_number', pl.packing_list_number, 'version', pl.version,
        'status', pl.status, 'released_at', pl.released_at, 'released_by_name', public.wh_profile_name(pl.released_by), 'replaced_reason', pl.replaced_reason,
        'snapshot', pl.snapshot) ORDER BY pl.version DESC) FROM public.wh_packing_lists pl WHERE pl.task_id = p_task_id), '[]'::jsonb)
  );
END $$;

-- Tablero de tareas (scope 'tareas') y de auditoría (scope 'auditoria'), o una sola tarea.
CREATE OR REPLACE FUNCTION public.wh_task_board(p_scope text DEFAULT 'tareas', p_task_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x->>'sort_date' DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'task_code', t.task_code, 'status', t.status, 'request_status', t.request_status,
      'request_number', r.request_number, 'transport_request_id', t.transport_request_id,
      'required_date', r.required_date, 'required_at', r.required_at, 'sort_date', coalesce(r.required_at::text, r.required_date::text, t.created_at::text),
      'created_at', t.created_at, 'contract_code', c.code,
      'components', (SELECT string_agg(cc.code, ', ' ORDER BY cc.code) FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id = rc.component_contract_id WHERE rc.request_id = r.id),
      'lots', (SELECT string_agg(DISTINCT nullif(p.source_lot, ''), ', ') FROM public.wh_packages p WHERE p.task_id = t.id),
      'client_name', coalesce(cl.commercial_name, cl.business_name, r.requester_name),
      'delivery_address', r.delivery_address,
      'assigned_picker', t.assigned_picker, 'picker_name', public.wh_profile_name(t.assigned_picker), 'assigned_at', t.assigned_at,
      'picked', (SELECT count(*) FROM public.wh_packages p WHERE p.task_id = t.id AND p.status IN ('PICKED','PACKED','LOADED')),
      'loose', (SELECT count(*) FROM public.wh_packages p WHERE p.task_id = t.id AND p.status = 'PICKED' AND p.lpn_id IS NULL),
      'lpn_total', s.total, 'lpn_approved', s.approved, 'lpn_observed', s.observed, 'lpn_rejected', s.rejected, 'lpn_pending', s.pending,
      'weight_kg', s.weight,
      'packing_list', (SELECT jsonb_build_object('id', pl.id, 'number', pl.packing_list_number, 'version', pl.version, 'released_at', pl.released_at)
                         FROM public.wh_packing_lists pl WHERE pl.task_id = t.id AND pl.status = 'LIBERADO'),
      'display_state', CASE
        WHEN EXISTS (SELECT 1 FROM public.wh_packing_lists pl WHERE pl.task_id = t.id AND pl.status = 'LIBERADO') THEN 'LIBERADO'
        WHEN t.status IN ('PICKING','PACKING','READY_FOR_LOAD') AND s.observed + s.rejected > 0 THEN 'OBSERVADO'
        WHEN t.status = 'READY_FOR_LOAD' THEN 'EN_AUDITORIA'
        WHEN t.status IN ('PICKING','PACKING') THEN 'EN_PICKING'
        WHEN t.status = 'PENDING' THEN 'PENDIENTE'
        ELSE t.status END
    ) AS x
    FROM public.wh_tasks t
    JOIN public.transport_requests r ON r.id = t.transport_request_id
    LEFT JOIN public.contracts c ON c.id = coalesce(t.contract_id, r.contract_id)
    LEFT JOIN public.clients cl ON cl.id = coalesce(r.client_id, c.client_id)
    CROSS JOIN LATERAL (SELECT count(*) AS total,
        count(*) FILTER (WHERE l.audit_status = 'APROBADO') AS approved, count(*) FILTER (WHERE l.audit_status = 'OBSERVADO') AS observed,
        count(*) FILTER (WHERE l.audit_status = 'RECHAZADO') AS rejected, count(*) FILTER (WHERE l.audit_status = 'PENDIENTE') AS pending,
        coalesce(sum(l.weight_kg), 0) AS weight
      FROM public.wh_lpns l WHERE l.task_id = t.id AND l.status <> 'VOID') s
    WHERE public.can_access_site(t.site_id)
      AND (p_task_id IS NULL OR t.id = p_task_id)
      AND (p_task_id IS NOT NULL OR CASE WHEN p_scope = 'auditoria'
             THEN t.status IN ('PICKING','PACKING','READY_FOR_LOAD') AND (s.total > 0 OR t.status = 'READY_FOR_LOAD')
             ELSE t.status NOT IN ('LOADED','RECONCILED','CANCELLED') END)
    LIMIT 500) q), '[]'::jsonb);
END $$;

-- Liberar Packing List: picking finalizado, todos los LPN aprobados, sin paquetes sueltos y cantidades consistentes.
CREATE OR REPLACE FUNCTION public.wh_release_packing_list(p_task_id uuid, p_override_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; r public.transport_requests%ROWTYPE; v_override text := nullif(trim(p_override_reason), '');
  v_number text; v_version integer; v_id uuid := gen_random_uuid(); v_snapshot jsonb; v_lpns jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de auditoría' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF t.status <> 'READY_FOR_LOAD' THEN RAISE EXCEPTION 'El picking aún no está finalizado'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packing_lists WHERE task_id = t.id AND status = 'LIBERADO') THEN RAISE EXCEPTION 'El Packing List ya está liberado'; END IF;
  PERFORM 1 FROM public.wh_lpns WHERE task_id = t.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID') THEN RAISE EXCEPTION 'La tarea no tiene LPN'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID' AND (status <> 'CLOSED' OR audit_status <> 'APROBADO')) THEN
    RAISE EXCEPTION 'Hay LPN pendientes, observados o rechazados';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packages WHERE task_id = t.id AND status = 'PICKED') THEN RAISE EXCEPTION 'Hay paquetes recogidos sin consolidar'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns l WHERE l.task_id = t.id AND l.status <> 'VOID' AND (
             l.package_count <> (SELECT count(*) FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'PACKED')
             OR l.quantity <> (SELECT coalesce(sum(p.quantity), 0) FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'PACKED'))) THEN
    RAISE EXCEPTION 'Las cantidades de algún LPN no coinciden con sus paquetes';
  END IF;
  IF public.wh_user_prepared(t.id) AND (v_override IS NULL OR NOT public.wh_has_permission(ARRAY['almacen-supervisor'])) THEN
    RAISE EXCEPTION 'No puede liberar una tarea en la que preparó paquetes (requiere supervisión con motivo)';
  END IF;
  SELECT * INTO r FROM public.transport_requests WHERE id = t.transport_request_id;
  SELECT packing_list_number, max(version) + 1 INTO v_number, v_version FROM public.wh_packing_lists WHERE task_id = t.id GROUP BY packing_list_number ORDER BY 2 DESC LIMIT 1;
  IF v_number IS NULL THEN
    v_number := 'PL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.wh_packing_list_seq')::text, 6, '0'); v_version := 1;
  END IF;
  v_lpns := (public.wh_task_lpns(t.id))->'lpns';
  v_snapshot := jsonb_build_object(
    'packing_list_number', v_number, 'version', v_version, 'task_code', t.task_code, 'request_number', r.request_number,
    'contract_code', (SELECT code FROM public.contracts WHERE id = coalesce(t.contract_id, r.contract_id)),
    'client_name', (SELECT coalesce(commercial_name, business_name) FROM public.clients WHERE id = coalesce(r.client_id, (SELECT client_id FROM public.contracts WHERE id = r.contract_id))),
    'delivery_address', r.delivery_address,
    'lots', (SELECT string_agg(DISTINCT nullif(p.source_lot, ''), ', ') FROM public.wh_packages p WHERE p.task_id = t.id AND p.status = 'PACKED'),
    'prepared_at', (SELECT min(occurred_at) FROM public.wh_scan_events WHERE task_id = t.id AND event_type = 'PICK'),
    'picker_name', public.wh_profile_name(t.assigned_picker),
    'auditor_name', public.wh_profile_name(auth.uid()), 'released_at', now(),
    'lpn_count', jsonb_array_length(v_lpns),
    'package_count', (SELECT sum((x->>'package_count')::integer) FROM jsonb_array_elements(v_lpns) x),
    'total_weight_kg', (SELECT sum((x->>'weight_kg')::numeric) FROM jsonb_array_elements(v_lpns) x),
    'lpns', v_lpns);
  INSERT INTO public.wh_packing_lists(id, task_id, transport_request_id, site_id, packing_list_number, version, status, snapshot, released_by, override_reason)
  VALUES (v_id, t.id, t.transport_request_id, t.site_id, v_number, v_version, 'LIBERADO', v_snapshot, auth.uid(),
          CASE WHEN public.wh_user_prepared(t.id) THEN v_override END);
  INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (t.site_id, t.id, 'PACKING_LIST_RELEASED', v_number, jsonb_build_object('version', v_version, 'id', v_id), auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'packing_list_number', v_number, 'version', v_version);
END $$;

CREATE OR REPLACE FUNCTION public.wh_print_packing_list(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pl public.wh_packing_lists%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  SELECT * INTO pl FROM public.wh_packing_lists WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(pl.site_id) THEN RAISE EXCEPTION 'Packing List no disponible'; END IF;
  IF pl.status <> 'LIBERADO' THEN RAISE EXCEPTION 'Esta versión del Packing List fue reemplazada y no se puede imprimir'; END IF;
  UPDATE public.wh_packing_lists SET print_count = print_count + 1 WHERE id = pl.id;
  INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (pl.site_id, pl.task_id, 'PACKING_LIST_PRINT', pl.packing_list_number, jsonb_build_object('version', pl.version), auth.uid(), gen_random_uuid());
  RETURN pl.snapshot;
END $$;

-- Pendientes de informar al TMS (liberados o reemplazados después de informar).
CREATE OR REPLACE FUNCTION public.wh_packing_lists_unreported()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'transport_request_id', transport_request_id, 'packing_list_number', packing_list_number,
      'version', version, 'status', status, 'released_at', released_at, 'lpn_count', snapshot->'lpn_count', 'package_count', snapshot->'package_count',
      'total_weight_kg', snapshot->'total_weight_kg', 'picker_name', snapshot->>'picker_name', 'auditor_name', snapshot->>'auditor_name',
      'payload', jsonb_build_object('task_code', snapshot->>'task_code', 'replaced_reason', replaced_reason)))
    FROM public.wh_packing_lists WHERE tms_reported_at IS NULL AND public.can_access_site(site_id) LIMIT 50), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.wh_packing_list_mark_reported(p_id uuid, p_status text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  -- solo si no cambió desde que se informó (un reemplazo posterior debe volver a informarse)
  UPDATE public.wh_packing_lists SET tms_reported_at = now() WHERE id = p_id AND status = p_status;
END $$;

-- 3. Estados: finalizar picking, reabrir y carga solo con Packing List vigente -----------------------------
CREATE OR REPLACE FUNCTION public.wh_task_action(p_task_id uuid, p_action text, p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE t public.wh_tasks%ROWTYPE; v_action text:=upper(p_action); v_to text; v_n int; v_open numeric;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
 IF v_action IN ('START_PICKING','PICK') THEN v_to:='PICKING';
 ELSIF v_action='START_PACKING' THEN v_to:='PACKING';
 ELSIF v_action IN ('READY_FOR_LOAD','FINISH_PICKING') THEN v_to:='READY_FOR_LOAD';
 ELSIF v_action='REOPEN_PICKING' THEN v_to:='PICKING';
 ELSIF v_action='LOAD' THEN v_to:='LOADED';
 ELSIF v_action='LOAD_PARTIAL' THEN v_to:='PARTIAL';
 ELSIF v_action='PAUSE' THEN v_to:='PAUSED';
 ELSIF v_action='RESUME' THEN v_to:='PICKING';
 ELSIF v_action='CANCEL' THEN v_to:='CANCELLED';
 ELSE RAISE EXCEPTION 'Acción de tarea no reconocida'; END IF;
 IF v_action IN ('START_PICKING','PICK','RESUME') AND NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE='42501'; END IF;
 IF v_action IN ('FINISH_PICKING','REOPEN_PICKING') AND NOT public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de picking' USING ERRCODE='42501'; END IF;
 IF v_action='START_PACKING' AND NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de packing' USING ERRCODE='42501'; END IF;
 IF v_action IN ('READY_FOR_LOAD','LOAD') AND NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor','apt-carga']) THEN RAISE EXCEPTION 'Sin permiso de carga' USING ERRCODE='42501'; END IF;
 IF v_action='LOAD_PARTIAL' AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'La excepción de carga parcial es exclusiva de supervisión' USING ERRCODE='42501'; END IF;
 IF v_action IN ('PAUSE','CANCEL') AND NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Acción exclusiva de supervisión' USING ERRCODE='42501'; END IF;
 IF v_action IN ('PAUSE','CANCEL') AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Registre el motivo'; END IF;
 IF v_action='LOAD_PARTIAL' AND nullif(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Registre el motivo de la excepción de carga parcial'; END IF;
 IF v_action IN ('START_PICKING','PICK','RESUME') AND t.request_status NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada para iniciar el picking'; END IF;
 IF NOT ((t.status IN ('PENDING','PARTIAL') AND v_to='PICKING' AND v_action<>'REOPEN_PICKING') OR (t.status='PENDING' AND v_to='CANCELLED') OR
   (t.status='PICKING' AND v_to IN ('PACKING','PAUSED','CANCELLED')) OR (t.status='PAUSED' AND v_to IN ('PICKING','CANCELLED') AND v_action<>'REOPEN_PICKING') OR
   (t.status IN ('PICKING','PACKING') AND v_action='FINISH_PICKING') OR
   (t.status='PACKING' AND v_to IN ('READY_FOR_LOAD','PAUSED','CANCELLED') AND v_action<>'FINISH_PICKING') OR
   (t.status='READY_FOR_LOAD' AND v_action='REOPEN_PICKING') OR
   (t.status='READY_FOR_LOAD' AND v_to IN ('LOADED','PARTIAL','PAUSED','CANCELLED'))) THEN RAISE EXCEPTION 'Transición no permitida: % → %',t.status,v_to; END IF;
 IF v_to='READY_FOR_LOAD' THEN
  SELECT count(*) INTO v_n FROM public.wh_packages p WHERE p.task_id=t.id AND p.status<>'VOID';
  IF v_n=0 OR EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status NOT IN ('PACKED','LOADED','VOID')) THEN RAISE EXCEPTION 'No se puede finalizar: hay paquetes recogidos sin consolidar en LPN'; END IF;
  IF EXISTS(SELECT 1 FROM public.wh_packages p LEFT JOIN public.wh_lpns l ON l.id=p.lpn_id WHERE p.task_id=t.id AND p.status='PACKED' AND (p.lpn_id IS NULL OR l.status NOT IN ('CLOSED','LOADED'))) THEN RAISE EXCEPTION 'Asigne todos los paquetes empacados a LPN cerrados antes de finalizar'; END IF;
 END IF;
 IF v_to IN ('LOADED','PARTIAL') AND NOT EXISTS(SELECT 1 FROM public.wh_packing_lists WHERE task_id=t.id AND status='LIBERADO') THEN
  RAISE EXCEPTION 'No se puede cargar: el Packing List no está liberado por auditoría';
 END IF;
 IF v_to='LOADED' AND (EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status NOT IN ('LOADED','VOID')) OR NOT EXISTS(SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status='LOADED')) THEN RAISE EXCEPTION 'No se puede confirmar salida: escanee todos los paquetes cargados'; END IF;
 IF v_to IN ('LOADED','PARTIAL') THEN
  SELECT coalesce(sum(remaining_qty),0) INTO v_open FROM public.wh_task_lines WHERE task_id=t.id;
  IF v_to='PARTIAL' AND (NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status='LOADED') OR v_open<=0) THEN RAISE EXCEPTION 'La excepción parcial requiere paquetes cargados y un saldo pendiente'; END IF;
  IF v_to='LOADED' AND v_open>0 THEN RAISE EXCEPTION 'Queda saldo solicitado; la supervisión debe registrar el despacho parcial con motivo'; END IF;
 END IF;
 IF v_action='REOPEN_PICKING' THEN PERFORM public.wh_invalidate_release(t.id, coalesce(nullif(trim(p_reason),''),'Picking reabierto')); END IF;
 UPDATE public.wh_tasks SET status=v_to,updated_by=auth.uid(),paused_reason=CASE WHEN v_to='PAUSED' THEN trim(p_reason) ELSE NULL END,
  cancelled_reason=CASE WHEN v_to='CANCELLED' THEN trim(p_reason) ELSE cancelled_reason END,
  loaded_at=CASE WHEN v_to IN ('LOADED','PARTIAL') THEN now() ELSE loaded_at END,
  load_override_reason=CASE WHEN v_action='LOAD_PARTIAL' THEN trim(p_reason) WHEN v_to='PICKING' THEN NULL ELSE load_override_reason END,
  load_override_by=CASE WHEN v_action='LOAD_PARTIAL' THEN auth.uid() WHEN v_to='PICKING' THEN NULL ELSE load_override_by END,
  load_override_at=CASE WHEN v_action='LOAD_PARTIAL' THEN now() WHEN v_to='PICKING' THEN NULL ELSE load_override_at END WHERE id=t.id;
 INSERT INTO public.wh_scan_events(site_id,task_id,event_type,scanned_code,payload,operator_id,client_event_id)
  SELECT t.site_id,t.id,'TASK_'||v_action,t.task_code,jsonb_build_object('from',t.status,'to',v_to,'reason',nullif(trim(p_reason),'')),auth.uid(),gen_random_uuid()
  WHERE v_action IN ('FINISH_PICKING','REOPEN_PICKING');
 UPDATE public.wh_packages SET status='AVAILABLE',task_id=NULL,lpn_id=NULL,task_line_id=NULL WHERE task_id=t.id AND status NOT IN ('VOID','LOADED') AND v_to='CANCELLED';
 IF v_to='CANCELLED' THEN
  UPDATE public.wh_task_lines SET picked_qty=0,packed_qty=0 WHERE task_id=t.id AND loaded_qty=0;
  UPDATE public.wh_lpns SET status='VOID',void_reason=trim(p_reason) WHERE task_id=t.id AND status IN ('OPEN','CLOSED');
  PERFORM public.wh_invalidate_release(t.id, 'Tarea cancelada: '||trim(p_reason));
  INSERT INTO public.wh_scan_events(site_id,task_id,event_type,scanned_code,payload,operator_id,client_event_id)
   VALUES(t.site_id,t.id,'TASK_CANCELLED',t.task_code,jsonb_build_object('reason',trim(p_reason),'lpn_disassembled',true),auth.uid(),gen_random_uuid());
 END IF;
 RETURN jsonb_build_object('id',t.id,'status',v_to,'remaining_qty',coalesce(v_open,0),'partial_override',v_action='LOAD_PARTIAL');
END $function$;

-- Una cancelación desde TMS también deja sin efecto el Packing List vigente.
CREATE OR REPLACE FUNCTION public.wh_invalidate_release_on_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
    PERFORM public.wh_invalidate_release(NEW.id, coalesce(NEW.cancelled_reason, 'Tarea cancelada'));
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS wh_tasks_cancel_release ON public.wh_tasks;
CREATE TRIGGER wh_tasks_cancel_release AFTER UPDATE OF status ON public.wh_tasks FOR EACH ROW EXECUTE FUNCTION public.wh_invalidate_release_on_cancel();

-- 4. Evidencias (bucket privado; en el arnés local sin Storage se omite) -------------------------------------
DO $storage$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('wh_audit_evidence', 'wh_audit_evidence', false, 10485760, ARRAY['image/jpeg','image/png','image/webp'])
    ON CONFLICT (id) DO NOTHING;
    DROP POLICY IF EXISTS wh_audit_evidence_insert ON storage.objects;
    CREATE POLICY wh_audit_evidence_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'wh_audit_evidence' AND public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']));
    DROP POLICY IF EXISTS wh_audit_evidence_read ON storage.objects;
    CREATE POLICY wh_audit_evidence_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'wh_audit_evidence' AND public.wh_any_warehouse_permission());
  END IF;
END $storage$;

-- 5. Permisos de ejecución -------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.wh_any_warehouse_permission(), public.wh_profile_name(uuid), public.wh_invalidate_release(uuid, text),
  public.wh_user_prepared(uuid, uuid), public.wh_invalidate_release_on_cancel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wh_any_warehouse_permission() TO authenticated;
REVOKE ALL ON FUNCTION public.wh_tms_sync_claim(boolean), public.wh_tms_sync_fail(text), public.wh_tms_sync_apply(jsonb),
  public.wh_assign_task(uuid), public.wh_consolidate_lpn(uuid, text[], uuid), public.wh_lpn_remove_package(uuid, text, boolean, text),
  public.wh_lpn_undo(uuid, text), public.wh_print_lpn_label(uuid), public.wh_audit_lpn(uuid, text, text, text, text[], text),
  public.wh_task_lpns(uuid), public.wh_task_board(text, uuid), public.wh_release_packing_list(uuid, text), public.wh_print_packing_list(uuid),
  public.wh_packing_lists_unreported(), public.wh_packing_list_mark_reported(uuid, text), public.wh_task_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_tms_sync_claim(boolean), public.wh_tms_sync_fail(text), public.wh_tms_sync_apply(jsonb),
  public.wh_assign_task(uuid), public.wh_consolidate_lpn(uuid, text[], uuid), public.wh_lpn_remove_package(uuid, text, boolean, text),
  public.wh_lpn_undo(uuid, text), public.wh_print_lpn_label(uuid), public.wh_audit_lpn(uuid, text, text, text, text[], text),
  public.wh_task_lpns(uuid), public.wh_task_board(text, uuid), public.wh_release_packing_list(uuid, text), public.wh_print_packing_list(uuid),
  public.wh_packing_lists_unreported(), public.wh_packing_list_mark_reported(uuid, text), public.wh_task_action(uuid, text, text) TO authenticated;

-- 6. Picking validado por OT cuando la solicitud TMS no trae detalle de productos (caso actual del TMS):
--    el paquete debe tener una OT incluida en la solicitud; con detalle, lo no solicitado sigue requiriendo supervisión.
CREATE OR REPLACE FUNCTION public.wh_record_scan(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; l public.wh_lpns%ROWTYPE; v_perm text; v_line public.wh_task_lines%ROWTYPE; v_count integer;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
 v_perm:=CASE upper(p_event) WHEN 'PICK' THEN 'almacen-picking' WHEN 'PACK' THEN 'almacen-packing' WHEN 'LOAD' THEN 'almacen-carga' ELSE 'almacen-supervisor' END;
 IF NOT public.wh_has_permission(ARRAY[v_perm,'almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE='42501'; END IF;
 IF nullif(trim(p_code),'') IS NULL OR p_client_event_id IS NULL THEN RAISE EXCEPTION 'Lea un código válido; se requiere identificador de operación'; END IF;
 IF upper(p_event)='PICK' AND t.request_status NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud aún no está aprobada para iniciar el picking'; END IF;
 IF upper(p_event)='LOAD' AND t.dispatch_id IS NULL THEN RAISE EXCEPTION 'Programe la solicitud en un despacho antes de confirmar carga'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id AND scanned_code=trim(p_code)
   AND event_type IN (upper(p_event),CASE WHEN upper(p_event)='LOAD' THEN 'LOAD_LPN' ELSE upper(p_event) END) AND task_id=t.id) THEN
  RETURN jsonb_build_object('success',true,'duplicate_retry',true,'code',trim(p_code),'event',upper(p_event));
 ELSIF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id) THEN RAISE EXCEPTION 'El identificador de lectura ya se usó para otra operación'; END IF;
 IF upper(p_event)='LOAD' THEN
  SELECT * INTO l FROM public.wh_lpns WHERE lpn_code=trim(p_code) FOR UPDATE;
  IF FOUND THEN
   IF l.task_id IS DISTINCT FROM t.id OR l.site_id<>t.site_id OR l.status<>'CLOSED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'LPN no está cerrado para esta tarea'; END IF;
   SELECT count(*)::integer INTO v_count FROM public.wh_packages WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED';
   IF v_count=0 THEN RAISE EXCEPTION 'El LPN no contiene paquetes listos para cargar'; END IF;
   WITH moved AS (
    UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id
     WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED' RETURNING task_line_id,quantity
   ), totals AS (
    SELECT task_line_id,sum(quantity) AS qty FROM moved WHERE task_line_id IS NOT NULL GROUP BY task_line_id
   )
   UPDATE public.wh_task_lines tl SET loaded_qty=loaded_qty+x.qty FROM totals x WHERE tl.id=x.task_line_id;
   UPDATE public.wh_lpns SET status='LOADED' WHERE id=l.id;
   INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
    VALUES(t.site_id,t.id,l.id,'LOAD_LPN',l.lpn_code,jsonb_build_object('package_count',v_count),auth.uid(),p_client_event_id);
   RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'packages_loaded',v_count);
  END IF;
 END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_code) AND site_id=t.site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Código no pertenece a este almacén'; END IF;
 IF upper(p_event)='PICK' THEN
   IF p.status NOT IN ('AVAILABLE','RESERVED') OR t.status NOT IN ('PENDING','PICKING') THEN RAISE EXCEPTION 'Paquete no disponible para picking'; END IF;
   IF p.contract_id IS NULL AND nullif(trim(p.source_contract_code),'') IS NULL THEN RAISE EXCEPTION 'El paquete no tiene OT registrada; no se puede validar contra la solicitud'; END IF;
   IF p.contract_id IS NOT NULL AND p.contract_id<>t.contract_id AND NOT EXISTS(SELECT 1 FROM public.transport_request_components c WHERE c.request_id=t.transport_request_id AND c.component_contract_id=p.contract_id) THEN
    RAISE EXCEPTION 'El paquete pertenece a otra OT o contrato que no está incluido en la solicitud';
   END IF;
   IF nullif(trim(p.source_contract_code),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=t.contract_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) AND NOT EXISTS(SELECT 1 FROM public.transport_request_components rc JOIN public.contracts c ON c.id=rc.component_contract_id WHERE rc.request_id=t.transport_request_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) THEN
    RAISE EXCEPTION 'La OT/contrato del ingreso APT no está incluida en la solicitud';
   END IF;
   SELECT * INTO v_line FROM public.wh_task_lines WHERE task_id=t.id AND upper(coalesce(product_code,''))=upper(p.source_product_code)
    AND (contract_id IS NULL OR contract_id=t.contract_id OR p.contract_id IS NULL OR contract_id=p.contract_id) ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF FOUND THEN
     IF v_line.requested_qty IS NOT NULL AND v_line.picked_qty+p.quantity>v_line.requested_qty THEN RAISE EXCEPTION 'La cantidad recogida superaría lo solicitado'; END IF;
     UPDATE public.wh_task_lines SET picked_qty=picked_qty+p.quantity WHERE id=v_line.id;
   ELSE
     v_count:=(SELECT count(*) FROM public.wh_task_lines WHERE task_id=t.id AND source='REQUEST');
     IF v_count>0 AND NOT (public.wh_has_permission(ARRAY['almacen-supervisor']) AND coalesce((p_payload->>'confirmed_unrequested_stock')::boolean,false)) THEN
      RAISE EXCEPTION 'El producto no está en el detalle de solicitud. La supervisión debe confirmar el material alternativo antes de recogerlo';
     END IF;
     INSERT INTO public.wh_task_lines(task_id,contract_id,product_code,description,requested_qty,picked_qty,unit,weight_kg,source)
     VALUES(t.id,p.contract_id,p.source_product_code,p.description,NULL,p.quantity,p.unit,p.weight_kg,CASE WHEN v_count>0 THEN 'SUPERVISOR_CONFIRMED_STOCK' ELSE 'OT_VALIDATED' END) RETURNING id INTO v_line.id;
   END IF;
   IF p.task_id IS NOT NULL AND p.task_id<>t.id THEN RAISE EXCEPTION 'Paquete ya reservado para otra tarea'; END IF;
   UPDATE public.wh_packages SET status='PICKED',task_id=t.id,task_line_id=v_line.id WHERE id=p.id;
   UPDATE public.wh_tasks SET status='PICKING',assigned_picker=coalesce(assigned_picker,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PENDING';
 ELSIF upper(p_event)='PACK' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PICKED' OR t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'Paquete no corresponde a tarea o no está recogido'; END IF;
   UPDATE public.wh_packages SET status='PACKED' WHERE id=p.id;
   UPDATE public.wh_task_lines SET packed_qty=packed_qty+p.quantity WHERE id=p.task_line_id;
   SELECT * INTO l FROM public.wh_lpns WHERE task_id=t.id AND status='OPEN' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
   IF FOUND THEN
    UPDATE public.wh_packages SET lpn_id=l.id WHERE id=p.id;
    UPDATE public.wh_lpns SET package_count=package_count+1,quantity=quantity+p.quantity,weight_kg=weight_kg+coalesce(p.weight_kg,0) WHERE id=l.id;
   END IF;
   UPDATE public.wh_tasks SET status='PACKING',assigned_packer=coalesce(assigned_packer,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PICKING';
 ELSIF upper(p_event)='LOAD' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PACKED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'Paquete no está listo para cargar'; END IF;
   UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id WHERE id=p.id;
   UPDATE public.wh_task_lines SET loaded_qty=loaded_qty+p.quantity WHERE id=p.task_line_id;
 ELSE RAISE EXCEPTION 'Tipo de lectura no reconocido'; END IF;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(t.site_id,t.id,p.id,CASE WHEN upper(p_event)='PACK' AND l.id IS NOT NULL THEN l.id ELSE NULL END,upper(p_event),trim(p_code),coalesce(p_payload,'{}'),auth.uid(),p_client_event_id)
 ON CONFLICT(site_id,client_event_id) DO NOTHING;
 RETURN jsonb_build_object('success',true,'package',p.package_code,'event',upper(p_event));
END $function$
;
REVOKE ALL ON FUNCTION public.wh_record_scan(uuid, text, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_record_scan(uuid, text, text, uuid, jsonb) TO authenticated;
