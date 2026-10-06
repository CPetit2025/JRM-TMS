-- Responsibilities: signed packing list before departure, delivery guide from driver/provider, supervisor review.
-- Existing departed/closed services and documents retain their history.
BEGIN;
ALTER TABLE public.dispatch_documents
 ADD COLUMN IF NOT EXISTS auditor_name text,
 ADD COLUMN IF NOT EXISTS auditor_signed_date date,
 ADD COLUMN IF NOT EXISTS auditor_signature_confirmed boolean NOT NULL DEFAULT false;

-- Private issuer; scheduling and explicit authorized renewal serialize on the dispatch row.
CREATE FUNCTION public.delivery_issue_access_core(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; v_token text; v_code text; v_expires timestamptz;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR d->>'modalidad' IS DISTINCT FROM 'TERCERO' OR d->>'status' NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN
   RAISE EXCEPTION 'El servicio no admite acceso del tercero'; END IF;
 UPDATE public.dispatch_tercero_enlaces SET revoked_at=now() WHERE dispatch_id=p_dispatch AND revoked_at IS NULL;
 v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 v_code:=substr(replace(gen_random_uuid()::text,'-',''),1,12);
 v_expires:=GREATEST(now(),COALESCE(NULLIF(d->>'scheduled_departure','')::timestamptz,now()))+interval '3 days';
 INSERT INTO public.dispatch_tercero_enlaces(token,dispatch_id,created_by,expires_at,access_code)
 VALUES(v_token,p_dispatch,auth.uid(),v_expires,v_code);
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'ENLACE_TERCERO','Acceso del proveedor generado; compartir portal, placa y código',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'token',v_token,'codigo',v_code,'placa',d->>'vehicle_plate','expires_at',v_expires);
END $$;
REVOKE ALL ON FUNCTION public.delivery_issue_access_core(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.tercero_generar_enlace(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.tercero_puede_operar(p_dispatch_id) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 RETURN public.delivery_issue_access_core(p_dispatch_id);
END $$;
CREATE FUNCTION public.delivery_auto_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.modalidad='TERCERO' AND
    (NEW.modalidad IS DISTINCT FROM OLD.modalidad OR NEW.status IN ('CANCELADO','LIQUIDADO','CERRADO')) THEN
   UPDATE public.dispatch_tercero_enlaces SET revoked_at=now() WHERE dispatch_id=NEW.id AND revoked_at IS NULL;
 END IF;
 IF NEW.modalidad='TERCERO' AND NEW.status IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN
   IF TG_OP='INSERT' THEN PERFORM public.delivery_issue_access_core(NEW.id);
   ELSIF NEW.modalidad IS DISTINCT FROM OLD.modalidad OR NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate
      OR NEW.carrier_id IS DISTINCT FROM OLD.carrier_id OR NEW.tercero_telefono IS DISTINCT FROM OLD.tercero_telefono
      OR NEW.tercero_conductor IS DISTINCT FROM OLD.tercero_conductor THEN
     PERFORM public.delivery_issue_access_core(NEW.id);
   END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.delivery_auto_access() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER delivery_auto_access AFTER INSERT OR UPDATE ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.delivery_auto_access();
-- Provision only open journeys without a usable access; preserve existing valid credentials.
DO $$ DECLARE d record; BEGIN
 FOR d IN SELECT x.id FROM public.dispatches x WHERE x.modalidad='TERCERO' AND x.status IN ('PROGRAMADO','EN_CURSO','EN RUTA')
   AND NOT EXISTS(SELECT 1 FROM public.dispatch_tercero_enlaces l WHERE l.dispatch_id=x.id AND l.revoked_at IS NULL AND l.expires_at>now() AND l.access_code IS NOT NULL)
   AND (NOT EXISTS(SELECT 1 FROM public.dispatch_tercero_enlaces l WHERE l.dispatch_id=x.id)
     OR EXISTS(SELECT 1 FROM public.dispatch_tercero_enlaces l WHERE l.dispatch_id=x.id AND l.revoked_at IS NULL))
 LOOP PERFORM public.delivery_issue_access_core(d.id); END LOOP;
END $$;

CREATE FUNCTION public.register_signed_packing_list(p_dispatch_id uuid,p_request_id uuid,p_file_path text,p_file_name text,
 p_mime_type text,p_size_bytes bigint,p_auditor text,p_signed_date date,p_signature_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.dispatches%ROWTYPE; v_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_tms_permission('documentario') THEN
   RETURN jsonb_build_object('success',false,'error','Solo el Asistente Documentario carga el Packing List firmado'); END IF;
 SELECT * INTO d FROM public.dispatches WHERE id=p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RETURN jsonb_build_object('success',false,'error','Despacho inexistente'); END IF;
 IF d.status<>'PROGRAMADO' THEN RETURN jsonb_build_object('success',false,'error','El Packing List se confirma antes de la salida'); END IF;
 IF NOT COALESCE(p_signature_confirmed,false) OR NULLIF(trim(p_auditor),'') IS NULL OR p_signed_date IS NULL OR p_signed_date>current_date THEN
   RETURN jsonb_build_object('success',false,'error','Indique auditor, fecha y confirme que el archivo contiene su firma'); END IF;
 IF COALESCE(p_mime_type,'') NOT IN ('application/pdf','image/jpeg','image/png','image/webp') OR COALESCE(p_size_bytes,0) NOT BETWEEN 1 AND 15728640 THEN
   RETURN jsonb_build_object('success',false,'error','Adjunte el Packing List firmado en PDF o fotografía, hasta 15 MB'); END IF;
 IF public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id OR
    NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=p_file_path) THEN
   RETURN jsonb_build_object('success',false,'error','El archivo no está disponible para este despacho'); END IF;
 IF p_request_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND transport_request_id=p_request_id) THEN
   RETURN jsonb_build_object('success',false,'error','La solicitud no pertenece a este despacho'); END IF;
 INSERT INTO public.dispatch_documents(dispatch_id,transport_request_id,doc_type,file_path,file_name,mime_type,size_bytes,
   uploaded_by,auditor_name,auditor_signed_date,auditor_signature_confirmed)
 VALUES(p_dispatch_id,p_request_id,'PACKING_LIST',p_file_path,p_file_name,p_mime_type,p_size_bytes,auth.uid(),left(trim(p_auditor),120),p_signed_date,true) RETURNING id INTO v_id;
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;
REVOKE ALL ON FUNCTION public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_signed_packing_list(uuid,uuid,text,text,text,bigint,text,date,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.register_dispatch_document(
  p_dispatch_id uuid, p_request_id uuid, p_doc_type text, p_cargo_type text, p_document_number text,
  p_file_path text, p_file_name text, p_mime_type text, p_size_bytes bigint, p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d        record;
  v_pickup boolean;
  v_type   text := upper(COALESCE(p_doc_type, ''));
  v_number text := NULLIF(upper(trim(COALESCE(p_document_number, ''))), '');
  v_id     uuid;
BEGIN
  IF NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario carga documentos del despacho');
  END IF;
  SELECT id, status, site_id, vehicle_plate INTO d FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' AND v_type <> 'OTRO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya salió (' || d.status || '): solo se pueden adjuntar documentos de tipo "Otro"');
  END IF;
  v_pickup := EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id AND NOT public.delivery_required(dispatch_id,transport_request_id));
  IF v_type NOT IN ('GUIA_REMISION', 'PACKING_LIST', 'NOTA_DESPACHO', 'OTRO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de documento inválido');
  END IF;
  IF v_type='GUIA_REMISION' THEN
    RETURN jsonb_build_object('success',false,'error','La guía firmada debe subirla el conductor desde el app o el proveedor desde su portal');
  END IF;
  IF v_type='PACKING_LIST' THEN
    RETURN jsonb_build_object('success',false,'error','Use la carga de Packing List firmado e identifique al auditor');
  END IF;
  IF v_type = 'NOTA_DESPACHO' AND NOT v_pickup THEN
    RETURN jsonb_build_object('success', false, 'error', 'La Nota de Despacho es solo para recojos del cliente; este envío requiere guía de remisión');
  END IF;
  IF v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') AND v_number IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la serie y número del documento');
  END IF;
  IF v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') AND COALESCE(p_mime_type, '') <> 'application/pdf' THEN
    RETURN jsonb_build_object('success', false, 'error', 'La guía y la Nota de Despacho se cargan en PDF');
  END IF;
  IF v_type = 'GUIA_REMISION' AND EXISTS (SELECT 1 FROM public.dispatch_documents
      WHERE doc_type = 'GUIA_REMISION' AND voided_at IS NULL AND upper(document_number) = v_number) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La guía ' || v_number || ' ya está registrada');
  END IF;
  IF p_request_id IS NULL AND v_type IN ('GUIA_REMISION', 'NOTA_DESPACHO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Seleccione la parada (solicitud) del documento');
  END IF;
  IF p_request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.dispatch_requests
      WHERE dispatch_id = p_dispatch_id AND transport_request_id = p_request_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'La solicitud no pertenece a este despacho');
  END IF;
  IF public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Archivo inválido para este despacho');
  END IF;

  IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='dispatch_documents' AND name=p_file_path) THEN
    RETURN jsonb_build_object('success',false,'error','El archivo no está disponible para este despacho');
  END IF;
  INSERT INTO public.dispatch_documents (dispatch_id, transport_request_id, doc_type, cargo_type, document_number,
    file_path, file_name, mime_type, size_bytes, notes, uploaded_by)
  VALUES (p_dispatch_id, p_request_id, v_type, NULLIF(upper(COALESCE(p_cargo_type, '')), ''), v_number,
    p_file_path, p_file_name, p_mime_type, p_size_bytes, NULLIF(trim(COALESCE(p_notes, '')), ''), auth.uid())
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_documents_missing(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record; v_general boolean; v_packing text; v_notes text;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id IS NULL
   AND x.doc_type='PACKING_LIST' AND x.voided_at IS NULL AND x.auditor_signature_confirmed
   AND NULLIF(trim(x.auditor_name),'') IS NOT NULL AND x.auditor_signed_date IS NOT NULL
   AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name=x.file_path)) INTO v_general;
 FOR s IN SELECT r.transport_request_id,COALESCE(t.request_number,r.transport_request_id::text) AS number
   FROM public.dispatch_requests r LEFT JOIN public.transport_requests t ON t.id=r.transport_request_id
   WHERE r.dispatch_id=p_dispatch_id ORDER BY r.sequence_order NULLS LAST,t.request_number LOOP
   IF NOT v_general AND NOT EXISTS(SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id=s.transport_request_id
     AND x.doc_type='PACKING_LIST' AND x.voided_at IS NULL AND x.auditor_signature_confirmed
     AND NULLIF(trim(x.auditor_name),'') IS NOT NULL AND x.auditor_signed_date IS NOT NULL
     AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name=x.file_path)) THEN
     v_packing:=concat_ws(', ',v_packing,s.number);
   END IF;
   IF NOT public.delivery_required(p_dispatch_id,s.transport_request_id) AND NOT EXISTS(
     SELECT 1 FROM public.dispatch_documents x WHERE x.dispatch_id=p_dispatch_id AND x.transport_request_id=s.transport_request_id
       AND x.doc_type='NOTA_DESPACHO' AND x.voided_at IS NULL
       AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name=x.file_path)) THEN
     v_notes:=concat_ws(', ',v_notes,s.number);
   END IF;
 END LOOP;
 RETURN NULLIF(concat_ws('; ',CASE WHEN v_packing IS NOT NULL THEN 'Packing List firmado por el auditor: '||v_packing END,
   CASE WHEN v_notes IS NOT NULL THEN 'Nota de Despacho: '||v_notes END),'');
END $$;

CREATE OR REPLACE FUNCTION public.confirm_dispatch_documents(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record; v_missing text;
BEGIN
  IF NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario confirma los documentos');
  END IF;
  SELECT id, status, site_id, vehicle_plate INTO d FROM public.dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya no está programado (' || d.status || ')');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho no tiene paradas');
  END IF;
  v_missing := public.dispatch_documents_missing(p_dispatch_id);
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('success',false,'error','Documentos pendientes: '||v_missing);
  END IF;
  UPDATE public.dispatches SET docs_ready_at = now(), docs_ready_by = auth.uid(),
    docs_reissue = false, docs_reissue_reason = NULL, docs_reissue_at = NULL
  WHERE id = p_dispatch_id;
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  SELECT p_dispatch_id, 'DOCUMENTOS', 'Packing List firmado confirmado por el Asistente Documentario; guía de entrega a cargo del conductor o proveedor', auth.uid()
  WHERE to_regclass('public.dispatch_events') IS NOT NULL;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_docs_detect_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.docs_ready_at IS NOT NULL AND NEW.status = 'PROGRAMADO' AND (
     NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
    NEW.docs_reissue := true;
    NEW.docs_reissue_at := now();
    NEW.docs_reissue_reason := concat_ws('; ',
      CASE WHEN NEW.vehicle_plate IS DISTINCT FROM OLD.vehicle_plate THEN 'Cambió la placa ' || COALESCE(OLD.vehicle_plate, '—') || ' → ' || COALESCE(NEW.vehicle_plate, '—') END,
      CASE WHEN NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN 'Cambió el conductor' END);
  END IF;
  -- Salida del almacén: exige documentos confirmados y vigentes (cancelar sigue permitido)
  IF NEW.docs_required AND OLD.status = 'PROGRAMADO' AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('PROGRAMADO', 'CANCELADO') THEN
    IF NEW.docs_reissue THEN
      RAISE EXCEPTION 'Documentos por reemitir (%): el Asistente Documentario debe actualizar y confirmar el Packing List firmado antes de la salida',
        COALESCE(NEW.docs_reissue_reason, 'cambios en el despacho');
    ELSIF NEW.docs_ready_at IS NULL OR public.dispatch_documents_missing(NEW.id) IS NOT NULL THEN
      RAISE EXCEPTION 'Documentos pendientes: confirme el Packing List firmado por el auditor y la Nota de Despacho cuando corresponda antes de salir';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.packing_document_invalidated() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.doc_type='PACKING_LIST' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
   UPDATE public.dispatches SET docs_ready_at=NULL,docs_ready_by=NULL,docs_reissue=true,docs_reissue_reason='Se anuló el Packing List firmado',docs_reissue_at=now()
   WHERE id=NEW.dispatch_id AND status='PROGRAMADO';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.packing_document_invalidated() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER packing_document_invalidated AFTER UPDATE OF voided_at ON public.dispatch_documents
 FOR EACH ROW EXECUTE FUNCTION public.packing_document_invalidated();
-- Apply the new responsibility to pending departures; never alter departed/closed routes.
UPDATE public.dispatches SET docs_ready_at=NULL,docs_ready_by=NULL,docs_reissue=true,
 docs_reissue_reason='Confirmar Packing List firmado por el auditor según el nuevo control documentario',docs_reissue_at=now()
WHERE status='PROGRAMADO' AND docs_required AND docs_ready_at IS NOT NULL AND public.dispatch_documents_missing(id) IS NOT NULL;

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
                'cargo', to_jsonb(t)->>'cargo_description', 'client', to_jsonb(t)->>'requester_name')
                ORDER BY (to_jsonb(r)->>'sequence_order')::int NULLS LAST, t.request_number), '[]'::jsonb)
              FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
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

CREATE OR REPLACE FUNCTION public.delivery_submit_core(p_dispatch uuid,p_request uuid,p_photos text[],p_received text,p_note text,
 p_source text,p_guide text DEFAULT NULL,p_operation uuid DEFAULT NULL,p_captured timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; c public.delivery_conformities; s public.delivery_submissions; photo text; sid uuid; v_guide text;
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
 v_guide:=COALESCE(NULLIF(trim(p_guide),''),(SELECT NULLIF(trim(document_number),'') FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request));
 IF v_guide IS NULL THEN RAISE EXCEPTION 'Indique el número de la guía de remisión firmada'; END IF;
 IF NULLIF(trim(p_received),'') IS NULL THEN RAISE EXCEPTION 'Indique quién recibió la entrega'; END IF;
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
  left(v_guide,80),p_captured)
 RETURNING id INTO sid;
 UPDATE public.delivery_conformities SET state='RECIBIDA',current_submission_id=sid,arrived_at=COALESCE(arrived_at,p_captured),updated_at=now() WHERE dispatch_id=p_dispatch AND request_id=p_request;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'GUIA_RECIBIDA','Guía de entrega recibida; pendiente de validación del Supervisor de Transporte',COALESCE(auth.uid()::text,'tercero'));
 RETURN jsonb_build_object('success',true,'submission_id',sid,'pending_review',true);
END $$;

CREATE OR REPLACE FUNCTION public.tercero_registrar_entrega(p_dispatch_id uuid,p_request_id uuid,p_at timestamptz,
 p_recibido_por text,p_foto text,p_nota text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('success',false,'error','El proveedor contratado debe subir su guía desde el portal de transportistas; comparta el acceso del tercero');
END $$;
CREATE OR REPLACE FUNCTION public.registrar_cargo(p_dispatch_id uuid,p_file_path text DEFAULT NULL,p_notas text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN jsonb_build_object('success',false,'error','La guía de conformidad se recibe desde el app del conductor o el portal del proveedor y la valida el Supervisor de Transporte');
END $$;
-- Keep receipt/KPI history without asking the assistant to upload delivery evidence a second time.
CREATE FUNCTION public.delivery_record_cargo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=NEW.dispatch_id
    AND public.delivery_required(r.dispatch_id,r.transport_request_id)
    AND NOT EXISTS(SELECT 1 FROM public.delivery_submissions s WHERE s.dispatch_id=r.dispatch_id AND s.request_id=r.transport_request_id)) THEN
   INSERT INTO public.dispatch_cargos(dispatch_id,recibido_at,recibido_by,file_path,notas)
   VALUES(NEW.dispatch_id,NEW.submitted_at,NULL,'driver_evidence/'||NEW.photos[1],'Guías recibidas desde conductor/proveedor; conformidad sujeta a revisión del Supervisor de Transporte')
   ON CONFLICT(dispatch_id) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.delivery_record_cargo() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER delivery_record_cargo AFTER INSERT ON public.delivery_submissions FOR EACH ROW EXECUTE FUNCTION public.delivery_record_cargo();
CREATE OR REPLACE FUNCTION public.delivery_can_read(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=auth.uid() AND p.is_active) AND (
   ((public.is_tms_admin() OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('monitoreo')
     OR public.has_tms_read_permission('torre-control') OR public.has_tms_read_permission('documentario')) AND public.can_access_site(d.site_id))
   OR EXISTS(SELECT 1 FROM public.drivers r JOIN public.profiles p ON p.id=r.profile_id
     WHERE r.id=d.driver_id AND r.profile_id=auth.uid() AND r.is_active AND p.is_active)));
$$;
CREATE FUNCTION public.delivery_can_read_photo(p_path text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.delivery_submissions s
 WHERE p_path=ANY(s.photos) AND public.delivery_can_read(s.dispatch_id));
$$;
REVOKE ALL ON FUNCTION public.delivery_can_read_photo(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.delivery_can_read_photo(text) TO authenticated;
CREATE POLICY delivery_submission_photo_read ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='driver_evidence' AND public.delivery_can_read_photo(name));

COMMIT;
