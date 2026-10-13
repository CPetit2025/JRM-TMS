-- «Dar por liquidado» manual, además de la liquidación automática por servicio.
-- Lo usan el Administrador, el Jefe de Distribución, el Supervisor de Transporte y los roles de Despacho
-- (no el Auditor de Despacho). Exige motivo, queda auditado (quién, cuándo, qué faltaba) y se puede revertir.
-- La regla automática no cambia: settlement_checklist sigue siendo la única fuente para la bandeja y la pantalla.
CREATE TABLE IF NOT EXISTS public.settlement_manual_closures (
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  closed_by uuid,
  closed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, request_id)
);
ALTER TABLE public.settlement_manual_closures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.settlement_manual_closures;
CREATE POLICY security_active_account ON public.settlement_manual_closures AS RESTRICTIVE FOR ALL TO authenticated
 USING((SELECT public.is_active_tms_user())) WITH CHECK((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.settlement_manual_closures FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.can_settle_manually() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
    WHERE p.id=auth.uid() AND p.is_active AND (
      lower(btrim(r.name)) IN ('administrador','jefe de distribución','supervisor de transporte')
      OR (lower(r.name) LIKE '%despach%' AND lower(btrim(r.name))<>'auditor de despacho')));
$$;
REVOKE ALL ON FUNCTION public.can_settle_manually() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_settle_manually() TO authenticated;

-- La regla por tipo de servicio queda como base; la lista de verificación agrega el cierre manual.
DO $rename$
BEGIN
  IF to_regprocedure('public.settlement_checklist_rules(uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.settlement_checklist(uuid,uuid) RENAME TO settlement_checklist_rules;
  END IF;
END $rename$;
REVOKE ALL ON FUNCTION public.settlement_checklist_rules(uuid,uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settlement_checklist(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base jsonb:=public.settlement_checklist_rules(p_dispatch,p_request); m public.settlement_manual_closures%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  IF m.dispatch_id IS NULL OR (base->>'complete')::boolean THEN RETURN base; END IF;
  RETURN base||jsonb_build_object('complete',true,'missing','[]'::jsonb,'manual',jsonb_build_object(
    'reason',m.reason,'missing',base->'missing','closed_at',m.closed_at,
    'closed_by',(SELECT COALESCE(NULLIF(to_jsonb(p)->>'full_name',''),to_jsonb(p)->>'email') FROM public.profiles p WHERE p.id=m.closed_by)));
END $$;
REVOKE ALL ON FUNCTION public.settlement_checklist(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settlement_checklist(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.settlement_mark_settled(p_dispatch uuid,p_request uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; base jsonb;
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
  base:=public.settlement_checklist_rules(p_dispatch,p_request);
  IF (base->>'complete')::boolean THEN RAISE EXCEPTION 'El servicio ya está liquidado con sus documentos'; END IF;
  INSERT INTO public.settlement_manual_closures(dispatch_id,request_id,reason,missing,closed_by)
  VALUES(p_dispatch,p_request,btrim(p_reason),COALESCE(base->'missing','[]'::jsonb),auth.uid())
  ON CONFLICT (dispatch_id,request_id) DO UPDATE SET reason=EXCLUDED.reason,missing=EXCLUDED.missing,closed_by=EXCLUDED.closed_by,closed_at=now();
  RETURN public.settlement_checklist(p_dispatch,p_request);
END $$;
REVOKE ALL ON FUNCTION public.settlement_mark_settled(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_mark_settled(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.settlement_undo_manual(p_dispatch uuid,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.can_settle_manually() THEN
    RAISE EXCEPTION 'Sin permiso para revertir la liquidación manual'; END IF;
  SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch;
  IF d IS NULL OR NOT public.can_access_site(NULLIF(d->>'site_id','')::uuid) THEN RAISE EXCEPTION 'Despacho inexistente o sede no autorizada'; END IF;
  DELETE FROM public.settlement_manual_closures WHERE dispatch_id=p_dispatch AND request_id=p_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'El servicio no tiene liquidación manual'; END IF;
  RETURN public.settlement_checklist(p_dispatch,p_request);
END $$;
REVOKE ALL ON FUNCTION public.settlement_undo_manual(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settlement_undo_manual(uuid,uuid) TO authenticated;

-- Despacho también ve la lista de verificación (para el botón), no solo Documentos.
DO $patch$
DECLARE sig regprocedure:='public.get_settlement_checklists(uuid[])'::regprocedure; def text; changed text;
BEGIN
  def:=pg_get_functiondef(sig);
  changed:=replace(def,$o$NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho'))$o$,
    $n$NOT (public.has_tms_permission('documentario') OR public.has_tms_permission('despacho') OR public.can_settle_manually())$n$);
  IF changed=def THEN RAISE EXCEPTION 'Motor no reconocido: %',sig; END IF;
  EXECUTE changed;
END $patch$;
