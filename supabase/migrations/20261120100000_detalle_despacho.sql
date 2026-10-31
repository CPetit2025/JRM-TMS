-- Detalle del despacho (modal de seis pestañas): hitos reales, presencia GPS e historial unificado de una parada
-- (despacho × solicitud). Solo lectura: no cambia estados ni cierra nada. Cada fuente se lee en su propio bloque;
-- si producción no tiene una tabla o columna, la fuente se informa en sources_failed y el resto del detalle sigue.
-- Columnas opcionales de dispatches/dispatch_events se leen con to_jsonb (producción no coincide con el repo).
BEGIN;

CREATE OR REPLACE FUNCTION public.dispatch_detail_actor(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NULLIF(trim(concat_ws(' ', to_jsonb(p)->>'first_name', to_jsonb(p)->>'last_name')), '')
 FROM public.profiles p WHERE p.id=p_user
$$;
REVOKE ALL ON FUNCTION public.dispatch_detail_actor(uuid) FROM PUBLIC, anon, authenticated;

-- Contenido del detalle sin control de acceso (interno: lo llama get_dispatch_detail y la prueba de caja).
CREATE OR REPLACE FUNCTION public.dispatch_detail_payload(p_dispatch uuid, p_request uuid, p_economic boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 d jsonb; ev jsonb := '[]'::jsonb; part jsonb; failed text[] := '{}';
 v_salida timestamptz; v_llegada timestamptz; v_retorno timestamptz; v_cierre timestamptz; v_cierre_estado text;
 v_review jsonb; v_rejection jsonb; v_presence jsonb; v_driver jsonb;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch;
 IF d IS NULL THEN RETURN NULL; END IF;

 -- Hitos de la ruta: bitácora de cambios de estado (kpi_dispatch_log), con respaldo en las columnas reales
 BEGIN
  SELECT min(l.at) FILTER (WHERE l.estado_nuevo IN ('EN_CURSO','EN RUTA','EN_RUTA')),
         max(l.at) FILTER (WHERE l.estado_nuevo='RETORNO_COMPLETADO'),
         max(l.at) FILTER (WHERE l.estado_nuevo IN ('CIERRE_OPERATIVO','LIQUIDADO','CERRADO'))
    INTO v_salida, v_retorno, v_cierre
  FROM public.kpi_dispatch_log l WHERE l.dispatch_id=p_dispatch;
  SELECT l.estado_nuevo INTO v_cierre_estado FROM public.kpi_dispatch_log l
  WHERE l.dispatch_id=p_dispatch AND l.estado_nuevo IN ('CIERRE_OPERATIVO','LIQUIDADO','CERRADO') ORDER BY l.at DESC LIMIT 1;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'kpi_dispatch_log');
 END;
 v_salida := COALESCE(v_salida, (d->>'tercero_salida_at')::timestamptz);
 v_retorno := COALESCE((d->>'returned_at')::timestamptz, v_retorno);

 BEGIN
  SELECT c.arrived_at INTO v_llegada FROM public.delivery_conformities c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request;
  SELECT jsonb_build_object('decision',r.decision,'reason',r.reason,'at',r.reviewed_at,'by',public.dispatch_detail_actor(r.reviewed_by))
    INTO v_review FROM public.delivery_reviews r JOIN public.delivery_submissions s ON s.id=r.submission_id
  WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request ORDER BY r.reviewed_at DESC LIMIT 1;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_conformities');
 END;
 BEGIN
  SELECT jsonb_build_object('kind',r.kind,'reason_code',r.reason_code,'at',r.captured_at,'decision',r.decision)
    INTO v_rejection FROM public.delivery_rejections r WHERE r.dispatch_id=p_dispatch AND r.request_id=p_request;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_rejections');
 END;

 -- Conductor y presencia del app: solo transporte propio con conductor; nunca se supone conexión
 BEGIN
  SELECT jsonb_build_object('name',NULLIF(trim(concat_ws(' ', to_jsonb(r)->>'first_name', to_jsonb(r)->>'last_name')),''),
    'document_number',to_jsonb(r)->>'document_number') INTO v_driver FROM public.drivers r WHERE r.id=(d->>'driver_id')::uuid;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'drivers');
 END;
 v_presence := jsonb_build_object('applies', d->>'driver_id' IS NOT NULL AND COALESCE(d->>'modalidad','PROPIA') NOT IN ('TERCERO','RECOJO_CLIENTE'),
   'connected', false, 'last_seen_at', NULL, 'gps_state', NULL, 'gps_at', d->>'last_gps_at', 'server_now', now());
 IF (v_presence->>'applies')::boolean THEN
  BEGIN
   SELECT v_presence || jsonb_build_object('connected', COALESCE(a.last_seen_at>=now()-interval '90 seconds' AND a.disconnected_at IS NULL, false),
     'last_seen_at', a.last_seen_at, 'gps_state', a.gps_state)
     INTO v_presence FROM public.driver_app_presence a WHERE a.driver_id=(d->>'driver_id')::uuid;
   v_presence := COALESCE(v_presence, jsonb_build_object('applies',true,'connected',false,'gps_at',d->>'last_gps_at','server_now',now()));
  EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'driver_app_presence');
  END;
 END IF;

 -- Historial: solo registros guardados (nunca se reconstruye desde el estado actual)
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',e.created_at,'source','OPERACION','scope','RUTA','type',e.event_type,'detail',e.description,
    'actor',COALESCE(public.dispatch_detail_actor(COALESCE(to_jsonb(e)->>'user_id',to_jsonb(e)->>'created_by_user')::uuid), e.created_by),
    'origin',to_jsonb(e)->>'origin',
    'level',CASE WHEN e.event_type IN ('INCIDENCIA','RETRASO','DESVIO') THEN 'INCIDENCIA' ELSE 'INFO' END)), '[]') INTO part
  FROM public.dispatch_events e WHERE e.dispatch_id=p_dispatch;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column OR invalid_text_representation THEN failed := array_append(failed, 'dispatch_events');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',e.created_at,'source','SOLICITUD','scope','SERVICIO','type','SOLICITUD_'||e.action,
    'detail',CASE WHEN e.action='STATUS_CHANGED' THEN concat_ws(' → ', e.previous_state->>'status', e.next_state->>'status') END,
    'actor',public.dispatch_detail_actor(e.actor_id),'level','INFO')), '[]') INTO part
  FROM public.transport_request_events e WHERE e.request_id=p_request;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'transport_request_events');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',s.submitted_at,'source','ENTREGA','scope','SERVICIO','type','GUIA_RECIBIDA',
    'detail',concat_ws(' · ', CASE WHEN s.guide_number IS NOT NULL THEN 'Guía '||s.guide_number END, cardinality(s.photos)||' foto(s)', 'Origen '||s.source),
    'actor',COALESCE(public.dispatch_detail_actor(s.submitted_by), s.received_by),'level','INFO')), '[]') INTO part
  FROM public.delivery_submissions s WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request;
  ev := ev || part;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',r.reviewed_at,'source','ENTREGA','scope','SERVICIO','type','CONFORMIDAD_'||r.decision,
    'detail',r.reason,'actor',public.dispatch_detail_actor(r.reviewed_by),'level',CASE WHEN r.decision='VALIDADA' THEN 'INFO' ELSE 'ALERTA' END)), '[]') INTO part
  FROM public.delivery_reviews r JOIN public.delivery_submissions s ON s.id=r.submission_id WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request;
  ev := ev || part;
  IF v_llegada IS NOT NULL THEN
   ev := ev || jsonb_build_array(jsonb_build_object('at',v_llegada,'source','ENTREGA','scope','SERVICIO','type','LLEGADA_DESTINO','level','INFO'));
  END IF;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_submissions');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(x), '[]') INTO part FROM (
   SELECT jsonb_build_object('at',r.captured_at,'source','ENTREGA','scope','SERVICIO','type','RECHAZO_'||r.kind,'detail',concat_ws(' · ', r.reason_code, r.note),
     'actor',public.dispatch_detail_actor(r.created_by),'level','INCIDENCIA') x
   FROM public.delivery_rejections r WHERE r.dispatch_id=p_dispatch AND r.request_id=p_request
   UNION ALL
   SELECT jsonb_build_object('at',r.decided_at,'source','ENTREGA','scope','SERVICIO','type','RECHAZO_'||r.decision,'detail',r.decision_reason,
     'actor',public.dispatch_detail_actor(r.decided_by),'level','INFO')
   FROM public.delivery_rejections r WHERE r.dispatch_id=p_dispatch AND r.request_id=p_request AND r.decided_at IS NOT NULL) q;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'delivery_rejections');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',e.created_at,'source','DOCUMENTARIO','scope','SERVICIO','type','DOCUMENTARIO_'||e.action,
    'detail',concat_ws(' · ', concat_ws(' → ', e.previous_status, e.new_status), e.reason),'actor',public.dispatch_detail_actor(e.actor_id),'level','INFO')), '[]') INTO part
  FROM public.documentary_closure_events e WHERE e.dispatch_id=p_dispatch AND e.request_id=p_request;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'documentary_closure_events');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(x), '[]') INTO part FROM (
   SELECT jsonb_build_object('at',t.uploaded_at,'source','DOCUMENTO','scope',CASE WHEN t.transport_request_id IS NULL THEN 'RUTA' ELSE 'SERVICIO' END,
     'type','DOCUMENTO_REGISTRADO','detail',concat_ws(' ', t.doc_type, t.document_number),'actor',public.dispatch_detail_actor(t.uploaded_by),'level','INFO') x
   FROM public.dispatch_documents t WHERE t.dispatch_id=p_dispatch AND (t.transport_request_id IS NULL OR t.transport_request_id=p_request)
   UNION ALL
   SELECT jsonb_build_object('at',t.voided_at,'source','DOCUMENTO','scope',CASE WHEN t.transport_request_id IS NULL THEN 'RUTA' ELSE 'SERVICIO' END,
     'type','DOCUMENTO_ANULADO','detail',concat_ws(' · ', concat_ws(' ', t.doc_type, t.document_number), t.void_reason),'actor',public.dispatch_detail_actor(t.voided_by),'level','ALERTA')
   FROM public.dispatch_documents t WHERE t.dispatch_id=p_dispatch AND (t.transport_request_id IS NULL OR t.transport_request_id=p_request) AND t.voided_at IS NOT NULL) q;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'dispatch_documents');
 END;
 BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at',i.occurred_at,'source','INCIDENTE','scope','RUTA','type','INCIDENTE_'||i.incident_type,
    'detail',concat_ws(' · ', i.severity, i.description, i.location),'actor',public.dispatch_detail_actor(i.created_by),'level','INCIDENCIA')), '[]') INTO part
  FROM public.vehicle_incidents i WHERE i.dispatch_id=p_dispatch;
  ev := ev || part;
 EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'vehicle_incidents');
 END;
 IF p_economic THEN
  BEGIN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('at',e.created_at,'source','ECONOMICO','scope','RUTA','type','ECONOMICO_'||e.action,
     'detail',concat_ws(' · ', concat_ws(' → ', e.from_status, e.to_status), e.reason),'actor',public.dispatch_detail_actor(e.created_by),'level','INFO')), '[]') INTO part
   FROM public.economic_closure_events e WHERE e.dispatch_id=p_dispatch;
   ev := ev || part;
  EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'economic_closure_events');
  END;
  BEGIN
   SELECT COALESCE(jsonb_agg(jsonb_build_object('at',e.created_at,'source','COSTO','scope',CASE WHEN e.transport_request_id=p_request THEN 'SERVICIO' ELSE 'RUTA' END,
     'type','COSTO_'||e.stage,'detail',concat_ws(' · ', concat_ws(' ', e.service_kind, e.concept),
       CASE WHEN e.new_amount IS NOT NULL THEN concat_ws(' → ', 'S/ '||e.old_amount, 'S/ '||e.new_amount) END,
       concat_ws(' → ', e.old_status, e.new_status), e.reason),
     'actor',public.dispatch_detail_actor(e.created_by),'level','INFO')), '[]') INTO part
   FROM public.service_cost_events e
   WHERE e.dispatch_id=p_dispatch AND (e.transport_request_id IS NULL OR e.transport_request_id=p_request);
   ev := ev || part;
  EXCEPTION WHEN undefined_table OR undefined_column THEN failed := array_append(failed, 'service_cost_events');
  END;
 END IF;

 RETURN jsonb_build_object(
  'dispatch', jsonb_build_object('id',d->>'id','number',d->>'dispatch_number','status',d->>'status','modalidad',d->>'modalidad',
    'scheduled_departure',d->>'scheduled_departure','estimated_distance_km',NULLIF((d->>'estimated_distance_km')::numeric,0),
    'vehicle_plate',d->>'vehicle_plate','driver',v_driver,
    'services_count',(SELECT count(*) FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch)),
  'milestones', jsonb_build_object('programado',d->>'scheduled_departure','salida',v_salida,'llegada',v_llegada,
    'conformidad',v_review,'rechazo',v_rejection,'retorno',v_retorno,'cierre',v_cierre,'cierre_estado',v_cierre_estado),
  'presence', v_presence,
  'events', COALESCE((SELECT jsonb_agg(x ORDER BY ts DESC) FROM (SELECT x, (x->>'at')::timestamptz ts FROM jsonb_array_elements(ev) x
    WHERE x->>'at' IS NOT NULL ORDER BY 2 DESC LIMIT 500) q), '[]'),
  'economic', p_economic,
  'sources_failed', to_jsonb(failed));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_detail_payload(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;

-- Detalle de una parada: quien ve la ruta en Torre de Control; los eventos económicos solo con lectura económica
CREATE OR REPLACE FUNCTION public.get_dispatch_detail(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_dispatch IS NULL OR NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin permiso para ver este despacho'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests r WHERE r.dispatch_id=p_dispatch AND r.transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La solicitud no pertenece a este despacho';
 END IF;
 RETURN public.dispatch_detail_payload(p_dispatch, p_request, public.economic_can_read());
END $$;
REVOKE ALL ON FUNCTION public.get_dispatch_detail(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_detail(uuid,uuid) TO authenticated;

COMMIT;
