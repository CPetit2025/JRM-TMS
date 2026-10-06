-- Una solicitud conserva su último antecedente de reprogramación al volver a APROBADA.
CREATE FUNCTION public.get_transport_request_rescheduling(p_request_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT (public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('solicitudes')) THEN
   RAISE EXCEPTION 'Sin permiso para consultar reprogramaciones'; END IF;
 IF cardinality(p_request_ids)>1000 THEN RAISE EXCEPTION 'Consulte como máximo 1000 solicitudes'; END IF;
 RETURN COALESCE((SELECT jsonb_agg(to_jsonb(last_change)) FROM (
   SELECT DISTINCT ON (k.request_id) k.request_id,k.fecha_anterior,k.fecha_nueva,k.at
   FROM public.kpi_reprogramaciones k JOIN public.transport_requests r ON r.id=k.request_id
   WHERE k.request_id=ANY(p_request_ids) AND public.can_access_site(r.site_id)
     AND (NOT public.is_contract_administrator() OR public.has_assigned_request(r.id,false))
   ORDER BY k.request_id,k.at DESC,k.id DESC
 ) last_change),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_transport_request_rescheduling(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_transport_request_rescheduling(uuid[]) TO authenticated,service_role;
