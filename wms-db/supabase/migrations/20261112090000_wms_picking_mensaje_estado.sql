-- El picking rechazaba solicitudes ya ENTREGADAS con «aún no está aprobada», lo que confundía. Se informa el estado real.
-- Misma regla (solo APROBADA/APROBADO/ASIGNADA); solo cambia el texto.
CREATE OR REPLACE FUNCTION public.wh_record_scan_core(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.wh_tasks%ROWTYPE; p public.wh_packages%ROWTYPE; l public.wh_lpns%ROWTYPE; v_perm text; v_line public.wh_task_lines%ROWTYPE; v_count integer;
BEGIN
 PERFORM public.security_assert_active_session();
 SELECT * INTO t FROM public.wh_tasks WHERE id=p_task_id;
 IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
 v_perm:=CASE upper(p_event) WHEN 'PICK' THEN 'almacen-picking' WHEN 'PACK' THEN 'almacen-packing' WHEN 'LOAD' THEN 'almacen-carga' ELSE 'almacen-supervisor' END;
 IF NOT public.wh_has_permission(ARRAY[v_perm,'almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE='42501'; END IF;
 IF nullif(trim(p_code),'') IS NULL OR p_client_event_id IS NULL THEN RAISE EXCEPTION 'Lea un código válido; se requiere identificador de operación'; END IF;
 IF upper(p_event)='PICK' AND t.request_status NOT IN ('APROBADA','APROBADO','ASIGNADA') THEN RAISE EXCEPTION 'La solicitud está % en el TMS: solo se hace picking de solicitudes aprobadas o asignadas', coalesce(nullif(t.request_status,''),'sin estado'); END IF;
 IF upper(p_event)='LOAD' AND t.dispatch_id IS NULL THEN RAISE EXCEPTION 'Programe la solicitud en un despacho antes de confirmar carga'; END IF;
 IF upper(p_event)='LOAD' AND NOT EXISTS(SELECT 1 FROM public.wh_packing_lists WHERE task_id=t.id AND status='LIBERADO') THEN RAISE EXCEPTION 'No se puede cargar: el Packing List no está liberado por auditoría'; END IF;
 IF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id AND scanned_code=trim(p_code)
   AND event_type IN (upper(p_event),CASE WHEN upper(p_event)='LOAD' THEN 'LOAD_LPN' ELSE upper(p_event) END) AND task_id=t.id) THEN
  RETURN jsonb_build_object('success',true,'duplicate_retry',true,'code',trim(p_code),'event',upper(p_event));
 ELSIF EXISTS(SELECT 1 FROM public.wh_scan_events WHERE site_id=t.site_id AND client_event_id=p_client_event_id) THEN RAISE EXCEPTION 'El identificador de lectura ya se usó para otra operación'; END IF;
 IF upper(p_event)='LOAD' THEN
  SELECT * INTO l FROM public.wh_lpns WHERE lpn_code=trim(p_code) FOR UPDATE;
  IF FOUND THEN
   IF l.task_id IS DISTINCT FROM t.id OR l.site_id<>t.site_id OR l.status<>'CLOSED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'LPN no está cerrado para esta tarea'; END IF;
   SELECT count(*)::integer INTO v_count FROM public.wh_packages WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED';
   IF v_count=0 THEN RAISE EXCEPTION 'El LPN no contiene paquetes listos para cargar'; END IF;
   WITH moved AS (
    UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id
     WHERE lpn_id=l.id AND task_id=t.id AND status='PACKED' RETURNING task_line_id,quantity
   ), totals AS (
    SELECT task_line_id,sum(quantity) AS qty FROM moved WHERE task_line_id IS NOT NULL GROUP BY task_line_id
   )
   UPDATE public.wh_task_lines tl SET loaded_qty=loaded_qty+x.qty FROM totals x WHERE tl.id=x.task_line_id;
   UPDATE public.wh_lpns SET status='LOADED' WHERE id=l.id;
   INSERT INTO public.wh_scan_events(site_id,task_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
    VALUES(t.site_id,t.id,l.id,'LOAD_LPN',l.lpn_code,jsonb_build_object('package_count',v_count),auth.uid(),p_client_event_id);
   RETURN jsonb_build_object('success',true,'lpn',l.lpn_code,'packages_loaded',v_count);
  END IF;
 END IF;
 SELECT * INTO p FROM public.wh_packages WHERE package_code=trim(p_code) AND site_id=t.site_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Código no pertenece a este almacén'; END IF;
 IF upper(p_event)='PICK' THEN
   IF p.status NOT IN ('AVAILABLE','RESERVED') OR t.status NOT IN ('PENDING','PICKING') THEN RAISE EXCEPTION 'Paquete no disponible para picking'; END IF;
   IF p.contract_id IS NULL AND nullif(trim(p.source_contract_code),'') IS NULL THEN RAISE EXCEPTION 'El paquete no tiene OT registrada; no se puede validar contra la solicitud'; END IF;
   IF p.contract_id IS NOT NULL AND p.contract_id<>t.contract_id AND NOT EXISTS(SELECT 1 FROM public.transport_request_components c WHERE c.request_id=t.transport_request_id AND c.component_contract_id=p.contract_id) THEN
    RAISE EXCEPTION 'El paquete pertenece a otra OT o contrato que no está incluido en la solicitud';
   END IF;
   IF nullif(trim(p.source_contract_code),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=t.contract_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) AND NOT EXISTS(SELECT 1 FROM public.transport_request_components rc JOIN public.contracts c ON c.id=rc.component_contract_id WHERE rc.request_id=t.transport_request_id AND regexp_replace(regexp_replace(upper(c.code::text),'[^A-Z0-9]','','g'),'^OT','')=regexp_replace(regexp_replace(upper(p.source_contract_code),'[^A-Z0-9]','','g'),'^OT','')) THEN
    RAISE EXCEPTION 'La OT/contrato del ingreso APT no está incluida en la solicitud';
   END IF;
   SELECT * INTO v_line FROM public.wh_task_lines WHERE task_id=t.id AND upper(coalesce(product_code,''))=upper(p.source_product_code)
    AND (contract_id IS NULL OR contract_id=t.contract_id OR p.contract_id IS NULL OR contract_id=p.contract_id) ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF FOUND THEN
     IF v_line.requested_qty IS NOT NULL AND v_line.picked_qty+p.quantity>v_line.requested_qty THEN RAISE EXCEPTION 'La cantidad recogida superaría lo solicitado'; END IF;
     UPDATE public.wh_task_lines SET picked_qty=picked_qty+p.quantity WHERE id=v_line.id;
   ELSE
     v_count:=(SELECT count(*) FROM public.wh_task_lines WHERE task_id=t.id AND source='REQUEST');
     IF v_count>0 AND NOT (public.wh_has_permission(ARRAY['almacen-supervisor']) AND coalesce((p_payload->>'confirmed_unrequested_stock')::boolean,false)) THEN
      RAISE EXCEPTION 'El producto no está en el detalle de solicitud. La supervisión debe confirmar el material alternativo antes de recogerlo';
     END IF;
     INSERT INTO public.wh_task_lines(task_id,contract_id,product_code,description,requested_qty,picked_qty,unit,weight_kg,source)
     VALUES(t.id,p.contract_id,p.source_product_code,p.description,NULL,p.quantity,p.unit,p.weight_kg,CASE WHEN v_count>0 THEN 'SUPERVISOR_CONFIRMED_STOCK' ELSE 'OT_VALIDATED' END) RETURNING id INTO v_line.id;
   END IF;
   IF p.task_id IS NOT NULL AND p.task_id<>t.id THEN RAISE EXCEPTION 'Paquete ya reservado para otra tarea'; END IF;
   UPDATE public.wh_packages SET status='PICKED',task_id=t.id,task_line_id=v_line.id WHERE id=p.id;
   UPDATE public.wh_tasks SET status='PICKING',assigned_picker=coalesce(assigned_picker,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PENDING';
 ELSIF upper(p_event)='PACK' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PICKED' OR t.status NOT IN ('PICKING','PACKING') THEN RAISE EXCEPTION 'Paquete no corresponde a tarea o no está recogido'; END IF;
   UPDATE public.wh_packages SET status='PACKED' WHERE id=p.id;
   UPDATE public.wh_task_lines SET packed_qty=packed_qty+p.quantity WHERE id=p.task_line_id;
   SELECT * INTO l FROM public.wh_lpns WHERE task_id=t.id AND status='OPEN' ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
   IF FOUND THEN
    UPDATE public.wh_packages SET lpn_id=l.id WHERE id=p.id;
    UPDATE public.wh_lpns SET package_count=package_count+1,quantity=quantity+p.quantity,weight_kg=weight_kg+coalesce(p.weight_kg,0) WHERE id=l.id;
   END IF;
   UPDATE public.wh_tasks SET status='PACKING',assigned_packer=coalesce(assigned_packer,auth.uid()),updated_by=auth.uid() WHERE id=t.id AND status='PICKING';
 ELSIF upper(p_event)='LOAD' THEN
   IF p.task_id IS DISTINCT FROM t.id OR p.status<>'PACKED' OR t.status<>'READY_FOR_LOAD' THEN RAISE EXCEPTION 'Paquete no está listo para cargar'; END IF;
   UPDATE public.wh_packages SET status='LOADED',dispatch_id=t.dispatch_id WHERE id=p.id;
   UPDATE public.wh_task_lines SET loaded_qty=loaded_qty+p.quantity WHERE id=p.task_line_id;
 ELSE RAISE EXCEPTION 'Tipo de lectura no reconocido'; END IF;
 INSERT INTO public.wh_scan_events(site_id,task_id,package_id,lpn_id,event_type,scanned_code,payload,operator_id,client_event_id)
 VALUES(t.site_id,t.id,p.id,CASE WHEN upper(p_event)='PACK' AND l.id IS NOT NULL THEN l.id ELSE NULL END,upper(p_event),trim(p_code),coalesce(p_payload,'{}'),auth.uid(),p_client_event_id)
 ON CONFLICT(site_id,client_event_id) DO NOTHING;
 RETURN jsonb_build_object('success',true,'package',p.package_code,'event',upper(p_event));
END $function$;
