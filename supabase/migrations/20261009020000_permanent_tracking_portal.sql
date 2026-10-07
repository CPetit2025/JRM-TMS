BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE public.tracking_portal_links (
 token uuid PRIMARY KEY DEFAULT gen_random_uuid(), site_id uuid NOT NULL REFERENCES public.sites(id),
 contract_ids uuid[] NOT NULL DEFAULT '{}', pin_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES public.profiles(id), created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, rotated_at timestamptz,
 attempt_window timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX tracking_portal_site ON public.tracking_portal_links(site_id,created_at);
-- Avoid duplicating production indexes that already have these leading keys.
DO $indexes$
DECLARE item record; v_leading smallint[];
BEGIN
 FOR item IN SELECT * FROM (VALUES ('dispatches','scheduled_departure','tracking_portal_dispatch_site_time'),
 ('transport_requests','required_date','tracking_portal_request_site_required'),
 ('transport_requests','created_at','tracking_portal_request_site_created')) x(table_name,time_column,index_name) LOOP
 SELECT ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=('public.'||item.table_name)::regclass AND attname='site_id'),
 (SELECT attnum FROM pg_attribute WHERE attrelid=('public.'||item.table_name)::regclass AND attname=item.time_column)] INTO v_leading;
 IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=('public.'||item.table_name)::regclass AND i.indpred IS NULL AND i.indisvalid
 AND ARRAY(SELECT k FROM unnest(i.indkey) WITH ORDINALITY keys(k,n) WHERE n<=2 ORDER BY n)=v_leading) THEN
 EXECUTE format('CREATE INDEX %I ON public.%I(site_id,%I)',item.index_name,item.table_name,item.time_column);
 END IF;
 END LOOP;
END $indexes$;
CREATE INDEX tracking_portal_creator ON public.tracking_portal_links(created_by);
ALTER TABLE public.tracking_portal_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.tracking_portal_links AS RESTRICTIVE FOR ALL TO authenticated USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.tracking_portal_links FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.tracking_portal_links TO service_role;

CREATE FUNCTION public.generate_tracking_portal_link(p_scope jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE site uuid:=(p_scope->>'site_id')::uuid; ids uuid[]; pin text; tok uuid;
BEGIN
 IF NOT public.has_tms_permission('despacho') OR NOT public.can_access_site(site) THEN RAISE EXCEPTION 'Sin permiso para compartir esta sede'; END IF;
 SELECT COALESCE(array_agg(value::uuid),'{}') INTO ids FROM jsonb_array_elements_text(COALESCE(p_scope->'contract_ids','[]'));
 IF cardinality(ids)>100 OR EXISTS(SELECT 1 FROM unnest(ids) x WHERE NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=x AND c.site_id=site)) THEN RAISE EXCEPTION 'OT fuera del alcance autorizado'; END IF;
 pin:=lpad((('x'||substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint % 100000000)::text,8,'0');
 INSERT INTO public.tracking_portal_links(site_id,contract_ids,pin_hash,created_by)
 VALUES(site,ids,extensions.crypt(pin,extensions.gen_salt('bf',8)),auth.uid()) RETURNING token INTO tok;
 RETURN jsonb_build_object('token',tok,'pin',pin,'scope',jsonb_build_object('site_id',site,'contract_ids',ids));
END $$;

CREATE FUNCTION public.get_tracking_portal_scope_options() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 RETURN jsonb_build_object('sites',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'name',COALESCE(to_jsonb(s)->>'name',to_jsonb(s)->>'code',s.id::text))),'[]') FROM public.sites s WHERE public.can_access_site(s.id)),
 'contracts',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'code',c.code,'site_id',c.site_id)),'[]') FROM public.contracts c WHERE public.can_access_site(c.site_id)));
END $$;

CREATE FUNCTION public.list_tracking_portal_links() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('token',token,'site_id',site_id,'contract_ids',contract_ids,'created_at',created_at,'revoked_at',revoked_at,'rotated_at',rotated_at) ORDER BY created_at DESC),'[]')
 FROM public.tracking_portal_links WHERE public.has_tms_permission('despacho') AND public.can_access_site(site_id);
$$;
CREATE FUNCTION public.manage_tracking_portal_link(p_token uuid,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.tracking_portal_links; pin text;
BEGIN
 SELECT * INTO link FROM public.tracking_portal_links WHERE token=p_token FOR UPDATE;
 IF NOT FOUND OR NOT public.has_tms_permission('despacho') OR NOT public.can_access_site(link.site_id) THEN RAISE EXCEPTION 'Sin permiso'; END IF;
 IF p_action='REVOKE' THEN UPDATE public.tracking_portal_links SET revoked_at=now() WHERE token=p_token;
 ELSIF p_action='ROTATE_PIN' AND link.revoked_at IS NULL THEN
 pin:=lpad((('x'||substr(replace(gen_random_uuid()::text,'-',''),1,8))::bit(32)::bigint % 100000000)::text,8,'0');
 UPDATE public.tracking_portal_links SET pin_hash=extensions.crypt(pin,extensions.gen_salt('bf',8)),rotated_at=now(),attempts=0 WHERE token=p_token;
 ELSE RAISE EXCEPTION 'Acción no válida'; END IF;
 RETURN jsonb_build_object('token',p_token,'pin',pin,'action',p_action);
END $$;

CREATE FUNCTION public.get_public_tracking_portal_info(p_token uuid,p_pin text,p_from date,p_to date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.tracking_portal_links; payload jsonb; requests jsonb; rows jsonb:='[]'; points jsonb; route_ids uuid[]; route_limited boolean:=false; row_limited boolean:=false; request_limited boolean:=false; range_start timestamptz; range_end timestamptz;
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
 range_start:=p_from::timestamp AT TIME ZONE 'America/Lima';range_end:=(p_to+1)::timestamp AT TIME ZONE 'America/Lima';
 SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC,x->>'id'),'[]') INTO requests FROM (
 SELECT jsonb_build_object('id',t.id,'request_number',t.request_number,'ot_code',c.code,
 'created_at',t.created_at,'required_date',t.required_date,'required_at',to_jsonb(t)->>'required_at',
 'request_type',t.request_type,'attention_mode',to_jsonb(t)->>'attention_mode',
 'delivery_zone',to_jsonb(t)->>'delivery_zone','lead_time_policy',to_jsonb(t)->'lead_time_policy',
 'pickup_address',t.pickup_address,'delivery_address',t.delivery_address,'status',t.status) x
 FROM public.transport_requests t LEFT JOIN public.contracts c ON c.id=t.contract_id
 WHERE t.site_id=link.site_id AND (cardinality(link.contract_ids)=0 OR t.contract_id=ANY(link.contract_ids))
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
 WHERE dr.dispatch_id=dp.id AND t.site_id=link.site_id AND (cardinality(link.contract_ids)=0 OR t.contract_id=ANY(link.contract_ids)))
 ORDER BY dp.scheduled_departure DESC,dp.id LIMIT 501) bounded_routes;
 route_ids:=route_ids[1:500];
 -- Project only authorized stops, once. Event history is fetched once per route,
 -- not once for each stop or through a repeated security-definer helper call.
 WITH routes AS MATERIALIZED (
 SELECT d.*,ev.last_type,ev.last_at,COALESCE(ev.events,'[]'::jsonb) AS public_events FROM public.dispatches d
 LEFT JOIN LATERAL (SELECT (array_agg(e.event_type ORDER BY e.created_at DESC,e.id DESC))[1] AS last_type,
 max(e.created_at) AS last_at,jsonb_agg(jsonb_build_object('type',e.event_type,'description',NULL,'at',e.created_at) ORDER BY e.created_at DESC,e.id DESC) AS events
 FROM (SELECT id,event_type,created_at FROM public.dispatch_events WHERE dispatch_id=d.id ORDER BY created_at DESC,id DESC LIMIT 30)e) ev ON true
 WHERE d.id=ANY(route_ids)), stops AS MATERIALIZED (
 SELECT d.*,t.id AS request_id,t.request_number,t.pickup_address,t.delivery_address,dr.sequence_order,dr.document_number,
 dr.status AS stop_status,ct.code AS ot_code,cl.business_name AS client_name,ca.business_name AS carrier_name,
 c.state AS conformity_state,c.current_submission_id,c.arrived_at,c.updated_at AS conformity_updated,
 s.guide_number,s.photos,s.submitted_at,
 NOT (d.driver_id IS NULL AND d.vehicle_plate='EXTERNO' AND COALESCE(to_jsonb(d)->>'modalidad','PROPIA')<>'TERCERO' AND to_jsonb(dr)->>'document_type'='NOTA_SALIDA') AS needs_guide
 FROM routes d JOIN public.dispatch_requests dr ON dr.dispatch_id=d.id JOIN public.transport_requests t ON t.id=dr.transport_request_id
 LEFT JOIN public.contracts ct ON ct.id=t.contract_id LEFT JOIN public.clients cl ON cl.id=ct.client_id
 LEFT JOIN public.carriers ca ON ca.id=NULLIF(to_jsonb(d)->>'carrier_id','')::uuid
 LEFT JOIN public.delivery_conformities c ON c.dispatch_id=d.id AND c.request_id=t.id
 LEFT JOIN public.delivery_submissions s ON s.id=c.current_submission_id
 WHERE t.site_id=link.site_id AND (cardinality(link.contract_ids)=0 OR t.contract_id=ANY(link.contract_ids))
 ORDER BY d.scheduled_departure DESC,d.id,dr.sequence_order,t.id LIMIT 2001)
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
 'dispatch_status',status,'dispatch_id',id,'request_id',request_id,'dispatch_number',dispatch_number,'request_number',request_number,
 'ot_code',COALESCE(ot_code::text,'Sin OT vinculada'),'client_name',client_name,'pickup_address',pickup_address,'delivery_address',delivery_address,
 'plate',vehicle_plate,'driver_name',COALESCE(NULLIF(driver_name,''),to_jsonb(stops)->>'tercero_conductor'),'carrier_name',carrier_name,
 'modalidad',CASE WHEN NOT needs_guide THEN 'RECOJO_CLIENTE' ELSE to_jsonb(stops)->>'modalidad' END,'scheduled_departure',scheduled_departure,
 'guide_number',COALESCE(guide_number,document_number),
 'documents_state',CASE WHEN NOT COALESCE((to_jsonb(stops)->>'docs_required')::boolean,false) THEN 'NO_REQUERIDO' WHEN COALESCE((to_jsonb(stops)->>'docs_reissue')::boolean,false) THEN 'REEMISION' WHEN to_jsonb(stops)->>'docs_ready_at' IS NOT NULL THEN 'LISTO' ELSE 'PENDIENTE' END,
 'conformity',CASE WHEN NOT needs_guide THEN 'NO_APLICA' ELSE COALESCE(conformity_state,CASE WHEN status IN ('LIQUIDADO','CERRADO') THEN 'HISTORICA' ELSE 'PENDIENTE' END) END,
 'submission_id',NULL,'photos_count',COALESCE(cardinality(photos),0),'submitted_at',submitted_at,'arrived_at',arrived_at,
 'state',CASE WHEN status IN ('LIQUIDADO','CERRADO','CANCELADO') THEN status WHEN NOT needs_guide AND stop_status<>'ENTREGADO' THEN 'RECOJO_CLIENTE'
 WHEN conformity_state='RECIBIDA' THEN 'PENDIENTE_VALIDACION' WHEN conformity_state IN ('OBSERVADA','RECHAZADA') THEN conformity_state
 WHEN conformity_state='VALIDADA' OR stop_status='ENTREGADO' THEN 'ENTREGADO' WHEN last_type IN ('INCIDENCIA','RETRASO','DESVIO') THEN 'INCIDENCIA'
 WHEN arrived_at IS NOT NULL THEN 'EN_DESTINO' ELSE status END,
 'last_event_at',COALESCE(conformity_updated,last_at,scheduled_departure),'gps_at',to_jsonb(stops)->>'last_gps_at','events',public_events)
 ORDER BY scheduled_departure DESC,id,sequence_order,request_id),'[]'),count(*)>2000 INTO rows,row_limited FROM stops;
 IF row_limited THEN SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=2000; END IF;
 -- A mixed route's live position discloses other stops; GPS is shared only for full-site scopes.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('dispatch_id',dp.id,'vehicle_plate',dp.vehicle_plate,'driver_name',dp.driver_name,
 'lat',dp.last_lat,'lng',dp.last_lon,'last_gps_at',dp.last_gps_at)),'[]') INTO points FROM public.dispatches dp
 WHERE cardinality(link.contract_ids)=0 AND dp.site_id=link.site_id AND dp.id=ANY(route_ids)
 AND dp.last_gps_at>now()-interval '15 minutes' AND dp.last_lat IS NOT NULL AND dp.last_lon IS NOT NULL;
 RETURN jsonb_build_object('mode','permanent','rows',rows,'requests',requests,'locations',points,'limited',request_limited OR route_limited OR row_limited);
END $$;
REVOKE ALL ON FUNCTION public.get_tracking_portal_scope_options(),public.generate_tracking_portal_link(jsonb),public.list_tracking_portal_links(),public.manage_tracking_portal_link(uuid,text),public.get_public_tracking_portal_info(uuid,text,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_portal_scope_options(),public.generate_tracking_portal_link(jsonb),public.list_tracking_portal_links(),public.manage_tracking_portal_link(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_tracking_portal_info(uuid,text,date,date) TO anon,authenticated;
-- Supabase projects may already have pgcrypto in another schema. Keep the existing
-- extension in place and qualify its functions without changing any existing callers.
DO $crypto_schema$
DECLARE crypto_schema text; signature regprocedure; source text;
BEGIN
 SELECT n.nspname INTO crypto_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
 IF crypto_schema IS NULL THEN RAISE EXCEPTION 'Se requiere pgcrypto para proteger los códigos de acceso'; END IF;
 IF crypto_schema <> 'extensions' THEN
  FOREACH signature IN ARRAY ARRAY['public.generate_tracking_portal_link(jsonb)'::regprocedure,
    'public.manage_tracking_portal_link(uuid,text)'::regprocedure,
    'public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure] LOOP
   SELECT pg_get_functiondef(signature) INTO source;
   source:=replace(source,'extensions.crypt(',format('%I.crypt(',crypto_schema));
   source:=replace(source,'extensions.gen_salt(',format('%I.gen_salt(',crypto_schema));
   EXECUTE source;
  END LOOP;
 END IF;
END $crypto_schema$;
COMMIT;
