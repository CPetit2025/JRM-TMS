-- Hallazgos de Auditoría de Despacho (F1): registro, asignación, corrección, validación y cierre, trazables por OT.
-- Tablas nuevas que reutilizan contracts (OT), dispatches, transport_requests y profiles. Toda escritura pasa por RPC
-- SECURITY DEFINER; las tablas solo se leen (RLS). Las evidencias van al bucket privado audit_findings, asociadas al
-- hallazgo, y nunca se borran una vez registradas (se anulan con motivo). No modifica tablas existentes.
BEGIN;

-- 1. Tablas ------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_finding_categories(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 code text NOT NULL UNIQUE,
 name text NOT NULL,
 is_safety boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,
 sort int NOT NULL DEFAULT 100,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_findings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 number text NOT NULL UNIQUE,
 registered_at timestamptz NOT NULL DEFAULT now(),
 contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE RESTRICT,
 dispatch_id uuid REFERENCES public.dispatches(id) ON DELETE SET NULL,
 transport_request_id uuid REFERENCES public.transport_requests(id) ON DELETE SET NULL,
 site_id uuid,
 ot_code text,
 client_id uuid,
 client_name text,
 destination text,
 process_area text NOT NULL,
 auditor_id uuid NOT NULL REFERENCES public.profiles(id),
 severity text NOT NULL CHECK (severity IN ('MENOR','MAYOR','CRITICO')),
 status text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO','EN_CORRECCION','PENDIENTE_VALIDACION','CERRADO')),
 description text NOT NULL,
 material_code text,
 material_description text,
 quantity numeric CHECK (quantity IS NULL OR quantity >= 0),
 unit text,
 location text,
 observations text,
 required_action text,
 responsible_id uuid REFERENCES public.profiles(id),
 responsible_area text,
 due_date date,
 attended_at timestamptz,
 closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_findings_contract_idx ON public.audit_findings(contract_id);
CREATE INDEX IF NOT EXISTS audit_findings_dispatch_open_idx ON public.audit_findings(dispatch_id) WHERE status <> 'CERRADO';
CREATE INDEX IF NOT EXISTS audit_findings_transport_request_idx ON public.audit_findings(transport_request_id);
CREATE INDEX IF NOT EXISTS audit_findings_responsible_idx ON public.audit_findings(responsible_id);
CREATE INDEX IF NOT EXISTS audit_findings_auditor_idx ON public.audit_findings(auditor_id);
CREATE INDEX IF NOT EXISTS audit_findings_registered_idx ON public.audit_findings(registered_at DESC);

CREATE TABLE IF NOT EXISTS public.audit_finding_category_links(
 finding_id uuid NOT NULL REFERENCES public.audit_findings(id) ON DELETE CASCADE,
 category_id uuid NOT NULL REFERENCES public.audit_finding_categories(id) ON DELETE RESTRICT,
 PRIMARY KEY(finding_id, category_id)
);
CREATE INDEX IF NOT EXISTS audit_finding_category_links_category_idx ON public.audit_finding_category_links(category_id);

CREATE TABLE IF NOT EXISTS public.audit_finding_corrections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 finding_id uuid NOT NULL REFERENCES public.audit_findings(id) ON DELETE CASCADE,
 round int NOT NULL,
 action_executed text NOT NULL,
 executed_at timestamptz NOT NULL,
 corrected_by uuid NOT NULL REFERENCES public.profiles(id),
 observations text,
 submitted_by uuid NOT NULL REFERENCES public.profiles(id),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 validated_by uuid REFERENCES public.profiles(id),
 validated_at timestamptz,
 result text CHECK (result IN ('CONFORME','RECHAZADO')),
 validation_comment text,
 no_photo_reason text,
 UNIQUE(finding_id, round)
);
CREATE INDEX IF NOT EXISTS audit_finding_corrections_corrected_by_idx ON public.audit_finding_corrections(corrected_by);

CREATE TABLE IF NOT EXISTS public.audit_finding_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 finding_id uuid NOT NULL REFERENCES public.audit_findings(id) ON DELETE RESTRICT,
 correction_id uuid REFERENCES public.audit_finding_corrections(id) ON DELETE SET NULL,
 phase text NOT NULL CHECK (phase IN ('ANTES','DESPUES')),
 file_path text NOT NULL UNIQUE,
 description text,
 mime_type text NOT NULL,
 size_bytes bigint NOT NULL,
 uploaded_by uuid NOT NULL REFERENCES public.profiles(id),
 uploaded_at timestamptz NOT NULL DEFAULT now(),
 voided_at timestamptz,
 voided_by uuid REFERENCES public.profiles(id),
 void_reason text
);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_finding_idx ON public.audit_finding_evidence(finding_id);
CREATE INDEX IF NOT EXISTS audit_finding_evidence_correction_idx ON public.audit_finding_evidence(correction_id);

CREATE TABLE IF NOT EXISTS public.audit_finding_events(
 id bigserial PRIMARY KEY,
 finding_id uuid NOT NULL REFERENCES public.audit_findings(id) ON DELETE CASCADE,
 event_type text NOT NULL,
 from_status text,
 to_status text,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 actor uuid,
 at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_finding_events_finding_idx ON public.audit_finding_events(finding_id, at);

-- Categorías iniciales (administrables). Estiba/seguridad y condición de la unidad no admiten excepción de salida.
INSERT INTO public.audit_finding_categories(code,name,is_safety,sort) VALUES
 ('DIFERENCIA_CANTIDAD','Diferencia de cantidades',false,10),
 ('MATERIAL_FALTANTE','Material faltante',false,20),
 ('MATERIAL_SOBRANTE','Material sobrante',false,30),
 ('PRODUCTO_DANADO','Producto dañado',false,40),
 ('EMBALAJE','Embalaje o packing inadecuado',false,50),
 ('ROTULADO','Rotulado incorrecto',false,60),
 ('PACKING_LIST','Packing list inconsistente',false,70),
 ('DOCUMENTACION','Documentación incorrecta o incompleta',false,80),
 ('PERNERIA','Pernería incompleta',false,90),
 ('ESTIBA_SEGURIDAD','Estiba o seguridad',true,100),
 ('CONDICION_UNIDAD','Condición de la unidad',true,110),
 ('OTROS','Otros',false,900)
ON CONFLICT (code) DO NOTHING;

-- 2. Reglas de acceso ----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_finding_can_read(p_site uuid, p_responsible uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) AND (
  public.is_tms_admin()
  OR (p_responsible IS NOT NULL AND p_responsible=auth.uid())
  OR (public.has_tms_read_permission('hallazgos') AND (p_site IS NULL OR public.can_access_site(p_site))));
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_can_write(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin()
  OR (public.has_tms_permission('hallazgos') AND (p_site IS NULL OR public.can_access_site(p_site))));
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_can_validate(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND (public.is_tms_admin()
  OR (public.has_tms_permission('hallazgos-validar') AND (p_site IS NULL OR public.can_access_site(p_site))));
$$;
-- Usuario activo que puede abrir /despacho/hallazgos (lectura o escritura del módulo, o administrador).
CREATE OR REPLACE FUNCTION public.audit_finding_user_assignable(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
  WHERE p.id=p_user AND p.is_active AND (lower(trim(r.name)) IN ('administrador','admin')
   OR r.permissions ? 'hallazgos' OR r.permissions ? 'hallazgos:read' OR r.permissions ? 'hallazgos:write'));
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_user_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT nullif(trim(concat_ws(' ',p.first_name,p.last_name)),'') FROM public.profiles p WHERE p.id=p_user;
$$;
-- Primer segmento de la ruta de Storage como uuid (nunca falla: devuelve NULL si no es un uuid).
CREATE OR REPLACE FUNCTION public.audit_finding_path_id(p_name text) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
BEGIN RETURN split_part(p_name,'/',1)::uuid; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;
-- Puede subir a esa carpeta: ANTES quien registra (hallazgo no cerrado); DESPUES el responsable en corrección.
CREATE OR REPLACE FUNCTION public.audit_finding_can_upload(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND split_part(p_name,'/',3)=auth.uid()::text AND EXISTS(
  SELECT 1 FROM public.audit_findings f WHERE f.id=public.audit_finding_path_id(p_name) AND (
   (split_part(p_name,'/',2)='ANTES' AND f.status<>'CERRADO' AND public.audit_finding_can_write(f.site_id))
   OR (split_part(p_name,'/',2)='DESPUES' AND f.status='EN_CORRECCION' AND (f.responsible_id=auth.uid() OR public.is_tms_admin()))));
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_object_unregistered(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND split_part(p_name,'/',3)=auth.uid()::text
  AND NOT EXISTS(SELECT 1 FROM public.audit_finding_evidence WHERE file_path=p_name);
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_object_readable(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.audit_finding_evidence e JOIN public.audit_findings f ON f.id=e.finding_id
  WHERE e.file_path=p_name AND public.audit_finding_can_read(f.site_id,f.responsible_id));
$$;
CREATE OR REPLACE FUNCTION public.audit_finding_log(p_finding uuid,p_type text,p_from text,p_to text,p_detail jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO public.audit_finding_events(finding_id,event_type,from_status,to_status,detail,actor)
 VALUES(p_finding,p_type,p_from,p_to,COALESCE(p_detail,'{}'::jsonb),auth.uid());
$$;

-- 3. RLS: solo lectura; sin escritura directa ------------------------------------------------------------------------
ALTER TABLE public.audit_finding_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_finding_category_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_finding_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_finding_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_finding_categories FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_findings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_finding_category_links FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_finding_corrections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_finding_evidence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.audit_finding_events FROM PUBLIC, anon, authenticated;
-- Barrera de cuenta activa (C55).
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_categories;
CREATE POLICY security_active_account ON public.audit_finding_categories AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.audit_findings;
CREATE POLICY security_active_account ON public.audit_findings AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_category_links;
CREATE POLICY security_active_account ON public.audit_finding_category_links AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_corrections;
CREATE POLICY security_active_account ON public.audit_finding_corrections AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_evidence;
CREATE POLICY security_active_account ON public.audit_finding_evidence AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_events;
CREATE POLICY security_active_account ON public.audit_finding_events AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON SEQUENCE public.audit_finding_events_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_finding_categories, public.audit_findings, public.audit_finding_category_links,
 public.audit_finding_corrections, public.audit_finding_evidence, public.audit_finding_events TO authenticated;

DROP POLICY IF EXISTS audit_finding_categories_read ON public.audit_finding_categories;
CREATE POLICY audit_finding_categories_read ON public.audit_finding_categories FOR SELECT TO authenticated
 USING (public.is_tms_admin() OR public.has_tms_read_permission('hallazgos'));
DROP POLICY IF EXISTS audit_findings_read ON public.audit_findings;
CREATE POLICY audit_findings_read ON public.audit_findings FOR SELECT TO authenticated
 USING (public.audit_finding_can_read(site_id, responsible_id));
DROP POLICY IF EXISTS audit_finding_category_links_read ON public.audit_finding_category_links;
CREATE POLICY audit_finding_category_links_read ON public.audit_finding_category_links FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.audit_findings f WHERE f.id=finding_id AND public.audit_finding_can_read(f.site_id,f.responsible_id)));
DROP POLICY IF EXISTS audit_finding_corrections_read ON public.audit_finding_corrections;
CREATE POLICY audit_finding_corrections_read ON public.audit_finding_corrections FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.audit_findings f WHERE f.id=finding_id AND public.audit_finding_can_read(f.site_id,f.responsible_id)));
DROP POLICY IF EXISTS audit_finding_evidence_read ON public.audit_finding_evidence;
CREATE POLICY audit_finding_evidence_read ON public.audit_finding_evidence FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.audit_findings f WHERE f.id=finding_id AND public.audit_finding_can_read(f.site_id,f.responsible_id)));
DROP POLICY IF EXISTS audit_finding_events_read ON public.audit_finding_events;
CREATE POLICY audit_finding_events_read ON public.audit_finding_events FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.audit_findings f WHERE f.id=finding_id AND public.audit_finding_can_read(f.site_id,f.responsible_id)));

-- 4. Storage: bucket privado; sin borrado de lo registrado ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('audit_findings','audit_findings',false,10*1024*1024,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=EXCLUDED.file_size_limit, allowed_mime_types=EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS audit_findings_obj_insert ON storage.objects;
CREATE POLICY audit_findings_obj_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK (bucket_id='audit_findings' AND public.audit_finding_can_upload(name));
DROP POLICY IF EXISTS audit_findings_obj_read ON storage.objects;
CREATE POLICY audit_findings_obj_read ON storage.objects FOR SELECT TO authenticated
 USING (bucket_id='audit_findings' AND (public.audit_finding_object_readable(name) OR public.audit_finding_object_unregistered(name)));
-- Solo se retira un archivo propio que no llegó a registrarse (subida abandonada).
DROP POLICY IF EXISTS audit_findings_obj_cleanup ON storage.objects;
CREATE POLICY audit_findings_obj_cleanup ON storage.objects FOR DELETE TO authenticated
 USING (bucket_id='audit_findings' AND public.audit_finding_object_unregistered(name));

-- 5. Notificaciones internas -------------------------------------------------------------------------------------------
INSERT INTO public.notif_reglas(evento,categoria,descripcion,severidad,permisos,al_solicitante) VALUES
 ('HALLAZGO_ASIGNADO','DESPACHO','Hallazgo de auditoría asignado (solo al responsable)','warn','{}',true),
 ('HALLAZGO_POR_VALIDAR','DESPACHO','Corrección de hallazgo pendiente de validación','info',ARRAY['hallazgos-validar'],false),
 ('HALLAZGO_RECHAZADO','DESPACHO','Corrección de hallazgo rechazada (solo al responsable)','warn','{}',true)
ON CONFLICT (evento) DO NOTHING;

-- Los avisos personales solo los ve su destinatario (se antepone a la definición vigente, sin reescribirla).
DO $guard$
DECLARE v_def text; v_pos int;
BEGIN
 IF to_regprocedure('public.notif_can_see_event(text,text[],uuid)') IS NULL THEN RETURN; END IF;
 v_def:=pg_get_functiondef('public.notif_can_see_event(text,text[],uuid)'::regprocedure);
 IF position('HALLAZGO_ASIGNADO' IN v_def)>0 THEN RETURN; END IF;
 v_pos:=position(E'BEGIN\n' IN v_def);
 IF v_pos=0 THEN RAISE EXCEPTION 'No se reconoce la política de notificaciones.'; END IF;
 EXECUTE substr(v_def,1,v_pos+4)||E'\n IF p_evento IN (''HALLAZGO_ASIGNADO'',''HALLAZGO_RECHAZADO'') THEN RETURN COALESCE(p_target=auth.uid(),false); END IF;\n'||substr(v_def,v_pos+5);
END $guard$;

-- 6. RPC -------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_finding_search_ot(p_query text, p_limit int DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:=NULLIF(trim(COALESCE(p_query,'')),'');
BEGIN
 IF NOT (public.is_tms_admin() OR public.has_tms_permission('hallazgos')) THEN RETURN '[]'::jsonb; END IF;
 IF q IS NULL OR length(q)<2 THEN RETURN '[]'::jsonb; END IF;
 RETURN COALESCE((SELECT jsonb_agg(x ORDER BY x->>'ot_code') FROM (
  SELECT jsonb_build_object('contract_id',c.id,'ot_code',c.code,'client_id',c.client_id,
   'client_name',(SELECT cl.business_name FROM public.clients cl WHERE cl.id=c.client_id),'site_id',c.site_id,
   'dispatches',COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id',d.id,'dispatch_number',d.dispatch_number,'status',d.status,
      'scheduled_departure',d.scheduled_departure,'transport_request_id',t.id,'request_number',to_jsonb(t)->>'request_number',
      'destination',NULLIF(concat_ws(' · ',to_jsonb(t)->>'delivery_address',to_jsonb(t)->>'delivery_district'),''))
      ORDER BY d.scheduled_departure DESC NULLS LAST)
    FROM public.transport_requests t JOIN public.dispatch_requests dr ON dr.transport_request_id=t.id JOIN public.dispatches d ON d.id=dr.dispatch_id
    WHERE t.contract_id=c.id AND d.status NOT IN ('CERRADO','LIQUIDADO','CANCELADO')
     AND (d.site_id IS NULL OR public.can_access_site(d.site_id))),'[]'::jsonb)) x
  FROM public.contracts c
  WHERE (c.site_id IS NULL OR public.can_access_site(c.site_id))
   AND (c.code::text ILIKE q||'%' OR EXISTS(SELECT 1 FROM public.clients cl WHERE cl.id=c.client_id AND cl.business_name ILIKE '%'||q||'%'))
  ORDER BY c.code LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)) s),'[]'::jsonb);
END $$;

-- Valida OT, despacho y parada; devuelve los datos que se copian del momento (cliente, destino, sede).
CREATE OR REPLACE FUNCTION public.audit_finding_resolve_target(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.contracts; v_dispatch uuid:=NULLIF(p->>'dispatch_id','')::uuid; v_request uuid:=NULLIF(p->>'transport_request_id','')::uuid;
 v_site uuid; v_dest text; v_dsite uuid;
BEGIN
 SELECT * INTO c FROM public.contracts WHERE id=NULLIF(p->>'contract_id','')::uuid;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Elija la OT con el buscador'; END IF;
 v_site:=c.site_id;
 IF v_request IS NOT NULL AND v_dispatch IS NULL THEN RAISE EXCEPTION 'Elija el despacho de la parada'; END IF;
 IF v_dispatch IS NOT NULL THEN
  SELECT d.site_id INTO v_dsite FROM public.dispatches d WHERE d.id=v_dispatch AND EXISTS(
   SELECT 1 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
   WHERE dr.dispatch_id=d.id AND t.contract_id=c.id AND (v_request IS NULL OR t.id=v_request));
  IF NOT FOUND THEN RAISE EXCEPTION 'El despacho o la parada no pertenecen a la OT'; END IF;
  v_site:=COALESCE(v_dsite,v_site);
 END IF;
 IF v_request IS NOT NULL THEN
  SELECT NULLIF(concat_ws(' · ',to_jsonb(t)->>'delivery_address',to_jsonb(t)->>'delivery_district'),'') INTO v_dest
  FROM public.transport_requests t WHERE t.id=v_request;
 END IF;
 RETURN jsonb_build_object('contract_id',c.id,'dispatch_id',v_dispatch,'transport_request_id',v_request,'site_id',v_site,
  'ot_code',c.code,'client_id',c.client_id,'client_name',(SELECT cl.business_name FROM public.clients cl WHERE cl.id=c.client_id),'destination',v_dest);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_set_categories(p_finding uuid, p_ids jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_ids uuid[]; n int;
BEGIN
 IF jsonb_typeof(p_ids)<>'array' THEN RAISE EXCEPTION 'Elija al menos un tipo de hallazgo'; END IF;
 SELECT array_agg(DISTINCT x::uuid) INTO v_ids FROM jsonb_array_elements_text(p_ids) x;
 SELECT count(*) INTO n FROM public.audit_finding_categories WHERE id=ANY(COALESCE(v_ids,'{}')) AND active;
 IF COALESCE(cardinality(v_ids),0)=0 OR n<>cardinality(v_ids) THEN RAISE EXCEPTION 'Elija al menos un tipo de hallazgo vigente'; END IF;
 DELETE FROM public.audit_finding_category_links WHERE finding_id=p_finding AND category_id<>ALL(v_ids);
 INSERT INTO public.audit_finding_category_links(finding_id,category_id) SELECT p_finding,unnest(v_ids) ON CONFLICT DO NOTHING;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t jsonb; v_id uuid; v_number text; v_year text:=to_char(now() AT TIME ZONE 'America/Lima','YYYY'); v_seq int;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success',false,'error','Sesión no válida'); END IF;
 t:=public.audit_finding_resolve_target(p);
 IF NOT public.audit_finding_can_write(NULLIF(t->>'site_id','')::uuid) THEN
  RETURN jsonb_build_object('success',false,'error','No tiene permiso para registrar hallazgos en esta OT'); END IF;
 IF COALESCE(p->>'severity','') NOT IN ('MENOR','MAYOR','CRITICO') THEN RETURN jsonb_build_object('success',false,'error','Elija la criticidad'); END IF;
 IF NULLIF(trim(COALESCE(p->>'process_area','')),'') IS NULL THEN RETURN jsonb_build_object('success',false,'error','Indique el área o proceso auditado'); END IF;
 IF length(trim(COALESCE(p->>'description','')))<5 THEN RETURN jsonb_build_object('success',false,'error','Describa el hallazgo'); END IF;
 -- Numeración correlativa por año (HAL-2026-00001), serializada.
 PERFORM pg_advisory_xact_lock(hashtext('audit_findings_number'));
 SELECT COALESCE(max(split_part(number,'-',3)::int),0)+1 INTO v_seq FROM public.audit_findings WHERE number LIKE 'HAL-'||v_year||'-%';
 v_number:='HAL-'||v_year||'-'||lpad(v_seq::text,5,'0');
 INSERT INTO public.audit_findings(number,contract_id,dispatch_id,transport_request_id,site_id,ot_code,client_id,client_name,destination,
  process_area,auditor_id,severity,description,material_code,material_description,quantity,unit,location,observations,required_action)
 VALUES(v_number,(t->>'contract_id')::uuid,NULLIF(t->>'dispatch_id','')::uuid,NULLIF(t->>'transport_request_id','')::uuid,NULLIF(t->>'site_id','')::uuid,
  t->>'ot_code',NULLIF(t->>'client_id','')::uuid,t->>'client_name',t->>'destination',left(trim(p->>'process_area'),120),auth.uid(),p->>'severity',
  left(trim(p->>'description'),4000),left(NULLIF(trim(p->>'material_code'),''),80),left(NULLIF(trim(p->>'material_description'),''),300),
  NULLIF(p->>'quantity','')::numeric,left(NULLIF(trim(p->>'unit'),''),30),left(NULLIF(trim(p->>'location'),''),200),
  left(NULLIF(trim(p->>'observations'),''),2000),left(NULLIF(trim(p->>'required_action'),''),2000))
 RETURNING id INTO v_id;
 PERFORM public.audit_finding_set_categories(v_id,p->'category_ids');
 PERFORM public.audit_finding_log(v_id,'REGISTRADO',NULL,'ABIERTO',jsonb_build_object('severity',p->>'severity'));
 RETURN jsonb_build_object('success',true,'id',v_id,'number',v_number);
EXCEPTION WHEN raise_exception OR invalid_text_representation THEN
 RETURN jsonb_build_object('success',false,'error',SQLERRM);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_update(p_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings; t jsonb;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id FOR UPDATE;
 IF f.id IS NULL OR NOT public.audit_finding_can_read(f.site_id,f.responsible_id) THEN RETURN jsonb_build_object('success',false,'error','Hallazgo no encontrado'); END IF;
 IF f.status<>'ABIERTO' THEN RETURN jsonb_build_object('success',false,'error','Solo se edita un hallazgo Abierto'); END IF;
 IF NOT (public.is_tms_admin() OR (f.auditor_id=auth.uid() AND public.audit_finding_can_write(f.site_id)) OR public.audit_finding_can_validate(f.site_id)) THEN
  RETURN jsonb_build_object('success',false,'error','Solo el auditor que lo registró o un validador lo edita'); END IF;
 t:=public.audit_finding_resolve_target(p);
 IF NOT public.audit_finding_can_write(NULLIF(t->>'site_id','')::uuid) THEN RETURN jsonb_build_object('success',false,'error','No tiene permiso sobre esa OT'); END IF;
 IF COALESCE(p->>'severity','') NOT IN ('MENOR','MAYOR','CRITICO') THEN RETURN jsonb_build_object('success',false,'error','Elija la criticidad'); END IF;
 IF NULLIF(trim(COALESCE(p->>'process_area','')),'') IS NULL THEN RETURN jsonb_build_object('success',false,'error','Indique el área o proceso auditado'); END IF;
 IF length(trim(COALESCE(p->>'description','')))<5 THEN RETURN jsonb_build_object('success',false,'error','Describa el hallazgo'); END IF;
 UPDATE public.audit_findings SET contract_id=(t->>'contract_id')::uuid,dispatch_id=NULLIF(t->>'dispatch_id','')::uuid,
  transport_request_id=NULLIF(t->>'transport_request_id','')::uuid,site_id=NULLIF(t->>'site_id','')::uuid,ot_code=t->>'ot_code',
  client_id=NULLIF(t->>'client_id','')::uuid,client_name=t->>'client_name',destination=t->>'destination',
  process_area=left(trim(p->>'process_area'),120),severity=p->>'severity',description=left(trim(p->>'description'),4000),
  material_code=left(NULLIF(trim(p->>'material_code'),''),80),material_description=left(NULLIF(trim(p->>'material_description'),''),300),
  quantity=NULLIF(p->>'quantity','')::numeric,unit=left(NULLIF(trim(p->>'unit'),''),30),location=left(NULLIF(trim(p->>'location'),''),200),
  observations=left(NULLIF(trim(p->>'observations'),''),2000),required_action=left(NULLIF(trim(p->>'required_action'),''),2000)
 WHERE id=p_id;
 PERFORM public.audit_finding_set_categories(p_id,p->'category_ids');
 PERFORM public.audit_finding_log(p_id,'EDITADO','ABIERTO','ABIERTO',jsonb_build_object('severity_before',f.severity,'severity',p->>'severity',
  'contract_before',f.contract_id,'dispatch_before',f.dispatch_id));
 RETURN jsonb_build_object('success',true,'id',p_id);
EXCEPTION WHEN raise_exception OR invalid_text_representation THEN
 RETURN jsonb_build_object('success',false,'error',SQLERRM);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_assign(p_id uuid, p_responsible uuid, p_area text, p_due date, p_required_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id FOR UPDATE;
 IF f.id IS NULL OR NOT public.audit_finding_can_write(f.site_id) THEN RETURN jsonb_build_object('success',false,'error','No tiene permiso para asignar este hallazgo'); END IF;
 IF f.status NOT IN ('ABIERTO','EN_CORRECCION') THEN RETURN jsonb_build_object('success',false,'error','El hallazgo ya tiene una corrección en validación o está cerrado'); END IF;
 IF p_responsible IS NULL OR NOT public.audit_finding_user_assignable(p_responsible) THEN
  RETURN jsonb_build_object('success',false,'error','El responsable debe ser un usuario activo con acceso a Hallazgos'); END IF;
 IF p_due IS NULL OR p_due < (f.registered_at AT TIME ZONE 'America/Lima')::date THEN
  RETURN jsonb_build_object('success',false,'error','La fecha compromiso no puede ser anterior al registro'); END IF;
 IF NULLIF(trim(COALESCE(p_required_action,f.required_action,'')),'') IS NULL THEN
  RETURN jsonb_build_object('success',false,'error','Indique la acción requerida'); END IF;
 UPDATE public.audit_findings SET responsible_id=p_responsible,responsible_area=left(NULLIF(trim(p_area),''),120),due_date=p_due,
  required_action=left(COALESCE(NULLIF(trim(p_required_action),''),required_action),2000),status='EN_CORRECCION' WHERE id=p_id;
 PERFORM public.audit_finding_log(p_id,CASE WHEN f.responsible_id IS NULL THEN 'ASIGNADO' ELSE 'REASIGNADO' END,f.status,'EN_CORRECCION',
  jsonb_build_object('responsible_id',p_responsible,'previous_responsible_id',f.responsible_id,'due_date',p_due));
 PERFORM public.notif_emit('HALLAZGO_ASIGNADO','hal-asig-'||p_id||'-'||p_responsible||'-'||p_due,
  'Se te asignó el hallazgo '||f.number||CASE WHEN f.severity='CRITICO' THEN ' (CRÍTICO)' WHEN f.severity='MAYOR' THEN ' (Mayor)' ELSE '' END,
  left('OT '||COALESCE(f.ot_code,'')||' · vence '||to_char(p_due,'DD/MM/YYYY')||' · '||f.description,500),'/despacho/hallazgos?id='||p_id,p_responsible);
 RETURN jsonb_build_object('success',true,'id',p_id,'status','EN_CORRECCION');
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_submit_correction(p_id uuid, p_action text, p_executed_at timestamptz, p_observations text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings; v_round int; v_corr uuid;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id FOR UPDATE;
 IF f.id IS NULL OR NOT (f.responsible_id=auth.uid() OR public.is_tms_admin()) THEN
  RETURN jsonb_build_object('success',false,'error','Solo el responsable asignado registra la corrección'); END IF;
 IF f.status<>'EN_CORRECCION' THEN RETURN jsonb_build_object('success',false,'error','El hallazgo no está en corrección'); END IF;
 IF length(trim(COALESCE(p_action,'')))<5 THEN RETURN jsonb_build_object('success',false,'error','Describa la corrección ejecutada'); END IF;
 IF p_executed_at IS NULL OR p_executed_at>now()+interval '5 minutes' OR p_executed_at<f.registered_at-interval '1 day' THEN
  RETURN jsonb_build_object('success',false,'error','Indique una fecha de ejecución válida'); END IF;
 SELECT COALESCE(max(round),0)+1 INTO v_round FROM public.audit_finding_corrections WHERE finding_id=p_id;
 INSERT INTO public.audit_finding_corrections(finding_id,round,action_executed,executed_at,corrected_by,observations,submitted_by)
 VALUES(p_id,v_round,left(trim(p_action),4000),p_executed_at,auth.uid(),left(NULLIF(trim(p_observations),''),2000),auth.uid()) RETURNING id INTO v_corr;
 -- Las fotos DESPUÉS cargadas en esta ronda quedan asociadas a la corrección.
 UPDATE public.audit_finding_evidence SET correction_id=v_corr WHERE finding_id=p_id AND phase='DESPUES' AND correction_id IS NULL AND voided_at IS NULL;
 UPDATE public.audit_findings SET status='PENDIENTE_VALIDACION',attended_at=now() WHERE id=p_id;
 PERFORM public.audit_finding_log(p_id,'CORRECCION_REGISTRADA','EN_CORRECCION','PENDIENTE_VALIDACION',jsonb_build_object('round',v_round,'correction_id',v_corr));
 PERFORM public.notif_emit('HALLAZGO_POR_VALIDAR','hal-val-'||v_corr,'Hallazgo '||f.number||' listo para validar',
  left('OT '||COALESCE(f.ot_code,'')||' · ronda '||v_round||' · '||trim(p_action),500),'/despacho/hallazgos?id='||p_id,NULL);
 RETURN jsonb_build_object('success',true,'id',p_id,'round',v_round,'status','PENDIENTE_VALIDACION');
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_validate(p_id uuid, p_result text, p_comment text, p_no_photo_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings; c public.audit_finding_corrections;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id FOR UPDATE;
 IF f.id IS NULL OR NOT public.audit_finding_can_validate(f.site_id) THEN RETURN jsonb_build_object('success',false,'error','No tiene permiso para validar hallazgos'); END IF;
 IF f.status<>'PENDIENTE_VALIDACION' THEN RETURN jsonb_build_object('success',false,'error','El hallazgo no tiene una corrección pendiente de validación'); END IF;
 SELECT * INTO c FROM public.audit_finding_corrections WHERE finding_id=p_id AND result IS NULL ORDER BY round DESC LIMIT 1 FOR UPDATE;
 IF c.id IS NULL THEN RETURN jsonb_build_object('success',false,'error','No hay corrección por validar'); END IF;
 IF c.corrected_by=auth.uid() OR c.submitted_by=auth.uid() THEN RETURN jsonb_build_object('success',false,'error','Quien registró la corrección no puede validarla'); END IF;
 IF p_result='CONFORME' THEN
  IF NOT EXISTS(SELECT 1 FROM public.audit_finding_evidence WHERE correction_id=c.id AND phase='DESPUES' AND voided_at IS NULL)
     AND length(trim(COALESCE(p_no_photo_reason,'')))<10 THEN
   RETURN jsonb_build_object('success',false,'error','Falta la foto de subsanación: adjúntela o indique por qué no corresponde'); END IF;
  UPDATE public.audit_finding_corrections SET result='CONFORME',validated_by=auth.uid(),validated_at=now(),
   validation_comment=left(NULLIF(trim(p_comment),''),2000),no_photo_reason=left(NULLIF(trim(p_no_photo_reason),''),500) WHERE id=c.id;
  UPDATE public.audit_findings SET status='CERRADO',closed_at=now() WHERE id=p_id;
  PERFORM public.audit_finding_log(p_id,'VALIDADO_CONFORME','PENDIENTE_VALIDACION','CERRADO',jsonb_build_object('round',c.round,'no_photo_reason',NULLIF(trim(p_no_photo_reason),'')));
  RETURN jsonb_build_object('success',true,'id',p_id,'status','CERRADO');
 ELSIF p_result='RECHAZADO' THEN
  IF length(trim(COALESCE(p_comment,'')))<5 THEN RETURN jsonb_build_object('success',false,'error','Indique por qué se rechaza la corrección'); END IF;
  UPDATE public.audit_finding_corrections SET result='RECHAZADO',validated_by=auth.uid(),validated_at=now(),validation_comment=left(trim(p_comment),2000) WHERE id=c.id;
  UPDATE public.audit_findings SET status='EN_CORRECCION' WHERE id=p_id;
  PERFORM public.audit_finding_log(p_id,'VALIDADO_RECHAZADO','PENDIENTE_VALIDACION','EN_CORRECCION',jsonb_build_object('round',c.round,'comment',trim(p_comment)));
  PERFORM public.notif_emit('HALLAZGO_RECHAZADO','hal-rech-'||c.id,'Corrección rechazada: hallazgo '||f.number,
   left(trim(p_comment),500),'/despacho/hallazgos?id='||p_id,f.responsible_id);
  RETURN jsonb_build_object('success',true,'id',p_id,'status','EN_CORRECCION');
 END IF;
 RETURN jsonb_build_object('success',false,'error','Resultado no válido (Conforme o Rechazado)');
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_add_evidence(p_finding uuid, p_phase text, p_file_path text, p_description text, p_mime text, p_size bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings; v_id uuid;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_finding FOR UPDATE;
 IF f.id IS NULL THEN RETURN jsonb_build_object('success',false,'error','Hallazgo no encontrado'); END IF;
 SELECT id INTO v_id FROM public.audit_finding_evidence WHERE file_path=p_file_path AND finding_id=p_finding;
 IF v_id IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',v_id,'duplicate',true); END IF;
 IF COALESCE(p_phase,'') NOT IN ('ANTES','DESPUES') THEN RETURN jsonb_build_object('success',false,'error','Clasifique la foto como Antes o Después'); END IF;
 IF NOT public.audit_finding_can_upload(p_file_path) OR public.audit_finding_path_id(p_file_path) IS DISTINCT FROM p_finding
    OR split_part(p_file_path,'/',2)<>p_phase THEN
  RETURN jsonb_build_object('success',false,'error',CASE WHEN p_phase='DESPUES' THEN 'Solo el responsable sube fotos de la corrección mientras está En corrección'
   ELSE 'No tiene permiso para subir evidencias a este hallazgo' END); END IF;
 IF COALESCE(p_mime,'') NOT IN ('image/jpeg','image/png','image/webp') OR COALESCE(p_size,0) NOT BETWEEN 1 AND 10485760 THEN
  RETURN jsonb_build_object('success',false,'error','Adjunte una imagen JPG, PNG o WEBP de hasta 10 MB'); END IF;
 IF NOT EXISTS(SELECT 1 FROM storage.objects WHERE bucket_id='audit_findings' AND name=p_file_path) THEN
  RETURN jsonb_build_object('success',false,'error','La foto no se terminó de subir'); END IF;
 IF (SELECT count(*) FROM public.audit_finding_evidence WHERE finding_id=p_finding AND voided_at IS NULL)>=40 THEN
  RETURN jsonb_build_object('success',false,'error','El hallazgo ya tiene 40 fotos vigentes'); END IF;
 INSERT INTO public.audit_finding_evidence(finding_id,phase,file_path,description,mime_type,size_bytes,uploaded_by)
 VALUES(p_finding,p_phase,p_file_path,left(NULLIF(trim(p_description),''),300),p_mime,p_size,auth.uid()) RETURNING id INTO v_id;
 PERFORM public.audit_finding_log(p_finding,'EVIDENCIA_AGREGADA',f.status,f.status,jsonb_build_object('evidence_id',v_id,'phase',p_phase));
 RETURN jsonb_build_object('success',true,'id',v_id);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_void_evidence(p_evidence uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.audit_finding_evidence; f public.audit_findings;
BEGIN
 SELECT * INTO e FROM public.audit_finding_evidence WHERE id=p_evidence FOR UPDATE;
 SELECT * INTO f FROM public.audit_findings WHERE id=e.finding_id;
 IF e.id IS NULL OR NOT public.audit_finding_can_validate(f.site_id) THEN RETURN jsonb_build_object('success',false,'error','No tiene permiso para anular evidencias'); END IF;
 IF e.voided_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',e.id,'duplicate',true); END IF;
 IF length(trim(COALESCE(p_reason,'')))<10 THEN RETURN jsonb_build_object('success',false,'error','Indique el motivo de la anulación (mínimo 10 caracteres)'); END IF;
 UPDATE public.audit_finding_evidence SET voided_at=now(),voided_by=auth.uid(),void_reason=left(trim(p_reason),500) WHERE id=e.id;
 PERFORM public.audit_finding_log(e.finding_id,'EVIDENCIA_ANULADA',f.status,f.status,jsonb_build_object('evidence_id',e.id,'phase',e.phase,'reason',trim(p_reason)));
 RETURN jsonb_build_object('success',true,'id',e.id);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_fix_date(p_id uuid, p_registered_at timestamptz, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id FOR UPDATE;
 IF f.id IS NULL OR NOT public.audit_finding_can_validate(f.site_id) THEN RETURN jsonb_build_object('success',false,'error','No tiene autorización para corregir la fecha'); END IF;
 IF p_registered_at IS NULL OR p_registered_at>now() THEN RETURN jsonb_build_object('success',false,'error','La fecha no puede ser futura'); END IF;
 IF length(trim(COALESCE(p_reason,'')))<10 THEN RETURN jsonb_build_object('success',false,'error','Indique el motivo de la corrección (mínimo 10 caracteres)'); END IF;
 UPDATE public.audit_findings SET registered_at=p_registered_at WHERE id=p_id;
 PERFORM public.audit_finding_log(p_id,'FECHA_CORREGIDA',f.status,f.status,jsonb_build_object('before',f.registered_at,'after',p_registered_at,'reason',trim(p_reason)));
 RETURN jsonb_build_object('success',true,'id',p_id);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.audit_findings;
BEGIN
 SELECT * INTO f FROM public.audit_findings WHERE id=p_id;
 IF f.id IS NULL OR NOT public.audit_finding_can_read(f.site_id,f.responsible_id) THEN RETURN jsonb_build_object('success',false,'error','Hallazgo no encontrado'); END IF;
 RETURN jsonb_build_object('success',true,
  'finding',to_jsonb(f)||jsonb_build_object('auditor_name',public.audit_finding_user_name(f.auditor_id),
    'responsible_name',public.audit_finding_user_name(f.responsible_id),
    'dispatch_number',(SELECT d.dispatch_number FROM public.dispatches d WHERE d.id=f.dispatch_id),
    'request_number',(SELECT to_jsonb(t)->>'request_number' FROM public.transport_requests t WHERE t.id=f.transport_request_id),
    'overdue',f.status<>'CERRADO' AND f.due_date IS NOT NULL AND f.due_date<(now() AT TIME ZONE 'America/Lima')::date,
    'can_edit',f.status='ABIERTO' AND (public.is_tms_admin() OR (f.auditor_id=auth.uid() AND public.audit_finding_can_write(f.site_id)) OR public.audit_finding_can_validate(f.site_id)),
    'can_assign',f.status IN ('ABIERTO','EN_CORRECCION') AND public.audit_finding_can_write(f.site_id),
    'can_correct',f.status='EN_CORRECCION' AND (f.responsible_id=auth.uid() OR public.is_tms_admin()),
    'can_validate',f.status='PENDIENTE_VALIDACION' AND public.audit_finding_can_validate(f.site_id)
      AND NOT EXISTS(SELECT 1 FROM public.audit_finding_corrections c WHERE c.finding_id=f.id AND c.result IS NULL AND auth.uid() IN (c.corrected_by,c.submitted_by)),
    'can_upload_before',f.status<>'CERRADO' AND public.audit_finding_can_write(f.site_id),
    'can_void',public.audit_finding_can_validate(f.site_id)),
  'categories',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',k.id,'code',k.code,'name',k.name,'is_safety',k.is_safety) ORDER BY k.sort)
    FROM public.audit_finding_category_links l JOIN public.audit_finding_categories k ON k.id=l.category_id WHERE l.finding_id=f.id),'[]'::jsonb),
  'evidence',COALESCE((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('uploaded_by_name',public.audit_finding_user_name(e.uploaded_by),
     'voided_by_name',public.audit_finding_user_name(e.voided_by)) ORDER BY e.uploaded_at) FROM public.audit_finding_evidence e WHERE e.finding_id=f.id),'[]'::jsonb),
  'corrections',COALESCE((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('corrected_by_name',public.audit_finding_user_name(c.corrected_by),
     'validated_by_name',public.audit_finding_user_name(c.validated_by)) ORDER BY c.round) FROM public.audit_finding_corrections c WHERE c.finding_id=f.id),'[]'::jsonb),
  'events',COALESCE((SELECT jsonb_agg(to_jsonb(v)||jsonb_build_object('actor_name',public.audit_finding_user_name(v.actor)) ORDER BY v.at,v.id)
    FROM public.audit_finding_events v WHERE v.finding_id=f.id),'[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_list(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p jsonb:=COALESCE(p_filters,'{}'::jsonb); v_today date:=(now() AT TIME ZONE 'America/Lima')::date; v_rows jsonb; v_kpis jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('rows','[]'::jsonb,'kpis','{}'::jsonb); END IF;
 WITH base AS (
  SELECT f.* FROM public.audit_findings f
  WHERE public.audit_finding_can_read(f.site_id,f.responsible_id)
   AND (NULLIF(p->>'from','') IS NULL OR (f.registered_at AT TIME ZONE 'America/Lima')::date>=(p->>'from')::date)
   AND (NULLIF(p->>'to','') IS NULL OR (f.registered_at AT TIME ZONE 'America/Lima')::date<=(p->>'to')::date)
   AND (NULLIF(p->>'contract_id','') IS NULL OR f.contract_id=(p->>'contract_id')::uuid)
   AND (NULLIF(p->>'dispatch_id','') IS NULL OR f.dispatch_id=(p->>'dispatch_id')::uuid)
   AND (NULLIF(p->>'client_id','') IS NULL OR f.client_id=(p->>'client_id')::uuid)
   AND (NULLIF(p->>'severity','') IS NULL OR f.severity=p->>'severity')
   AND (NULLIF(p->>'responsible_id','') IS NULL OR f.responsible_id=(p->>'responsible_id')::uuid)
   AND (NULLIF(p->>'auditor_id','') IS NULL OR f.auditor_id=(p->>'auditor_id')::uuid)
 ), filtered AS (
  SELECT * FROM base WHERE NULLIF(p->>'status','') IS NULL
   OR (p->>'status'='VENCIDO' AND status<>'CERRADO' AND due_date<v_today) OR status=p->>'status'
 )
 SELECT COALESCE((SELECT jsonb_agg(r ORDER BY r->>'registered_at' DESC) FROM (
   SELECT jsonb_build_object('id',f.id,'number',f.number,'registered_at',f.registered_at,'contract_id',f.contract_id,'ot_code',f.ot_code,
    'dispatch_id',f.dispatch_id,'dispatch_number',(SELECT d.dispatch_number FROM public.dispatches d WHERE d.id=f.dispatch_id),
    'client_id',f.client_id,'client_name',f.client_name,'destination',f.destination,'severity',f.severity,'status',f.status,
    'description',f.description,'process_area',f.process_area,'due_date',f.due_date,'attended_at',f.attended_at,'closed_at',f.closed_at,
    'responsible_id',f.responsible_id,'responsible_name',public.audit_finding_user_name(f.responsible_id),
    'auditor_id',f.auditor_id,'auditor_name',public.audit_finding_user_name(f.auditor_id),
    'overdue',f.status<>'CERRADO' AND f.due_date IS NOT NULL AND f.due_date<v_today,
    'categories',COALESCE((SELECT array_agg(k.name ORDER BY k.sort) FROM public.audit_finding_category_links l
      JOIN public.audit_finding_categories k ON k.id=l.category_id WHERE l.finding_id=f.id),'{}'::text[])) r
   FROM filtered f ORDER BY f.registered_at DESC LIMIT 500) s),'[]'::jsonb),
  jsonb_build_object('abiertos',(SELECT count(*) FROM base WHERE status<>'CERRADO'),
   'vencidos',(SELECT count(*) FROM base WHERE status<>'CERRADO' AND due_date<v_today),
   'pendientes_validacion',(SELECT count(*) FROM base WHERE status='PENDIENTE_VALIDACION'),
   'cerrados',(SELECT count(*) FROM base WHERE status='CERRADO'))
 INTO v_rows,v_kpis;
 RETURN jsonb_build_object('rows',v_rows,'kpis',v_kpis);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_assignable_users() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN NOT (public.is_tms_admin() OR public.has_tms_permission('hallazgos')) THEN '[]'::jsonb ELSE COALESCE((
  SELECT jsonb_agg(jsonb_build_object('id',p.id,'full_name',COALESCE(public.audit_finding_user_name(p.id),'Usuario'),'area',to_jsonb(p)->>'area')
   ORDER BY public.audit_finding_user_name(p.id))
  FROM public.profiles p WHERE public.audit_finding_user_assignable(p.id)),'[]'::jsonb) END;
$$;

-- Administración de categorías (permiso hallazgos-categorias). Nunca se borran: se desactivan.
CREATE OR REPLACE FUNCTION public.audit_finding_save_category(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid:=NULLIF(p->>'id','')::uuid; v_name text:=NULLIF(trim(COALESCE(p->>'name','')),'');
BEGIN
 IF NOT (public.is_tms_admin() OR public.has_tms_permission('hallazgos-categorias')) THEN
  RETURN jsonb_build_object('success',false,'error','No tiene permiso para administrar categorías'); END IF;
 IF v_name IS NULL THEN RETURN jsonb_build_object('success',false,'error','Indique el nombre de la categoría'); END IF;
 IF v_id IS NULL THEN
  INSERT INTO public.audit_finding_categories(code,name,is_safety,active,sort)
  VALUES(upper(regexp_replace(COALESCE(NULLIF(trim(p->>'code'),''),v_name),'[^A-Za-z0-9]+','_','g')),left(v_name,120),
   COALESCE((p->>'is_safety')::boolean,false),COALESCE((p->>'active')::boolean,true),COALESCE((p->>'sort')::int,500))
  RETURNING id INTO v_id;
 ELSE
  UPDATE public.audit_finding_categories SET name=left(v_name,120),is_safety=COALESCE((p->>'is_safety')::boolean,is_safety),
   active=COALESCE((p->>'active')::boolean,active),sort=COALESCE((p->>'sort')::int,sort) WHERE id=v_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'error','Categoría no encontrada'); END IF;
 END IF;
 RETURN jsonb_build_object('success',true,'id',v_id);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('success',false,'error','Ya existe una categoría con ese código');
END $$;

-- 7. Privilegios ----------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.audit_finding_can_read(uuid,uuid), public.audit_finding_can_write(uuid), public.audit_finding_can_validate(uuid),
 public.audit_finding_user_assignable(uuid), public.audit_finding_user_name(uuid), public.audit_finding_path_id(text),
 public.audit_finding_can_upload(text), public.audit_finding_object_unregistered(text), public.audit_finding_object_readable(text),
 public.audit_finding_log(uuid,text,text,text,jsonb), public.audit_finding_resolve_target(jsonb), public.audit_finding_set_categories(uuid,jsonb),
 public.audit_finding_search_ot(text,int), public.audit_finding_create(jsonb), public.audit_finding_update(uuid,jsonb),
 public.audit_finding_assign(uuid,uuid,text,date,text), public.audit_finding_submit_correction(uuid,text,timestamptz,text),
 public.audit_finding_validate(uuid,text,text,text), public.audit_finding_add_evidence(uuid,text,text,text,text,bigint),
 public.audit_finding_void_evidence(uuid,text), public.audit_finding_fix_date(uuid,timestamptz,text), public.audit_finding_detail(uuid),
 public.audit_finding_list(jsonb), public.audit_finding_assignable_users(), public.audit_finding_save_category(jsonb) FROM PUBLIC, anon;
-- Internas: solo las usan otras funciones y las políticas.
REVOKE ALL ON FUNCTION public.audit_finding_log(uuid,text,text,text,jsonb), public.audit_finding_resolve_target(jsonb),
 public.audit_finding_set_categories(uuid,jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.audit_finding_can_read(uuid,uuid), public.audit_finding_can_write(uuid), public.audit_finding_can_validate(uuid),
 public.audit_finding_user_assignable(uuid), public.audit_finding_user_name(uuid), public.audit_finding_path_id(text),
 public.audit_finding_can_upload(text), public.audit_finding_object_unregistered(text), public.audit_finding_object_readable(text),
 public.audit_finding_search_ot(text,int), public.audit_finding_create(jsonb), public.audit_finding_update(uuid,jsonb),
 public.audit_finding_assign(uuid,uuid,text,date,text), public.audit_finding_submit_correction(uuid,text,timestamptz,text),
 public.audit_finding_validate(uuid,text,text,text), public.audit_finding_add_evidence(uuid,text,text,text,text,bigint),
 public.audit_finding_void_evidence(uuid,text), public.audit_finding_fix_date(uuid,timestamptz,text), public.audit_finding_detail(uuid),
 public.audit_finding_list(jsonb), public.audit_finding_assignable_users(), public.audit_finding_save_category(jsonb) TO authenticated;

-- 8. Permisos de los roles base ---------------------------------------------------------------------------------------
UPDATE public.roles SET permissions=COALESCE(permissions,'[]'::jsonb)||'["hallazgos:write","hallazgos-validar"]'::jsonb
 WHERE lower(trim(name)) IN ('auditor de despacho','supervisor de despacho') AND NOT COALESCE(permissions,'[]'::jsonb) ? 'hallazgos:write';
UPDATE public.roles SET permissions=COALESCE(permissions,'[]'::jsonb)||'["hallazgos:write","hallazgos-validar","hallazgos-excepcion","hallazgos-categorias"]'::jsonb
 WHERE lower(trim(name))='jefe de distribución' AND NOT COALESCE(permissions,'[]'::jsonb) ? 'hallazgos:write';
UPDATE public.roles SET permissions=COALESCE(permissions,'[]'::jsonb)||'["hallazgos:read"]'::jsonb
 WHERE lower(trim(name)) IN ('supervisor de transporte','asistente documentario')
  AND NOT (COALESCE(permissions,'[]'::jsonb) ?| ARRAY['hallazgos:read','hallazgos:write','hallazgos']);

NOTIFY pgrst, 'reload schema';
COMMIT;
