-- Conformidad de entrega: una guía recibida no autoriza el cierre del servicio.
-- Solo el Supervisor de Transporte valida; las observaciones conservan versiones.
BEGIN;
CREATE TABLE public.delivery_conformities (
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id),
  request_id uuid NOT NULL REFERENCES public.transport_requests(id),
  state text NOT NULL DEFAULT 'PENDIENTE' CHECK (state IN ('PENDIENTE','RECIBIDA','OBSERVADA','RECHAZADA','VALIDADA')),
  arrived_at timestamptz,
  current_submission_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(dispatch_id,request_id)
);
CREATE TABLE public.delivery_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL UNIQUE,
  dispatch_id uuid NOT NULL,
  request_id uuid NOT NULL,
  photos text[] NOT NULL CHECK (cardinality(photos) BETWEEN 1 AND 5),
  guide_number text,
  received_by text,
  note text,
  source text NOT NULL CHECK (source IN ('APP','WEB','ENLACE','HISTORICO')),
  submitted_by uuid,
  captured_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(dispatch_id,request_id) REFERENCES public.delivery_conformities(dispatch_id,request_id)
);
ALTER TABLE public.delivery_conformities ADD CONSTRAINT delivery_current_submission_fk
  FOREIGN KEY(current_submission_id) REFERENCES public.delivery_submissions(id);
CREATE INDEX delivery_submissions_stop_idx ON public.delivery_submissions(dispatch_id,request_id,submitted_at DESC);
CREATE TABLE public.delivery_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL UNIQUE REFERENCES public.delivery_submissions(id),
  decision text NOT NULL CHECK(decision IN ('VALIDADA','OBSERVADA','RECHAZADA')),
  reason text,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.delivery_portal_attempts (
  fingerprint text PRIMARY KEY,
  window_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
ALTER TABLE public.dispatch_tercero_enlaces ADD COLUMN IF NOT EXISTS access_code text;
CREATE UNIQUE INDEX delivery_access_code_idx ON public.dispatch_tercero_enlaces(access_code) WHERE access_code IS NOT NULL;

-- Compatibilidad con el recojo por cliente vigente: nota de salida, unidad
-- EXTERNO y sin conductor propio. No se convierte en un viaje de proveedor.
CREATE FUNCTION public.delivery_required(p_dispatch uuid,p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id
  WHERE d.id=p_dispatch AND dr.transport_request_id=p_request AND d.driver_id IS NULL
    AND d.vehicle_plate='EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA')<>'TERCERO'
    AND to_jsonb(dr)->>'document_type'='NOTA_SALIDA');
$$;

CREATE FUNCTION public.delivery_can_read(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active) AND (
   ((public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo')
     OR public.has_tms_read_permission('torre-control')) AND public.can_access_site(d.site_id))
   OR EXISTS(SELECT 1 FROM public.drivers r JOIN public.profiles p ON p.id=r.profile_id
     WHERE r.id=d.driver_id AND r.profile_id=auth.uid() AND r.is_active AND p.is_active)));
$$;
CREATE FUNCTION public.delivery_can_review(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
   JOIN public.dispatches d ON d.id=p_dispatch
   WHERE p.id=auth.uid() AND p.is_active AND r.name='Supervisor de Transporte'
     AND public.can_access_site(d.site_id));
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['delivery_conformities','delivery_submissions','delivery_reviews','delivery_portal_attempts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END $$;

-- Las fotografías referenciadas por una versión no se eliminan ni sobrescriben.
CREATE INDEX delivery_photos_idx ON public.delivery_submissions USING gin(photos);
CREATE FUNCTION public.delivery_photo_mutable(p_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.delivery_submissions WHERE photos @> ARRAY[p_name]);
$$;
CREATE POLICY delivery_evidence_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
 USING(bucket_id<>'driver_evidence' OR public.delivery_photo_mutable(name));
CREATE POLICY delivery_evidence_no_overwrite ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
 USING(bucket_id<>'driver_evidence' OR public.delivery_photo_mutable(name))
 WITH CHECK(bucket_id<>'driver_evidence' OR public.delivery_photo_mutable(name));

-- Los viajes ya cerrados conservan su historia. La evidencia existente de viajes
-- abiertos entra en revisión; nunca se aprueba automáticamente una foto antigua.
INSERT INTO public.delivery_conformities(dispatch_id,request_id)
 SELECT DISTINCT s.dispatch_id,s.transport_request_id FROM public.route_stops_log s
 JOIN public.dispatches d ON d.id=s.dispatch_id
 JOIN public.dispatch_requests dr ON dr.dispatch_id=s.dispatch_id AND dr.transport_request_id=s.transport_request_id
 WHERE s.photo_url IS NOT NULL AND s.stop_type='ENTREGA' AND d.status NOT IN ('LIQUIDADO','CERRADO','CANCELADO');
INSERT INTO public.delivery_submissions(operation_id,dispatch_id,request_id,photos,source,captured_at)
 SELECT gen_random_uuid(),s.dispatch_id,s.transport_request_id,ARRAY[s.photo_url],'HISTORICO',COALESCE(s.arrival_time,now())
 FROM public.route_stops_log s JOIN public.delivery_conformities c ON c.dispatch_id=s.dispatch_id AND c.request_id=s.transport_request_id
 WHERE s.photo_url IS NOT NULL AND s.stop_type='ENTREGA';
UPDATE public.delivery_conformities c SET state='RECIBIDA',current_submission_id=(
 SELECT s.id FROM public.delivery_submissions s WHERE s.dispatch_id=c.dispatch_id AND s.request_id=c.request_id
 ORDER BY s.captured_at DESC,s.id LIMIT 1);

CREATE FUNCTION public.delivery_submit_core(p_dispatch uuid,p_request uuid,p_photos text[],p_received text,p_note text,
 p_source text,p_guide text DEFAULT NULL,p_operation uuid DEFAULT NULL,p_captured timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; c public.delivery_conformities; s public.delivery_submissions; photo text; sid uuid;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR d->>'status' IN ('PROGRAMADO','LIQUIDADO','CERRADO','CANCELADO') THEN RAISE EXCEPTION 'El servicio no admite evidencias de entrega'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request) THEN RAISE EXCEPTION 'La entrega no pertenece al servicio'; END IF;
 IF p_operation IS NOT NULL THEN
  SELECT * INTO s FROM public.delivery_submissions WHERE operation_id=p_operation;
  IF s.id IS NOT NULL THEN
   IF s.dispatch_id<>p_dispatch OR s.request_id<>p_request THEN RAISE EXCEPTION 'Operación de otro servicio'; END IF;
   RETURN jsonb_build_object('success',true,'submission_id',s.id,'pending_review',true,'duplicate',true);
  END IF;
 END IF;
 IF COALESCE(cardinality(p_photos),0) NOT BETWEEN 1 AND 5 OR p_source IS NULL OR p_source NOT IN ('APP','WEB','ENLACE') THEN RAISE EXCEPTION 'Adjunte de una a cinco fotos de la guía firmada'; END IF;
 IF p_captured IS NULL OR p_captured>now()+interval '5 minutes' OR p_captured<now()-interval '3 days' THEN RAISE EXCEPTION 'Fecha de captura no válida'; END IF;
 FOREACH photo IN ARRAY p_photos LOOP
  IF photo IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence' AND o.name=photo)
   OR (p_source='ENLACE' AND photo NOT LIKE 'tercero/'||p_dispatch::text||'/%')
   OR (p_source='APP' AND photo NOT LIKE auth.uid()::text||'/'||p_dispatch::text||'/'||p_request::text||'/%')
   OR (p_source='WEB' AND photo NOT LIKE auth.uid()::text||'/tercero/'||p_dispatch::text||'/%')
   OR (p_source IN ('APP','WEB') AND auth.uid() IS NULL) THEN RAISE EXCEPTION 'Foto no válida para esta entrega'; END IF;
 END LOOP;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(p_dispatch,p_request) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF c.state NOT IN ('PENDIENTE','OBSERVADA','RECHAZADA') THEN RAISE EXCEPTION 'Sustento enviado: acceso bloqueado hasta una observación o rechazo del Supervisor de Transporte'; END IF;
 INSERT INTO public.delivery_submissions(operation_id,dispatch_id,request_id,photos,received_by,note,source,submitted_by,guide_number,captured_at)
 VALUES(COALESCE(p_operation,gen_random_uuid()),p_dispatch,p_request,p_photos,left(NULLIF(trim(p_received),''),120),left(p_note,1000),p_source,auth.uid(),
  COALESCE(NULLIF(trim(p_guide),''),(SELECT document_number FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request)),p_captured)
 RETURNING id INTO sid;
 UPDATE public.delivery_conformities SET state='RECIBIDA',current_submission_id=sid,arrived_at=COALESCE(arrived_at,p_captured),updated_at=now() WHERE dispatch_id=p_dispatch AND request_id=p_request;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'GUIA_RECIBIDA','Guía de entrega recibida; pendiente de validación del Supervisor de Transporte',COALESCE(auth.uid()::text,'tercero'));
 RETURN jsonb_build_object('success',true,'submission_id',sid,'pending_review',true);
END $$;

CREATE FUNCTION public.delivery_arrive_core(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; a timestamptz;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR d->>'status' NOT IN ('EN RUTA','EN_CURSO') OR NOT EXISTS(
  SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request AND status<>'ENTREGADO') THEN
  RAISE EXCEPTION 'La entrega no está en ruta'; END IF;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(p_dispatch,p_request) ON CONFLICT DO NOTHING;
 SELECT arrived_at INTO a FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request;
 IF a IS NULL THEN
  UPDATE public.delivery_conformities SET arrived_at=now(),updated_at=now() WHERE dispatch_id=p_dispatch AND request_id=p_request;
  INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
   VALUES(p_dispatch,'EN_DESTINO','Llegada confirmada a una entrega',COALESCE(auth.uid()::text,'tercero'));
 END IF;
 RETURN jsonb_build_object('success',true);
END $$;
CREATE FUNCTION public.delivery_arrive(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.delivery_can_read(p_dispatch) OR NOT (
  public.tercero_puede_operar(p_dispatch) OR EXISTS(SELECT 1 FROM public.dispatches d JOIN public.drivers r ON r.id=d.driver_id
  WHERE d.id=p_dispatch AND r.profile_id=auth.uid() AND r.is_active)) THEN RAISE EXCEPTION 'Sin permiso para registrar llegada'; END IF;
 RETURN public.delivery_arrive_core(p_dispatch,p_request);
END $$;

-- La app conserva el cálculo GPS y el orden de paradas. La aprobación es un
-- evento posterior y no se finge ENTREGADO en el teléfono al recibir una foto.
CREATE FUNCTION public.delivery_submit_driver(p_dispatch uuid,p_request uuid,p_photos text[],p_received text,p_note text,
 p_guide text,p_operation uuid,p_captured timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE driver uuid; seq integer; point public.route_track_points; result jsonb; km numeric; complete boolean; correction boolean; stop public.dispatch_requests;
BEGIN
 SELECT driver_id INTO driver FROM public.dispatches WHERE id=p_dispatch AND status NOT IN ('PROGRAMADO','LIQUIDADO','CERRADO','CANCELADO') FOR UPDATE;
 IF driver IS NULL OR NOT EXISTS(SELECT 1 FROM public.drivers r JOIN public.profiles p ON p.id=r.profile_id
  WHERE r.id=driver AND r.profile_id=auth.uid() AND r.is_active AND p.is_active) THEN RAISE EXCEPTION 'Ruta no autorizada'; END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_submissions WHERE operation_id=p_operation AND dispatch_id=p_dispatch AND request_id=p_request) THEN
  RETURN jsonb_build_object('success',true,'pending_review',true,'duplicate',true); END IF;
 SELECT * INTO stop FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
 SELECT state IN ('OBSERVADA','RECHAZADA') INTO correction FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request;
 IF stop.dispatch_id IS NULL THEN RAISE EXCEPTION 'Punto fuera de secuencia'; END IF;
 IF COALESCE(correction,false) THEN
  -- Una corrección documental conserva los kilómetros y la llegada originales,
  -- incluso cuando el conductor ya está de regreso o en base.
  result:=public.delivery_submit_core(p_dispatch,p_request,p_photos,p_received,p_note,'APP',p_guide,p_operation,p_captured);
  INSERT INTO public.route_stops_log(dispatch_id,transport_request_id,driver_id,stop_type,arrival_time,odometer_km,photo_url,notes)
   VALUES(p_dispatch,p_request,driver,'ENTREGA',p_captured,COALESCE((SELECT max(odometer_km) FROM public.route_stops_log WHERE dispatch_id=p_dispatch AND transport_request_id=p_request),0),p_photos[1],'Corrección de sustento');
  RETURN result||jsonb_build_object('leg_actual_km',stop.leg_actual_km,'leg_gps_complete',stop.leg_gps_complete,'arrival_lat',stop.arrival_lat,'arrival_lon',stop.arrival_lon);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=p_dispatch AND status IN ('EN RUTA','EN_CURSO')) THEN RAISE EXCEPTION 'Ruta no autorizada para nuevas entregas'; END IF;
 seq:=stop.sequence_order;
 IF seq IS NULL OR seq IS DISTINCT FROM (SELECT min(dr.sequence_order) FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id WHERE dr.dispatch_id=p_dispatch AND c.state IS DISTINCT FROM 'VALIDADA' AND public.delivery_required(dr.dispatch_id,dr.transport_request_id)) THEN RAISE EXCEPTION 'Punto fuera de secuencia; falta conformidad de una entrega anterior'; END IF;
 SELECT * INTO point FROM public.route_track_points WHERE dispatch_id=p_dispatch AND leg_order=seq
  AND recorded_at<=p_captured+interval '5 seconds' ORDER BY recorded_at DESC LIMIT 1;
 IF point.id IS NULL OR point.recorded_at<p_captured-interval '45 seconds' THEN RAISE EXCEPTION 'Se requiere GPS de la captura; sincronice los puntos pendientes'; END IF;
 SELECT round(COALESCE(sum(distance_m),0)/1000,3),count(*)>=2 AND NOT bool_or(gap_detected)
  INTO km,complete FROM public.route_track_points WHERE dispatch_id=p_dispatch AND leg_order=seq AND recorded_at<=p_captured+interval '5 seconds';
 result:=public.delivery_submit_core(p_dispatch,p_request,p_photos,p_received,p_note,'APP',p_guide,p_operation,p_captured);
 UPDATE public.dispatch_requests SET leg_actual_km=km,leg_gps_complete=complete,arrival_lat=point.latitude,arrival_lon=point.longitude
  WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
 INSERT INTO public.route_stops_log(dispatch_id,transport_request_id,driver_id,stop_type,arrival_time,odometer_km,photo_url)
 VALUES(p_dispatch,p_request,driver,'ENTREGA',p_captured,point.cumulative_m/1000,p_photos[1]);
 RETURN result||jsonb_build_object('leg_actual_km',km,'leg_gps_complete',complete,'arrival_lat',point.latitude,'arrival_lon',point.longitude);
END $$;
CREATE OR REPLACE FUNCTION public.complete_dispatch_stop(p_dispatch_id uuid,p_request_id uuid,p_photo_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN public.delivery_submit_driver(p_dispatch_id,p_request_id,ARRAY[p_photo_url],NULL,NULL,NULL,gen_random_uuid(),now());
END $$;

CREATE OR REPLACE FUNCTION public.tercero_entrega_core(p_dispatch_id uuid,p_request_id uuid,p_at timestamptz,p_recibido_por text,p_foto text,p_nota text,p_fuente text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; result jsonb;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch_id FOR UPDATE;
 IF d IS NULL OR d->>'modalidad' IS DISTINCT FROM 'TERCERO' THEN RETURN jsonb_build_object('success',false,'error','El despacho no es de una unidad tercerizada'); END IF;
 IF NULLIF(trim(p_foto),'') IS NULL THEN RETURN jsonb_build_object('success',false,'error','Adjunte la foto de la guía firmada'); END IF;
 IF COALESCE(p_at,now())<NULLIF(d->>'tercero_salida_at','')::timestamptz-interval '5 minutes' THEN RAISE EXCEPTION 'Entrega anterior a la salida'; END IF;
 result:=public.delivery_submit_core(p_dispatch_id,p_request_id,ARRAY[p_foto],p_recibido_por,p_nota,p_fuente,NULL,NULL,COALESCE(p_at,now()));
 INSERT INTO public.route_stops_log(dispatch_id,transport_request_id,driver_id,stop_type,arrival_time,odometer_km,photo_url,notes)
 VALUES(p_dispatch_id,p_request_id,NULL,'ENTREGA',COALESCE(p_at,now()),0,p_foto,p_nota);
 INSERT INTO public.dispatch_tercero_entregas(dispatch_id,transport_request_id,entregado_at,recibido_por,foto_path,nota,fuente,registrado_por)
 VALUES(p_dispatch_id,p_request_id,COALESCE(p_at,now()),p_recibido_por,p_foto,p_nota,p_fuente,auth.uid())
 ON CONFLICT(dispatch_id,transport_request_id) DO UPDATE SET entregado_at=EXCLUDED.entregado_at,recibido_por=EXCLUDED.recibido_por,
 foto_path=EXCLUDED.foto_path,nota=EXCLUDED.nota,fuente=EXCLUDED.fuente,registrado_por=EXCLUDED.registrado_por;
 RETURN result||jsonb_build_object('pendientes',(SELECT count(*) FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND status<>'ENTREGADO'),'entregado',false);
END $$;

CREATE FUNCTION public.delivery_review(p_dispatch uuid,p_request uuid,p_submission uuid,p_decision text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.delivery_conformities; d jsonb;
BEGIN
 IF NOT public.delivery_can_review(p_dispatch) THEN RAISE EXCEPTION 'Solo el Supervisor de Transporte valida la conformidad'; END IF;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d->>'status' IN ('LIQUIDADO','CERRADO','CANCELADO') THEN RAISE EXCEPTION 'Servicio cerrado'; END IF;
 SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF c.current_submission_id IS DISTINCT FROM p_submission OR c.state IS DISTINCT FROM 'RECIBIDA' THEN RAISE EXCEPTION 'El sustento cambió o ya fue revisado; actualice la vista'; END IF;
 IF p_decision NOT IN ('VALIDADA','OBSERVADA','RECHAZADA') OR p_decision IS NULL THEN RAISE EXCEPTION 'Decisión no válida'; END IF;
 IF p_decision='VALIDADA' AND EXISTS(SELECT 1 FROM public.delivery_submissions s CROSS JOIN LATERAL unnest(s.photos) photo WHERE s.id=p_submission AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence' AND o.name=photo)) THEN RAISE EXCEPTION 'Una fotografía no está disponible; observe el sustento para solicitar una corrección'; END IF;
 IF p_decision<>'VALIDADA' AND NULLIF(trim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'Indique el motivo de la observación o rechazo'; END IF;
 INSERT INTO public.delivery_reviews(submission_id,decision,reason,reviewed_by) VALUES(p_submission,p_decision,left(p_reason,1000),auth.uid());
 UPDATE public.delivery_conformities SET state=p_decision,updated_at=now() WHERE dispatch_id=p_dispatch AND request_id=p_request;
 IF p_decision='VALIDADA' THEN
  UPDATE public.dispatch_requests SET status='ENTREGADO' WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;
  UPDATE public.transport_requests SET status='ENTREGADA' WHERE id=p_request;
  IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities x ON x.dispatch_id=dr.dispatch_id AND x.request_id=dr.transport_request_id
   WHERE dr.dispatch_id=p_dispatch AND x.state IS DISTINCT FROM 'VALIDADA') AND d->>'status' IN ('EN RUTA','EN_CURSO') AND d->>'modalidad'='TERCERO' THEN
   UPDATE public.dispatches SET status='ENTREGADO',tercero_entrega_at=(SELECT max(s.captured_at) FROM public.delivery_conformities x JOIN public.delivery_submissions s ON s.id=x.current_submission_id WHERE x.dispatch_id=p_dispatch) WHERE id=p_dispatch;
   INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by) VALUES(p_dispatch,'ENTREGADO','Todas las guías validadas por Supervisor de Transporte',auth.uid()::text);
  END IF;
 END IF;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'CONFORMIDAD_'||p_decision,'Conformidad '||lower(p_decision)||COALESCE(': '||NULLIF(trim(p_reason),''),''),auth.uid()::text);
 RETURN jsonb_build_object('success',true);
END $$;

-- Guardas también para actualizaciones directas, funciones antiguas y cierre financiero.
CREATE FUNCTION public.delivery_guard_advance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='dispatch_requests' THEN
  IF NEW.status='ENTREGADO' AND OLD.status IS DISTINCT FROM NEW.status AND NOT EXISTS(
   SELECT 1 FROM public.delivery_conformities WHERE dispatch_id=NEW.dispatch_id AND request_id=NEW.transport_request_id AND state='VALIDADA') AND public.delivery_required(NEW.dispatch_id,NEW.transport_request_id) THEN
   RAISE EXCEPTION 'La guía debe ser aprobada por el Supervisor de Transporte antes de avanzar el servicio'; END IF;
 ELSIF TG_TABLE_NAME='transport_requests' THEN
  IF NEW.status='ENTREGADA' AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS(
   SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
   LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
   WHERE dr.transport_request_id=NEW.id AND d.status NOT IN ('LIQUIDADO','CERRADO','CANCELADO') AND c.state IS DISTINCT FROM 'VALIDADA' AND public.delivery_required(dr.dispatch_id,dr.transport_request_id)) THEN
   RAISE EXCEPTION 'La guía debe ser aprobada por el Supervisor de Transporte antes de avanzar el servicio'; END IF;
 ELSE
  IF NEW.status IN ('ESPERANDO_AUTORIZACION','RETORNO','RETORNO_COMPLETADO','ENTREGADO','LIQUIDADO','CERRADO') AND OLD.status IS DISTINCT FROM NEW.status AND EXISTS(
   SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
   WHERE dr.dispatch_id=NEW.id AND c.state IS DISTINCT FROM 'VALIDADA' AND public.delivery_required(dr.dispatch_id,dr.transport_request_id)) THEN
   RAISE EXCEPTION 'Faltan guías aprobadas por el Supervisor de Transporte; el servicio no puede avanzar'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_guard_stop BEFORE UPDATE OF status ON public.dispatch_requests FOR EACH ROW EXECUTE FUNCTION public.delivery_guard_advance();
CREATE TRIGGER delivery_guard_request BEFORE UPDATE OF status ON public.transport_requests FOR EACH ROW EXECUTE FUNCTION public.delivery_guard_advance();
CREATE TRIGGER delivery_guard_dispatch BEFORE UPDATE OF status ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.delivery_guard_advance();

CREATE FUNCTION public.delivery_get(p_dispatch uuid,p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin acceso a esta entrega'; END IF;
 RETURN jsonb_build_object('state',CASE WHEN NOT public.delivery_required(p_dispatch,p_request) THEN 'NO_APLICA' ELSE COALESCE((SELECT state FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request),'PENDIENTE') END,
  'arrived_at',(SELECT arrived_at FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request),
  'can_review',public.delivery_can_review(p_dispatch),
  'submissions',COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('review',(
   SELECT to_jsonb(r) FROM public.delivery_reviews r WHERE r.submission_id=s.id)) ORDER BY s.submitted_at DESC)
   FROM public.delivery_submissions s WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request),'[]'::jsonb));
END $$;

CREATE FUNCTION public.delivery_rows_core(p_dispatch uuid,p_public boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
 'dispatch_id',d.id,'request_id',t.id,'dispatch_number',d.dispatch_number,'request_number',t.request_number,
 'ot_code',COALESCE(ct.code::text,'Sin OT vinculada'),'client_name',cl.business_name,
 'pickup_address',t.pickup_address,'delivery_address',t.delivery_address,'plate',d.vehicle_plate,
 'driver_name',COALESCE(NULLIF(d.driver_name,''),to_jsonb(d)->>'tercero_conductor'),
 'carrier_name',ca.business_name,'modalidad',CASE WHEN NOT public.delivery_required(d.id,t.id) THEN 'RECOJO_CLIENTE' ELSE to_jsonb(d)->>'modalidad' END,'scheduled_departure',d.scheduled_departure,
 'guide_number',COALESCE(s.guide_number,dr.document_number),
 'documents_state',CASE WHEN NOT COALESCE((to_jsonb(d)->>'docs_required')::boolean,false) THEN 'NO_REQUERIDO' WHEN COALESCE((to_jsonb(d)->>'docs_reissue')::boolean,false) THEN 'REEMISION' WHEN to_jsonb(d)->>'docs_ready_at' IS NOT NULL THEN 'LISTO' ELSE 'PENDIENTE' END,'conformity',CASE WHEN NOT public.delivery_required(d.id,t.id) THEN 'NO_APLICA' ELSE COALESCE(c.state,CASE WHEN d.status IN ('LIQUIDADO','CERRADO') THEN 'HISTORICA' ELSE 'PENDIENTE' END) END,
 'submission_id',c.current_submission_id,'photos_count',COALESCE(cardinality(s.photos),0),'submitted_at',s.submitted_at,'arrived_at',c.arrived_at,
 'state',CASE WHEN d.status IN ('LIQUIDADO','CERRADO','CANCELADO') THEN d.status
   WHEN NOT public.delivery_required(d.id,t.id) AND dr.status<>'ENTREGADO' THEN 'RECOJO_CLIENTE'
   WHEN c.state='RECIBIDA' THEN 'PENDIENTE_VALIDACION'
   WHEN c.state IN ('OBSERVADA','RECHAZADA') THEN c.state
   WHEN c.state='VALIDADA' OR dr.status='ENTREGADO' THEN 'ENTREGADO'
   WHEN (SELECT e.event_type FROM public.dispatch_events e WHERE e.dispatch_id=d.id ORDER BY e.created_at DESC LIMIT 1) IN ('INCIDENCIA','RETRASO','DESVIO') THEN 'INCIDENCIA'
   WHEN c.arrived_at IS NOT NULL THEN 'EN_DESTINO' ELSE d.status END,
 'last_event_at',COALESCE(c.updated_at,(SELECT max(e.created_at) FROM public.dispatch_events e WHERE e.dispatch_id=d.id),d.scheduled_departure),
 'gps_at',to_jsonb(d)->>'last_gps_at',
 'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('type',e.event_type,'description',CASE WHEN p_public THEN NULL ELSE e.description END,'at',e.created_at) ORDER BY e.created_at DESC)
   FROM (SELECT * FROM public.dispatch_events WHERE dispatch_id=d.id ORDER BY created_at DESC LIMIT 30)e),'[]'::jsonb)
 ) ORDER BY dr.sequence_order),'[]'::jsonb)
 FROM public.dispatches d JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id
 JOIN public.transport_requests t ON t.id=dr.transport_request_id
 LEFT JOIN public.contracts ct ON ct.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=ct.client_id
 LEFT JOIN public.carriers ca ON ca.id=NULLIF(to_jsonb(d)->>'carrier_id','')::uuid
 LEFT JOIN public.delivery_conformities c ON c.dispatch_id=d.id AND c.request_id=t.id
 LEFT JOIN public.delivery_submissions s ON s.id=c.current_submission_id WHERE d.id=p_dispatch;
$$;
CREATE FUNCTION public.delivery_tracking_rows(p_dispatches uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE id uuid; rows jsonb:='[]';
BEGIN
 IF cardinality(p_dispatches)>200 THEN RAISE EXCEPTION 'Seleccione hasta 200 despachos'; END IF;
 FOREACH id IN ARRAY COALESCE(p_dispatches,'{}'::uuid[]) LOOP
  IF NOT public.delivery_can_read(id) THEN RAISE EXCEPTION 'Sin acceso a este despacho'; END IF;
  rows:=rows||public.delivery_rows_core(id,false);
 END LOOP;
 RETURN rows;
END $$;

-- El seguimiento compartido valida el PIN en cada actualización y nunca expone
-- archivos privados, teléfonos, códigos de acceso ni costos.
CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_info(p_token uuid,p_pin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE day date; rows jsonb:='[]'; item record;
BEGIN
 SELECT planning_date INTO day FROM public.daily_tracking_links WHERE tracking_token=p_token AND tracking_pin=p_pin AND expires_at>now();
 IF day IS NULL THEN RAISE EXCEPTION 'PIN incorrecto, enlace vencido o no válido'; END IF;
 FOR item IN SELECT d.id FROM public.dispatches d WHERE (d.scheduled_departure AT TIME ZONE 'America/Lima')::date=day LOOP
  rows:=rows||public.delivery_rows_core(item.id,true);
 END LOOP;
 RETURN jsonb_build_object('planning_date',day,'rows',rows);
END $$;

-- El mapa usa el mismo día de Lima y no atribuye velocidad a un punto que no la informa.
CREATE OR REPLACE FUNCTION public.get_public_daily_tracking_locations(p_token uuid,p_pin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE day date; locations jsonb;
BEGIN
 SELECT planning_date INTO day FROM public.daily_tracking_links WHERE tracking_token=p_token AND tracking_pin=p_pin AND expires_at>now();
 IF day IS NULL THEN RAISE EXCEPTION 'PIN incorrecto, enlace vencido o no válido'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('dispatch_id',d.id,'driver_name',d.driver_name,'vehicle_plate',d.vehicle_plate,
  'lat',d.last_lat,'lng',d.last_lon,'last_gps_at',d.last_gps_at)),'[]'::jsonb) INTO locations FROM public.dispatches d
 WHERE (d.scheduled_departure AT TIME ZONE 'America/Lima')::date=day AND d.last_gps_at>now()-interval '15 minutes' AND d.last_lat IS NOT NULL AND d.last_lon IS NOT NULL;
 RETURN locations;
END $$;

CREATE OR REPLACE FUNCTION public.tercero_generar_enlace(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; token text; code text; expires timestamptz;
BEGIN
 IF NOT public.tercero_puede_operar(p_dispatch_id) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch_id FOR UPDATE;
 IF d->>'modalidad' IS DISTINCT FROM 'TERCERO' OR d->>'status' IN ('LIQUIDADO','CERRADO','CANCELADO') THEN RAISE EXCEPTION 'El servicio no admite acceso del tercero'; END IF;
 UPDATE public.dispatch_tercero_enlaces SET revoked_at=now() WHERE dispatch_id=p_dispatch_id AND revoked_at IS NULL;
 token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 code:=substr(replace(gen_random_uuid()::text,'-',''),1,12);
 expires:=GREATEST(now(),COALESCE(NULLIF(d->>'scheduled_departure','')::timestamptz,now()))+interval '3 days';
 INSERT INTO public.dispatch_tercero_enlaces(token,dispatch_id,created_by,expires_at,access_code) VALUES(token,p_dispatch_id,auth.uid(),expires,code);
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch_id,'ENLACE_TERCERO','Acceso del tercero generado o renovado',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'token',token,'codigo',code,'placa',d->>'vehicle_plate','expires_at',expires);
END $$;
CREATE FUNCTION public.delivery_portal_login(p_plate text,p_code text,p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE token text; n integer;
BEGIN
 IF p_fingerprint IS NULL OR length(p_fingerprint)<>64 THEN RAISE EXCEPTION 'Solicitud no válida'; END IF;
 INSERT INTO public.delivery_portal_attempts(fingerprint,attempts) VALUES(p_fingerprint,1)
 ON CONFLICT(fingerprint) DO UPDATE SET
 attempts=CASE WHEN delivery_portal_attempts.window_at<now()-interval '10 minutes' THEN 1 ELSE delivery_portal_attempts.attempts+1 END,
 window_at=CASE WHEN delivery_portal_attempts.window_at<now()-interval '10 minutes' THEN now() ELSE delivery_portal_attempts.window_at END RETURNING attempts INTO n;
 IF n>10 THEN RETURN jsonb_build_object('success',false,'limited',true,'error','Demasiados intentos. Espere diez minutos.'); END IF;
 SELECT l.token INTO token FROM public.dispatch_tercero_enlaces l JOIN public.dispatches d ON d.id=l.dispatch_id
 WHERE upper(regexp_replace(d.vehicle_plate,'[^A-Za-z0-9]','','g'))=upper(regexp_replace(p_plate,'[^A-Za-z0-9]','','g'))
 AND l.access_code=lower(regexp_replace(p_code,'[^A-Za-z0-9]','','g')) AND l.revoked_at IS NULL AND l.expires_at>now()
 AND d.status NOT IN ('LIQUIDADO','CERRADO','CANCELADO') AND EXISTS(
  SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
  WHERE dr.dispatch_id=d.id AND COALESCE(c.state,'PENDIENTE') IN ('PENDIENTE','OBSERVADA','RECHAZADA'));
 IF token IS NULL THEN RETURN jsonb_build_object('success',false,'error','Placa o código no válido, o sin entregas habilitadas.'); END IF;
 DELETE FROM public.delivery_portal_attempts WHERE fingerprint=p_fingerprint;
 RETURN jsonb_build_object('success',true,'token',token);
END $$;
CREATE OR REPLACE FUNCTION public.tercero_enlace_info(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dispatch uuid:=public.tercero_enlace_despacho(p_token); d jsonb; stops jsonb;
BEGIN
 IF v_dispatch IS NULL THEN RETURN jsonb_build_object('success',false,'error','Acceso no válido, vencido o servicio cerrado'); END IF;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=v_dispatch;
 SELECT jsonb_agg(jsonb_build_object('request_id',dr.transport_request_id,'orden',dr.sequence_order,'solicitud',t.request_number,
  'destino',t.delivery_address,'documento',dr.document_number,'estado',dr.status,'conformidad',COALESCE(c.state,'PENDIENTE'),
  'arrived_at',c.arrived_at,'ot',ct.code,'cliente',cl.business_name,'motivo',rev.reason) ORDER BY dr.sequence_order) INTO stops
 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
 LEFT JOIN public.contracts ct ON ct.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=ct.client_id
 LEFT JOIN public.delivery_conformities c ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
 LEFT JOIN public.delivery_reviews rev ON rev.submission_id=c.current_submission_id
 WHERE dr.dispatch_id=v_dispatch AND COALESCE(c.state,'PENDIENTE') IN ('PENDIENTE','OBSERVADA','RECHAZADA');
 IF stops IS NULL THEN RETURN jsonb_build_object('success',false,'error','Sustento enviado. Acceso bloqueado; solo se habilita con observación o rechazo del Supervisor de Transporte.'); END IF;
 RETURN jsonb_build_object('success',true,'dispatch_id',v_dispatch,
  'despacho',jsonb_build_object('numero',d->>'dispatch_number','estado',d->>'status','placa',d->>'vehicle_plate',
   'conductor',d->>'tercero_conductor','salida_programada',d->>'scheduled_departure','salida_at',d->>'tercero_salida_at'),
  'paradas',stops);
END $$;
CREATE FUNCTION public.delivery_public_authorize(p_token text,p_request uuid,p_operation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dispatch uuid:=public.tercero_enlace_despacho(p_token); sid uuid;
BEGIN
 IF v_dispatch IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=v_dispatch AND transport_request_id=p_request) THEN RAISE EXCEPTION 'Entrega no autorizada'; END IF;
 SELECT s.id INTO sid FROM public.delivery_submissions s WHERE operation_id=p_operation AND dispatch_id=v_dispatch AND request_id=p_request;
 IF sid IS NOT NULL THEN RETURN jsonb_build_object('success',true,'dispatch_id',v_dispatch,'duplicate',true,'submission_id',sid); END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_conformities WHERE dispatch_id=v_dispatch AND request_id=p_request AND state IN ('RECIBIDA','VALIDADA')) THEN RAISE EXCEPTION 'Acceso bloqueado para esta entrega'; END IF;
 RETURN jsonb_build_object('success',true,'dispatch_id',v_dispatch);
END $$;
CREATE FUNCTION public.delivery_public_submit(p_token text,p_request uuid,p_operation uuid,p_photos text[],p_received text,p_note text,p_guide text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE access jsonb; result jsonb; v_dispatch uuid;
BEGIN
 access:=public.delivery_public_authorize(p_token,p_request,p_operation);
 IF COALESCE((access->>'duplicate')::boolean,false) THEN RETURN access-'dispatch_id'||jsonb_build_object('pending_review',true); END IF;
 v_dispatch:=(access->>'dispatch_id')::uuid;
 result:=public.delivery_submit_core(v_dispatch,p_request,p_photos,p_received,p_note,'ENLACE',p_guide,p_operation,now());
 IF NOT COALESCE((result->>'duplicate')::boolean,false) THEN
  INSERT INTO public.route_stops_log(dispatch_id,transport_request_id,driver_id,stop_type,arrival_time,odometer_km,photo_url,notes)
   VALUES(v_dispatch,p_request,NULL,'ENTREGA',now(),0,p_photos[1],p_note);
  INSERT INTO public.dispatch_tercero_entregas(dispatch_id,transport_request_id,entregado_at,recibido_por,foto_path,nota,fuente,registrado_por)
   VALUES(v_dispatch,p_request,now(),p_received,p_photos[1],p_note,'ENLACE',NULL)
   ON CONFLICT(dispatch_id,transport_request_id) DO UPDATE SET entregado_at=EXCLUDED.entregado_at,recibido_por=EXCLUDED.recibido_por,
    foto_path=EXCLUDED.foto_path,nota=EXCLUDED.nota,fuente=EXCLUDED.fuente,registrado_por=NULL;
 END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.delivery_public_arrive(p_token text,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE access jsonb;
BEGIN
 access:=public.delivery_public_authorize(p_token,p_request,NULL);
 RETURN public.delivery_arrive_core((access->>'dispatch_id')::uuid,p_request);
END $$;

-- Extiende el avance instalado conservando sus permisos y comprobaciones de sede.
DO $patch$ DECLARE definition text; anchor text:='''token'', l.token, ''expires_at'''; BEGIN
 SELECT pg_get_functiondef('public.tercero_avance(uuid)'::regprocedure) INTO definition;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Sin punto de extensión en avance del tercero'; END IF;
 definition:=replace(definition,anchor,'''token'', l.token, ''codigo'', l.access_code, ''expires_at''');
 definition:=replace(definition,'''estado'', dr.status, ''entregado_at''',
   '''estado'', dr.status, ''conformidad'', COALESCE((SELECT state FROM public.delivery_conformities c WHERE c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id),''PENDIENTE''), ''entregado_at''');
 EXECUTE definition;
END $patch$;

DO $patch$ DECLARE definition text; anchor text:='''RETORNO_COMPLETADO'')'; BEGIN
 SELECT pg_get_functiondef('public.get_active_trip_context()'::regprocedure) INTO definition;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Sin punto de extensión en contexto de viaje'; END IF;
 definition:=replace(definition,anchor,'''RETORNO_COMPLETADO'',''ENTREGADO'')');
 definition:=replace(definition,'''status'', dr.status, ''document_number''',
   '''status'', dr.status, ''conformity'', COALESCE((SELECT c.state FROM public.delivery_conformities c WHERE c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id),CASE WHEN public.delivery_required(dr.dispatch_id,dr.transport_request_id) THEN ''PENDIENTE'' ELSE ''NO_APLICA'' END), ''document_number''');
 definition:=replace(definition,'''actual_distance_km'', v_dispatch.actual_distance_km',
   '''return_actual_km'', to_jsonb(v_dispatch)->''return_actual_km'', ''actual_distance_km'', v_dispatch.actual_distance_km');
 EXECUTE definition;
END $patch$;

-- Conserva recibos de idempotencia y autorización del sincronizador instalado.
DO $patch$ DECLARE definition text; anchor text:='IF p_action_type = ''complete_dispatch_stop'' THEN'; BEGIN
 SELECT pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure) INTO definition;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Sin punto de extensión en acciones offline'; END IF;
 EXECUTE replace(definition,anchor,$branch$IF p_action_type = 'delivery_submit_driver' THEN
    v_result := public.delivery_submit_driver((p_payload->>'dispatch_id')::uuid,(p_payload->>'request_id')::uuid,
      ARRAY(SELECT jsonb_array_elements_text(p_payload->'photos')),p_payload->>'received_by',p_payload->>'note',p_payload->>'guide',
      p_operation_id,(p_payload->>'captured_at')::timestamptz);
  ELSIF p_action_type = 'complete_dispatch_stop' THEN$branch$);
END $patch$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure AS signature,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'delivery_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  IF f.proname IN ('delivery_can_read','delivery_can_review','delivery_photo_mutable','delivery_get','delivery_tracking_rows','delivery_arrive','delivery_submit_driver','delivery_review') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);
  ELSIF f.proname IN ('delivery_portal_login','delivery_public_authorize','delivery_public_submit','delivery_public_arrive') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END IF;
 END LOOP;
END $$;
COMMIT;
NOTIFY pgrst,'reload schema';
