-- Detalle del despacho · datos que faltaban en el modelo:
--  * dispatch_evidence: evidencias operativas con etapa (recojo, tránsito, llegada, descarga, incidencia, otro) que
--    registra quien opera la ruta desde el detalle. Archivo en el bucket dispatch_documents bajo
--    <despacho>/evidencia/<usuario>/; tamaño guardado; no se borran: se anulan con motivo (queda el registro).
--  * dispatch_route_estimates: distancia, tiempo y trazo estimados por OSRM al programar la ruta, por solicitud.
-- Solo tablas nuevas y funciones nuevas o envoltorios; no toca datos existentes ni las tablas protegidas.
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE TABLE IF NOT EXISTS public.dispatch_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id  uuid REFERENCES public.transport_requests(id) ON DELETE SET NULL,
  stage       text NOT NULL CHECK (stage IN ('RECOJO','TRANSITO','LLEGADA','DESCARGA','INCIDENCIA','OTRO')),
  file_path   text NOT NULL UNIQUE,
  file_name   text,
  mime_type   text,
  size_bytes  bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  note        text CHECK (note IS NULL OR length(note) <= 500),
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  voided_at   timestamptz,
  voided_by   uuid,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 10 AND 500)
);
CREATE INDEX IF NOT EXISTS dispatch_evidence_dispatch_idx ON public.dispatch_evidence(dispatch_id);
ALTER TABLE public.dispatch_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_evidence FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_evidence;
CREATE POLICY security_active_account ON public.dispatch_evidence AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));

CREATE TABLE IF NOT EXISTS public.dispatch_route_estimates (
  dispatch_id  uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  distance_km  numeric(10,2) CHECK (distance_km IS NULL OR distance_km >= 0),
  duration_min numeric(10,1) CHECK (duration_min IS NULL OR duration_min >= 0),
  origin       jsonb,
  destination  jsonb,
  geometry     jsonb,
  source       text NOT NULL DEFAULT 'OSRM',
  computed_by  uuid,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, request_id)
);
ALTER TABLE public.dispatch_route_estimates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_route_estimates FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_route_estimates;
CREATE POLICY security_active_account ON public.dispatch_route_estimates AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));

-- Carpeta propia de evidencias: solo quien opera la ruta sube a <despacho>/evidencia/<su usuario>/
CREATE OR REPLACE FUNCTION public.dispatch_evidence_can_upload(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=public.dispatch_document_folder(p_name) AND public.can_operate_dispatch(d.site_id))
  AND p_name LIKE public.dispatch_document_folder(p_name)::text||'/evidencia/'||auth.uid()::text||'/%'
$$;
CREATE OR REPLACE FUNCTION public.dispatch_evidence_can_read(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.dispatch_evidence e WHERE e.file_path=p_name AND e.voided_at IS NULL AND public.delivery_can_read(e.dispatch_id))
$$;
-- Archivo propio que no llegó a registrarse (si falla el registro, la pantalla lo retira)
CREATE OR REPLACE FUNCTION public.dispatch_evidence_unregistered(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p_name LIKE '%/evidencia/'||auth.uid()::text||'/%' AND NOT EXISTS(SELECT 1 FROM public.dispatch_evidence e WHERE e.file_path=p_name)
$$;
REVOKE ALL ON FUNCTION public.dispatch_evidence_can_upload(text), public.dispatch_evidence_can_read(text), public.dispatch_evidence_unregistered(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_evidence_can_upload(text), public.dispatch_evidence_can_read(text), public.dispatch_evidence_unregistered(text) TO authenticated;

DROP POLICY IF EXISTS dispatch_evidence_obj_insert ON storage.objects;
CREATE POLICY dispatch_evidence_obj_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK (bucket_id='dispatch_documents' AND public.dispatch_evidence_can_upload(name));
DROP POLICY IF EXISTS dispatch_evidence_obj_read ON storage.objects;
CREATE POLICY dispatch_evidence_obj_read ON storage.objects FOR SELECT TO authenticated
 USING (bucket_id='dispatch_documents' AND name LIKE '%/evidencia/%' AND (public.dispatch_evidence_can_read(name) OR public.dispatch_evidence_unregistered(name)));
DROP POLICY IF EXISTS dispatch_evidence_obj_cleanup ON storage.objects;
CREATE POLICY dispatch_evidence_obj_cleanup ON storage.objects FOR DELETE TO authenticated
 USING (bucket_id='dispatch_documents' AND public.dispatch_evidence_unregistered(name));

CREATE OR REPLACE FUNCTION public.register_dispatch_evidence(p_dispatch uuid, p_request uuid, p_stage text, p_file_path text,
 p_file_name text, p_mime_type text, p_size_bytes bigint, p_note text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_id uuid; v_stage text := upper(btrim(COALESCE(p_stage,'')));
BEGIN
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id=p_dispatch;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT public.can_operate_dispatch(d.site_id) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar evidencias en esta ruta');
 END IF;
 IF v_stage NOT IN ('RECOJO','TRANSITO','LLEGADA','DESCARGA','INCIDENCIA','OTRO') THEN RETURN jsonb_build_object('success',false,'error','Etapa inválida'); END IF;
 IF p_request IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id=p_request) THEN
  RETURN jsonb_build_object('success',false,'error','La solicitud no pertenece a este despacho');
 END IF;
 IF public.dispatch_document_folder(p_file_path) IS DISTINCT FROM p_dispatch OR p_file_path NOT LIKE p_dispatch::text||'/evidencia/'||auth.uid()::text||'/%' THEN
  RETURN jsonb_build_object('success',false,'error','Archivo inválido para este despacho');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='dispatch_documents' AND o.name=p_file_path) THEN
  RETURN jsonb_build_object('success',false,'error','El archivo no se cargó');
 END IF;
 IF p_note IS NOT NULL AND length(p_note) > 500 THEN RETURN jsonb_build_object('success',false,'error','La descripción admite hasta 500 caracteres'); END IF;
 INSERT INTO public.dispatch_evidence(dispatch_id,request_id,stage,file_path,file_name,mime_type,size_bytes,note,uploaded_by)
 VALUES(p_dispatch,p_request,v_stage,p_file_path,p_file_name,p_mime_type,p_size_bytes,NULLIF(btrim(p_note),''),auth.uid())
 ON CONFLICT (file_path) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','La evidencia ya está registrada'); END IF;
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;

-- Anular (no borrar): quien la subió o Despacho, con motivo; el archivo queda como respaldo
CREATE OR REPLACE FUNCTION public.void_dispatch_evidence(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e record;
BEGIN
 SELECT x.id, x.uploaded_by, x.voided_at, d.site_id INTO e FROM public.dispatch_evidence x JOIN public.dispatches d ON d.id=x.dispatch_id WHERE x.id=p_id FOR UPDATE OF x;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT public.can_operate_dispatch(e.site_id)
   OR NOT (e.uploaded_by=auth.uid() OR public.has_tms_permission('despacho')) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para anular esta evidencia');
 END IF;
 IF e.voided_at IS NOT NULL THEN RETURN jsonb_build_object('success',false,'error','La evidencia ya está anulada'); END IF;
 IF length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN RETURN jsonb_build_object('success',false,'error','Indique el motivo (10 a 500 caracteres)'); END IF;
 UPDATE public.dispatch_evidence SET voided_at=now(), voided_by=auth.uid(), void_reason=btrim(p_reason) WHERE id=p_id;
 RETURN jsonb_build_object('success',true);
END $$;

-- Estimado de OSRM guardado al programar (reemplaza el de la misma solicitud si se vuelve a calcular)
CREATE OR REPLACE FUNCTION public.save_dispatch_route_estimates(p_dispatch uuid, p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; it jsonb; n int := 0;
BEGIN
 SELECT x.id, x.site_id INTO d FROM public.dispatches x WHERE x.id=p_dispatch;
 IF NOT FOUND OR auth.uid() IS NULL OR NOT public.has_tms_permission('despacho') OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
  RETURN jsonb_build_object('success',false,'error','Sin permiso para registrar el estimado de la ruta');
 END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) > 50 THEN RETURN jsonb_build_object('success',false,'error','Estimado inválido'); END IF;
 FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id::text=it->>'request_id') THEN CONTINUE; END IF;
  IF jsonb_typeof(it->'geometry') = 'array' AND jsonb_array_length(it->'geometry') > 2000 THEN CONTINUE; END IF;
  INSERT INTO public.dispatch_route_estimates(dispatch_id,request_id,distance_km,duration_min,origin,destination,geometry,computed_by)
  VALUES(p_dispatch,(it->>'request_id')::uuid,NULLIF(it->>'distance_km','')::numeric,NULLIF(it->>'duration_min','')::numeric,
    it->'origin',it->'destination',CASE WHEN jsonb_typeof(it->'geometry')='array' THEN it->'geometry' END,auth.uid())
  ON CONFLICT (dispatch_id,request_id) DO UPDATE SET distance_km=EXCLUDED.distance_km,duration_min=EXCLUDED.duration_min,origin=EXCLUDED.origin,
    destination=EXCLUDED.destination,geometry=EXCLUDED.geometry,computed_by=EXCLUDED.computed_by,computed_at=now();
  n := n + 1;
 END LOOP;
 RETURN jsonb_build_object('success',true,'saved',n);
END $$;
REVOKE ALL ON FUNCTION public.register_dispatch_evidence(uuid,uuid,text,text,text,text,bigint,text), public.void_dispatch_evidence(uuid,text),
 public.save_dispatch_route_estimates(uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_dispatch_evidence(uuid,uuid,text,text,text,text,bigint,text), public.void_dispatch_evidence(uuid,text),
 public.save_dispatch_route_estimates(uuid,jsonb) TO authenticated;

-- Piezas nuevas del detalle (internas): estimado de la parada y evidencias operativas vigentes
CREATE OR REPLACE FUNCTION public.dispatch_detail_extras(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_est jsonb; v_ev jsonb; v_kind text; failed text[] := '{}';
BEGIN
 BEGIN
  SELECT jsonb_build_object('distance_km',e.distance_km,'duration_min',e.duration_min,'origin',e.origin,'destination',e.destination,
    'geometry',e.geometry,'source',e.source,'computed_at',e.computed_at) INTO v_est
  FROM public.dispatch_route_estimates e WHERE e.dispatch_id=p_dispatch AND e.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'dispatch_route_estimates');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'stage',e.stage,'file_path',e.file_path,'file_name',e.file_name,'mime_type',e.mime_type,
    'size_bytes',e.size_bytes,'note',e.note,'uploaded_at',e.uploaded_at,'uploaded_by',public.dispatch_detail_actor(e.uploaded_by),
    'scope',CASE WHEN e.request_id IS NULL THEN 'RUTA' ELSE 'SERVICIO' END,
    'can_void',auth.uid() IS NOT NULL AND (e.uploaded_by=auth.uid() OR public.has_tms_permission('despacho')))
    ORDER BY e.uploaded_at DESC), '[]') INTO v_ev
  FROM public.dispatch_evidence e WHERE e.dispatch_id=p_dispatch AND e.voided_at IS NULL AND (e.request_id IS NULL OR e.request_id=p_request);
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'dispatch_evidence');
 END;
 BEGIN
  SELECT c.service_kind INTO v_kind FROM public.documentary_closures c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'documentary_closures');
 END;
 RETURN jsonb_build_object('estimate',v_est,'evidence',COALESCE(v_ev,'[]'::jsonb),'service_kind',v_kind,'sources_failed',to_jsonb(failed));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_detail_extras(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_dispatch_detail(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; x jsonb;
BEGIN
 IF p_dispatch IS NULL OR NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para ver este despacho'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho';
 END IF;
 v := public.dispatch_detail_payload(p_dispatch, p_request, public.economic_can_read());
 x := public.dispatch_detail_extras(p_dispatch, p_request);
 RETURN v || jsonb_build_object('estimate', x->'estimate', 'sources_failed', (v->'sources_failed') || (x->'sources_failed'));
END $$;

CREATE OR REPLACE FUNCTION public.get_dispatch_detail_files(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; x jsonb;
BEGIN
 IF p_dispatch IS NULL OR NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para ver este despacho'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho';
 END IF;
 v := public.dispatch_detail_files_payload(p_dispatch, p_request, public.can_view_dispatch_documents(p_dispatch));
 x := public.dispatch_detail_extras(p_dispatch, p_request);
 RETURN v || jsonb_build_object('evidence', x->'evidence', 'service_kind', x->'service_kind',
  'can_add_evidence', (SELECT public.can_operate_dispatch(d.site_id) FROM public.dispatches d WHERE d.id=p_dispatch),
  'sources_failed', (v->'sources_failed') || (x->'sources_failed'));
END $$;
REVOKE ALL ON FUNCTION public.get_dispatch_detail(uuid,uuid), public.get_dispatch_detail_files(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_detail(uuid,uuid), public.get_dispatch_detail_files(uuid,uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
