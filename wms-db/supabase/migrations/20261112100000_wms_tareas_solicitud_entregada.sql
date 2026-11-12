-- Tareas de picking de solicitudes ya ENTREGADAS o EN TRÁNSITO en el TMS quedaban pendientes o «En picking» y el escaneo
-- se rechazaba. Si no tienen nada recogido, se cierran (CANCELLED) con el motivo; si ya tienen paquetes, no se tocan.
CREATE OR REPLACE FUNCTION public.wh_sync_transport_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_site uuid; v_state text; v_id uuid; v_done boolean := false;
BEGIN
 IF upper(coalesce(NEW.request_type,'DESPACHO')) IN ('RECOJO','TRASLADO') THEN RETURN NEW; END IF;
 v_state:=public.wh_task_status_for_request(NEW.status);
 v_site:=NEW.site_id;
 INSERT INTO public.wh_tasks(task_code,transport_request_id,site_id,contract_id,created_by,request_status,dispatch_id)
  SELECT 'WH-'||NEW.request_number,NEW.id,v_site,NEW.contract_id,auth.uid(),NEW.status,
   (SELECT dr.dispatch_id FROM public.dispatch_requests dr WHERE dr.transport_request_id=NEW.id ORDER BY dr.created_at DESC LIMIT 1)
 ON CONFLICT(transport_request_id) DO NOTHING;
 SELECT id INTO v_id FROM public.wh_tasks WHERE transport_request_id=NEW.id;
 IF v_id IS NOT NULL THEN
  -- Ya despachada o entregada en el TMS y sin nada recogido en el WMS: la tarea ya no se puede trabajar y se cierra.
  v_done := upper(coalesce(NEW.status,'')) IN ('ENTREGADA','EN TRANSITO','EN TRÁNSITO')
    AND EXISTS (SELECT 1 FROM public.wh_tasks WHERE id=v_id AND status IN ('PENDING','PICKING','PAUSED'))
    AND NOT EXISTS (SELECT 1 FROM public.wh_packages WHERE task_id=v_id AND status<>'VOID');
  UPDATE public.wh_tasks SET request_status=NEW.status,updated_by=auth.uid(),
   status=CASE WHEN status IN ('LOADED','RECONCILED') THEN status WHEN v_done THEN 'CANCELLED' WHEN v_state='PAUSED' THEN 'PAUSED' WHEN v_state='CANCELLED' THEN 'CANCELLED' WHEN v_state='PENDING' AND status='PAUSED' THEN 'PENDING' ELSE status END,
   paused_reason=CASE WHEN v_state='PAUSED' THEN 'Solicitud observada' WHEN v_state='PENDING' THEN NULL ELSE paused_reason END,
   cancelled_reason=CASE WHEN v_done THEN 'Solicitud ya despachada o entregada en el TMS sin pasar por el WMS' WHEN v_state='CANCELLED' THEN 'Solicitud cancelada o rechazada' ELSE cancelled_reason END
  WHERE id=v_id AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status);
 END IF;
 IF v_state='CANCELLED' THEN
  UPDATE public.wh_packages SET status='AVAILABLE',task_id=NULL,lpn_id=NULL
   WHERE task_id IN (SELECT id FROM public.wh_tasks WHERE transport_request_id=NEW.id) AND status NOT IN ('VOID','LOADED');
  UPDATE public.wh_lpns SET status='VOID',void_reason='Solicitud de transporte cancelada o rechazada'
   WHERE task_id IN (SELECT id FROM public.wh_tasks WHERE transport_request_id=NEW.id) AND status IN ('OPEN','CLOSED');
  INSERT INTO public.wh_scan_events(site_id,task_id,event_type,scanned_code,payload,operator_id,client_event_id)
   SELECT site_id,id,'REQUEST_CANCELLED',task_code,jsonb_build_object('request_status',NEW.status),auth.uid(),gen_random_uuid() FROM public.wh_tasks WHERE id=v_id;
 END IF;
 RETURN NEW;
END $function$;

UPDATE public.wh_tasks t SET status='CANCELLED', cancelled_reason='Solicitud ya despachada o entregada en el TMS sin pasar por el WMS'
WHERE upper(coalesce(t.request_status,'')) IN ('ENTREGADA','EN TRANSITO','EN TRÁNSITO') AND t.status IN ('PENDING','PICKING','PAUSED')
  AND NOT EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.task_id=t.id AND p.status<>'VOID');
