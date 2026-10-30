-- Etapa 5: cierre documentario por servicio, persistido e independiente del cierre económico (Etapa 4).
-- El cierre documentario dice si la operación quedó documentada (guías, notas, Packing List, conformidad, decisión del
-- rechazo); no toca montos, la liquidación económica ni el estado LIQUIDADO de la ruta.
--   * documentary_closures: estado por servicio (despacho + solicitud): PENDIENTE | EN_VALIDACION | OBSERVADO | COMPLETO,
--     con origen (AUTOMATICO por la regla de settlement_checklist | MANUAL), quién y cuándo lo completó, y la reapertura.
--   * documentary_closure_events: historial solo de inserción (estado anterior → nuevo, usuario, fecha y motivo).
--   * Se sincroniza con triggers sobre la evidencia (documentos, referencias, conformidad, sustentos, rechazos), desde
--     los RPC de cierre manual / deshacer / reabrir y al consultar la lista (get_settlement_checklists).
--   * Deshacer el cierre manual exige motivo y deja el registro en el historial; reabrir un COMPLETO exige motivo y lo
--     limitan los mismos cargos que el cierre manual (can_settle_manually).
-- Producción no coincide con el repo: tablas IF NOT EXISTS, columnas opcionales con to_jsonb y triggers solo si la tabla existe.

CREATE TABLE IF NOT EXISTS public.documentary_closures (
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDIENTE' CHECK (status IN ('PENDIENTE','EN_VALIDACION','OBSERVADO','COMPLETO')),
  source text CHECK (source IN ('AUTOMATICO','MANUAL')),
  service_kind text,
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  completed_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text CHECK (reopen_reason IS NULL OR length(btrim(reopen_reason)) BETWEEN 10 AND 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, request_id),
  CHECK ((status = 'COMPLETO') = (source IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documentary_closures_request_idx ON public.documentary_closures(request_id);
ALTER TABLE public.documentary_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.documentary_closures;
CREATE POLICY security_active_account ON public.documentary_closures AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.documentary_closures FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.documentary_closure_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('INICIAL','AUTOMATICO','CIERRE_MANUAL','DESHACER_MANUAL','REAPERTURA')),
  previous_status text,
  new_status text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS documentary_closure_events_service_idx ON public.documentary_closure_events(dispatch_id, request_id, created_at);
CREATE INDEX IF NOT EXISTS documentary_closure_events_request_idx ON public.documentary_closure_events(request_id);
ALTER TABLE public.documentary_closure_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.documentary_closure_events;
CREATE POLICY security_active_account ON public.documentary_closure_events AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.documentary_closure_events FROM PUBLIC, anon, authenticated;

-- Historial solo de inserción: no se edita ni se borra (salvo en cascada al eliminar la ruta o la solicitud).
CREATE OR REPLACE FUNCTION public.documentary_closure_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'El historial del cierre documentario no se modifica ni se elimina';
END $$;
REVOKE ALL ON FUNCTION public.documentary_closure_events_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS documentary_closure_events_append_only ON public.documentary_closure_events;
CREATE TRIGGER documentary_closure_events_append_only BEFORE UPDATE OR DELETE ON public.documentary_closure_events
  FOR EACH ROW EXECUTE FUNCTION public.documentary_closure_events_append_only();

-- Nombre visible del usuario (producción no tiene las mismas columnas en profiles que el repo)
CREATE OR REPLACE FUNCTION public.documentary_actor_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(NULLIF(btrim(to_jsonb(p)->>'full_name'),''),
    NULLIF(btrim(COALESCE(to_jsonb(p)->>'first_name','')||' '||COALESCE(to_jsonb(p)->>'last_name','')),''),
    NULLIF(to_jsonb(p)->>'email',''), NULLIF(to_jsonb(p)->>'username',''))
  FROM public.profiles p WHERE p.id = p_user;
$$;
REVOKE ALL ON FUNCTION public.documentary_actor_name(uuid) FROM PUBLIC, anon, authenticated;

-- Evidencia del servicio: regla por tipo de servicio, rechazo en destino y cierre manual (lo que era settlement_checklist).
CREATE OR REPLACE FUNCTION public.settlement_checklist_evidence(p_dispatch uuid,p_request uuid) RETURNS jsonb
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
    'reason',m.reason,'missing',base->'missing','closed_at',m.closed_at,'closed_by',public.documentary_actor_name(m.closed_by)));
END $$;
REVOKE ALL ON FUNCTION public.settlement_checklist_evidence(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- Lista de verificación: la evidencia más la reapertura (un servicio reabierto vuelve a «Liquidación pendiente»).
CREATE OR REPLACE FUNCTION public.settlement_checklist(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base jsonb:=public.settlement_checklist_evidence(p_dispatch,p_request); c public.documentary_closures%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.documentary_closures WHERE dispatch_id=p_dispatch AND request_id=p_request AND reopened_at IS NOT NULL;
  IF c.dispatch_id IS NULL THEN RETURN base; END IF;
  RETURN base||jsonb_build_object('complete',false,'missing',COALESCE(base->'missing','[]'::jsonb)||'["REAPERTURA"]'::jsonb,
    'reopened',jsonb_build_object('reason',c.reopen_reason,'at',c.reopened_at,'by',public.documentary_actor_name(c.reopened_by)));
END $$;
REVOKE ALL ON FUNCTION public.settlement_checklist(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settlement_checklist(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.documentary_closure_json(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('status',c.status,'source',c.source,'completed_at',c.completed_at,
    'completed_by',public.documentary_actor_name(c.completed_by),'reopened_at',c.reopened_at,'reopen_reason',c.reopen_reason,
    'reopened_by',public.documentary_actor_name(c.reopened_by),'updated_at',c.updated_at)
  FROM public.documentary_closures c WHERE c.dispatch_id=p_dispatch AND c.request_id=p_request;
$$;
REVOKE ALL ON FUNCTION public.documentary_closure_json(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- Sincroniza el estado persistido con la lista de verificación y registra el cambio en el historial.
--   SINCRONIZACION: consulta o carga inicial (sin usuario). CAMBIO: trigger de evidencia. EVIDENCIA: evidencia nueva
--   (documento, referencia, sustento, GR validada, decisión del rechazo): además levanta la reapertura.
--   CIERRE_MANUAL / DESHACER_MANUAL / REAPERTURA: acciones de usuario, siempre quedan en el historial con su motivo.
CREATE OR REPLACE FUNCTION public.documentary_closure_sync(p_dispatch uuid,p_request uuid,p_action text,p_reason text DEFAULT NULL,p_details jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cur public.documentary_closures%ROWTYPE; cl jsonb; v_status text; v_source text; v_log text; v_completed_at timestamptz; v_completed_by uuid;
  v_explicit boolean:=p_action IN ('CIERRE_MANUAL','DESHACER_MANUAL','REAPERTURA');
  v_actor uuid:=CASE WHEN p_action='SINCRONIZACION' THEN NULL ELSE auth.uid() END; m public.settlement_manual_closures%ROWTYPE;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('SINCRONIZACION','CAMBIO','EVIDENCIA','CIERRE_MANUAL','DESHACER_MANUAL','REAPERTURA') THEN
    RAISE EXCEPTION 'Acción de cierre documentario no válida: %',p_action; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=p_dispatch) OR NOT EXISTS(SELECT 1 FROM public.transport_requests WHERE id=p_request) THEN
    RETURN public.settlement_checklist(p_dispatch,p_request); END IF;
  SELECT * INTO cur FROM public.documentary_closures WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
  IF cur.reopened_at IS NOT NULL AND p_action IN ('EVIDENCIA','CIERRE_MANUAL') THEN
    UPDATE public.documentary_closures SET reopened_at=NULL,reopened_by=NULL,reopen_reason=NULL
     WHERE dispatch_id=p_dispatch AND request_id=p_request;
  END IF;
  cl:=public.settlement_checklist(p_dispatch,p_request);
  v_status:=CASE WHEN cl ? 'reopened' THEN 'OBSERVADO' WHEN (cl->>'complete')::boolean THEN 'COMPLETO'
    WHEN cl->>'guide_state' IN ('OBSERVADA','RECHAZADA') THEN 'OBSERVADO' WHEN cl->>'guide_state'='RECIBIDA' THEN 'EN_VALIDACION' ELSE 'PENDIENTE' END;
  v_source:=CASE WHEN v_status<>'COMPLETO' THEN NULL WHEN cur.status='COMPLETO' AND NOT v_explicit THEN cur.source
    WHEN cl ? 'manual' OR p_action='CIERRE_MANUAL' THEN 'MANUAL' ELSE 'AUTOMATICO' END;
  SELECT * INTO m FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  IF v_status='COMPLETO' AND cur.status='COMPLETO' THEN
    v_completed_at:=cur.completed_at; v_completed_by:=cur.completed_by;
  ELSIF v_status='COMPLETO' THEN
    v_completed_at:=CASE WHEN v_source='MANUAL' AND m.dispatch_id IS NOT NULL THEN m.closed_at ELSE now() END;
    v_completed_by:=CASE WHEN v_source='MANUAL' AND m.dispatch_id IS NOT NULL THEN m.closed_by ELSE v_actor END;
  END IF;

  IF cur.dispatch_id IS NULL THEN
    INSERT INTO public.documentary_closures(dispatch_id,request_id,status,source,service_kind,missing,completed_at,completed_by,updated_at)
    VALUES(p_dispatch,p_request,v_status,v_source,cl->>'kind',COALESCE(cl->'missing','[]'::jsonb),v_completed_at,v_completed_by,now())
    ON CONFLICT (dispatch_id,request_id) DO NOTHING;
    -- Otra sesión lo creó a la vez (dos consultas simultáneas): se vuelve a evaluar sobre esa fila
    IF NOT FOUND THEN RETURN public.documentary_closure_sync(p_dispatch,p_request,p_action,p_reason,p_details); END IF;
    v_log:=CASE WHEN v_explicit THEN p_action ELSE 'INICIAL' END;
  ELSIF cur.status IS DISTINCT FROM v_status OR cur.source IS DISTINCT FROM v_source OR cur.service_kind IS DISTINCT FROM cl->>'kind'
     OR cur.missing IS DISTINCT FROM COALESCE(cl->'missing','[]'::jsonb) OR cur.completed_by IS DISTINCT FROM v_completed_by THEN
    UPDATE public.documentary_closures SET status=v_status,source=v_source,service_kind=cl->>'kind',missing=COALESCE(cl->'missing','[]'::jsonb),
      completed_at=v_completed_at,completed_by=v_completed_by,updated_at=now()
     WHERE dispatch_id=p_dispatch AND request_id=p_request;
    v_log:=CASE WHEN v_explicit THEN p_action WHEN cur.status IS DISTINCT FROM v_status OR cur.source IS DISTINCT FROM v_source THEN 'AUTOMATICO' END;
  ELSIF v_explicit THEN
    v_log:=p_action;
  END IF;
  IF v_log IS NOT NULL THEN
    INSERT INTO public.documentary_closure_events(dispatch_id,request_id,action,previous_status,new_status,reason,details,actor_id)
    VALUES(p_dispatch,p_request,v_log,cur.status,v_status,NULLIF(btrim(COALESCE(p_reason,'')),''),
      COALESCE(p_details,'{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('source',v_source,'kind',cl->>'kind','missing',cl->'missing')),v_actor);
  END IF;
  RETURN cl||jsonb_build_object('documentary',public.documentary_closure_json(p_dispatch,p_request));
END $$;
REVOKE ALL ON FUNCTION public.documentary_closure_sync(uuid,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;

-- Triggers de evidencia: un error al sincronizar nunca bloquea la operación (la consulta lo vuelve a sincronizar).
CREATE OR REPLACE FUNCTION public.documentary_closure_evidence_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE recs jsonb[]:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[to_jsonb(NEW)] WHEN 'DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(NEW),to_jsonb(OLD)] END;
  v_action text:='CAMBIO'; x record;
BEGIN
  -- Evidencia nueva: documento, referencia o sustento cargado, GR validada o decisión del rechazo
  IF (TG_OP='INSERT' AND TG_TABLE_NAME IN ('dispatch_documents','dispatch_document_references','delivery_submissions'))
   OR (TG_OP<>'DELETE' AND TG_TABLE_NAME='delivery_conformities' AND to_jsonb(NEW)->>'state'='VALIDADA')
   OR (TG_OP<>'DELETE' AND TG_TABLE_NAME='delivery_rejections' AND to_jsonb(NEW)->>'decision' IS NOT NULL
       AND (TG_OP='INSERT' OR to_jsonb(OLD)->>'decision' IS NULL)) THEN
    v_action:='EVIDENCIA';
  END IF;
  FOR x IN SELECT DISTINCT dr.dispatch_id,dr.transport_request_id AS request_id
    FROM unnest(recs) j JOIN public.dispatch_requests dr ON dr.dispatch_id=NULLIF(j->>'dispatch_id','')::uuid
    WHERE NULLIF(COALESCE(j->>'request_id',j->>'transport_request_id'),'') IS NULL
       OR dr.transport_request_id=(COALESCE(j->>'request_id',j->>'transport_request_id'))::uuid
  LOOP
    BEGIN
      PERFORM public.documentary_closure_sync(x.dispatch_id,x.request_id,v_action,NULL,NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Cierre documentario no sincronizado (% / %): %',x.dispatch_id,x.request_id,SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.documentary_closure_evidence_trigger() FROM PUBLIC, anon, authenticated;

DO $triggers$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('dispatch_documents','AFTER INSERT OR DELETE OR UPDATE OF voided_at, transport_request_id, doc_type'),
    ('dispatch_document_references','AFTER INSERT OR DELETE'),
    ('delivery_conformities','AFTER INSERT OR DELETE OR UPDATE OF state'),
    ('delivery_submissions','AFTER INSERT'),
    ('delivery_rejections','AFTER INSERT OR DELETE OR UPDATE OF decision')) v(tbl,events)
  LOOP
    IF to_regclass('public.'||t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS documentary_closure_sync ON public.%I',t.tbl);
      EXECUTE format('CREATE TRIGGER documentary_closure_sync %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.documentary_closure_evidence_trigger()',t.events,t.tbl);
    END IF;
  END LOOP;
END $triggers$;

-- Cierre manual («Dar por liquidado» en la pantalla anterior): queda como cierre documentario MANUAL con su motivo.
-- Un servicio reabierto con la evidencia completa se vuelve a cerrar aquí sin registrar faltantes.
CREATE OR REPLACE FUNCTION public.settlement_mark_settled(p_dispatch uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; base jsonb; v_reopened boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.can_settle_manually() THEN
    RAISE EXCEPTION 'Solo el Administrador, el Jefe de Distribución, el Supervisor de Transporte o Despacho pueden dar por liquidado'; END IF;
  IF length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Indique el motivo (10 a 500 caracteres)'; END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
  IF d IS NULL OR NOT public.can_access_site(NULLIF(d->>'site_id','')::uuid) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
  IF d->>'status' IN ('PROGRAMADO','CANCELADO') THEN
    RAISE EXCEPTION 'Solo se liquida un servicio de una ruta que ya salió (estado %)',d->>'status'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request) THEN
    RAISE EXCEPTION 'La solicitud no pertenece a este despacho'; END IF;
  base:=public.settlement_checklist_evidence(p_dispatch,p_request);
  v_reopened:=EXISTS(SELECT 1 FROM public.documentary_closures WHERE dispatch_id=p_dispatch AND request_id=p_request AND reopened_at IS NOT NULL);
  IF (base->>'complete')::boolean AND NOT v_reopened THEN RAISE EXCEPTION 'El servicio ya tiene su cierre documentario completo'; END IF;
  IF NOT (base->>'complete')::boolean THEN
    INSERT INTO public.settlement_manual_closures(dispatch_id,request_id,reason,missing,closed_by)
    VALUES(p_dispatch,p_request,btrim(p_reason),COALESCE(base->'missing','[]'::jsonb),auth.uid())
    ON CONFLICT (dispatch_id,request_id) DO UPDATE SET reason=EXCLUDED.reason,missing=EXCLUDED.missing,closed_by=EXCLUDED.closed_by,closed_at=now();
  END IF;
  PERFORM public.documentary_closure_sync(p_dispatch,p_request,'CIERRE_MANUAL',btrim(p_reason),
    jsonb_build_object('faltaba',CASE WHEN (base->>'complete')::boolean THEN '[]'::jsonb ELSE COALESCE(base->'missing','[]'::jsonb) END));
  RETURN public.settlement_checklist(p_dispatch,p_request);
END $$;
REVOKE ALL ON FUNCTION public.settlement_mark_settled(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_mark_settled(uuid,uuid,text) TO authenticated;

-- Deshacer el cierre manual: exige motivo y el registro pasa al historial (antes se borraba sin rastro).
DROP FUNCTION IF EXISTS public.settlement_undo_manual(uuid,uuid);
CREATE OR REPLACE FUNCTION public.settlement_undo_manual(p_dispatch uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; m public.settlement_manual_closures%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.can_settle_manually() THEN
    RAISE EXCEPTION 'Sin permiso para revertir la liquidación manual'; END IF;
  IF length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Indique el motivo (10 a 500 caracteres)'; END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch;
  IF d IS NULL OR NOT public.can_access_site(NULLIF(d->>'site_id','')::uuid) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
  SELECT * INTO m FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
  IF m.dispatch_id IS NULL THEN RAISE EXCEPTION 'El servicio no tiene liquidación manual'; END IF;
  DELETE FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  PERFORM public.documentary_closure_sync(p_dispatch,p_request,'DESHACER_MANUAL',btrim(p_reason),
    jsonb_build_object('cierre_manual',jsonb_build_object('reason',m.reason,'missing',m.missing,'closed_at',m.closed_at,'closed_by',m.closed_by,
      'closed_by_name',public.documentary_actor_name(m.closed_by))));
  RETURN public.settlement_checklist(p_dispatch,p_request);
END $$;
REVOKE ALL ON FUNCTION public.settlement_undo_manual(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_undo_manual(uuid,uuid,text) TO authenticated;

-- Reapertura formal de un cierre documentario COMPLETO: motivo obligatorio, mismos cargos que el cierre manual.
-- El servicio queda OBSERVADO (vuelve a «Liquidación pendiente») hasta que llegue evidencia nueva o se cierre manualmente.
CREATE OR REPLACE FUNCTION public.documentary_reopen(p_dispatch uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; cl jsonb; m public.settlement_manual_closures%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.can_settle_manually() THEN
    RAISE EXCEPTION 'Solo el Administrador, el Jefe de Distribución, el Supervisor de Transporte o Despacho pueden reabrir el cierre documentario'; END IF;
  IF length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Indique el motivo (10 a 500 caracteres)'; END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
  IF d IS NULL OR NOT public.can_access_site(NULLIF(d->>'site_id','')::uuid) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.dispatch_requests WHERE dispatch_id=p_dispatch AND transport_request_id=p_request) THEN
    RAISE EXCEPTION 'La solicitud no pertenece a este despacho'; END IF;
  cl:=public.documentary_closure_sync(p_dispatch,p_request,'SINCRONIZACION',NULL,NULL);
  IF cl->'documentary'->>'status' IS DISTINCT FROM 'COMPLETO' THEN
    RAISE EXCEPTION 'Solo se reabre un cierre documentario completo (estado %)',COALESCE(cl->'documentary'->>'status','sin registro'); END IF;
  SELECT * INTO m FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request FOR UPDATE;
  IF m.dispatch_id IS NOT NULL THEN
    DELETE FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  END IF;
  UPDATE public.documentary_closures SET reopened_at=now(),reopened_by=auth.uid(),reopen_reason=btrim(p_reason)
   WHERE dispatch_id=p_dispatch AND request_id=p_request;
  RETURN public.documentary_closure_sync(p_dispatch,p_request,'REAPERTURA',btrim(p_reason),
    CASE WHEN m.dispatch_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('cierre_manual',jsonb_build_object('reason',m.reason,'missing',m.missing,
      'closed_at',m.closed_at,'closed_by',m.closed_by,'closed_by_name',public.documentary_actor_name(m.closed_by))) END);
END $$;
REVOKE ALL ON FUNCTION public.documentary_reopen(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.documentary_reopen(uuid,uuid,text) TO authenticated;

-- Lista de verificación por servicio para la pantalla, con el cierre documentario persistido (se sincroniza al consultar).
CREATE OR REPLACE FUNCTION public.get_settlement_checklists(p_dispatches uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho') OR public.can_settle_manually()) THEN
    RAISE EXCEPTION 'Sin permiso para ver la liquidación documentaria'; END IF;
  IF COALESCE(cardinality(p_dispatches),0)>200 THEN RAISE EXCEPTION 'Consulte hasta 200 despachos por vez'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('dispatch_id',s.dispatch_id,'request_id',s.request_id)
      ||public.documentary_closure_sync(s.dispatch_id,s.request_id,'SINCRONIZACION',NULL,NULL))
    FROM (SELECT DISTINCT dr.dispatch_id,dr.transport_request_id AS request_id FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id
      WHERE dr.dispatch_id=ANY(p_dispatches) AND public.can_access_site(d.site_id) ORDER BY 1,2) s),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_settlement_checklists(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_settlement_checklists(uuid[]) TO authenticated;

-- Historial del cierre documentario de un servicio
CREATE OR REPLACE FUNCTION public.get_documentary_closure_history(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho') OR public.can_settle_manually()) THEN
    RAISE EXCEPTION 'Sin permiso para ver la liquidación documentaria'; END IF;
  SELECT NULLIF(to_jsonb(d)->>'site_id','')::uuid INTO v_site FROM public.dispatches d WHERE d.id=p_dispatch;
  IF NOT FOUND OR NOT public.can_access_site(v_site) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'previous_status',e.previous_status,'new_status',e.new_status,
      'reason',e.reason,'details',e.details,'created_at',e.created_at,'actor',public.documentary_actor_name(e.actor_id)) ORDER BY e.created_at DESC)
    FROM public.documentary_closure_events e WHERE e.dispatch_id=p_dispatch AND e.request_id=p_request),'[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.get_documentary_closure_history(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_documentary_closure_history(uuid,uuid) TO authenticated;

-- Carga inicial: servicios de rutas vigentes que ya salieron (no programadas ni canceladas; las liquidadas o cerradas
-- solo de los últimos 120 días) sin estado persistido. Las más antiguas se registran al consultarlas.
-- Idempotente: solo crea lo que falta; las siguientes ejecuciones no agregan filas ni historial.
CREATE OR REPLACE FUNCTION public.documentary_closure_backfill() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x record; n integer:=0;
BEGIN
  FOR x IN SELECT DISTINCT dr.dispatch_id,dr.transport_request_id AS request_id
    FROM public.dispatch_requests dr JOIN public.dispatches d ON d.id=dr.dispatch_id JOIN public.transport_requests t ON t.id=dr.transport_request_id
    WHERE COALESCE(d.status::text,'') NOT IN ('','PROGRAMADO','CANCELADO')
      AND (d.status::text NOT IN ('LIQUIDADO','CERRADO') OR d.scheduled_departure >= now() - interval '120 days')
      AND NOT EXISTS(SELECT 1 FROM public.documentary_closures c WHERE c.dispatch_id=dr.dispatch_id AND c.request_id=dr.transport_request_id)
  LOOP
    BEGIN
      PERFORM public.documentary_closure_sync(x.dispatch_id,x.request_id,'SINCRONIZACION',NULL,'{"carga_inicial":true}'::jsonb);
      n:=n+1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Carga inicial del cierre documentario omitida (% / %): %',x.dispatch_id,x.request_id,SQLERRM;
    END;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.documentary_closure_backfill() FROM PUBLIC, anon, authenticated;

SELECT public.documentary_closure_backfill();
NOTIFY pgrst,'reload schema';
