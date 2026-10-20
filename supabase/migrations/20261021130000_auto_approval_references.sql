-- Automatic approval also covers valid OC/OS/RQ requests without inventing an OT.
-- The privilege exception is private, per request/actor/transaction; no browser-set flag authorizes approval.
BEGIN;

CREATE TABLE public.transport_request_auto_approval_contexts (
 request_id uuid PRIMARY KEY REFERENCES public.transport_requests(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 transaction_id bigint NOT NULL,
 backend_pid integer NOT NULL
);
CREATE INDEX transport_request_auto_approval_context_actor_idx ON public.transport_request_auto_approval_contexts(actor_id);
ALTER TABLE public.transport_request_auto_approval_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.transport_request_auto_approval_contexts AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.transport_request_auto_approval_contexts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.is_transport_request_auto_approval(p_request_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.is_active_tms_user() AND public.transport_request_auto_approve_enabled() AND EXISTS (
  SELECT 1 FROM public.transport_request_auto_approval_contexts c
  WHERE c.request_id=p_request_id AND c.actor_id=auth.uid()
   AND c.transaction_id=txid_current() AND c.backend_pid=pg_backend_pid()
 );
$$;
REVOKE ALL ON FUNCTION public.is_transport_request_auto_approval(uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Preserve the installed approval, cancellation, funding and reference rules.
-- Only the private save-time context may substitute the supervisor permission.
DO $patch$
DECLARE v_source text; v_old text:=$old$NOT public.has_tms_permission('despacho-aprobacion')$old$; v_count integer;
BEGIN
 v_source:=pg_get_functiondef('public.transport_request_budget_sync()'::regprocedure);
 v_count:=(length(v_source)-length(replace(v_source,v_old,'')))/length(v_old);
 IF v_count<>2 THEN RAISE EXCEPTION 'Motor de aprobación de transporte no reconocido: % controles',v_count; END IF;
 EXECUTE replace(v_source,v_old,
  $new$(NOT public.has_tms_permission('despacho-aprobacion') AND NOT public.is_transport_request_auto_approval(NEW.id))$new$);
 v_source:=pg_get_functiondef('public.request_attention_guard()'::regprocedure);
 v_count:=(length(v_source)-length(replace(v_source,v_old,'')))/length(v_old);
 IF v_count<>1 THEN RAISE EXCEPTION 'Control de importe operacional no reconocido: % controles',v_count; END IF;
 EXECUTE replace(v_source,v_old,
  $new$(NOT public.has_tms_permission('despacho-aprobacion') AND NOT public.is_transport_request_auto_approval(NEW.id))$new$);
END $patch$;

CREATE OR REPLACE FUNCTION public.transport_request_try_auto_approve(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.transport_requests%ROWTYPE; v_status text; v_cost numeric;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT public.transport_request_auto_approve_enabled() THEN RETURN false; END IF;
 SELECT * INTO r FROM public.transport_requests WHERE id=p_request_id FOR UPDATE;
 IF r.id IS NULL OR NOT public.can_access_site(r.site_id)
  OR r.status NOT IN ('PENDIENTE','PENDIENTE DE APROBACIÓN')
  OR (r.contract_id IS NULL AND NOT public.is_reference_transport(r))
  OR NULLIF(btrim(r.budget_observation),'') IS NOT NULL OR COALESCE(r.budget_shortfall,0)>0
  OR (public.is_contract_administrator() AND NOT public.has_assigned_request(r.id,true))
  OR public.request_party_missing(r.id) IS NOT NULL THEN RETURN false; END IF;
 v_cost:=COALESCE(r.service_cost,0)+COALESCE(r.unloading_estimate_pen,0);
 IF COALESCE(r.service_cost,0)<0 OR COALESCE(r.unloading_estimate_pen,0)<0
  OR v_cost::text IN ('NaN','Infinity','-Infinity') THEN RETURN false; END IF;
 IF r.contract_id IS NULL AND r.attention_mode IS DISTINCT FROM 'RECOJO_CLIENTE' AND NOT EXISTS (
  SELECT 1 FROM public.suppliers s WHERE s.id=r.supplier_id AND COALESCE((to_jsonb(s)->>'is_active')::boolean,true)
 ) THEN RETURN false; END IF;

 INSERT INTO public.transport_request_auto_approval_contexts(request_id,actor_id,transaction_id,backend_pid)
 VALUES(r.id,auth.uid(),txid_current(),pg_backend_pid());
 UPDATE public.transport_requests SET status='APROBADA',updated_at=now() WHERE id=r.id RETURNING status INTO v_status;
 DELETE FROM public.transport_request_auto_approval_contexts WHERE request_id=r.id;
 IF v_status IS DISTINCT FROM 'APROBADA' THEN RETURN false; END IF;
 INSERT INTO public.transport_request_events(request_id,actor_id,action,previous_state,next_state)
 VALUES(r.id,auth.uid(),'STATUS_CHANGED',
  jsonb_build_object('status',r.status,'required_date',r.required_date),
  jsonb_build_object('status','APROBADA','required_date',r.required_date,'origen','APROBACION_AUTOMATICA',
   'reference_type',r.reference_type,'reference_number',r.reference_number,
   'operational_approved_pen',CASE WHEN r.contract_id IS NULL THEN v_cost ELSE NULL END,
   'configured_by',(SELECT updated_by FROM public.transport_request_approval_settings WHERE id)));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.transport_request_try_auto_approve(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.transport_request_try_auto_approve(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
