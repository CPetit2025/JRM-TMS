-- Solicitudes: los roles que solo crean solicitudes (p. ej. Jefe de Almacén, Solicitante de Transporte) editan o
-- cancelan únicamente su propia solicitud, mientras no esté asignada a un despacho ni atendida.
-- Sin cambio para Administrador, Despacho (incluida la aprobación) y Contratos/OT (área comercial).
BEGIN;

CREATE OR REPLACE FUNCTION public.can_edit_transport_request(p_request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NULL
    OR public.is_tms_admin()
    OR public.has_tms_permission('despacho')
    OR public.has_tms_permission('despacho-aprobacion')
    OR public.has_tms_permission('ot')
    OR EXISTS (
      SELECT 1 FROM public.transport_requests t
      WHERE t.id = p_request_id AND t.created_by = auth.uid()
        AND t.status IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'APROBADA', 'APROBADO', 'OBSERVADA', 'REPROGRAMADA')
        AND NOT EXISTS (
          SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id = dr.dispatch_id
          WHERE dr.transport_request_id = t.id AND COALESCE(d.status, '') <> 'CANCELADO'));
$$;
REVOKE ALL ON FUNCTION public.can_edit_transport_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_transport_request(uuid) TO authenticated, service_role;

-- Edición: se envuelve la versión instalada sin cambiar su firma (producción puede diferir del repositorio)
DO $mig$
BEGIN
  IF to_regprocedure('public.save_transport_request_full_before_owner_guard(uuid,jsonb,jsonb,jsonb)') IS NULL THEN
    ALTER FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) RENAME TO save_transport_request_full_before_owner_guard;
  END IF;
  IF to_regprocedure('public.set_transport_request_status_before_owner_guard(uuid,text,date)') IS NULL THEN
    ALTER FUNCTION public.set_transport_request_status(uuid, text, date) RENAME TO set_transport_request_status_before_owner_guard;
  END IF;
END $mig$;
REVOKE ALL ON FUNCTION public.save_transport_request_full_before_owner_guard(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full_before_owner_guard(uuid, jsonb, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.set_transport_request_status_before_owner_guard(uuid, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status_before_owner_guard(uuid, text, date) TO service_role;

CREATE OR REPLACE FUNCTION public.save_transport_request_full(p_request_id uuid, p_payload jsonb, p_components jsonb, p_unloading jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_request_id IS NOT NULL AND NOT public.can_edit_transport_request(p_request_id) THEN
    RAISE EXCEPTION 'Solo puede editar sus propias solicitudes que aún no estén asignadas ni atendidas' USING ERRCODE = '42501';
  END IF;
  RETURN public.save_transport_request_full_before_owner_guard(p_request_id, p_payload, p_components, p_unloading);
END $$;
REVOKE ALL ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_transport_request_full(uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_transport_request_status(p_request_id uuid, p_new_status text, p_required_date date DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_new_status = 'CANCELADA' AND NOT public.can_edit_transport_request(p_request_id) THEN
    RAISE EXCEPTION 'Solo puede cancelar sus propias solicitudes que aún no estén asignadas ni atendidas' USING ERRCODE = '42501';
  END IF;
  PERFORM public.set_transport_request_status_before_owner_guard(p_request_id, p_new_status, p_required_date);
END $$;
REVOKE ALL ON FUNCTION public.set_transport_request_status(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_transport_request_status(uuid, text, date) TO authenticated, service_role;

-- Escritura directa por la API: la misma regla (Despacho conserva su acceso)
ALTER POLICY requests_write_site ON public.transport_requests
  USING (public.can_access_site(site_id) AND (
    (SELECT public.has_tms_permission('despacho'))
    OR ((SELECT public.has_tms_permission('solicitudes')) AND public.can_edit_transport_request(id))));

NOTIFY pgrst, 'reload schema';
COMMIT;
