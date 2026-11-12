-- Flujo «Solicitud → Picking y auditoría (WMS) → asignación/programación → SALIDA → entrega».
-- Asignar unidad y programar la ruta sigue permitido antes de que el almacén libere. Lo que se bloquea es la SALIDA:
-- un despacho no pasa a EN_CURSO / EN RUTA (ni una solicitud a EN TRANSITO) mientras alguna de sus solicitudes
-- de despacho desde el APT (Planta Chilca) no esté LIBERADA en el WMS (Packing List liberado = picking + auditoría).
--
-- Señal WMS → TMS: el servidor del WMS llama wms_report_request_status con la clave de integración (mismo mecanismo
-- que wms_feed_solicitudes / wms_report_packing_list: solo el hash vive aquí). Idempotente: cada fila trae la hora de
-- la foto del WMS y una foto más vieja nunca pisa una más nueva. Si el WMS deja de informar (latido > 15 min), la
-- salida sigue bloqueada (falla cerrada) y se muestra «Sin respuesta del WMS».
--
-- Alcance (solo lectura de columnas que existen en producción): request_type DESPACHO (nulo = DESPACHO, como el feed),
-- con OT (contract_id) y origen Planta Chilca, que es donde está el APT (el formulario fija ese origen en todo
-- despacho). RECOJO y TRASLADO no cambian.
--
-- Corte: system_settings.wms_release_gate_cutover = hora de aplicación. Las solicitudes que a esa hora ya estaban
-- asignadas, en tránsito o entregadas (o ya vinculadas a un despacho) quedan con una excepción de sistema y siguen su
-- flujo; las APROBADAS entran al flujo nuevo. Excepción manual: Supervisor de Despacho / Administrador, con motivo.

CREATE TABLE IF NOT EXISTS public.request_wms_status (
  transport_request_id uuid PRIMARY KEY REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('PENDIENTE','EN_PICKING','EN_AUDITORIA','OBSERVADO','LIBERADO','PAUSADO','CANCELADO')),
  task_code text,
  released_at timestamptz,
  wms_snapshot_at timestamptz NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.request_wms_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.request_wms_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.request_wms_status TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.request_wms_status;
CREATE POLICY security_active_account ON public.request_wms_status AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS request_wms_status_read ON public.request_wms_status;
CREATE POLICY request_wms_status_read ON public.request_wms_status FOR SELECT TO authenticated
  USING ((public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'))
    AND EXISTS (SELECT 1 FROM public.transport_requests r WHERE r.id = request_wms_status.transport_request_id));

-- Excepciones de salida (solo se agregan: quedan como auditoría). created_by nulo = excepción de sistema del corte.
CREATE TABLE IF NOT EXISTS public.request_wms_release_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transport_request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_wms_release_overrides_request_idx ON public.request_wms_release_overrides(transport_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS request_wms_release_overrides_created_by_idx ON public.request_wms_release_overrides(created_by);
ALTER TABLE public.request_wms_release_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.request_wms_release_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.request_wms_release_overrides TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.request_wms_release_overrides;
CREATE POLICY security_active_account ON public.request_wms_release_overrides AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS request_wms_release_overrides_read ON public.request_wms_release_overrides;
CREATE POLICY request_wms_release_overrides_read ON public.request_wms_release_overrides FOR SELECT TO authenticated
  USING ((public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'))
    AND EXISTS (SELECT 1 FROM public.transport_requests r WHERE r.id = request_wms_release_overrides.transport_request_id));

-- Alcance: despacho con OT desde Planta Chilca (APT).
CREATE OR REPLACE FUNCTION public.wms_release_in_scope(p_type text, p_contract uuid, p_pickup text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT upper(coalesce(p_type, 'DESPACHO')) = 'DESPACHO' AND p_contract IS NOT NULL AND coalesce(p_pickup, '') ILIKE '%chilca%'
$$;

-- Corte (se guarda una sola vez) y excepciones de sistema para lo ya asignado/despachado a esa hora.
INSERT INTO public.system_settings(key, value, description, updated_at)
VALUES ('wms_release_gate_cutover', now()::text,
  'Inicio del flujo con WMS: desde aquí la salida de despachos APT exige la liberación del almacén (picking y auditoría).', now())
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.request_wms_release_overrides(transport_request_id, reason, created_by, created_at)
SELECT r.id, 'Solicitud asignada antes del flujo con WMS', NULL,
       (SELECT value::timestamptz FROM public.system_settings WHERE key = 'wms_release_gate_cutover')
FROM public.transport_requests r
WHERE public.wms_release_in_scope(r.request_type, r.contract_id, r.pickup_address)
  AND (upper(coalesce(r.status, '')) IN ('ASIGNADA','EN TRANSITO','EN TRÁNSITO','EN_TRANSITO','ENTREGADA')
       OR EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.transport_request_id = r.id))
  AND NOT EXISTS (SELECT 1 FROM public.request_wms_release_overrides o WHERE o.transport_request_id = r.id);

-- Estado de liberación de una solicitud (interno: triggers y RPC de lectura).
CREATE OR REPLACE FUNCTION public.wms_release_gate(p_request uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; s record; o record; v_beat timestamptz; v_state text;
BEGIN
  SELECT t.id, t.request_number, t.request_type, t.contract_id, t.pickup_address INTO r FROM public.transport_requests t WHERE t.id = p_request;
  IF NOT FOUND OR NOT public.wms_release_in_scope(r.request_type, r.contract_id, r.pickup_address) THEN
    RETURN jsonb_build_object('id', p_request, 'request_number', r.request_number, 'required', false, 'blocked', false);
  END IF;
  SELECT x.reason, x.created_at, x.created_by INTO o FROM public.request_wms_release_overrides x
   WHERE x.transport_request_id = p_request ORDER BY x.created_at DESC LIMIT 1;
  SELECT x.status, x.released_at, x.task_code, x.reported_at INTO s FROM public.request_wms_status x WHERE x.transport_request_id = p_request;
  SELECT nullif(value, '')::timestamptz INTO v_beat FROM public.system_settings WHERE key = 'wms_status_last_report';
  v_state := CASE WHEN s.status = 'LIBERADO' THEN 'LIBERADO'
                  WHEN v_beat IS NULL OR v_beat < now() - interval '15 minutes' THEN 'SIN_RESPUESTA'
                  ELSE coalesce(s.status, 'PENDIENTE') END;
  RETURN jsonb_build_object('id', p_request, 'request_number', r.request_number, 'required', true, 'state', v_state,
    'label', CASE v_state WHEN 'LIBERADO' THEN 'Liberada' WHEN 'SIN_RESPUESTA' THEN 'Sin respuesta del WMS'
      WHEN 'PENDIENTE' THEN 'Pendiente de picking' WHEN 'EN_PICKING' THEN 'En picking' WHEN 'EN_AUDITORIA' THEN 'En auditoría'
      WHEN 'OBSERVADO' THEN 'Observada en auditoría' WHEN 'PAUSADO' THEN 'Pausada en el WMS' WHEN 'CANCELADO' THEN 'Cancelada en el WMS'
      ELSE v_state END,
    'task_code', s.task_code, 'released_at', s.released_at, 'reported_at', s.reported_at,
    'override', CASE WHEN o.reason IS NOT NULL THEN jsonb_build_object('reason', o.reason, 'at', o.created_at,
      'by', coalesce((SELECT nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), '') FROM public.profiles p WHERE p.id = o.created_by), 'Sistema')) END,
    'blocked', v_state <> 'LIBERADO' AND o.reason IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.wms_release_gate(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wms_release_assert(p_requests uuid[])
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_msg text;
BEGIN
  SELECT string_agg(format('La solicitud %s aún no fue liberada por el almacén (picking y auditoría en el WMS); no puede salir. Estado WMS: %s.',
           g->>'request_number', g->>'label'), ' ' ORDER BY g->>'request_number')
    INTO v_msg
  FROM (SELECT DISTINCT unnest(p_requests) AS id) x CROSS JOIN LATERAL public.wms_release_gate(x.id) g
  WHERE x.id IS NOT NULL AND (g->>'blocked')::boolean;
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION '%', v_msg USING ERRCODE = 'P0001', HINT = 'wms_release_check';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.wms_release_assert(uuid[]) FROM PUBLIC, anon, authenticated;

-- Salida del despacho: misma condición que audit_finding_release_guard (PROGRAMADO → EN_CURSO/EN RUTA, y en flota
-- propia también EN_CURSO → EN RUTA, que es cuando el conductor inicia desde la app).
CREATE OR REPLACE FUNCTION public.wms_release_departure_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('EN_CURSO', 'EN RUTA', 'EN_RUTA', 'EN_TRANSITO') AND NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status = 'PROGRAMADO'
       OR (OLD.status = 'EN_CURSO' AND to_jsonb(NEW) ->> 'modalidad' IS DISTINCT FROM 'TERCERO')) THEN
    PERFORM public.wms_release_assert(ARRAY(SELECT dr.transport_request_id FROM public.dispatch_requests dr WHERE dr.dispatch_id = NEW.id));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.wms_release_departure_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS wms_release_departure_guard ON public.dispatches;
CREATE TRIGGER wms_release_departure_guard BEFORE UPDATE OF status ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.wms_release_departure_guard();

-- Una solicitud no pasa a EN TRANSITO por otra vía (cambio de estado manual) sin liberación.
CREATE OR REPLACE FUNCTION public.wms_release_request_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF upper(coalesce(NEW.status, '')) IN ('EN TRANSITO', 'EN TRÁNSITO', 'EN_TRANSITO')
     AND upper(coalesce(OLD.status, '')) IN ('APROBADA', 'APROBADO', 'REPROGRAMADA', 'ASIGNADA') THEN
    PERFORM public.wms_release_assert(ARRAY[NEW.id]);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.wms_release_request_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS wms_release_request_guard ON public.transport_requests;
CREATE TRIGGER wms_release_request_guard BEFORE UPDATE OF status ON public.transport_requests
  FOR EACH ROW EXECUTE FUNCTION public.wms_release_request_guard();

-- Lectura para la UI: por solicitudes (Solicitudes / Programación) o por despacho (Torre, detalle y app del conductor).
CREATE OR REPLACE FUNCTION public.wms_release_status(p_requests uuid[] DEFAULT NULL, p_dispatch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ids uuid[];
BEGIN
  IF NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  IF p_dispatch IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = p_dispatch
         AND ((public.has_tms_read_permission('despacho') AND public.can_access_site(d.site_id))
           OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id AND dr.profile_id = auth.uid()))) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al despacho');
    END IF;
    v_ids := ARRAY(SELECT dr.transport_request_id FROM public.dispatch_requests dr WHERE dr.dispatch_id = p_dispatch AND dr.transport_request_id IS NOT NULL);
  ELSE
    IF NOT (public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho')) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
    END IF;
    v_ids := ARRAY(SELECT t.id FROM public.transport_requests t WHERE t.id = ANY(coalesce(p_requests, '{}')) AND public.can_access_site(t.site_id) LIMIT 1000);
  END IF;
  RETURN jsonb_build_object('success', true, 'can_override', public.has_tms_permission('despacho-aprobacion'),
    'items', coalesce((SELECT jsonb_agg(public.wms_release_gate(x)) FROM (SELECT DISTINCT unnest(v_ids) AS x) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.wms_release_status(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_release_status(uuid[], uuid) TO authenticated;

-- Excepción de emergencia con motivo obligatorio (queda registrada con usuario y hora).
CREATE OR REPLACE FUNCTION public.wms_release_override(p_request uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g jsonb;
BEGIN
  IF NOT public.is_active_tms_user() OR NOT public.has_tms_permission('despacho-aprobacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Supervisor de Despacho o un administrador autoriza la salida sin liberación del WMS');
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la excepción (mínimo 20 caracteres)');
  END IF;
  PERFORM 1 FROM public.transport_requests t WHERE t.id = p_request AND public.can_access_site(t.site_id) FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solicitud no encontrada');
  END IF;
  g := public.wms_release_gate(p_request);
  IF NOT (g->>'required')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud no requiere liberación del WMS'); END IF;
  IF NOT (g->>'blocked')::boolean THEN RETURN jsonb_build_object('success', false, 'error', 'La solicitud ya está liberada o tiene excepción'); END IF;
  INSERT INTO public.request_wms_release_overrides(transport_request_id, reason, created_by) VALUES (p_request, btrim(p_reason), auth.uid());
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.wms_release_override(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wms_release_override(uuid, text) TO authenticated;

-- Señal del WMS. Filas: {transport_request_id, status, task_code, released_at, snapshot_at}. Ignora solicitudes que no
-- existen; una foto más vieja no reemplaza una más nueva (reintentos fuera de orden). Registra el latido.
CREATE OR REPLACE FUNCTION public.wms_report_request_status(p_key text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.integration_key_ok('wms', p_key) THEN
    RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'Formato de estados WMS inválido';
  END IF;
  INSERT INTO public.request_wms_status AS s (transport_request_id, status, task_code, released_at, wms_snapshot_at, reported_at)
  SELECT DISTINCT ON (t.id) t.id, e->>'status', left(e->>'task_code', 60), (e->>'released_at')::timestamptz,
         coalesce((e->>'snapshot_at')::timestamptz, now()), now()
  FROM jsonb_array_elements(p_rows) e
  JOIN public.transport_requests t ON t.id = (e->>'transport_request_id')::uuid
  WHERE e->>'status' IN ('PENDIENTE','EN_PICKING','EN_AUDITORIA','OBSERVADO','LIBERADO','PAUSADO','CANCELADO')
  ORDER BY t.id, coalesce((e->>'snapshot_at')::timestamptz, now()) DESC
  ON CONFLICT (transport_request_id) DO UPDATE SET status = EXCLUDED.status, task_code = EXCLUDED.task_code,
    released_at = EXCLUDED.released_at, wms_snapshot_at = EXCLUDED.wms_snapshot_at, reported_at = now()
  WHERE EXCLUDED.wms_snapshot_at >= s.wms_snapshot_at
    AND (s.status, s.task_code, s.released_at) IS DISTINCT FROM (EXCLUDED.status, EXCLUDED.task_code, EXCLUDED.released_at);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.system_settings(key, value, description, updated_at)
  VALUES ('wms_status_last_report', now()::text, 'Último informe de estados del WMS (latido de la integración).', now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  RETURN jsonb_build_object('success', true, 'applied', v_n);
END $$;
REVOKE ALL ON FUNCTION public.wms_report_request_status(text, jsonb) FROM PUBLIC;
-- Igual que las otras dos funciones de la integración: el servidor del WMS llama sin sesión TMS y la clave es obligatoria.
GRANT EXECUTE ON FUNCTION public.wms_report_request_status(text, jsonb) TO anon, authenticated;

-- El feed al WMS agrega la ruta asignada (placa y conductor) para la etapa de Carga y si la solicitud sigue el flujo
-- anterior al corte. Mismo cuerpo que 20261231100000_wms_feed_columnas_produccion.sql más «dispatch» y «legacy_flow».
CREATE OR REPLACE FUNCTION public.wms_feed_solicitudes(p_key text, p_known_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.integration_key_ok('wms', p_key) THEN
    RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'request_number', r.request_number,
      'request_type', upper(coalesce(r.request_type, 'DESPACHO')),
      'attention_mode', j->>'attention_mode', 'status', r.status,
      'required_date', r.required_date, 'required_at', j->>'required_at', 'created_at', r.created_at,
      'requester_name', r.requester_name, 'pickup_address', r.pickup_address, 'delivery_address', r.delivery_address,
      'reference_number', j->>'reference_number', 'purchase_order', j->>'purchase_order',
      'site_code', (SELECT s.code FROM public.sites s WHERE s.id = r.site_id),
      'client', (SELECT jsonb_build_object('id', cl.id, 'business_name', cl.business_name, 'ruc', cl.ruc,
                   'commercial_name', cl.commercial_name)
                 FROM public.clients cl WHERE cl.id = coalesce((j->>'client_id')::uuid, c.client_id)),
      'contract', jsonb_build_object('id', c.id, 'code', c.code, 'type', c.type::text, 'client_id', c.client_id),
      'components', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', rc.id, 'requested_weight_kg', rc.requested_weight_kg,
                 'requested_volume_m3', rc.requested_volume_m3,
                 'contract', jsonb_build_object('id', cc.id, 'code', cc.code, 'type', cc.type::text, 'client_id', cc.client_id)))
        FROM public.transport_request_components rc JOIN public.contracts cc ON cc.id = rc.component_contract_id
        WHERE rc.request_id = r.id), '[]'::jsonb),
      'dispatch', (SELECT jsonb_build_object('id', d.id, 'number', d.dispatch_number, 'vehicle_plate', d.vehicle_plate,
                     'driver_name', d.driver_name, 'status', d.status, 'scheduled_departure', d.scheduled_departure)
                   FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
                   WHERE dr.transport_request_id = r.id AND d.status <> 'CANCELADO'
                   ORDER BY dr.created_at DESC LIMIT 1),
      -- Asignada antes del corte: el WMS cierra su tarea pendiente («Solicitud asignada antes del flujo con WMS»).
      'legacy_flow', EXISTS (SELECT 1 FROM public.request_wms_release_overrides o
                             WHERE o.transport_request_id = r.id AND o.created_by IS NULL)
    ) ORDER BY r.created_at)
    FROM public.transport_requests r
    CROSS JOIN LATERAL to_jsonb(r) j
    JOIN public.contracts c ON c.id = r.contract_id
    WHERE r.id = ANY(coalesce(p_known_ids, '{}'))
       OR (upper(coalesce(r.request_type, 'DESPACHO')) = 'DESPACHO'
           AND upper(r.status) IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE DE APROBACION', 'APROBADA',
                                   'APROBADO', 'ASIGNADA', 'REPROGRAMADA', 'OBSERVADA'))
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_feed_solicitudes(text, uuid[]) TO anon, authenticated;
