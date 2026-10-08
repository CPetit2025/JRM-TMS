-- Tipo de servicio de solicitudes ya programadas, para las tablas que solo reciben request_id
-- (Torre de Control y Documentos de despacho). Los perfiles de esas bandejas (p. ej. Auditor de Despacho con
-- planificacion/packing-list) no leen transport_requests por RLS; esta función devuelve solo tipo, modalidad de
-- atención y contrato, con la misma autorización por permiso y sede que la bandeja documentaria y la Torre.
CREATE OR REPLACE FUNCTION public.request_service_types(p_requests uuid[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'request_type', t.request_type,
           'attention_mode', to_jsonb(t)->>'attention_mode', 'contract_id', t.contract_id)), '[]'::jsonb)
    FROM public.transport_requests t
   WHERE auth.uid() IS NOT NULL
     AND cardinality(p_requests) <= 1000
     AND t.id = ANY(p_requests)
     AND (public.is_tms_admin() OR EXISTS (
       SELECT 1 FROM public.dispatch_requests r JOIN public.dispatches d ON d.id = r.dispatch_id
        WHERE r.transport_request_id = t.id AND public.can_access_site(d.site_id)
          AND (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
            OR public.has_tms_read_permission('monitoreo') OR public.has_tms_read_permission('documentario')
            OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion')
            OR public.can_view_driver_evidence())))
$$;
REVOKE ALL ON FUNCTION public.request_service_types(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_service_types(uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.request_service_types(uuid[]) IS 'Tipo de servicio (tipo, modalidad, contrato) de solicitudes programadas, con permiso y sede de la bandeja.';
NOTIFY pgrst, 'reload schema';
