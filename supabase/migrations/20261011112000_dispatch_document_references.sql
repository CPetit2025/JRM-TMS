-- Números documentarios por servicio. Referenciar un número nunca equivale a
-- recibir una guía firmada ni a aprobar la conformidad de entrega.
BEGIN;
CREATE TABLE public.dispatch_document_references (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 dispatch_id uuid NOT NULL REFERENCES public.dispatches(id),
 request_id uuid NOT NULL REFERENCES public.transport_requests(id),
 doc_type text NOT NULL CHECK (doc_type IN ('GUIA_REMISION','NOTA_DESPACHO')),
 document_number text NOT NULL CHECK (
  (doc_type='GUIA_REMISION' AND document_number ~ '^[A-Z0-9]{3,4}-[0-9]{1,10}$') OR
  (doc_type='NOTA_DESPACHO' AND document_number ~ '^[A-Z0-9]{1,8}-[0-9]{1,10}$')),
 created_by uuid NOT NULL REFERENCES public.profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(dispatch_id,request_id,doc_type,document_number)
);
CREATE INDEX dispatch_document_references_request_idx ON public.dispatch_document_references(request_id);
CREATE INDEX dispatch_document_references_creator_idx ON public.dispatch_document_references(created_by);
ALTER TABLE public.dispatch_document_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.dispatch_document_references AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.dispatch_document_references FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.link_dispatch_document_numbers(p_dispatch uuid,p_request uuid,p_type text,p_numbers text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_type text:=upper(trim(COALESCE(p_type,''))); v_numbers text[]; v_count integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.has_tms_permission('documentario') THEN
  RAISE EXCEPTION 'Sin permiso para vincular números documentarios';
 END IF;
 SELECT id,site_id,status INTO d FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF NOT FOUND OR NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
 IF d.status='CANCELADO' THEN RAISE EXCEPTION 'El despacho está cancelado'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.transport_requests r ON r.id=dr.transport_request_id
   WHERE dr.dispatch_id=p_dispatch AND r.id=p_request AND public.can_access_site(r.site_id)) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho o sede';
 END IF;
 IF v_type NOT IN ('GUIA_REMISION','NOTA_DESPACHO') THEN RAISE EXCEPTION 'Tipo de documento inválido'; END IF;
 IF COALESCE(cardinality(p_numbers),0) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Vincule entre 1 y 50 números por operación'; END IF;
 SELECT array_agg(upper(trim(n))) INTO v_numbers FROM unnest(p_numbers) n;
 IF EXISTS(SELECT 1 FROM unnest(v_numbers) n WHERE n IS NULL OR n !~ CASE WHEN v_type='GUIA_REMISION'
   THEN '^[A-Z0-9]{3,4}-[0-9]{1,10}$' ELSE '^[A-Z0-9]{1,8}-[0-9]{1,10}$' END) THEN
  RAISE EXCEPTION 'Respete la serie y correlativo; ejemplo T001-6591. No omita ceros ni use espacios';
 END IF;
 SELECT count(DISTINCT n) INTO v_count FROM unnest(v_numbers) n;
 IF v_count<>cardinality(v_numbers) OR EXISTS(SELECT 1 FROM public.dispatch_document_references
  WHERE dispatch_id=p_dispatch AND request_id=p_request AND doc_type=v_type AND document_number=ANY(v_numbers)) THEN
  RAISE EXCEPTION 'Hay números duplicados o ya vinculados a este servicio';
 END IF;
 INSERT INTO public.dispatch_document_references(dispatch_id,request_id,doc_type,document_number,created_by)
 SELECT p_dispatch,p_request,v_type,n,auth.uid() FROM unnest(v_numbers) n;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'NUMEROS_DOCUMENTARIOS_VINCULADOS',v_type||' · solicitud '||p_request||' · '||array_to_string(v_numbers,', '),auth.uid());
 RETURN jsonb_build_object('success',true,'linked',cardinality(v_numbers));
END $$;

CREATE FUNCTION public.get_dispatch_document_references(p_dispatch uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND is_active) OR
  NOT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND (
   public.delivery_can_read(d.id) OR (public.can_access_site(d.site_id) AND (
    public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion'))))) THEN
  RAISE EXCEPTION 'Sin acceso a los números documentarios de este despacho';
 END IF;
 RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at,id)
  FROM public.dispatch_document_references r WHERE dispatch_id=p_dispatch),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.link_dispatch_document_numbers(uuid,uuid,text,text[]) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.get_dispatch_document_references(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_dispatch_document_numbers(uuid,uuid,text,text[]),public.get_dispatch_document_references(uuid) TO authenticated;

-- Un cliente viejo tampoco puede pedir al asistente que cargue archivos o
-- confirme la salida. Mantener las funciones existentes para otros perfiles.
DO $$ DECLARE f record; body text; BEGIN
 FOR f IN SELECT p.oid,p.proname,pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('register_dispatch_document','confirm_dispatch_documents','void_dispatch_document','anular_documento','registrar_cargo','register_signed_packing_list') LOOP
  body := regexp_replace(f.def, '\mBEGIN\M', E'BEGIN\n  IF EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name=\'Asistente Documentario\') THEN\n    RETURN jsonb_build_object(\'success\',false,\'error\',\'El Asistente Documentario solo vincula números de Guía de Remisión y Nota de Despacho; la guía firmada corresponde al conductor o proveedor\');\n  END IF;');
  IF body=f.def THEN RAISE EXCEPTION 'No se pudo proteger %',f.proname; END IF;
  EXECUTE body;
 END LOOP;
END $$;
-- Reject assistant file mutations even from stale clients or direct table calls.
CREATE POLICY document_refs_only_insert ON public.dispatch_documents AS RESTRICTIVE FOR INSERT TO authenticated
 WITH CHECK(NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name='Asistente Documentario'));
CREATE POLICY document_refs_only_update ON public.dispatch_documents AS RESTRICTIVE FOR UPDATE TO authenticated
 USING(NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name='Asistente Documentario'))
 WITH CHECK(NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name='Asistente Documentario'));
CREATE POLICY document_refs_only_delete ON public.dispatch_documents AS RESTRICTIVE FOR DELETE TO authenticated
 USING(NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name='Asistente Documentario'));
DO $storage$ DECLARE signature text; source text; changed text; BEGIN
 FOREACH signature IN ARRAY ARRAY['public.can_upload_dispatch_document(uuid)','public.can_upload_packing_list(uuid)'] LOOP
  source:=pg_get_functiondef(to_regprocedure(signature));
  changed:=replace(source,'SELECT auth.uid() IS NOT NULL AND',
   'SELECT auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND r.name=''Asistente Documentario'') AND');
  IF changed=source THEN RAISE EXCEPTION 'Permiso de Storage incompatible: %',signature; END IF;
  EXECUTE changed;
 END LOOP;
END $storage$;
NOTIFY pgrst,'reload schema';
COMMIT;
