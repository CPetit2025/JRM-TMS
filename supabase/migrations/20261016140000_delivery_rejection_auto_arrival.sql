-- Entrega «Rechazada en destino» y llegada registrada por el Copiloto.
-- A) Rechazo en destino (app del conductor):
--    · TOTAL: el cliente no recibe la carga. Se registra con motivo, fotos, GPS y hora; la parada queda cerrada como
--      rechazada (no exige guía), la ruta continúa y se avisa de inmediato a Despacho, Supervisor de Transporte y al
--      responsable de la OT. Despacho o el Supervisor deciden: reprogramar (nueva fecha) o anular, con motivo.
--      La parada se liquida con la evidencia del rechazo y el flete del viaje se consume igual.
--    · PARCIAL: el cliente recibe una parte. Se registra el rechazo y la entrega sigue con su guía como siempre.
--    · Las entregas normales no cambian.
-- B) Llegada al destino: guarda ubicación, precisión y origen (MANUAL, COPILOTO, AUTO_GEOCERCA). El Copiloto la
--    registra sola al entrar en la geocerca del destino (aprendida de entregas anteriores) y el conductor puede
--    deshacerla. El Copiloto nunca entrega ni rechaza por su cuenta.

-- ===================================================================================== A) Rechazo en destino
CREATE TABLE IF NOT EXISTS public.delivery_rejections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id    uuid NOT NULL UNIQUE,
  dispatch_id     uuid NOT NULL REFERENCES public.dispatches(id),
  request_id      uuid NOT NULL REFERENCES public.transport_requests(id),
  kind            text NOT NULL CHECK (kind IN ('TOTAL','PARCIAL')),
  reason_code     text NOT NULL CHECK (reason_code IN ('CLIENTE_AUSENTE','FUERA_DE_HORARIO','MERCADERIA_DANADA','PEDIDO_INCORRECTO',
                    'NO_RECONOCE_PEDIDO','DOCUMENTOS','DIRECCION_ERRADA','OTRO')),
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  photos          text[] NOT NULL CHECK (cardinality(photos) BETWEEN 1 AND 5),
  latitude        numeric,
  longitude       numeric,
  accuracy_m      numeric,
  captured_at     timestamptz NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decision        text CHECK (decision IS NULL OR decision IN ('REPROGRAMADA','ANULADA')),
  decision_reason text,
  decided_by      uuid,
  decided_at      timestamptz,
  UNIQUE (dispatch_id, request_id)
);
CREATE INDEX IF NOT EXISTS delivery_rejections_pending_idx ON public.delivery_rejections(created_at DESC) WHERE kind = 'TOTAL' AND decision IS NULL;
CREATE INDEX IF NOT EXISTS delivery_rejections_photos_idx ON public.delivery_rejections USING gin(photos);
ALTER TABLE public.delivery_rejections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.delivery_rejections;
CREATE POLICY security_active_account ON public.delivery_rejections AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.delivery_rejections FROM PUBLIC, anon, authenticated;

-- Las fotos del rechazo, como las de la guía, no se borran ni se sobrescriben
CREATE OR REPLACE FUNCTION public.delivery_photo_mutable(p_name text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.delivery_submissions WHERE photos @> ARRAY[p_name])
    AND NOT EXISTS(SELECT 1 FROM public.delivery_rejections WHERE photos @> ARRAY[p_name]);
$$;

CREATE OR REPLACE FUNCTION public.delivery_rejected(p_dispatch uuid, p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request AND kind='TOTAL');
$$;
-- Entrega que todavía espera su guía: requiere guía y no fue rechazada en destino
CREATE OR REPLACE FUNCTION public.delivery_open_required(p_dispatch uuid, p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.delivery_required(p_dispatch,p_request) AND NOT public.delivery_rejected(p_dispatch,p_request);
$$;

-- Guardas de avance, orden de las paradas y cierre por puntos completos: la parada rechazada ya no espera guía
DO $patch$
DECLARE sig regprocedure; def text;
BEGIN
 FOREACH sig IN ARRAY ARRAY['public.delivery_guard_advance()'::regprocedure,
   'public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure,
   'public.dispatch_close_when_points_done()'::regprocedure] LOOP
  def := pg_get_functiondef(sig);
  IF position('delivery_open_required' IN def) > 0 THEN CONTINUE; END IF;
  IF position('public.delivery_required(' IN def) = 0 THEN RAISE EXCEPTION 'Función no reconocida: % (revisar antes de migrar)', sig; END IF;
  EXECUTE replace(def, 'public.delivery_required(', 'public.delivery_open_required(');
 END LOOP;
END $patch$;

-- Una entrega rechazada no admite la guía de entrega
DO $patch$
DECLARE sig regprocedure := 'public.delivery_submit_driver(uuid,uuid,text[],text,text,text,uuid,timestamptz)'::regprocedure; def text;
  anchor text := 'SELECT * INTO stop FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request;';
BEGIN
 def := pg_get_functiondef(sig);
 IF position('Entrega rechazada en destino' IN def) > 0 THEN RETURN; END IF;
 IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'Envío de guías del conductor no reconocido: revisar antes de migrar'; END IF;
 EXECUTE replace(def, anchor, anchor || E'\n IF public.delivery_rejected(p_dispatch,p_request) THEN RAISE EXCEPTION ''Entrega rechazada en destino: no admite guía de entrega''; END IF;');
END $patch$;

-- Liquidar la ruta: la parada rechazada no bloquea y su solicitud no pasa a ENTREGADA
DO $patch$
DECLARE sig regprocedure := 'public.close_dispatch_route(uuid)'::regprocedure; def text;
  a1 text := 'WHERE dispatch_id = p_dispatch_id AND status <> ''ENTREGADO'') THEN';
  a2 text := 'SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id);';
BEGIN
 def := pg_get_functiondef(sig);
 IF position('delivery_rejected' IN def) > 0 THEN RETURN; END IF;
 IF position(a1 IN def) = 0 OR position(a2 IN def) = 0 THEN RAISE EXCEPTION 'Cierre de ruta no reconocido: revisar antes de migrar'; END IF;
 def := replace(def, a1, 'WHERE dispatch_id = p_dispatch_id AND status <> ''ENTREGADO'' AND NOT public.delivery_rejected(dispatch_id, transport_request_id)) THEN');
 def := replace(def, a2, 'SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id AND NOT public.delivery_rejected(dispatch_id, transport_request_id));');
 EXECUTE def;
END $patch$;

-- Una solicitud rechazada y reprogramada puede entrar a otra ruta vigente
DO $patch$
DECLARE sig regprocedure := to_regprocedure('public.add_active_route_service(uuid,uuid,uuid,text,uuid,numeric,numeric,numeric,numeric,timestamp with time zone,text)'); def text;
  anchor text := 'WHERE x.transport_request_id=p_request AND y.status<>''CANCELADO'')';
BEGIN
 IF sig IS NULL THEN RETURN; END IF;
 def := pg_get_functiondef(sig);
 IF position('delivery_rejected' IN def) > 0 THEN RETURN; END IF;
 IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'Agregar servicio a ruta no reconocido: revisar antes de migrar'; END IF;
 EXECUTE replace(def, anchor, 'WHERE x.transport_request_id=p_request AND y.status<>''CANCELADO'' AND NOT public.delivery_rejected(x.dispatch_id,x.transport_request_id))');
END $patch$;

-- Torre de Control y portal público: estado «Rechazada en destino» de la parada
DO $patch$
DECLARE def text;
BEGIN
 def := pg_get_functiondef('public.delivery_rows_core(uuid,boolean)'::regprocedure);
 IF position('RECHAZADO_DESTINO' IN def) = 0 THEN
  IF position('WHEN c.state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''' IN def) = 0 THEN RAISE EXCEPTION 'Filas de entrega no reconocidas: revisar antes de migrar'; END IF;
  EXECUTE replace(def, 'WHEN c.state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''',
    'WHEN public.delivery_rejected(d.id,t.id) THEN ''RECHAZADO_DESTINO'' WHEN c.state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''');
 END IF;
 def := pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure);
 IF position('RECHAZADO_DESTINO' IN def) = 0 THEN
  IF position('WHEN conformity_state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''' IN def) = 0 THEN RAISE EXCEPTION 'Portal de seguimiento no reconocido: revisar antes de migrar'; END IF;
  EXECUTE replace(def, 'WHEN conformity_state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''',
    'WHEN public.delivery_rejected(stops.id,stops.request_id) THEN ''RECHAZADO_DESTINO'' WHEN conformity_state=''RECIBIDA'' THEN ''PENDIENTE_VALIDACION''');
 END IF;
END $patch$;

-- Aviso inmediato (Despacho, Torre, Supervisor de Transporte, Solicitudes y quien pidió el servicio)
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('ENTREGA_RECHAZADA', 'DESPACHO', 'Entrega rechazada en destino (total o parcial)', 'crit',
   ARRAY['despacho', 'despacho-aprobacion', 'torre-control', 'entregas-validacion', 'solicitudes'], true)
ON CONFLICT (evento) DO NOTHING;

CREATE OR REPLACE FUNCTION public.delivery_rejection_reason_label(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE p_code WHEN 'CLIENTE_AUSENTE' THEN 'Cliente ausente o local cerrado' WHEN 'FUERA_DE_HORARIO' THEN 'Fuera del horario de recepción'
  WHEN 'MERCADERIA_DANADA' THEN 'Mercadería dañada' WHEN 'PEDIDO_INCORRECTO' THEN 'Pedido o cantidad incorrecta'
  WHEN 'NO_RECONOCE_PEDIDO' THEN 'El cliente no reconoce el pedido' WHEN 'DOCUMENTOS' THEN 'Falta o error en documentos'
  WHEN 'DIRECCION_ERRADA' THEN 'Dirección errada' WHEN 'OTRO' THEN 'Otro motivo' ELSE p_code END;
$$;

CREATE OR REPLACE FUNCTION public.delivery_rejection_notify(p_rejection uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.delivery_rejections; t jsonb; d jsonb; v_title text; v_body text; v_owner uuid; v_user uuid;
BEGIN
 SELECT * INTO r FROM public.delivery_rejections WHERE id=p_rejection;
 SELECT to_jsonb(x) INTO t FROM public.transport_requests x WHERE x.id=r.request_id;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=r.dispatch_id;
 v_title := CASE WHEN r.kind='TOTAL' THEN 'Entrega rechazada en destino: ' ELSE 'Rechazo parcial en destino: ' END
   || COALESCE(t->>'request_number','') || ' · ' || COALESCE(d->>'dispatch_number','');
 v_body := concat_ws(' · ', public.delivery_rejection_reason_label(r.reason_code), NULLIF(btrim(r.note),''), NULLIF(d->>'vehicle_plate',''),
   NULLIF(t->>'delivery_address',''), CASE WHEN r.kind='TOTAL' THEN 'Decida: reprogramar o anular' END);
 v_owner := COALESCE(public.notif_uuid(t->>'created_by'), public.notif_uuid(t->>'requested_by'), public.notif_uuid(t->>'user_id'));
 PERFORM public.notif_emit('ENTREGA_RECHAZADA', 'rechazo-' || r.id::text, v_title, v_body, '/torre-control', v_owner);
 -- Responsable de la OT (Administrador de Contratos asignado y su respaldo)
 IF NULLIF(t->>'contract_id','') IS NOT NULL THEN
  FOR v_user IN SELECT DISTINCT a.user_id FROM public.contract_user_assignments a
    WHERE a.contract_id=public.contract_root_id((t->>'contract_id')::uuid) AND a.active AND a.role IN ('ADMIN_CONTRATO','BACKUP')
      AND a.user_id IS DISTINCT FROM v_owner LOOP
   INSERT INTO public.notifications(evento,categoria,severidad,titulo,cuerpo,link,permisos,target_user,dedupe_key)
   VALUES('ENTREGA_RECHAZADA','DESPACHO','crit',left(v_title,200),left(v_body,500),'/solicitudes','{}',v_user,'rechazo-'||r.id::text||'-'||v_user::text)
   ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
  END LOOP;
 END IF;
EXCEPTION WHEN OTHERS THEN
 RETURN; -- el aviso nunca impide registrar el rechazo
END $$;

CREATE OR REPLACE FUNCTION public.delivery_reject_driver(p_dispatch uuid, p_request uuid, p_kind text, p_reason text, p_note text,
  p_photos text[], p_lat numeric, p_lon numeric, p_accuracy numeric, p_operation uuid, p_captured timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_driver uuid; v_status text; v_state text; old public.delivery_rejections; v_id uuid; v_kind text := upper(btrim(COALESCE(p_kind,'')));
  v_reason text := upper(btrim(COALESCE(p_reason,''))); v_note text := NULLIF(btrim(COALESCE(p_note,'')),''); photo text; v_closed boolean := false;
BEGIN
 SELECT driver_id, status INTO v_driver, v_status FROM public.dispatches WHERE id=p_dispatch FOR UPDATE;
 IF v_driver IS NULL OR NOT EXISTS(SELECT 1 FROM public.drivers r JOIN public.profiles p ON p.id=r.profile_id
   WHERE r.id=v_driver AND r.profile_id=auth.uid() AND r.is_active AND p.is_active) THEN RAISE EXCEPTION 'Ruta no autorizada'; END IF;
 SELECT * INTO old FROM public.delivery_rejections WHERE operation_id=p_operation;
 IF old.id IS NOT NULL THEN
  IF old.dispatch_id<>p_dispatch OR old.request_id<>p_request THEN RAISE EXCEPTION 'Operación de otro servicio'; END IF;
  RETURN jsonb_build_object('success',true,'rejection_id',old.id,'kind',old.kind,'duplicate',true);
 END IF;
 IF v_status NOT IN ('EN RUTA','EN_CURSO') THEN RAISE EXCEPTION 'La ruta no está en curso: el rechazo se registra en el destino'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request) THEN
  RAISE EXCEPTION 'La entrega no pertenece al servicio'; END IF;
 IF NOT public.delivery_required(p_dispatch,p_request) THEN RAISE EXCEPTION 'El recojo por el cliente no se registra como rechazo en destino'; END IF;
 IF v_kind NOT IN ('TOTAL','PARCIAL') THEN RAISE EXCEPTION 'Indique si el rechazo es total o parcial'; END IF;
 IF v_reason NOT IN ('CLIENTE_AUSENTE','FUERA_DE_HORARIO','MERCADERIA_DANADA','PEDIDO_INCORRECTO','NO_RECONOCE_PEDIDO','DOCUMENTOS','DIRECCION_ERRADA','OTRO') THEN
  RAISE EXCEPTION 'Seleccione el motivo del rechazo'; END IF;
 IF (v_reason='OTRO' OR v_kind='PARCIAL') AND COALESCE(length(v_note),0) < 5 THEN
  RAISE EXCEPTION '%', CASE WHEN v_kind='PARCIAL' THEN 'Detalle qué se rechazó (producto y cantidad)' ELSE 'Detalle el motivo del rechazo' END; END IF;
 IF COALESCE(cardinality(p_photos),0) NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Adjunte de una a cinco fotos del rechazo'; END IF;
 IF p_captured IS NULL OR p_captured>now()+interval '5 minutes' OR p_captured<now()-interval '3 days' THEN RAISE EXCEPTION 'Fecha de captura no válida'; END IF;
 FOREACH photo IN ARRAY p_photos LOOP
  IF photo IS NULL OR photo NOT LIKE auth.uid()::text||'/'||p_dispatch::text||'/'||p_request::text||'/%'
   OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='driver_evidence' AND o.name=photo) THEN
   RAISE EXCEPTION 'Foto no válida para este rechazo'; END IF;
 END LOOP;
 SELECT state INTO v_state FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request;
 IF v_state='VALIDADA' OR (v_kind='TOTAL' AND v_state='RECIBIDA') THEN
  RAISE EXCEPTION 'La guía de esta entrega ya fue enviada: comunique la incidencia a Despacho'; END IF;
 SELECT * INTO old FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF old.kind='TOTAL' THEN RAISE EXCEPTION 'El rechazo total de esta entrega ya fue registrado'; END IF;
 IF old.id IS NOT NULL THEN
  -- Un rechazo parcial se corrige o pasa a total con el nuevo registro
  UPDATE public.delivery_rejections SET operation_id=p_operation, kind=v_kind, reason_code=v_reason, note=left(v_note,1000), photos=p_photos,
   latitude=p_lat, longitude=p_lon, accuracy_m=p_accuracy, captured_at=p_captured, created_by=auth.uid(), created_at=now()
  WHERE id=old.id RETURNING id INTO v_id;
 ELSE
  INSERT INTO public.delivery_rejections(operation_id,dispatch_id,request_id,kind,reason_code,note,photos,latitude,longitude,accuracy_m,captured_at,created_by)
  VALUES(p_operation,p_dispatch,p_request,v_kind,v_reason,left(v_note,1000),p_photos,p_lat,p_lon,p_accuracy,p_captured,auth.uid()) RETURNING id INTO v_id;
 END IF;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(p_dispatch,p_request) ON CONFLICT DO NOTHING;
 UPDATE public.delivery_conformities SET arrived_at=COALESCE(arrived_at,p_captured), updated_at=now(),
   arrival_lat=CASE WHEN arrived_at IS NULL THEN p_lat ELSE arrival_lat END, arrival_lon=CASE WHEN arrived_at IS NULL THEN p_lon ELSE arrival_lon END,
   arrival_accuracy_m=CASE WHEN arrived_at IS NULL THEN p_accuracy ELSE arrival_accuracy_m END,
   arrival_source=CASE WHEN arrived_at IS NULL THEN 'MANUAL' ELSE arrival_source END
 WHERE dispatch_id=p_dispatch AND request_id=p_request;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'INCIDENCIA',CASE WHEN v_kind='TOTAL' THEN 'Entrega rechazada en destino (total): ' ELSE 'Rechazo parcial en destino: ' END
   ||public.delivery_rejection_reason_label(v_reason)||COALESCE(' · '||v_note,'')
   ||' · Solicitud '||COALESCE((SELECT request_number FROM public.transport_requests WHERE id=p_request),''),auth.uid()::text);
 PERFORM public.delivery_rejection_notify(v_id);
 -- Rechazo total del último punto pendiente: la ruta se cierra como al enviar la última guía
 IF v_kind='TOTAL' AND NOT EXISTS(SELECT 1 FROM public.dispatch_requests dr LEFT JOIN public.delivery_conformities c
   ON c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id
   WHERE dr.dispatch_id=p_dispatch AND COALESCE(dr.status,'') NOT IN ('CANCELADO','RETIRADO')
    AND public.delivery_open_required(dr.dispatch_id,dr.transport_request_id) AND COALESCE(c.state,'PENDIENTE') NOT IN ('RECIBIDA','VALIDADA')) THEN
  v_closed := public.dispatch_operational_close(p_dispatch,'CONDUCTOR');
 END IF;
 RETURN jsonb_build_object('success',true,'rejection_id',v_id,'kind',v_kind,'route_closed',COALESCE(v_closed,false));
END $$;

-- Decisión sobre la solicitud rechazada: reprogramar (nueva fecha) o anular, siempre con motivo.
CREATE OR REPLACE FUNCTION public.delivery_rejection_can_decide(p_dispatch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT auth.uid() IS NOT NULL AND public.is_active_tms_user() AND EXISTS(SELECT 1 FROM public.dispatches d WHERE d.id=p_dispatch AND public.can_access_site(d.site_id))
  AND (public.is_tms_admin() OR public.has_tms_permission('despacho') OR public.has_tms_permission('despacho-aprobacion')
   OR public.has_tms_permission('entregas-validacion') OR public.delivery_can_review(p_dispatch));
$$;

CREATE OR REPLACE FUNCTION public.delivery_rejection_decide(p_dispatch uuid, p_request uuid, p_decision text, p_reason text,
  p_required_at timestamptz DEFAULT NULL, p_delivery_zone text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.delivery_rejections; t public.transport_requests; v_decision text := upper(btrim(COALESCE(p_decision,'')));
  v_reason text := btrim(COALESCE(p_reason,'')); v_final text;
BEGIN
 IF NOT public.delivery_rejection_can_decide(p_dispatch) THEN RAISE EXCEPTION 'Solo Despacho o el Supervisor de Transporte deciden sobre un rechazo'; END IF;
 SELECT * INTO r FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request AND kind='TOTAL' FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'La entrega no tiene un rechazo total registrado'; END IF;
 IF r.decision IS NOT NULL THEN RAISE EXCEPTION 'El rechazo ya fue resuelto (%)', lower(r.decision); END IF;
 IF length(v_reason) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Indique el motivo de la decisión (10 a 500 caracteres)'; END IF;
 SELECT * INTO t FROM public.transport_requests WHERE id=p_request FOR UPDATE;
 IF v_decision='REPROGRAMAR' THEN
  IF p_required_at IS NULL OR (p_required_at AT TIME ZONE 'America/Lima')::date < (now() AT TIME ZONE 'America/Lima')::date THEN
   RAISE EXCEPTION 'La nueva fecha debe ser hoy o posterior'; END IF;
  IF p_delivery_zone IS NOT NULL AND p_delivery_zone NOT IN ('LIMA','PROVINCIA','EXTERIOR') THEN RAISE EXCEPTION 'Zona de atención no válida'; END IF;
  UPDATE public.transport_requests SET status='REPROGRAMADA', required_date=(p_required_at AT TIME ZONE 'America/Lima')::date, required_at=p_required_at,
    delivery_zone=COALESCE(p_delivery_zone, delivery_zone), updated_at=now()
  WHERE id=p_request RETURNING status INTO v_final;
  INSERT INTO public.kpi_reprogramaciones(request_id,causa,detalle,fecha_anterior,fecha_nueva,by)
  VALUES(p_request,'CLIENTE','Rechazo en destino: '||v_reason,t.required_date,(p_required_at AT TIME ZONE 'America/Lima')::date,auth.uid());
 ELSIF v_decision='ANULAR' THEN
  UPDATE public.transport_requests SET status='CANCELADA', updated_at=now() WHERE id=p_request RETURNING status INTO v_final;
 ELSE
  RAISE EXCEPTION 'Decisión no válida: reprogramar o anular';
 END IF;
 UPDATE public.delivery_rejections SET decision=CASE WHEN v_decision='REPROGRAMAR' THEN 'REPROGRAMADA' ELSE 'ANULADA' END,
   decision_reason=v_reason, decided_by=auth.uid(), decided_at=now() WHERE id=r.id;
 INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
 VALUES(p_request,auth.uid(),'STATUS_CHANGED',jsonb_build_object('status',t.status,'required_date',t.required_date),
   jsonb_build_object('status',v_final,'required_at',p_required_at,'reason','Rechazo en destino: '||v_reason));
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'RECHAZO_RESUELTO','Rechazo en destino de '||t.request_number||': '||CASE WHEN v_decision='REPROGRAMAR'
   THEN 'reprogramada para el '||to_char(p_required_at AT TIME ZONE 'America/Lima','DD/MM/YYYY HH24:MI') ELSE 'anulada' END||' · '||v_reason,auth.uid()::text);
 RETURN jsonb_build_object('success',true,'decision',v_decision,'request_status',v_final);
END $$;

-- Liquidación documentaria: la parada rechazada se liquida con la evidencia del rechazo y la decisión tomada
CREATE OR REPLACE FUNCTION public.settlement_checklist(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base jsonb; m public.settlement_manual_closures%ROWTYPE; rj public.delivery_rejections%ROWTYPE;
BEGIN
  SELECT * INTO rj FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request AND kind='TOTAL';
  IF rj.id IS NOT NULL THEN
    base:=jsonb_build_object('kind','RECHAZO','complete',rj.decision IS NOT NULL,
      'missing',CASE WHEN rj.decision IS NULL THEN '["DECISION_RECHAZO"]'::jsonb ELSE '[]'::jsonb END,
      'guide_state','RECHAZO_DESTINO','note',false,'packing',false,'references','[]'::jsonb,
      'rejection',jsonb_build_object('reason',public.delivery_rejection_reason_label(rj.reason_code),'note',rj.note,'photos',cardinality(rj.photos),
        'captured_at',rj.captured_at,'decision',rj.decision,'decision_reason',rj.decision_reason,'decided_at',rj.decided_at));
  ELSE
    base:=public.settlement_checklist_rules(p_dispatch,p_request);
  END IF;
  SELECT * INTO m FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  IF m.dispatch_id IS NULL OR (base->>'complete')::boolean THEN RETURN base; END IF;
  RETURN base||jsonb_build_object('complete',true,'missing','[]'::jsonb,'manual',jsonb_build_object(
    'reason',m.reason,'missing',base->'missing','closed_at',m.closed_at,
    'closed_by',(SELECT COALESCE(NULLIF(to_jsonb(p)->>'full_name',''),to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id=m.closed_by)));
END $$;
REVOKE ALL ON FUNCTION public.settlement_checklist(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settlement_checklist(uuid,uuid) TO service_role;

-- La bandeja «Liquidación pendiente» usa settlement_checklist: la parada rechazada con decisión ya no queda pendiente.

-- ============================================================================ B) Llegada al destino con ubicación
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS arrival_lat numeric;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS arrival_lon numeric;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS arrival_accuracy_m numeric;
ALTER TABLE public.delivery_conformities ADD COLUMN IF NOT EXISTS arrival_source text;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_conformities_arrival_source_check') THEN
  ALTER TABLE public.delivery_conformities ADD CONSTRAINT delivery_conformities_arrival_source_check
   CHECK (arrival_source IS NULL OR arrival_source IN ('MANUAL','COPILOTO','AUTO_GEOCERCA'));
 END IF;
END $c$;

CREATE OR REPLACE FUNCTION public.delivery_arrive_at(p_dispatch uuid, p_request uuid, p_lat numeric, p_lon numeric, p_accuracy numeric, p_source text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; c public.delivery_conformities; v_source text := upper(btrim(COALESCE(p_source,'MANUAL')));
BEGIN
 IF NOT public.delivery_can_read(p_dispatch) OR NOT (
  public.tercero_puede_operar(p_dispatch) OR EXISTS(SELECT 1 FROM public.dispatches x JOIN public.drivers r ON r.id=x.driver_id
  WHERE x.id=p_dispatch AND r.profile_id=auth.uid() AND r.is_active)) THEN RAISE EXCEPTION 'Sin permiso para registrar llegada'; END IF;
 IF v_source NOT IN ('MANUAL','COPILOTO','AUTO_GEOCERCA') THEN RAISE EXCEPTION 'Origen de la llegada no válido'; END IF;
 IF (p_lat IS NULL) <> (p_lon IS NULL) OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Ubicación no válida'; END IF;
 IF v_source='AUTO_GEOCERCA' AND (p_lat IS NULL OR p_accuracy IS NULL OR p_accuracy > 60) THEN
  RAISE EXCEPTION 'La llegada automática requiere un GPS preciso'; END IF;
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR d->>'status' NOT IN ('EN RUTA','EN_CURSO') OR NOT EXISTS(
  SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request AND status<>'ENTREGADO')
  OR public.delivery_rejected(p_dispatch,p_request) THEN
  RAISE EXCEPTION 'La entrega no está en ruta'; END IF;
 INSERT INTO public.delivery_conformities(dispatch_id,request_id) VALUES(p_dispatch,p_request) ON CONFLICT DO NOTHING;
 SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF c.arrived_at IS NOT NULL THEN
  RETURN jsonb_build_object('success',true,'already',true,'arrived_at',c.arrived_at,'source',c.arrival_source);
 END IF;
 UPDATE public.delivery_conformities SET arrived_at=now(), arrival_lat=p_lat, arrival_lon=p_lon, arrival_accuracy_m=p_accuracy,
   arrival_source=v_source, updated_at=now() WHERE dispatch_id=p_dispatch AND request_id=p_request;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'EN_DESTINO',CASE v_source WHEN 'AUTO_GEOCERCA' THEN 'Llegada registrada por el Copiloto al entrar en la geocerca del destino'
   WHEN 'COPILOTO' THEN 'Llegada confirmada desde el aviso del Copiloto' ELSE 'Llegada confirmada a una entrega' END
   ||COALESCE(' (GPS ±'||round(p_accuracy)::text||' m)',''),COALESCE(auth.uid()::text,'tercero'));
 RETURN jsonb_build_object('success',true,'arrived_at',now(),'source',v_source);
END $$;

-- El conductor deshace una llegada automática equivocada (solo la del Copiloto, sin guía ni rechazo, dentro de 30 min)
CREATE OR REPLACE FUNCTION public.delivery_arrive_undo(p_dispatch uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.delivery_conformities;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.dispatches x JOIN public.drivers r ON r.id=x.driver_id JOIN public.profiles p ON p.id=r.profile_id
   WHERE x.id=p_dispatch AND r.profile_id=auth.uid() AND r.is_active AND p.is_active) THEN RAISE EXCEPTION 'Ruta no autorizada'; END IF;
 SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
 IF c.arrived_at IS NULL THEN RETURN jsonb_build_object('success',true,'already',true); END IF;
 IF c.arrival_source IS DISTINCT FROM 'AUTO_GEOCERCA' OR c.state<>'PENDIENTE' OR c.current_submission_id IS NOT NULL
  OR c.arrived_at < now()-interval '30 minutes' OR EXISTS(SELECT 1 FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request) THEN
  RAISE EXCEPTION 'Solo se deshace una llegada automática reciente, antes de enviar la guía o el rechazo'; END IF;
 UPDATE public.delivery_conformities SET arrived_at=NULL, arrival_lat=NULL, arrival_lon=NULL, arrival_accuracy_m=NULL, arrival_source=NULL, updated_at=now()
 WHERE dispatch_id=p_dispatch AND request_id=p_request;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'LLEGADA_DESHECHA','El conductor deshizo la llegada registrada por el Copiloto',auth.uid()::text);
 RETURN jsonb_build_object('success',true);
END $$;

-- Punto del destino aprendido de entregas anteriores a la misma dirección (GPS de la guía o de la llegada confirmada)
CREATE OR REPLACE FUNCTION public.delivery_destination_point(p_request uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH target AS (SELECT public.norm_address(delivery_address) AS addr FROM public.transport_requests WHERE id=p_request),
 pts AS (
  SELECT x.lat, x.lon, x.at FROM (
   SELECT dr.arrival_lat::float8 AS lat, dr.arrival_lon::float8 AS lon, dr.created_at AS at, dr.transport_request_id AS rid
     FROM public.dispatch_requests dr WHERE dr.arrival_lat IS NOT NULL AND dr.arrival_lon IS NOT NULL
   UNION ALL
   SELECT c.arrival_lat::float8, c.arrival_lon::float8, c.arrived_at, c.request_id FROM public.delivery_conformities c
     WHERE c.arrival_source='MANUAL' AND c.arrival_lat IS NOT NULL AND COALESCE(c.arrival_accuracy_m,999)<=50
  ) x JOIN public.transport_requests t ON t.id=x.rid, target
  WHERE target.addr IS NOT NULL AND length(target.addr)>=8 AND public.norm_address(t.delivery_address)=target.addr
  ORDER BY x.at DESC NULLS LAST LIMIT 5),
 latest AS (SELECT lat, lon FROM pts LIMIT 1),
 near AS (SELECT p.lat, p.lon FROM pts p, latest l
   WHERE sqrt(power((p.lat-l.lat)*111320,2)+power((p.lon-l.lon)*111320*cos(radians(l.lat)),2)) <= 300)
 SELECT CASE WHEN count(*)=0 THEN NULL ELSE jsonb_build_object('lat',round(avg(lat)::numeric,6),'lon',round(avg(lon)::numeric,6),
   'samples',count(*),'radius_m',150) END FROM near;
$$;

-- Contexto del viaje en el app: estado de rechazo, llegada y punto aprendido de cada parada
DO $rename$
BEGIN
 IF to_regprocedure('public.get_active_trip_context_before_delivery_status()') IS NULL THEN
  ALTER FUNCTION public.get_active_trip_context() RENAME TO get_active_trip_context_before_delivery_status;
 END IF;
END $rename$;
REVOKE ALL ON FUNCTION public.get_active_trip_context_before_delivery_status() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_active_trip_context() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb := public.get_active_trip_context_before_delivery_status(); v_trip uuid := NULLIF(r#>>'{trip,id}','')::uuid;
BEGIN
 IF v_trip IS NULL OR jsonb_typeof(r#>'{trip,stops}') <> 'array' THEN RETURN r; END IF;
 r := jsonb_set(r, '{trip,stops}', COALESCE((SELECT jsonb_agg(s || jsonb_build_object(
    'conformity', CASE WHEN rj.kind='TOTAL' THEN to_jsonb('RECHAZO_DESTINO'::text) ELSE s->'conformity' END,
    'rejection', CASE WHEN rj.id IS NULL THEN NULL ELSE jsonb_build_object('kind',rj.kind,'reason',public.delivery_rejection_reason_label(rj.reason_code),
      'note',rj.note,'captured_at',rj.captured_at,'decision',rj.decision) END,
    'arrived_at', c.arrived_at, 'arrival_source', c.arrival_source,
    'destination', public.delivery_destination_point(NULLIF(s->>'transport_request_id','')::uuid)) ORDER BY o)
   FROM jsonb_array_elements(r#>'{trip,stops}') WITH ORDINALITY e(s,o)
   LEFT JOIN public.delivery_rejections rj ON rj.dispatch_id=v_trip AND rj.request_id=NULLIF(s->>'transport_request_id','')::uuid
   LEFT JOIN public.delivery_conformities c ON c.dispatch_id=v_trip AND c.request_id=NULLIF(s->>'transport_request_id','')::uuid), '[]'::jsonb));
 IF jsonb_typeof(r->'pending')='object' AND r->'pending' ? 'stops' THEN
  r := jsonb_set(r, '{pending,stops}', to_jsonb((SELECT count(*) FROM public.dispatch_requests dr WHERE dr.dispatch_id=v_trip AND dr.status<>'ENTREGADO'
    AND NOT public.delivery_rejected(dr.dispatch_id,dr.transport_request_id))));
 END IF;
 RETURN r;
END $$;

-- Conformidad: el detalle incluye el rechazo y la llegada
CREATE OR REPLACE FUNCTION public.delivery_get(p_dispatch uuid,p_request uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rj public.delivery_rejections; c public.delivery_conformities;
BEGIN
 IF NOT public.delivery_can_read(p_dispatch) THEN RAISE EXCEPTION 'Sin acceso a esta entrega'; END IF;
 SELECT * INTO rj FROM public.delivery_rejections WHERE dispatch_id=p_dispatch AND request_id=p_request;
 SELECT * INTO c FROM public.delivery_conformities WHERE dispatch_id=p_dispatch AND request_id=p_request;
 RETURN jsonb_build_object('state',CASE WHEN rj.kind='TOTAL' THEN 'RECHAZO_DESTINO' WHEN NOT public.delivery_required(p_dispatch,p_request) THEN 'NO_APLICA' ELSE COALESCE(c.state,'PENDIENTE') END,
  'arrived_at',c.arrived_at,'arrival_source',c.arrival_source,'arrival_accuracy_m',c.arrival_accuracy_m,
  'can_review',public.delivery_can_review(p_dispatch),
  'can_decide',rj.kind='TOTAL' AND rj.decision IS NULL AND public.delivery_rejection_can_decide(p_dispatch),
  'rejection',CASE WHEN rj.id IS NULL THEN NULL ELSE jsonb_build_object('id',rj.id,'kind',rj.kind,'reason_code',rj.reason_code,
    'reason',public.delivery_rejection_reason_label(rj.reason_code),'note',rj.note,'photos',to_jsonb(rj.photos),'latitude',rj.latitude,'longitude',rj.longitude,
    'accuracy_m',rj.accuracy_m,'captured_at',rj.captured_at,'decision',rj.decision,'decision_reason',rj.decision_reason,'decided_at',rj.decided_at,
    'decided_by',(SELECT COALESCE(NULLIF(to_jsonb(p)->>'full_name',''),NULLIF(trim(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name')),''),to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id=rj.decided_by),
    'required_date',(SELECT required_date FROM public.transport_requests WHERE id=p_request)) END,
  'submissions',COALESCE((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('review',(
   SELECT to_jsonb(r) FROM public.delivery_reviews r WHERE r.submission_id=s.id)) ORDER BY s.submitted_at DESC)
   FROM public.delivery_submissions s WHERE s.dispatch_id=p_dispatch AND s.request_id=p_request),'[]'::jsonb));
END $$;

-- Acción guardada sin señal: el rechazo se sincroniza como la guía
DO $patch$
DECLARE def text; anchor text := 'IF p_action_type = ''delivery_submit_driver'' THEN';
BEGIN
 def := pg_get_functiondef('public.execute_driver_offline_action(uuid,text,jsonb)'::regprocedure);
 IF position('delivery_reject_driver' IN def) > 0 THEN RETURN; END IF;
 IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'Acciones offline no reconocidas: revisar antes de migrar'; END IF;
 EXECUTE replace(def, anchor, $branch$IF p_action_type = 'delivery_reject_driver' THEN
    v_result := public.delivery_reject_driver((p_payload->>'dispatch_id')::uuid,(p_payload->>'request_id')::uuid,p_payload->>'kind',
      p_payload->>'reason',p_payload->>'note',ARRAY(SELECT jsonb_array_elements_text(p_payload->'photos')),
      NULLIF(p_payload->>'latitude','')::numeric,NULLIF(p_payload->>'longitude','')::numeric,NULLIF(p_payload->>'accuracy_m','')::numeric,
      p_operation_id,(p_payload->>'captured_at')::timestamptz);
  ELSIF p_action_type = 'delivery_submit_driver' THEN$branch$);
END $patch$;

-- Permisos
REVOKE ALL ON FUNCTION public.delivery_rejected(uuid,uuid), public.delivery_open_required(uuid,uuid), public.delivery_rejection_reason_label(text),
  public.delivery_rejection_notify(uuid), public.delivery_rejection_can_decide(uuid), public.delivery_destination_point(uuid),
  public.delivery_reject_driver(uuid,uuid,text,text,text,text[],numeric,numeric,numeric,uuid,timestamptz),
  public.delivery_rejection_decide(uuid,uuid,text,text,timestamptz,text),
  public.delivery_arrive_at(uuid,uuid,numeric,numeric,numeric,text), public.delivery_arrive_undo(uuid,uuid),
  public.get_active_trip_context(), public.delivery_get(uuid,uuid), public.delivery_photo_mutable(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_reject_driver(uuid,uuid,text,text,text,text[],numeric,numeric,numeric,uuid,timestamptz),
  public.delivery_rejection_decide(uuid,uuid,text,text,timestamptz,text),
  public.delivery_arrive_at(uuid,uuid,numeric,numeric,numeric,text), public.delivery_arrive_undo(uuid,uuid),
  public.get_active_trip_context(), public.delivery_get(uuid,uuid), public.delivery_photo_mutable(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_trip_context() TO service_role;
NOTIFY pgrst, 'reload schema';
