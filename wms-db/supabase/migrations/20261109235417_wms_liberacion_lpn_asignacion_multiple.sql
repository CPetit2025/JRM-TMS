-- Auditoría libera LPN. El documento es una proyección automática del contenido liberado.
-- Helpers internos sin acceso desde Data API; RPC públicas mantienen sesión, sede y permisos.
CREATE SCHEMA IF NOT EXISTS wms_private;
REVOKE ALL ON SCHEMA wms_private FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION wms_private.refresh_packing_list(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; r public.transport_requests%ROWTYPE; v_auditor uuid;
  v_number text; v_version integer; v_id uuid := gen_random_uuid(); v_snapshot jsonb; v_lpns jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF t.status <> 'READY_FOR_LOAD' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packing_lists WHERE task_id = t.id AND status = 'LIBERADO') THEN
    RETURN (SELECT jsonb_build_object('id', id, 'packing_list_number', packing_list_number, 'version', version) FROM public.wh_packing_lists WHERE task_id = t.id AND status = 'LIBERADO');
  END IF;
  PERFORM 1 FROM public.wh_lpns WHERE task_id = t.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID' AND (status <> 'CLOSED' OR audit_status <> 'APROBADO')) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packages WHERE task_id = t.id AND (status = 'PICKED' OR (status = 'PACKED' AND lpn_id IS NULL))) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns l WHERE l.task_id = t.id AND l.status <> 'VOID' AND (
             l.package_count <> (SELECT count(*) FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'PACKED')
             OR l.quantity <> (SELECT coalesce(sum(p.quantity), 0) FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'PACKED'))) THEN
    RETURN NULL;
  END IF;
  -- La autorización proviene de las auditorías individuales, nunca del usuario que termina Picking.
  SELECT audited_by INTO v_auditor FROM public.wh_lpns
    WHERE task_id = t.id AND status <> 'VOID' AND audit_status = 'APROBADO'
    ORDER BY audited_at DESC NULLS LAST, id LIMIT 1;
  IF v_auditor IS NULL THEN RETURN NULL; END IF;
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
    'auditor_name', public.wh_profile_name(v_auditor), 'released_at', now(),
    'lpn_count', jsonb_array_length(v_lpns),
    'package_count', (SELECT sum((x->>'package_count')::integer) FROM jsonb_array_elements(v_lpns) x),
    'total_weight_kg', (SELECT sum((x->>'weight_kg')::numeric) FROM jsonb_array_elements(v_lpns) x),
    'lpns', v_lpns);
  INSERT INTO public.wh_packing_lists(id, task_id, transport_request_id, site_id, packing_list_number, version, status, snapshot, released_by, override_reason)
  VALUES (v_id, t.id, t.transport_request_id, t.site_id, v_number, v_version, 'LIBERADO', v_snapshot, v_auditor, NULL);
  INSERT INTO public.wh_scan_events(site_id, task_id, event_type, scanned_code, payload, operator_id, client_event_id)
  VALUES (t.site_id, t.id, 'PACKING_LIST_RELEASED', v_number, jsonb_build_object('version', v_version, 'id', v_id, 'automatic', true), auth.uid(), gen_random_uuid());
  RETURN jsonb_build_object('id', v_id, 'packing_list_number', v_number, 'version', v_version);
END $$;


REVOKE ALL ON FUNCTION wms_private.refresh_packing_list(uuid) FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.wh_audit_lpn(uuid, text, text, text, text[], text) SET SCHEMA wms_private;
CREATE FUNCTION public.wh_audit_lpn(p_lpn_id uuid, p_result text, p_comment text DEFAULT NULL, p_package_code text DEFAULT NULL,
  p_evidence_paths text[] DEFAULT '{}', p_override_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb; v_task uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso de auditoría' USING ERRCODE = '42501'; END IF;
  SELECT task_id INTO v_task FROM public.wh_lpns WHERE id = p_lpn_id;
  -- Mismo orden de bloqueo que finalizar Picking y asignar unidad.
  PERFORM 1 FROM public.wh_tasks WHERE id = v_task AND public.can_access_site(site_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LPN no disponible'; END IF;
  -- Todas las comprobaciones de auditor, sede y separación de funciones siguen en la función original.
  v_result := wms_private.wh_audit_lpn(p_lpn_id, p_result, p_comment, p_package_code, p_evidence_paths, p_override_reason);
  SELECT task_id INTO v_task FROM public.wh_lpns WHERE id = p_lpn_id;
  IF upper(p_result) IN ('OBSERVADO','RECHAZADO') THEN
    UPDATE public.wh_lpns SET load_unit_id = NULL WHERE id = p_lpn_id AND status = 'CLOSED'
      AND NOT EXISTS (SELECT 1 FROM public.wh_packages WHERE lpn_id = p_lpn_id AND status = 'LOADED');
  END IF;
  IF upper(p_result) = 'APROBADO' THEN PERFORM wms_private.refresh_packing_list(v_task); END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_audit_lpn(uuid, text, text, text, text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_audit_lpn(uuid, text, text, text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_audit_lpn(uuid, text, text, text, text[], text) TO authenticated;

ALTER FUNCTION public.wh_task_action(uuid, text, text) SET SCHEMA wms_private;
CREATE FUNCTION public.wh_task_action(p_task_id uuid, p_action text, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := wms_private.wh_task_action(p_task_id, p_action, p_reason);
  IF upper(p_action) IN ('FINISH_PICKING','READY_FOR_LOAD') THEN PERFORM wms_private.refresh_packing_list(p_task_id); END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_task_action(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_task_action(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_task_action(uuid, text, text) TO authenticated;

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
  IF EXISTS (SELECT 1 FROM public.wh_packing_lists WHERE task_id = t.id AND status = 'LIBERADO') THEN
    RETURN (SELECT jsonb_build_object('id', id, 'packing_list_number', packing_list_number, 'version', version) FROM public.wh_packing_lists WHERE task_id = t.id AND status = 'LIBERADO');
  END IF;
  PERFORM 1 FROM public.wh_lpns WHERE task_id = t.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID') THEN RAISE EXCEPTION 'La tarea no tiene LPN'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = t.id AND status <> 'VOID' AND (status <> 'CLOSED' OR audit_status <> 'APROBADO')) THEN
    RAISE EXCEPTION 'Hay LPN pendientes, observados o rechazados';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packages WHERE task_id = t.id AND (status = 'PICKED' OR (status = 'PACKED' AND lpn_id IS NULL))) THEN RAISE EXCEPTION 'Hay paquetes recogidos sin consolidar'; END IF;
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


-- Asignación múltiple atómica: se valida toda la selección antes de cambiar un solo LPN.
CREATE FUNCTION public.wh_lpns_assign_unit(p_task_id uuid, p_lpn_ids uuid[], p_unit_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; l public.wh_lpns%ROWTYPE; ids uuid[]; v_n integer;
BEGIN
  t := public.wh_load_unit_task(p_task_id);
  SELECT array_agg(DISTINCT x ORDER BY x) INTO ids FROM unnest(p_lpn_ids) x WHERE x IS NOT NULL;
  IF coalesce(cardinality(ids), 0) = 0 THEN RAISE EXCEPTION 'Seleccione al menos un bulto liberado'; END IF;
  IF cardinality(ids) > 500 THEN RAISE EXCEPTION 'Seleccione hasta 500 bultos por operación'; END IF;
  IF p_unit_id IS NOT NULL THEN
    PERFORM 1 FROM public.wh_load_units WHERE id = p_unit_id AND task_id = t.id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'La unidad no pertenece a esta tarea'; END IF;
  END IF;
  PERFORM 1 FROM public.wh_lpns WHERE id = ANY(ids) AND task_id = t.id ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_n FROM public.wh_lpns WHERE id = ANY(ids) AND task_id = t.id;
  IF v_n <> cardinality(ids) THEN RAISE EXCEPTION 'Hay bultos que no pertenecen a esta tarea'; END IF;
  IF EXISTS (SELECT 1 FROM public.wh_lpns WHERE id = ANY(ids) AND (status <> 'CLOSED' OR audit_status <> 'APROBADO')) THEN
    RAISE EXCEPTION 'Solo se asignan bultos liberados por Auditoría';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wh_packages WHERE lpn_id = ANY(ids) AND status = 'LOADED') THEN
    RAISE EXCEPTION 'Solo se asignan bultos aún no cargados';
  END IF;
  FOR l IN SELECT * FROM public.wh_lpns WHERE id = ANY(ids) ORDER BY id LOOP
    IF l.load_unit_id IS DISTINCT FROM p_unit_id THEN
      INSERT INTO public.wh_scan_events(site_id, task_id, lpn_id, event_type, scanned_code, payload, operator_id, client_event_id)
      VALUES (t.site_id, t.id, l.id, 'LPN_UNIT_ASSIGNED', l.lpn_code,
        jsonb_build_object('previous_unit_id', l.load_unit_id, 'unit_id', p_unit_id), auth.uid(), gen_random_uuid());
    END IF;
  END LOOP;
  -- Solo se modifica el destino: códigos, etiquetas, existencias y aprobación permanecen intactos.
  UPDATE public.wh_lpns SET load_unit_id = p_unit_id WHERE id = ANY(ids);
  RETURN jsonb_build_object('assigned', cardinality(ids), 'unit_id', p_unit_id);
END $$;
REVOKE ALL ON FUNCTION public.wh_lpns_assign_unit(uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_lpns_assign_unit(uuid, uuid[], uuid) TO authenticated;

-- Compatibilidad: ninguna llamada individual puede saltarse la validación de liberación.
CREATE OR REPLACE FUNCTION public.wh_lpn_assign_unit(p_lpn_id uuid, p_unit_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_task uuid;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para gestionar unidades de carga' USING ERRCODE = '42501'; END IF;
  SELECT task_id INTO v_task FROM public.wh_lpns WHERE id = p_lpn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bulto no encontrado'; END IF;
  PERFORM public.wh_lpns_assign_unit(v_task, ARRAY[p_lpn_id], p_unit_id);
END $$;
REVOKE ALL ON FUNCTION public.wh_lpn_assign_unit(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_lpn_assign_unit(uuid, uuid) TO authenticated;

-- Corregir el contenido o retirar su aprobación deja el LPN fuera del reparto, sin tocar etiquetas.
CREATE FUNCTION wms_private.clear_unreleased_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.wh_packages WHERE lpn_id = NEW.id AND status = 'LOADED') THEN
    NEW.load_unit_id := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wms_private.clear_unreleased_unit() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER wh_lpn_clear_unreleased_unit BEFORE UPDATE OF audit_status ON public.wh_lpns
FOR EACH ROW WHEN (OLD.audit_status = 'APROBADO' AND NEW.audit_status <> 'APROBADO')
EXECUTE FUNCTION wms_private.clear_unreleased_unit();

-- Actualizar el documento no libera LPN: solo materializa aprobaciones ya registradas.
-- También permite recuperar tareas listas anteriores a esta migración sin volver a aprobar ni reimprimir.
CREATE FUNCTION public.wh_refresh_packing_list(p_task_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN wms_private.refresh_packing_list(p_task_id);
END $$;
REVOKE ALL ON FUNCTION public.wh_refresh_packing_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_refresh_packing_list(uuid) TO authenticated;
