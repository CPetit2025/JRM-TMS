-- La OT se obtiene de cada solicitud, incluso cuando el despacho consolida varias OT.
-- Conserva permisos, sedes, orden, documentos y reglas de salida existentes.
CREATE OR REPLACE FUNCTION public.get_documentary_queue(p_include_departed boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (public.has_tms_read_permission('documentario') OR public.can_view_driver_evidence()) THEN
    RAISE EXCEPTION 'Sin permiso para ver la bandeja documentaria';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(q ORDER BY q.scheduled_departure NULLS LAST, q.dispatch_number)
    FROM (
      SELECT d.id, d.dispatch_number, d.status, d.vehicle_plate, d.driver_name, d.scheduled_departure,
             to_jsonb(d)->>'modalidad' AS modalidad, d.docs_required, d.docs_ready_at, d.docs_reissue, d.docs_reissue_reason,
             (COALESCE(d.vehicle_plate, '') = 'EXTERNO' AND d.modalidad IS DISTINCT FROM 'TERCERO') AS is_pickup,
             (SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''), to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = d.docs_ready_by) AS docs_ready_by_name,
             CASE WHEN d.status <> 'PROGRAMADO' THEN 'SALIO'
                  WHEN d.docs_reissue THEN 'REEMISION'
                  WHEN d.docs_ready_at IS NOT NULL THEN 'LISTO'
                  ELSE 'PENDIENTE' END AS doc_status,
             public.dispatch_documents_missing(d.id) AS missing,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'request_id', t.id, 'request_number', t.request_number, 'sequence', (to_jsonb(r)->>'sequence_order')::int,
                'delivery', concat_ws(' · ', to_jsonb(t)->>'delivery_address', to_jsonb(t)->>'delivery_district'),
                'cargo', to_jsonb(t)->>'cargo_description',
                'ot_code', NULLIF(trim(ct.code::text), ''),
                'client', COALESCE(NULLIF(trim(cl.business_name), ''), to_jsonb(t)->>'requester_name'))
                ORDER BY (to_jsonb(r)->>'sequence_order')::int NULLS LAST, t.request_number), '[]'::jsonb)
              FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
              LEFT JOIN public.contracts ct ON ct.id = t.contract_id
              LEFT JOIN public.clients cl ON cl.id = ct.client_id
              WHERE r.dispatch_id = d.id) AS stops,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', x.id, 'request_id', x.transport_request_id, 'doc_type', x.doc_type, 'cargo_type', x.cargo_type,
                'document_number', x.document_number, 'file_path', x.file_path, 'file_name', x.file_name,
                'mime_type', x.mime_type, 'auditor_name',x.auditor_name,'auditor_signed_date',x.auditor_signed_date,'signed',x.auditor_signature_confirmed, 'uploaded_at', x.uploaded_at,
                'uploaded_by', (SELECT COALESCE(NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), ''), to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id = x.uploaded_by))
                ORDER BY x.uploaded_at), '[]'::jsonb)
              FROM public.dispatch_documents x WHERE x.dispatch_id = d.id AND x.voided_at IS NULL) AS documents
      FROM public.dispatches d
      WHERE (d.site_id IS NULL OR public.can_access_site(d.site_id))
        AND (d.status = 'PROGRAMADO' OR (p_include_departed AND d.docs_required
             AND d.status NOT IN ('CANCELADO') AND COALESCE(d.scheduled_departure, now()) > now() - interval '7 days'))
    ) q), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_documentary_queue(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_documentary_queue(boolean) TO authenticated, service_role;
