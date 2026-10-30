-- Modal de Documentos de Despacho: categoría de archivo (sin tocar doc_type, que define las reglas de liquidación y la
-- guía única) y una consulta de contexto con lo que la bandeja no trae (retorno, quién subió cada archivo y su tamaño).
-- La información económica se sigue leyendo de economic_closure_detail: una sola fuente.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.dispatch_documents ADD COLUMN IF NOT EXISTS category text;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_documents_category_check') THEN
  ALTER TABLE public.dispatch_documents ADD CONSTRAINT dispatch_documents_category_check
   CHECK (category IS NULL OR category IN ('CONFORMIDAD','EVIDENCIA','COMPROBANTE','OTROS')) NOT VALID;
 END IF;
END $c$;

-- Categoría de un archivo «Otro documento» (guías, notas y Packing List ya se identifican por su tipo)
CREATE OR REPLACE FUNCTION public.set_dispatch_document_category(p_document_id uuid, p_category text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_cat text := NULLIF(upper(btrim(COALESCE(p_category,''))),'');
BEGIN
 IF NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('packing-list')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para clasificar documentos');
 END IF;
 SELECT x.id, x.doc_type, x.voided_at, s.site_id INTO d FROM public.dispatch_documents x JOIN public.dispatches s ON s.id = x.dispatch_id
 WHERE x.id = p_document_id FOR UPDATE OF x;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Documento inexistente'); END IF;
 IF d.voided_at IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El documento está anulado'); END IF;
 IF d.doc_type <> 'OTRO' THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se clasifican los archivos de tipo «Otro documento»'); END IF;
 IF v_cat IS NOT NULL AND v_cat NOT IN ('CONFORMIDAD','EVIDENCIA','COMPROBANTE','OTROS') THEN RETURN jsonb_build_object('success', false, 'error', 'Categoría inválida'); END IF;
 UPDATE public.dispatch_documents SET category = v_cat WHERE id = p_document_id;
 RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.set_dispatch_document_category(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_dispatch_document_category(uuid,text) TO authenticated;

-- Contexto del modal: retorno, estado operativo y archivos vigentes con categoría, tamaño y nombre de quien los subió
CREATE OR REPLACE FUNCTION public.dispatch_documents_modal_context(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record;
BEGIN
 IF NOT (public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('packing-list') OR public.has_tms_read_permission('planificacion')
   OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los documentos del despacho');
 END IF;
 SELECT x.id, x.status, x.site_id, x.scheduled_departure, to_jsonb(x)->>'returned_at' AS returned_at INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 RETURN jsonb_build_object('success', true, 'status', d.status, 'returned_at', d.returned_at,
  'documents', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'category', x.category, 'size_bytes', x.size_bytes,
     'uploaded_by_name', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
       FROM public.profiles pr WHERE pr.id = x.uploaded_by)))
   FROM public.dispatch_documents x WHERE x.dispatch_id = p_dispatch_id AND x.voided_at IS NULL), '[]'::jsonb),
  'voided', (SELECT count(*) FROM public.dispatch_documents x WHERE x.dispatch_id = p_dispatch_id AND x.voided_at IS NOT NULL));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_documents_modal_context(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dispatch_documents_modal_context(uuid) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
