-- Portal público de seguimiento (enlace permanente):
-- 1. Una OT autorizada incluye su familia: subcontratos y errores (también los que se creen después).
-- 2. El calendario recibe el tipo de OT (contrato / subcontrato / error), la OT madre y las referencias OS, OC y RQ.
-- 3. La ruta del día lleva las guías de remisión y el Packing List de cada parada; los archivos se entregan con
--    get_public_tracking_document (solo rol de servicio, desde /api/tracking/documento con URL firmada).
-- 4. El GPS se comparte también con accesos por OT cuando todas las paradas de la ruta están autorizadas.
BEGIN;

-- OT autorizadas + descendientes (subcontratos y errores). NULL = toda la sede.
CREATE OR REPLACE FUNCTION public.tracking_portal_contract_family(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH RECURSIVE fam(id) AS (
  SELECT c.id FROM public.contracts c WHERE c.id = ANY(p_ids)
  UNION SELECT c.id FROM public.contracts c JOIN fam f ON c.parent_contract_id = f.id)
 SELECT CASE WHEN COALESCE(cardinality(p_ids),0) = 0 THEN NULL ELSE COALESCE((SELECT array_agg(id) FROM fam),'{}'::uuid[]) END;
$$;
REVOKE ALL ON FUNCTION public.tracking_portal_contract_family(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracking_portal_contract_family(uuid[]) TO service_role;

-- Opciones del creador de accesos: tipo de OT y OT madre para mostrar la jerarquía.
CREATE OR REPLACE FUNCTION public.get_tracking_portal_scope_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 RETURN jsonb_build_object('sites',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'name',COALESCE(to_jsonb(s)->>'name',to_jsonb(s)->>'code',s.id::text))),'[]') FROM public.sites s WHERE public.can_access_site(s.id)),
 'contracts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'site_id',c.site_id,'type',to_jsonb(c)->>'type','parent_id',c.parent_contract_id) ORDER BY c.code),'[]') FROM public.contracts c WHERE public.can_access_site(c.site_id)));
END $$;
REVOKE ALL ON FUNCTION public.get_tracking_portal_scope_options() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_portal_scope_options() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_public_tracking_portal_info(p_token uuid,p_pin text,p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.tracking_portal_links; payload jsonb; requests jsonb; rows jsonb:='[]'; points jsonb; route_ids uuid[]; route_limited boolean:=false; row_limited boolean:=false; request_limited boolean:=false; range_start timestamptz; range_end timestamptz;
 v_all boolean; v_ids uuid[];
BEGIN
 -- Legacy credentials retain their original date and expiry; no client-side fallback.
 SELECT * INTO link FROM public.tracking_portal_links WHERE token=p_token FOR UPDATE;
 IF NOT FOUND THEN
  payload:=public.get_public_daily_tracking_info(p_token,p_pin);
  RETURN payload||jsonb_build_object('mode','legacy','requests','[]'::jsonb,'locations',public.get_public_daily_tracking_locations(p_token,p_pin));
 END IF;
 IF link.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','Acceso revocado'); END IF;
 IF link.attempt_window<now()-interval '15 minutes' THEN
  UPDATE public.tracking_portal_links SET attempt_window=now(),attempts=0 WHERE token=p_token; link.attempts:=0;
 END IF;
 IF link.attempts>=30 THEN RETURN jsonb_build_object('error','Demasiados intentos. Inténtalo en 15 minutos.'); END IF;
 IF p_pin IS NULL OR length(p_pin)<>8 OR extensions.crypt(p_pin,link.pin_hash)<>link.pin_hash THEN
  UPDATE public.tracking_portal_links SET attempts=attempts+1 WHERE token=p_token;
  RETURN jsonb_build_object('error','Código de acceso incorrecto');
 END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>41 THEN RAISE EXCEPTION 'Selecciona un período de hasta 42 días'; END IF;
 v_all:=cardinality(link.contract_ids)=0;
 v_ids:=COALESCE(public.tracking_portal_contract_family(link.contract_ids),'{}');
 range_start:=p_from::timestamp AT TIME ZONE 'America/Lima';range_end:=(p_to+1)::timestamp AT TIME ZONE 'America/Lima';
 SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC,x->>'id'),'[]') INTO requests FROM (
 SELECT jsonb_build_object('id',t.id,'request_number',t.request_number,'ot_code',c.code,
 'ot_type',to_jsonb(c)->>'type','parent_ot',pc.code,'client_name',cl.business_name,
 'reference_type',to_jsonb(t)->>'reference_type','reference_number',to_jsonb(t)->>'reference_number','purchase_order',to_jsonb(t)->>'purchase_order',
 'created_at',t.created_at,'required_date',t.required_date,'required_at',to_jsonb(t)->>'required_at',
 'request_type',t.request_type,'attention_mode',to_jsonb(t)->>'attention_mode',
 'delivery_zone',to_jsonb(t)->>'delivery_zone','lead_time_policy',to_jsonb(t)->'lead_time_policy',
 'pickup_address',t.pickup_address,'delivery_address',t.delivery_address,'status',t.status) x
 FROM public.transport_requests t LEFT JOIN public.contracts c ON c.id=t.contract_id
 LEFT JOIN public.contracts pc ON pc.id=c.parent_contract_id LEFT JOIN public.clients cl ON cl.id=c.client_id
 WHERE t.site_id=link.site_id AND (v_all OR t.contract_id=ANY(v_ids))
 AND ((t.required_date >= (p_from::timestamp AT TIME ZONE 'UTC') AND t.required_date < ((p_to+1)::timestamp AT TIME ZONE 'UTC'))
 OR (t.created_at>=range_start AND t.created_at<range_end)
 OR EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.dispatches dp ON dp.id=dr.dispatch_id
 WHERE dr.transport_request_id=t.id AND dp.site_id=link.site_id AND dp.scheduled_departure>=range_start AND dp.scheduled_departure<range_end))
 ORDER BY t.created_at DESC,t.id LIMIT 1001) limited;
 request_limited:=jsonb_array_length(requests)>1000;
 IF request_limited THEN SELECT jsonb_agg(value ORDER BY ordinality) INTO requests FROM jsonb_array_elements(requests) WITH ORDINALITY WHERE ordinality<=1000; END IF;
 SELECT COALESCE(array_agg(id ORDER BY scheduled_departure DESC,id),'{}'),count(*)>500 INTO route_ids,route_limited FROM (
 SELECT dp.id,dp.scheduled_departure FROM public.dispatches dp
 WHERE dp.site_id=link.site_id AND dp.scheduled_departure>=range_start AND dp.scheduled_departure<range_end
 AND EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
 WHERE dr.dispatch_id=dp.id AND t.site_id=link.site_id AND (v_all OR t.contract_id=ANY(v_ids)))
 ORDER BY dp.scheduled_departure DESC,dp.id LIMIT 501) bounded_routes;
 route_ids:=route_ids[1:500];
 -- Project only authorized stops, once. Event history is fetched once per route,
 -- not once for each stop or through a repeated security-definer helper call.
 -- full_scope: every stop of the route is authorized (route-level documents and GPS may be shared).
 WITH routes AS MATERIALIZED (
 SELECT d.*,ev.last_type,ev.last_at,COALESCE(ev.events,'[]'::jsonb) AS public_events,
 (v_all OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests dx JOIN public.transport_requests tx ON tx.id=dx.transport_request_id
  WHERE dx.dispatch_id=d.id AND (tx.site_id<>link.site_id OR tx.contract_id IS NULL OR NOT tx.contract_id=ANY(v_ids)))) AS full_scope
 FROM public.dispatches d
 LEFT JOIN LATERAL (SELECT (array_agg(e.event_type ORDER BY e.created_at DESC,e.id DESC))[1] AS last_type,
 max(e.created_at) AS last_at,jsonb_agg(jsonb_build_object('type',e.event_type,'description',NULL,'at',e.created_at) ORDER BY e.created_at DESC,e.id DESC) AS events
 FROM (SELECT id,event_type,created_at FROM public.dispatch_events WHERE dispatch_id=d.id ORDER BY created_at DESC,id DESC LIMIT 30)e) ev ON true
 WHERE d.id=ANY(route_ids)), stops AS MATERIALIZED (
 SELECT d.*,t.id AS request_id,t.request_number,t.pickup_address,t.delivery_address,dr.sequence_order,dr.document_number,
 dr.status AS stop_status,ct.code AS ot_code,to_jsonb(ct)->>'type' AS ot_type,cl.business_name AS client_name,ca.business_name AS carrier_name,
 to_jsonb(t)->>'reference_type' AS ref_type,to_jsonb(t)->>'reference_number' AS ref_number,to_jsonb(t)->>'purchase_order' AS po,
 c.state AS conformity_state,c.current_submission_id,c.arrived_at,c.updated_at AS conformity_updated,
 s.guide_number,s.photos,s.submitted_at,
 NOT (d.driver_id IS NULL AND d.vehicle_plate='EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA')<>'TERCERO' AND to_jsonb(dr)->>'document_type'='NOTA_SALIDA') AS needs_guide
 FROM routes d JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id JOIN public.transport_requests t ON t.id=dr.transport_request_id
 LEFT JOIN public.contracts ct ON ct.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=ct.client_id
 LEFT JOIN public.carriers ca ON ca.id=NULLIF(to_jsonb(d)->>'carrier_id','')::uuid
 LEFT JOIN public.delivery_conformities c ON c.dispatch_id=d.id AND c.request_id=t.id
 LEFT JOIN public.delivery_submissions s ON s.id=c.current_submission_id
 WHERE t.site_id=link.site_id AND (v_all OR t.contract_id=ANY(v_ids))
 ORDER BY d.scheduled_departure DESC,d.id,dr.sequence_order,t.id LIMIT 2001)
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
 'dispatch_status',status,'dispatch_id',id,'request_id',request_id,'dispatch_number',dispatch_number,'request_number',request_number,
 'ot_code',COALESCE(ot_code::text,'Sin OT vinculada'),'ot_type',ot_type,'reference_type',ref_type,'reference_number',ref_number,'purchase_order',po,
 'sequence_order',sequence_order,'client_name',client_name,'pickup_address',pickup_address,'delivery_address',delivery_address,
 'plate',vehicle_plate,'driver_name',COALESCE(NULLIF(driver_name,''),to_jsonb(stops)->>'tercero_conductor'),'carrier_name',carrier_name,
 'modalidad',CASE WHEN NOT needs_guide THEN 'RECOJO_CLIENTE' ELSE to_jsonb(stops)->>'modalidad' END,'scheduled_departure',scheduled_departure,
 'guide_number',COALESCE(guide_number,document_number),
 'documents_state',CASE WHEN NOT COALESCE((to_jsonb(stops)->>'docs_required')::boolean,false) THEN 'NO_REQUERIDO' WHEN COALESCE((to_jsonb(stops)->>'docs_reissue')::boolean,false) THEN 'REEMISION' WHEN to_jsonb(stops)->>'docs_ready_at' IS NOT NULL THEN 'LISTO' ELSE 'PENDIENTE' END,
 'documents',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',x.id,'type',x.doc_type,'number',x.document_number,'name',x.file_name) ORDER BY x.doc_type,x.uploaded_at),'[]'::jsonb)
   FROM public.dispatch_documents x WHERE x.dispatch_id=stops.id AND x.voided_at IS NULL AND x.doc_type IN ('GUIA_REMISION','PACKING_LIST')
   AND (x.transport_request_id=stops.request_id OR (x.transport_request_id IS NULL AND stops.full_scope))),
 'signed_photos',CASE WHEN conformity_state='VALIDADA' THEN COALESCE(cardinality(photos),0) ELSE 0 END,
 'conformity',CASE WHEN NOT needs_guide THEN 'NO_APLICA' ELSE COALESCE(conformity_state,CASE WHEN status IN ('LIQUIDADO','CERRADO') THEN 'HISTORICA' ELSE 'PENDIENTE' END) END,
 'submission_id',NULL,'photos_count',COALESCE(cardinality(photos),0),'submitted_at',submitted_at,'arrived_at',arrived_at,
 'state',CASE WHEN status IN ('LIQUIDADO','CERRADO','CANCELADO') THEN status WHEN NOT needs_guide AND stop_status<>'ENTREGADO' THEN 'RECOJO_CLIENTE'
 WHEN conformity_state='RECIBIDA' THEN 'PENDIENTE_VALIDACION' WHEN conformity_state IN ('OBSERVADA','RECHAZADA') THEN conformity_state
 WHEN conformity_state='VALIDADA' OR stop_status='ENTREGADO' THEN 'ENTREGADO' WHEN last_type IN ('INCIDENCIA','RETRASO','DESVIO') THEN 'INCIDENCIA'
 WHEN arrived_at IS NOT NULL THEN 'EN_DESTINO' ELSE status END,
 'last_event_at',COALESCE(conformity_updated,last_at,scheduled_departure),'gps_at',to_jsonb(stops)->>'last_gps_at','events',public_events)
 ORDER BY scheduled_departure DESC,id,sequence_order,request_id),'[]'),count(*)>2000 INTO rows,row_limited FROM stops;
 IF row_limited THEN SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=2000; END IF;
 -- A mixed route's live position discloses other stops: GPS only when every stop of the route is authorized.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('dispatch_id',dp.id,'dispatch_number',dp.dispatch_number,'vehicle_plate',dp.vehicle_plate,'driver_name',dp.driver_name,
 'lat',dp.last_lat,'lng',dp.last_lon,'last_gps_at',dp.last_gps_at)),'[]') INTO points FROM public.dispatches dp
 WHERE dp.site_id=link.site_id AND dp.id=ANY(route_ids)
 AND (v_all OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests dx JOIN public.transport_requests tx ON tx.id=dx.transport_request_id
  WHERE dx.dispatch_id=dp.id AND (tx.site_id<>link.site_id OR tx.contract_id IS NULL OR NOT tx.contract_id=ANY(v_ids))))
 AND dp.last_gps_at>now()-interval '15 minutes' AND dp.last_lat IS NOT NULL AND dp.last_lon IS NOT NULL;
 RETURN jsonb_build_object('mode','permanent','rows',rows,'requests',requests,'locations',points,'limited',request_limited OR route_limited OR row_limited);
END $$;
REVOKE ALL ON FUNCTION public.get_public_tracking_portal_info(uuid,text,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_tracking_portal_info(uuid,text,date,date) TO anon,authenticated;

-- Archivo autorizado para el portal: guía / Packing List (p_kind DOC, p_id = documento) o foto de la guía firmada
-- validada (p_kind FIRMA, p_id = despacho, p_request = solicitud, p_index = foto). Solo rol de servicio: la ruta
-- /api/tracking/documento valida el formato y devuelve una URL firmada de corta duración.
CREATE OR REPLACE FUNCTION public.get_public_tracking_document(p_token uuid,p_pin text,p_kind text,p_id uuid,p_request uuid DEFAULT NULL,p_index integer DEFAULT 1) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.tracking_portal_links; v_all boolean; v_ids uuid[]; doc record; v_photos text[];
BEGIN
 SELECT * INTO link FROM public.tracking_portal_links WHERE token=p_token FOR UPDATE;
 IF NOT FOUND OR link.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','Acceso no válido'); END IF;
 IF link.attempt_window<now()-interval '15 minutes' THEN
  UPDATE public.tracking_portal_links SET attempt_window=now(),attempts=0 WHERE token=p_token; link.attempts:=0;
 END IF;
 IF link.attempts>=30 THEN RETURN jsonb_build_object('error','Demasiados intentos. Inténtalo en 15 minutos.'); END IF;
 IF p_pin IS NULL OR length(p_pin)<>8 OR extensions.crypt(p_pin,link.pin_hash)<>link.pin_hash THEN
  UPDATE public.tracking_portal_links SET attempts=attempts+1 WHERE token=p_token;
  RETURN jsonb_build_object('error','Código de acceso incorrecto');
 END IF;
 v_all:=cardinality(link.contract_ids)=0;
 v_ids:=COALESCE(public.tracking_portal_contract_family(link.contract_ids),'{}');
 IF p_kind='DOC' THEN
  SELECT x.file_path,x.file_name,x.doc_type INTO doc FROM public.dispatch_documents x JOIN public.dispatches dp ON dp.id=x.dispatch_id
  WHERE x.id=p_id AND x.voided_at IS NULL AND x.doc_type IN ('GUIA_REMISION','PACKING_LIST') AND dp.site_id=link.site_id
  AND EXISTS(SELECT 1 FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id=dr.transport_request_id
   WHERE dr.dispatch_id=x.dispatch_id AND t.site_id=link.site_id AND (v_all OR t.contract_id=ANY(v_ids))
   AND (x.transport_request_id IS NULL OR x.transport_request_id=t.id))
  AND (x.transport_request_id IS NOT NULL OR v_all OR NOT EXISTS(SELECT 1 FROM public.dispatch_requests dx JOIN public.transport_requests tx ON tx.id=dx.transport_request_id
   WHERE dx.dispatch_id=x.dispatch_id AND (tx.site_id<>link.site_id OR tx.contract_id IS NULL OR NOT tx.contract_id=ANY(v_ids))));
  IF NOT FOUND THEN RETURN jsonb_build_object('error','Documento no disponible'); END IF;
  RETURN jsonb_build_object('bucket','dispatch_documents','path',doc.file_path,'name',COALESCE(doc.file_name,doc.doc_type));
 ELSIF p_kind='FIRMA' THEN
  SELECT s.photos INTO v_photos FROM public.delivery_conformities c JOIN public.delivery_submissions s ON s.id=c.current_submission_id
  JOIN public.transport_requests t ON t.id=c.request_id JOIN public.dispatches dp ON dp.id=c.dispatch_id
  WHERE c.dispatch_id=p_id AND c.request_id=p_request AND c.state='VALIDADA' AND dp.site_id=link.site_id
  AND t.site_id=link.site_id AND (v_all OR t.contract_id=ANY(v_ids));
  IF v_photos IS NULL OR p_index IS NULL OR p_index<1 OR p_index>cardinality(v_photos) THEN RETURN jsonb_build_object('error','Guía firmada no disponible'); END IF;
  RETURN jsonb_build_object('bucket','driver_evidence','path',v_photos[p_index],'name','Guía firmada '||p_index);
 END IF;
 RETURN jsonb_build_object('error','Solicitud no válida');
END $$;
REVOKE ALL ON FUNCTION public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer) TO service_role;
-- pgcrypto puede estar en otro esquema (ver 20261009020000): calificar sus funciones igual que allí.
DO $crypto_schema$
DECLARE crypto_schema text; signature regprocedure; source text;
BEGIN
 SELECT n.nspname INTO crypto_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
 IF crypto_schema IS NULL THEN RAISE EXCEPTION 'Se requiere pgcrypto para proteger los códigos de acceso'; END IF;
 IF crypto_schema <> 'extensions' THEN
  FOREACH signature IN ARRAY ARRAY['public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure,
    'public.get_public_tracking_document(uuid,text,text,uuid,uuid,integer)'::regprocedure] LOOP
   SELECT pg_get_functiondef(signature) INTO source;
   source:=replace(source,'extensions.crypt(',format('%I.crypt(',crypto_schema));
   source:=replace(source,'extensions.gen_salt(',format('%I.gen_salt(',crypto_schema));
   EXECUTE source;
  END LOOP;
 END IF;
END $crypto_schema$;
COMMIT;
