-- Documentos a cargo del conductor:
-- 1. El Packing List y la guía de remisión los carga el conductor desde el app o el enlace de entrega.
-- 2. La salida a ruta ya no depende de documentos confirmados por Documentario (se elimina el bloqueo).
-- 3. Las rutas nuevas y las vigentes dejan de exigir documentos de salida (sin avisos ni estado «esperando
--    documentos»); el historial de rutas cerradas no se toca.
BEGIN;

-- 1. Packing List del conductor junto a la guía de la entrega
ALTER TABLE public.delivery_submissions ADD COLUMN IF NOT EXISTS packing_photos text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.delivery_submissions DROP CONSTRAINT IF EXISTS delivery_submissions_packing_max;
ALTER TABLE public.delivery_submissions ADD CONSTRAINT delivery_submissions_packing_max CHECK (cardinality(packing_photos) <= 5);

-- Las fotos del Packing List también quedan protegidas contra borrado o sobrescritura.
CREATE OR REPLACE FUNCTION public.delivery_photo_mutable(p_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.delivery_submissions WHERE photos @> ARRAY[p_name] OR packing_photos @> ARRAY[p_name]);
$$;

-- Adjunta las fotos del Packing List a la versión enviada (misma operación). Idempotente: si ya tiene Packing List
-- no lo reemplaza. Valida que cada foto exista y pertenezca a la carpeta de esa entrega.
CREATE OR REPLACE FUNCTION public.delivery_set_packing(p_dispatch uuid,p_request uuid,p_operation uuid,p_photos text[],p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.delivery_submissions; photo text;
BEGIN
 IF COALESCE(cardinality(p_photos),0)=0 THEN RETURN jsonb_build_object('success',true,'packing',0); END IF;
 IF cardinality(p_photos)>5 THEN RAISE EXCEPTION 'Adjunte hasta cinco fotos del Packing List'; END IF;
 SELECT * INTO s FROM public.delivery_submissions WHERE operation_id=p_operation AND dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Envío de guía no encontrado para el Packing List'; END IF;
 IF cardinality(s.packing_photos)>0 THEN RETURN jsonb_build_object('success',true,'packing',cardinality(s.packing_photos),'duplicate',true); END IF;
 FOREACH photo IN ARRAY p_photos LOOP
  IF photo IS NULL OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence' AND o.name=photo)
   OR (p_source='ENLACE' AND photo NOT LIKE 'tercero/'||p_dispatch::text||'/%')
   OR (p_source='APP' AND (auth.uid() IS NULL OR photo NOT LIKE auth.uid()::text||'/'||p_dispatch::text||'/'||p_request::text||'/%'))
   OR p_source NOT IN ('APP','ENLACE') THEN RAISE EXCEPTION 'Foto de Packing List no válida para esta entrega'; END IF;
 END LOOP;
 UPDATE public.delivery_submissions SET packing_photos=p_photos WHERE id=s.id;
 RETURN jsonb_build_object('success',true,'packing',cardinality(p_photos));
END $$;
REVOKE ALL ON FUNCTION public.delivery_set_packing(uuid,uuid,uuid,text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_set_packing(uuid,uuid,uuid,text[],text) TO service_role;

-- Enlace de entrega (solo rol de servicio desde /api/tercero/[token]): resuelve el despacho por el enlace.
CREATE OR REPLACE FUNCTION public.delivery_public_set_packing(p_token text,p_request uuid,p_operation uuid,p_photos text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_dispatch uuid:=public.tercero_enlace_despacho(p_token);
BEGIN
 IF v_dispatch IS NULL THEN RAISE EXCEPTION 'Entrega no autorizada'; END IF;
 RETURN public.delivery_set_packing(v_dispatch,p_request,p_operation,p_photos,'ENLACE');
END $$;
REVOKE ALL ON FUNCTION public.delivery_public_set_packing(text,uuid,uuid,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_public_set_packing(text,uuid,uuid,text[]) TO service_role;

-- App del conductor: la acción offline de entrega adjunta el Packing List cuando viene en la operación.
DO $patch$ DECLARE definition text; anchor text:='p_operation_id,(p_payload->>''captured_at'')::timestamptz);
  ELSIF p_action_type = ''complete_dispatch_stop'' THEN'; BEGIN
 SELECT pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure) INTO definition;
 IF position('delivery_set_packing' IN definition)>0 THEN RETURN; END IF;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Sin punto de extensión para el Packing List en acciones offline'; END IF;
 EXECUTE replace(definition,anchor,$branch$p_operation_id,(p_payload->>'captured_at')::timestamptz);
    IF COALESCE((v_result->>'success')::boolean,false) AND jsonb_typeof(p_payload->'packing_photos')='array' THEN
      PERFORM public.delivery_set_packing((p_payload->>'dispatch_id')::uuid,(p_payload->>'request_id')::uuid,p_operation_id,
        ARRAY(SELECT jsonb_array_elements_text(p_payload->'packing_photos')),'APP');
    END IF;
  ELSIF p_action_type = 'complete_dispatch_stop' THEN$branch$);
END $patch$;

-- 2. La salida no se bloquea por documentos. Se conserva solo el aviso de reemisión para quien aún los use.
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
  -- Desde que el conductor carga el Packing List y la guía, la salida a ruta no depende de documentos.
  RETURN NEW;
END $$;

-- 3. Rutas nuevas sin exigencia de documentos de salida (programación propia y tercerizada).
DO $patch$ DECLARE signature regprocedure; definition text; changed text; BEGIN
 FOREACH signature IN ARRAY ARRAY['public.schedule_dispatch(uuid,text,timestamptz,numeric,numeric,uuid,text,jsonb)'::regprocedure,
   'public.schedule_dispatch_tercero(uuid,text,text,text,text,timestamptz,numeric,numeric,uuid,jsonb)'::regprocedure] LOOP
  SELECT pg_get_functiondef(signature) INTO definition;
  IF position('docs_required=false' IN definition)>0 THEN CONTINUE; END IF;
  changed:=replace(definition,'UPDATE public.dispatches SET cost_center_id=NULL,','UPDATE public.dispatches SET docs_required=false,docs_reissue=false,cost_center_id=NULL,');
  IF changed=definition THEN RAISE EXCEPTION 'No se pudo quitar la exigencia de documentos en %', signature; END IF;
  EXECUTE changed;
 END LOOP;
END $patch$;

-- Rutas vigentes: dejan de esperar documentos (una por una, sin detener la migración por un registro antiguo).
DO $existing$ DECLARE r record; BEGIN
 FOR r IN SELECT id FROM public.dispatches WHERE docs_required AND status NOT IN ('LIQUIDADO','CERRADO','CANCELADO') LOOP
  BEGIN
   UPDATE public.dispatches SET docs_required=false,docs_reissue=false WHERE id=r.id;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Despacho % conserva su marca de documentos: %', r.id, SQLERRM;
  END;
 END LOOP;
END $existing$;

-- 4. Portal público: el Packing List del conductor se muestra con la guía (recibida o validada) y se entrega con
--    URL firmada (tipo PACKING). Se reescriben sobre la definición vigente.
DO $portal$
DECLARE source text; changed text;
BEGIN
 SELECT pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure) INTO source;
 IF position('packing_photos' IN source)=0 THEN
  changed:=replace(source,'s.guide_number,s.photos,s.submitted_at','s.guide_number,s.photos,s.packing_photos,s.submitted_at');
  changed:=replace(changed,'''signed_photos'',CASE WHEN conformity_state IN (''RECIBIDA'',''VALIDADA'') THEN COALESCE(cardinality(photos),0) ELSE 0 END,',
   '''signed_photos'',CASE WHEN conformity_state IN (''RECIBIDA'',''VALIDADA'') THEN COALESCE(cardinality(photos),0) ELSE 0 END,''packing_photos'',CASE WHEN conformity_state IN (''RECIBIDA'',''VALIDADA'') THEN COALESCE(cardinality(packing_photos),0) ELSE 0 END,');
  IF position('''packing_photos'',CASE' IN changed)=0 OR position('s.packing_photos' IN changed)=0 THEN RAISE EXCEPTION 'No se pudo agregar el Packing List del conductor al portal'; END IF;
  EXECUTE changed;
 END IF;
 SELECT pg_get_functiondef('public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure) INTO source;
 IF position('PACKING''' IN source)=0 THEN
  changed:=replace(source,'ELSIF p_kind=''FIRMA'' THEN','ELSIF p_kind IN (''FIRMA'',''PACKING'') THEN');
  changed:=replace(changed,'SELECT s.photos INTO v_photos','SELECT CASE WHEN p_kind=''PACKING'' THEN s.packing_photos ELSE s.photos END INTO v_photos');
  changed:=replace(changed,'''name'',''Guía firmada ''||p_index','''name'',CASE WHEN p_kind=''PACKING'' THEN ''Packing List '' ELSE ''Guía de remisión '' END||p_index');
  IF position('s.packing_photos ELSE s.photos' IN changed)=0 OR position('IN (''FIRMA'',''PACKING'')' IN changed)=0 THEN RAISE EXCEPTION 'No se pudo habilitar el Packing List en los documentos del portal'; END IF;
  EXECUTE changed;
 END IF;
END $portal$;
COMMIT;
