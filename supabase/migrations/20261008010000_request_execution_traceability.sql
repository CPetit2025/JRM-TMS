-- Medición por solicitud/parada. No reparte el total de la ruta entre sus OT.
BEGIN;
CREATE FUNCTION public.get_transport_request_execution(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.transport_requests%ROWTYPE; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_tms_read_permission('solicitudes') THEN
   RAISE EXCEPTION 'Sin permiso para consultar servicios'; END IF;
 SELECT * INTO r FROM public.transport_requests WHERE id=p_request_id;
 IF NOT FOUND OR NOT public.can_access_site(r.site_id)
    OR (public.is_contract_administrator() AND NOT public.has_assigned_request(r.id,false)) THEN
   RAISE EXCEPTION 'Solicitud inexistente o sin acceso'; END IF;
 WITH legs AS (
   SELECT d.id AS dispatch_id,d.dispatch_number,d.status AS dispatch_status,d.vehicle_plate,d.driver_name,
     to_jsonb(d)->>'modalidad' AS modalidad,d.scheduled_departure,
     dr.status AS stop_status,dr.sequence_order,dr.leg_actual_km,dr.leg_gps_complete,
     COALESCE(c.state,'PENDIENTE') AS conformity,
     COALESCE(NULLIF(trim(s.guide_number),''),NULLIF(trim(dr.document_number),'')) AS guide_number,
     c.current_submission_id,
     d.status='CANCELADO' OR dr.status='CANCELADO' AS cancelled
   FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
   LEFT JOIN public.delivery_conformities c ON c.dispatch_id=d.id AND c.request_id=dr.transport_request_id
   LEFT JOIN public.delivery_submissions s ON s.id=c.current_submission_id AND s.dispatch_id=d.id AND s.request_id=dr.transport_request_id
   WHERE dr.transport_request_id=r.id AND public.can_access_site(d.site_id)
 ), measured AS (
   SELECT l.*,CASE
     WHEN l.cancelled THEN 'CANCELADO'
     WHEN to_jsonb(r)->>'attention_mode'='RECOJO_CLIENTE' THEN 'NO_APLICA'
     WHEN r.request_type='RECOJO' THEN 'RECOJO_SIN_PESO'
     WHEN l.conformity<>'VALIDADA' OR l.current_submission_id IS NULL OR l.guide_number IS NULL THEN 'SIN_GUIA_VALIDADA'
     WHEN public.apt_guia_key(l.guide_number) !~ '^[A-Z0-9]+-[0-9]+$' THEN 'GUIA_INCOMPLETA'
     WHEN EXISTS(
       SELECT 1 FROM public.dispatch_requests dr2 JOIN public.dispatches d2 ON d2.id=dr2.dispatch_id
       LEFT JOIN public.delivery_conformities c2 ON c2.dispatch_id=d2.id AND c2.request_id=dr2.transport_request_id
       LEFT JOIN public.delivery_submissions s2 ON s2.id=c2.current_submission_id AND s2.dispatch_id=d2.id AND s2.request_id=dr2.transport_request_id
       WHERE (dr2.dispatch_id,dr2.transport_request_id)<>(l.dispatch_id,r.id) AND d2.status<>'CANCELADO' AND dr2.status<>'CANCELADO'
       AND public.apt_guia_key(COALESCE(NULLIF(trim(s2.guide_number),''),NULLIF(trim(dr2.document_number),'')))=public.apt_guia_key(l.guide_number)
     ) THEN 'GUIA_COMPARTIDA'
     WHEN w.kg IS NULL OR w.incomplete THEN 'SIN_PESO_APT'
     ELSE 'APT_VALIDADO' END AS weight_status,w.kg
   FROM legs l LEFT JOIN LATERAL (
     SELECT NULLIF(sum(m.peso_kg),0) AS kg,COALESCE(bool_or(m.peso_kg IS NULL OR m.peso_kg<=0),false) AS incomplete
     FROM public.apt_movements m WHERE m.active AND m.valid AND m.kind='SALIDA'
       AND public.apt_guia_key(m.documento)=public.apt_guia_key(l.guide_number)
       AND l.conformity='VALIDADA' AND l.current_submission_id IS NOT NULL AND NOT l.cancelled
       AND r.request_type IN ('DESPACHO','TRASLADO') AND COALESCE(to_jsonb(r)->>'attention_mode','')<>'RECOJO_CLIENTE'
   ) w ON true
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'dispatch_id',dispatch_id,'dispatch_number',dispatch_number,'dispatch_status',dispatch_status,'stop_status',stop_status,
   'sequence',sequence_order,'vehicle_plate',vehicle_plate,'driver_name',driver_name,'modalidad',modalidad,'departure',scheduled_departure,
   'actual_km',CASE WHEN cancelled OR to_jsonb(r)->>'attention_mode'='RECOJO_CLIENTE' THEN NULL ELSE leg_actual_km END,
   'gps_complete',CASE WHEN cancelled THEN NULL ELSE leg_gps_complete END,'conformity',conformity,'guide_number',guide_number,
   'actual_weight_kg',CASE WHEN weight_status='APT_VALIDADO' THEN kg ELSE NULL END,'weight_status',weight_status
 ) ORDER BY scheduled_departure,dispatch_id),'[]'::jsonb) INTO result FROM measured;
 RETURN jsonb_build_object('request_id',r.id,'contract_id',r.contract_id,
   'ot_code',(SELECT code FROM public.contracts WHERE id=r.contract_id),'request_type',r.request_type,
   'attention_mode',to_jsonb(r)->>'attention_mode','requested_weight_kg',NULLIF(r.estimated_weight,0),'legs',result);
END $$;
REVOKE ALL ON FUNCTION public.get_transport_request_execution(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_transport_request_execution(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
