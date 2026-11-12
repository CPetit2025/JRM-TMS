-- Flujo con el TMS: la SALIDA del despacho en el TMS espera la liberación del almacén (picking + auditoría).
-- 1) wh_tms_request_states: estado de cada tarea con la misma regla de «display_state» del tablero, para que el servidor
--    del WMS lo informe al TMS (wms_report_request_status, con la clave de integración). La hora de la foto es la de
--    esta base: el TMS descarta fotos más viejas (reintentos fuera de orden).
-- 2) El feed del TMS trae la ruta asignada (N.º, placa, conductor): se guarda en la tarea y la placa se usa por defecto
--    en la unidad de carga (UT1 sin placa la toma; una UT nueva sin placa nace con ella).
-- 3) Corte: si el TMS marca la solicitud como asignada antes del flujo con WMS («legacy_flow»), su tarea pendiente se
--    cierra (CANCELLED) con ese motivo; si ya tiene bultos recogidos no se toca (igual que 20261112100000).

ALTER TABLE public.wh_tasks ADD COLUMN IF NOT EXISTS tms_dispatch_number text,
  ADD COLUMN IF NOT EXISTS tms_vehicle_plate text, ADD COLUMN IF NOT EXISTS tms_driver_name text;

CREATE OR REPLACE FUNCTION public.wh_tms_request_states()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('transport_request_id', t.transport_request_id, 'task_code', t.task_code,
      'status', CASE
        WHEN pl.id IS NOT NULL THEN 'LIBERADO'
        WHEN t.status = 'CANCELLED' THEN 'CANCELADO'
        WHEN t.status = 'PAUSED' THEN 'PAUSADO'
        WHEN t.status IN ('PICKING','PACKING','READY_FOR_LOAD') AND EXISTS (SELECT 1 FROM public.wh_lpns l
             WHERE l.task_id = t.id AND l.status <> 'VOID' AND l.audit_status IN ('OBSERVADO','RECHAZADO')) THEN 'OBSERVADO'
        WHEN t.status = 'READY_FOR_LOAD' THEN 'EN_AUDITORIA'
        WHEN t.status IN ('PICKING','PACKING') THEN 'EN_PICKING'
        ELSE 'PENDIENTE' END,
      'released_at', pl.released_at, 'snapshot_at', now()))
    FROM (SELECT * FROM public.wh_tasks t
          WHERE public.can_access_site(t.site_id)
            AND (t.status NOT IN ('LOADED','RECONCILED','CANCELLED') OR t.updated_at > now() - interval '3 days')
          ORDER BY t.updated_at DESC LIMIT 2000) t
    LEFT JOIN public.wh_packing_lists pl ON pl.task_id = t.id AND pl.status = 'LIBERADO'), '[]'::jsonb);
END $function$;
REVOKE ALL ON FUNCTION public.wh_tms_request_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_tms_request_states() TO authenticated;

-- Unidad de carga nueva sin placa: toma la placa asignada en el TMS.
CREATE OR REPLACE FUNCTION public.wh_load_unit_add(p_task_id uuid, p_plate text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; u public.wh_load_units%ROWTYPE;
BEGIN
  t := public.wh_load_unit_task(p_task_id);
  INSERT INTO public.wh_load_units(task_id, site_id, seq, plate)
  VALUES (t.id, t.site_id, (SELECT coalesce(max(seq), 0) + 1 FROM public.wh_load_units WHERE task_id = t.id),
          coalesce(nullif(upper(regexp_replace(btrim(coalesce(p_plate, '')), '\s+', '', 'g')), ''), t.tms_vehicle_plate))
  RETURNING * INTO u;
  RETURN jsonb_build_object('id', u.id, 'seq', u.seq, 'label', 'UT' || u.seq, 'plate', u.plate);
END $function$;

CREATE OR REPLACE FUNCTION public.wh_tms_sync_apply(p_key text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; c jsonb; v_site uuid; v_n integer := 0; v_contract uuid; v_client uuid; v_plate text;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF NOT public.wh_tms_key_ok(p_key) THEN RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501'; END IF;
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
    -- Ruta asignada en el TMS (se puede asignar antes de liberar): N.º, placa y conductor para la etapa de Carga.
    v_plate := nullif(upper(regexp_replace(btrim(coalesce(r->'dispatch'->>'vehicle_plate', '')), '\s+', '', 'g')), '');
    UPDATE public.wh_tasks SET tms_dispatch_number = r->'dispatch'->>'number', tms_vehicle_plate = v_plate, tms_driver_name = r->'dispatch'->>'driver_name'
     WHERE transport_request_id = (r->>'id')::uuid
       AND (tms_dispatch_number, tms_vehicle_plate, tms_driver_name) IS DISTINCT FROM (r->'dispatch'->>'number', v_plate, r->'dispatch'->>'driver_name');
    IF v_plate IS NOT NULL THEN
      UPDATE public.wh_load_units u SET plate = v_plate FROM public.wh_tasks t
       WHERE t.transport_request_id = (r->>'id')::uuid AND u.task_id = t.id AND u.seq = 1 AND u.plate IS NULL;
    END IF;
    -- Asignada antes del corte del flujo con WMS: la tarea pendiente se cierra (si ya tiene bultos, no se toca).
    IF coalesce((r->>'legacy_flow')::boolean, false) THEN
      UPDATE public.wh_tasks t SET status = 'CANCELLED', cancelled_reason = 'Solicitud asignada antes del flujo con WMS'
       WHERE t.transport_request_id = (r->>'id')::uuid AND t.status IN ('PENDING','PICKING','PAUSED')
         AND NOT EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.task_id = t.id AND p.status <> 'VOID');
    END IF;
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.wh_tms_sync_state SET last_ok_at = now(), last_count = v_n, last_error = NULL WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'requests', v_n);
END $function$;

-- Tablero: muestra la ruta asignada en el TMS (N.º, placa, conductor).
CREATE OR REPLACE FUNCTION public.wh_task_board(p_scope text DEFAULT 'tareas'::text, p_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      'tms_dispatch_number', t.tms_dispatch_number, 'tms_vehicle_plate', t.tms_vehicle_plate, 'tms_driver_name', t.tms_driver_name,
      'assigned_picker', t.assigned_picker, 'picker_name', public.wh_profile_name(t.assigned_picker), 'assigned_at', t.assigned_at, 'last_activity_at', public.wh_task_last_activity(t.id),
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
             THEN t.status IN ('PICKING','PACKING','READY_FOR_LOAD')
             ELSE t.status NOT IN ('LOADED','RECONCILED','CANCELLED') END)
    LIMIT 500) q), '[]'::jsonb);
END $function$;
