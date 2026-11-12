-- Historial de Picking: con p_scope = 'historial' el tablero devuelve las tareas activas (como 'tareas') y además las
-- cerradas (cargadas, conciliadas o canceladas) del rango p_from..p_to: fecha requerida en Lima o, sin ella, la de cierre.
-- 'tareas', 'auditoria' y p_task_id no cambian. Los parámetros nuevos tienen valor por defecto: se reemplaza la firma
-- (text, uuid) para que PostgREST no vea dos funciones con el mismo nombre.
DROP FUNCTION IF EXISTS public.wh_task_board(text, uuid);

CREATE OR REPLACE FUNCTION public.wh_task_board(p_scope text DEFAULT 'tareas'::text, p_task_id uuid DEFAULT NULL::uuid,
  p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_to date := coalesce(p_to, (now() AT TIME ZONE 'America/Lima')::date);
  -- Como máximo un año de cerradas por consulta.
  v_from date := greatest(coalesce(p_from, v_to), v_to - 366);
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin acceso al almacén' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x->>'sort_date' DESC) FROM (
    SELECT jsonb_build_object(
      'id', t.id, 'task_code', t.task_code, 'status', t.status, 'request_status', t.request_status,
      'request_number', r.request_number, 'transport_request_id', t.transport_request_id,
      'required_date', r.required_date, 'required_at', r.required_at, 'sort_date', coalesce(r.required_at::text, r.required_date::text, k.closed_at::text, t.created_at::text),
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
      -- Cierre (solo tareas cerradas): cuándo, quién (último usuario que la actualizó; vacío si la cerró la sincronización) y motivo.
      'closed_at', k.closed_at,
      'closed_by_name', CASE WHEN k.closed_at IS NOT NULL THEN public.wh_profile_name(t.updated_by) END,
      'cancelled_reason', CASE WHEN t.status = 'CANCELLED' THEN t.cancelled_reason END,
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
    CROSS JOIN LATERAL (SELECT CASE t.status WHEN 'LOADED' THEN coalesce(t.loaded_at, t.updated_at)
        WHEN 'RECONCILED' THEN coalesce(t.reconciled_at, t.loaded_at, t.updated_at) WHEN 'CANCELLED' THEN t.updated_at END AS closed_at) k
    CROSS JOIN LATERAL (SELECT count(*) AS total,
        count(*) FILTER (WHERE l.audit_status = 'APROBADO') AS approved, count(*) FILTER (WHERE l.audit_status = 'OBSERVADO') AS observed,
        count(*) FILTER (WHERE l.audit_status = 'RECHAZADO') AS rejected, count(*) FILTER (WHERE l.audit_status = 'PENDIENTE') AS pending,
        coalesce(sum(l.weight_kg), 0) AS weight
      FROM public.wh_lpns l WHERE l.task_id = t.id AND l.status <> 'VOID') s
    WHERE public.can_access_site(t.site_id)
      AND (p_task_id IS NULL OR t.id = p_task_id)
      AND (p_task_id IS NOT NULL OR CASE
             WHEN p_scope = 'auditoria' THEN t.status IN ('PICKING','PACKING','READY_FOR_LOAD')
             WHEN p_scope = 'historial' THEN t.status NOT IN ('LOADED','RECONCILED','CANCELLED')
               OR coalesce((r.required_at AT TIME ZONE 'America/Lima')::date, r.required_date, (k.closed_at AT TIME ZONE 'America/Lima')::date) BETWEEN v_from AND v_to
             ELSE t.status NOT IN ('LOADED','RECONCILED','CANCELLED') END)
    -- Activas primero: el tope de 500 nunca deja fuera una tarea por trabajar.
    ORDER BY k.closed_at IS NOT NULL, coalesce(r.required_at::text, r.required_date::text, k.closed_at::text, t.created_at::text) DESC
    LIMIT 500) q), '[]'::jsonb);
END $function$;

REVOKE ALL ON FUNCTION public.wh_task_board(text, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_task_board(text, uuid, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
