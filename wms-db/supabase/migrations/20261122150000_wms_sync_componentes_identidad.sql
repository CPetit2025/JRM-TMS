-- Sincronización TMS→WMS: corrige la identidad de los componentes y aísla cada solicitud.
--
-- Incidente (17-11-2026 → 22-11-2026): al editar una solicitud, el TMS borra y vuelve a crear sus componentes con id
-- nuevo. wh_tms_sync_apply insertaba con ON CONFLICT (id) ANTES de borrar los retirados, así que el componente nuevo
-- (mismo contrato, otro id) chocaba con la fila vieja en UNIQUE (request_id, component_contract_id). Como la corrida es
-- una sola transacción, esa solicitud detenía la sincronización de todas.
--
-- Cambios:
-- 1. Los componentes se identifican por (solicitud, contrato): primero se borran los retirados (y los que cambiaron de
--    contrato), luego se inserta con ON CONFLICT (request_id, component_contract_id) tomando el id del TMS y
--    actualizando peso y volumen. Ninguna FK apunta a transport_request_components.id.
-- 2. Un contrato repetido en la misma solicitud de la fuente se rechaza (solo esa solicitud).
-- 3. Cada solicitud corre en su propio bloque: si falla, se registra en last_error y las demás siguen.
CREATE OR REPLACE FUNCTION public.wh_tms_sync_apply(p_key text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r jsonb; c jsonb; v_site uuid; v_n integer := 0; v_contract uuid; v_client uuid; v_plate text;
  v_req uuid; v_comp jsonb; v_errors jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_tms_sync_allowed() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  IF NOT public.wh_tms_key_ok(p_key) THEN RAISE EXCEPTION 'Clave de integración inválida' USING ERRCODE = '42501'; END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Formato de sincronización inválido'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
   BEGIN
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
    v_req := (r->>'id')::uuid;
    v_comp := coalesce(r->'components', '[]'::jsonb);
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_comp) e WHERE e->'contract'->>'id' IS NOT NULL GROUP BY e->'contract'->>'id' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Componentes duplicados para el mismo contrato en la solicitud %', r->>'request_number';
    END IF;
    -- Retirados: contrato que ya no viene, o id que ahora trae otro contrato.
    DELETE FROM public.transport_request_components x WHERE x.request_id = v_req
      AND (x.component_contract_id IS NULL
           OR x.component_contract_id NOT IN (SELECT (e->'contract'->>'id')::uuid FROM jsonb_array_elements(v_comp) e WHERE e->'contract'->>'id' IS NOT NULL)
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_comp) e
                       WHERE (e->>'id')::uuid = x.id AND (e->'contract'->>'id')::uuid IS DISTINCT FROM x.component_contract_id));
    INSERT INTO public.transport_request_components(id, request_id, component_contract_id, requested_weight_kg, requested_volume_m3)
    SELECT (e->>'id')::uuid, v_req, (e->'contract'->>'id')::uuid, (e->>'requested_weight_kg')::numeric, (e->>'requested_volume_m3')::numeric
      FROM jsonb_array_elements(v_comp) e
    ON CONFLICT (request_id, component_contract_id) DO UPDATE SET id = EXCLUDED.id,
      requested_weight_kg = EXCLUDED.requested_weight_kg, requested_volume_m3 = EXCLUDED.requested_volume_m3;
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
   EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors || jsonb_build_object('request', coalesce(r->>'request_number', r->>'id'), 'error', SQLERRM);
   END;
  END LOOP;
  UPDATE public.wh_tms_sync_state SET last_ok_at = now(), last_count = v_n,
    last_error = CASE WHEN jsonb_array_length(v_errors) = 0 THEN NULL
      ELSE left(jsonb_array_length(v_errors) || ' solicitud(es) sin sincronizar: ' || v_errors::text, 500) END
   WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'requests', v_n, 'errors', v_errors);
END $function$;
