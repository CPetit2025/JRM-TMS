BEGIN;
CREATE FUNCTION public.daily_document_kpi(p_role text,p_subject uuid,p_from date,p_until date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH evidence AS (
   SELECT c.state,s.submitted_at,r.reviewed_at,d.daily_cutoff_at
   FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id
   LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
   LEFT JOIN public.delivery_submissions s ON s.id=c.current_submission_id
   LEFT JOIN public.delivery_reviews r ON r.submission_id=s.id AND r.decision='VALIDADA'
   WHERE public.dispatch_operating_day(to_jsonb(d)) BETWEEN p_from AND p_until AND d.daily_cutoff_at<=now() AND d.status<>'CANCELADO'
   AND public.delivery_required(d.id,dr.transport_request_id)
   AND (public.can_access_site(d.site_id) OR (p_role='CONDUCTOR' AND d.driver_id=p_subject AND EXISTS(SELECT 1 FROM public.drivers WHERE id=p_subject AND profile_id=auth.uid() AND is_active)))
   AND ((p_role='CONDUCTOR' AND d.driver_id=p_subject) OR (p_role='TRANSPORTE' AND NULLIF(to_jsonb(d)->>'created_by','')::uuid=p_subject))
 ), counts AS (
   SELECT count(*) total,
     count(*) FILTER(WHERE COALESCE(state,'PENDIENTE') IN ('PENDIENTE','OBSERVADA','RECHAZADA')) upload_pending,
     count(*) FILTER(WHERE state='RECIBIDA') review_pending,
     count(*) FILTER(WHERE state IN ('RECIBIDA','VALIDADA') AND submitted_at<daily_cutoff_at) uploaded_on_time,
     count(*) FILTER(WHERE state='VALIDADA' AND reviewed_at<daily_cutoff_at) reviewed_on_time FROM evidence
 ) SELECT jsonb_build_object('values',CASE WHEN p_role='CONDUCTOR' THEN
     jsonb_build_object('guias_pendientes',upload_pending,'guias_corte_puntual',round(100.0*uploaded_on_time/NULLIF(total,0),1))
   ELSE jsonb_build_object('guias_validacion_pendiente',review_pending,'guias_validacion_corte',round(100.0*reviewed_on_time/NULLIF(total,0),1),'guias_equipo_pendientes',upload_pending+review_pending) END,
   'context',CASE WHEN p_role='CONDUCTOR' THEN jsonb_build_object('guias_pendientes','Pendientes, observadas o rechazadas de '||total||' servicios vencidos al corte diario','guias_corte_puntual',uploaded_on_time||' de '||total||' presentadas antes de las 00:00 de Lima')
   ELSE jsonb_build_object('guias_validacion_pendiente','Recibidas pendientes de revisión de '||total||' servicios de rutas programadas por el responsable','guias_validacion_corte',reviewed_on_time||' de '||total||' aprobadas antes de las 00:00 de Lima','guias_equipo_pendientes','Guías pendientes de presentación o aprobación: '||(upload_pending+review_pending)) END)
 FROM counts;
$$;
REVOKE ALL ON FUNCTION public.daily_document_kpi(text,uuid,date,date) FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.kpi_parametros(rol,codigo,nombre,grupo,unidad,meta,sentido,peso,orden,descripcion) VALUES
 ('CONDUCTOR','guias_pendientes','Guías pendientes después del corte diario','Cierre documentario diario','n',0,'MENOR',0,30,'Pendientes, observadas o rechazadas; incluye rutas liberadas. No atribuye la espera de validación al conductor.'),
 ('CONDUCTOR','guias_corte_puntual','Guías presentadas antes del corte diario','Cierre documentario diario','%',100,'MAYOR',0,31,'Último sustento vigente presentado antes de las 00:00 de Lima y no observado ni rechazado.'),
 ('TRANSPORTE','guias_validacion_pendiente','Guías recibidas pendientes de validación','Cierre documentario diario','n',0,'MENOR',0,30,'Esperan al Supervisor de Transporte; rutas programadas por el responsable, dentro de sus sedes autorizadas.'),
 ('TRANSPORTE','guias_validacion_corte','Guías aprobadas antes del corte diario','Cierre documentario diario','%',100,'MAYOR',0,31,'Conformidades aprobadas antes de las 00:00 de Lima; no se consideran aprobadas por el cierre operativo.'),
 ('TRANSPORTE','guias_equipo_pendientes','Pendiente documentario del equipo','Cierre documentario diario','n',0,'MENOR',0,32,'Pendientes de presentación, corrección o aprobación, aunque unidad y conductor ya estén liberados.')
ON CONFLICT(rol,codigo) DO NOTHING;
DO $kpi$
DECLARE source text; changed text;
BEGIN
 source:=pg_get_functiondef('public.desempeno_calcular(text,uuid,date)'::regprocedure);
 changed:=replace(source,'v_kpis jsonb;','daily_metrics jsonb; v_kpis jsonb;');
 changed:=replace(changed,'-- Informe mensual (roles con informe)',
   'IF v_rol IN (''CONDUCTOR'',''TRANSPORTE'') THEN daily_metrics:=public.daily_document_kpi(v_rol,p_sujeto,v_ini,v_fin); val:=val||(daily_metrics->''values''); ctx:=ctx||(daily_metrics->''context''); END IF; -- Informe mensual (roles con informe)');
 IF changed=source OR position('daily_metrics:=public.daily_document_kpi' IN changed)=0 THEN RAISE EXCEPTION 'Motor KPI incompatible'; END IF;
 EXECUTE changed;
END $kpi$;
NOTIFY pgrst,'reload schema';
COMMIT;
