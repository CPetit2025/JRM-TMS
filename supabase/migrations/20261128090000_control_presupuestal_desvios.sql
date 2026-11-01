-- Control presupuestal de transporte por OT · etapa 4: bandeja de desvíos (docs/control-presupuestal, flujo F4).
-- Desvíos vigentes, calculados desde los datos (sin duplicarlos):
--  · COSTO_SOBRE_ACORDADO: costo final de un servicio o flete por encima del umbral, enviado a aprobación en el cierre
--    económico (ítem EN_REVISION). Reemplaza la aprobación manual del «Por aprobar».
--  · OT_SOBRE_TOPE: el gasto ejecutado dejó la OT por encima del tope más lo autorizado (R5: se registra, se sustenta).
--  · EMERGENCIA_SIN_RATIFICAR: autorización de emergencia que Gerencia no ratificó en su plazo.
-- Flujo: el Supervisor sustenta (motivo + evidencia) → el Jefe de Distribución recomienda → decide el Jefe dentro de sus
-- atribuciones o Gerencia cuando el desvío toca el margen protegido. Aprobar no cambia el presupuesto; rechazar devuelve
-- el costo a corrección (cierre económico) o registra la acción correctiva. Todo queda en el historial.
BEGIN;
SET LOCAL lock_timeout='60s';

CREATE TABLE IF NOT EXISTS public.budget_deviation_reviews (
  key              text PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('COSTO_SOBRE_ACORDADO','OT_SOBRE_TOPE','EMERGENCIA_SIN_RATIFICAR')),
  contract_id      uuid,
  dispatch_id      uuid,
  amount_pen       numeric(15,2),
  status           text NOT NULL DEFAULT 'PENDIENTE_SUSTENTO' CHECK (status IN ('PENDIENTE_SUSTENTO','SUSTENTADO','RECOMENDADO','APROBADO','RECHAZADO')),
  support_note     text, support_evidence text, supported_by uuid, supported_at timestamptz,
  recommend        boolean, recommendation text, recommended_by uuid, recommended_at timestamptz,
  decision_note    text, decided_by uuid, decided_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_deviation_reviews_contract_idx ON public.budget_deviation_reviews(contract_id);
CREATE INDEX IF NOT EXISTS budget_deviation_reviews_dispatch_idx ON public.budget_deviation_reviews(dispatch_id);
ALTER TABLE public.budget_deviation_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.budget_deviation_reviews;
CREATE POLICY security_active_account ON public.budget_deviation_reviews AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.budget_deviation_reviews FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.budget_deviation_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  action      text NOT NULL CHECK (action IN ('SUSTENTAR','RECOMENDAR','NO_RECOMENDAR','APROBAR','RECHAZAR')),
  amount_pen  numeric(15,2),
  note        text,
  evidence    text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS budget_deviation_events_key_idx ON public.budget_deviation_events(key, created_at);
ALTER TABLE public.budget_deviation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.budget_deviation_events;
CREATE POLICY security_active_account ON public.budget_deviation_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.budget_deviation_events FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS budget_deviation_events_append_only ON public.budget_deviation_events;
CREATE TRIGGER budget_deviation_events_append_only BEFORE UPDATE OR DELETE ON public.budget_deviation_events
 FOR EACH ROW EXECUTE FUNCTION public.service_cost_events_append_only();

-- Exceso de la familia de una OT sobre su tope más lo autorizado (0 si está dentro)
CREATE OR REPLACE FUNCTION public.budget_overrun(p_root uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT GREATEST(round(t.reserved + t.consumed - public.transport_operating_limit(COALESCE(b.allocated_pen, 0), p_root) - public.budget_authorized_over_cap(p_root), 2), 0)
 FROM public.transport_family_totals(p_root) t LEFT JOIN public.contract_budgets b ON b.contract_id = p_root AND b.concept = 'PARTIDA_TRANSPORTE'
$$;
REVOKE ALL ON FUNCTION public.budget_overrun(uuid) FROM PUBLIC,anon,authenticated;

-- Desvíos vigentes (sin el estado de su revisión)
CREATE OR REPLACE FUNCTION public.budget_deviations_current() RETURNS TABLE(key text, kind text, contract_id uuid, dispatch_id uuid, item_key text,
 amount_pen numeric, label text, since timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c record; i jsonb;
BEGIN
 -- Costos sobre lo acordado enviados a aprobación
 FOR c IN SELECT ec.dispatch_id, x.dispatch_number, x.contract_id, ec.updated_at FROM public.economic_closures ec JOIN public.dispatches x ON x.id = ec.dispatch_id
          WHERE ec.status IN ('EN_REVISION','CIERRE_PARCIAL','PENDIENTE','OBSERVADO') AND (x.site_id IS NULL OR public.can_access_site(x.site_id)) LOOP
  FOR i IN SELECT value FROM jsonb_array_elements(COALESCE(public.economic_route_items(c.dispatch_id), '[]'::jsonb)) WHERE value->>'status' = 'EN_REVISION' LOOP
   key := 'COSTO:' || c.dispatch_id || ':' || (i->>'key'); kind := 'COSTO_SOBRE_ACORDADO';
   contract_id := COALESCE(NULLIF(i->>'contract_id','')::uuid, c.contract_id); dispatch_id := c.dispatch_id; item_key := i->>'key';
   amount_pen := round(COALESCE((i->>'final_pen')::numeric, 0) - COALESCE((i->>'agreed_pen')::numeric, 0), 2);
   label := 'Ruta ' || COALESCE(c.dispatch_number::text, '') || ' · ' || COALESCE(i->>'concept', '') || COALESCE(' · ' || (i->>'request_number'), '')
    || ': S/ ' || COALESCE(i->>'agreed_pen', '0') || ' → S/ ' || COALESCE(i->>'final_pen', '0');
   since := COALESCE((i->>'validated_at')::timestamptz, c.updated_at);
   RETURN NEXT;
  END LOOP;
 END LOOP;
 -- OT sobre el tope sin autorización que lo cubra
 FOR c IN SELECT b.contract_id AS id, k.code, b.updated_at FROM public.contract_budgets b JOIN public.contracts k ON k.id = b.contract_id
          WHERE b.concept = 'PARTIDA_TRANSPORTE' AND k.parent_contract_id IS NULL AND b.allocated_pen > 0
            AND (k.site_id IS NULL OR public.can_access_site(k.site_id)) AND public.budget_overrun(b.contract_id) > 0 LOOP
  key := 'OT:' || c.id; kind := 'OT_SOBRE_TOPE'; contract_id := c.id; dispatch_id := NULL; item_key := NULL;
  amount_pen := public.budget_overrun(c.id); label := 'OT ' || c.code || ': S/ ' || public.budget_overrun(c.id) || ' sobre el tope sin autorización'; since := c.updated_at;
  RETURN NEXT;
 END LOOP;
 -- Emergencias sin ratificar en su plazo
 FOR c IN SELECT a.id, a.contract_id, a.amount_pen, a.regularize_by, k.code FROM public.budget_authorizations a JOIN public.contracts k ON k.id = a.contract_id
          WHERE a.emergency AND a.status = 'AUTORIZADA' AND a.decided_at IS NULL AND a.regularize_by < now() LOOP
  key := 'EMG:' || c.id; kind := 'EMERGENCIA_SIN_RATIFICAR'; contract_id := c.contract_id; dispatch_id := NULL; item_key := NULL;
  amount_pen := c.amount_pen; label := 'OT ' || c.code || ': emergencia de S/ ' || c.amount_pen || ' sin ratificar por Gerencia'; since := c.regularize_by;
  RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.budget_deviations_current() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.budget_deviations_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.budget_can_read() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al control presupuestal'); END IF;
 RETURN jsonb_build_object('success', true, 'settings', public.economic_settings_get(),
  'can_support', public.has_tms_permission('despacho') OR public.has_tms_permission('control-presupuestal-recomendar'),
  'can_recommend', public.has_tms_permission('control-presupuestal-recomendar'), 'can_authorize', public.has_tms_permission('control-presupuestal-autorizar'),
  'open', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', d.key, 'kind', d.kind, 'contract_id', d.contract_id, 'code', k.code, 'dispatch_id', d.dispatch_id,
     'amount_pen', d.amount_pen, 'label', d.label, 'since', d.since,
     -- Un desvío ya resuelto vuelve a pendiente si su monto creció
     'status', CASE WHEN r.status IN ('APROBADO','RECHAZADO') AND d.amount_pen > COALESCE(r.amount_pen, 0) + 0.01 THEN 'PENDIENTE_SUSTENTO' ELSE COALESCE(r.status, 'PENDIENTE_SUSTENTO') END,
     'needs_management', d.kind <> 'COSTO_SOBRE_ACORDADO' OR (d.contract_id IS NOT NULL AND public.budget_overrun(COALESCE(public.contract_root_id(d.contract_id), d.contract_id)) > 0),
     'support_note', r.support_note, 'support_evidence', r.support_evidence, 'supported_by', public.economic_user_name(r.supported_by),
     'recommend', r.recommend, 'recommendation', r.recommendation, 'recommended_by', public.economic_user_name(r.recommended_by),
     'decision_note', r.decision_note, 'decided_by', public.economic_user_name(r.decided_by))
    ORDER BY d.since)
   FROM public.budget_deviations_current() d LEFT JOIN public.budget_deviation_reviews r ON r.key = d.key LEFT JOIN public.contracts k ON k.id = d.contract_id
   WHERE NOT (r.status IN ('APROBADO','RECHAZADO') AND d.amount_pen <= COALESCE(r.amount_pen, 0) + 0.01)), '[]'::jsonb),
  'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', r.key, 'kind', r.kind, 'code', k.code, 'amount_pen', r.amount_pen, 'status', r.status,
     'support_note', r.support_note, 'recommendation', r.recommendation, 'decision_note', r.decision_note, 'decided_by', public.economic_user_name(r.decided_by),
     'decided_at', r.decided_at) ORDER BY r.decided_at DESC)
   FROM public.budget_deviation_reviews r LEFT JOIN public.contracts k ON k.id = r.contract_id
   WHERE r.decided_at >= now() - interval '90 days'), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.budget_deviations_list() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_deviations_list() TO authenticated;

-- Acción sobre un desvío: SUSTENTAR, RECOMENDAR, NO_RECOMENDAR, APROBAR, RECHAZAR
CREATE OR REPLACE FUNCTION public.budget_deviation_action(p_key text, p_action text, p_note text DEFAULT NULL, p_evidence text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; r record; v_action text := upper(COALESCE(p_action,'')); v_note text := NULLIF(btrim(COALESCE(p_note,'')),'');
 v_evidence text := NULLIF(btrim(COALESCE(p_evidence,'')),''); v_mgmt boolean; v_res jsonb; v_from text; v_to text; v_status text;
BEGIN
 SELECT * INTO d FROM public.budget_deviations_current() x WHERE x.key = p_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'El desvío ya no está vigente'; END IF;
 IF length(COALESCE(v_note,'')) > 1000 OR length(COALESCE(v_evidence,'')) > 1000 THEN RAISE EXCEPTION 'Texto demasiado extenso'; END IF;
 INSERT INTO public.budget_deviation_reviews(key, kind, contract_id, dispatch_id, amount_pen) VALUES (d.key, d.kind, d.contract_id, d.dispatch_id, d.amount_pen)
 ON CONFLICT (key) DO NOTHING;
 SELECT * INTO r FROM public.budget_deviation_reviews WHERE key = p_key FOR UPDATE;
 -- Resuelto y con monto mayor: se reabre
 IF r.status IN ('APROBADO','RECHAZADO') AND d.amount_pen > COALESCE(r.amount_pen, 0) + 0.01 THEN
  UPDATE public.budget_deviation_reviews SET status = 'PENDIENTE_SUSTENTO', amount_pen = d.amount_pen, recommend = NULL, decided_by = NULL, decided_at = NULL
  WHERE key = p_key RETURNING * INTO r;
 END IF;
 v_status := r.status;
 v_mgmt := d.kind <> 'COSTO_SOBRE_ACORDADO' OR (d.contract_id IS NOT NULL AND public.budget_overrun(COALESCE(public.contract_root_id(d.contract_id), d.contract_id)) > 0);
 IF v_action = 'SUSTENTAR' THEN
  IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('control-presupuestal-recomendar')) THEN RAISE EXCEPTION 'Sin permiso para sustentar desvíos'; END IF;
  IF v_status IN ('APROBADO','RECHAZADO') THEN RAISE EXCEPTION 'El desvío ya fue resuelto'; END IF;
  IF v_note IS NULL OR length(v_note) < 10 THEN RAISE EXCEPTION 'Explique la causa del desvío (mínimo 10 caracteres)'; END IF;
  UPDATE public.budget_deviation_reviews SET status = 'SUSTENTADO', amount_pen = d.amount_pen, support_note = v_note, support_evidence = v_evidence,
   supported_by = auth.uid(), supported_at = now() WHERE key = p_key;
 ELSIF v_action IN ('RECOMENDAR','NO_RECOMENDAR') THEN
  IF NOT public.has_tms_permission('control-presupuestal-recomendar') THEN RAISE EXCEPTION 'Solo el Jefe de Distribución recomienda'; END IF;
  IF v_status <> 'SUSTENTADO' THEN RAISE EXCEPTION 'Primero el Supervisor debe sustentar el desvío'; END IF;
  IF v_action = 'NO_RECOMENDAR' AND (v_note IS NULL OR length(v_note) < 5) THEN RAISE EXCEPTION 'Indique por qué no se recomienda'; END IF;
  UPDATE public.budget_deviation_reviews SET status = 'RECOMENDADO', recommend = v_action = 'RECOMENDAR', recommendation = v_note,
   recommended_by = auth.uid(), recommended_at = now() WHERE key = p_key;
 ELSIF v_action IN ('APROBAR','RECHAZAR') THEN
  IF v_mgmt AND NOT public.has_tms_permission('control-presupuestal-autorizar') THEN
   RAISE EXCEPTION 'Este desvío toca el margen protegido: lo decide Gerencia de Operaciones';
  END IF;
  IF NOT v_mgmt AND NOT (public.has_tms_permission('control-presupuestal-recomendar') OR public.has_tms_permission('control-presupuestal-autorizar')) THEN
   RAISE EXCEPTION 'Solo el Jefe de Distribución o Gerencia deciden desvíos';
  END IF;
  IF v_status IN ('APROBADO','RECHAZADO') THEN RAISE EXCEPTION 'El desvío ya fue resuelto'; END IF;
  IF v_status = 'PENDIENTE_SUSTENTO' AND d.kind <> 'EMERGENCIA_SIN_RATIFICAR' THEN RAISE EXCEPTION 'Primero el Supervisor debe sustentar el desvío'; END IF;
  IF v_action = 'RECHAZAR' AND (v_note IS NULL OR length(v_note) < 5) THEN RAISE EXCEPTION 'Indique la acción correctiva'; END IF;
  IF d.kind = 'COSTO_SOBRE_ACORDADO' THEN
   -- Aprobar el costo final (imputa su diferencia) o devolverlo a corrección en el cierre económico
   SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = d.dispatch_id FOR UPDATE;
   v_res := public.economic_item_set(d.dispatch_id, d.item_key, CASE v_action WHEN 'APROBAR' THEN 'APROBAR' ELSE 'OBSERVAR' END,
    CASE WHEN v_action = 'RECHAZAR' THEN v_note END);
   v_to := public.economic_route_sync(d.dispatch_id, CASE v_action WHEN 'APROBAR' THEN 'APROBAR' ELSE 'OBSERVAR' END, CASE WHEN v_action = 'RECHAZAR' THEN v_note END);
   INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
   VALUES (d.dispatch_id, CASE v_action WHEN 'APROBAR' THEN 'APROBAR' ELSE 'OBSERVAR' END, v_from, v_to, COALESCE(v_note, r.support_note),
    jsonb_build_object('item', jsonb_build_object('key', v_res->>'key', 'label', v_res->>'label', 'from', v_res->>'from', 'to', v_res->>'to'),
     'budget_delta_by_contract', v_res->'budget_delta_by_contract', 'desvio', p_key), auth.uid());
  ELSIF d.kind = 'EMERGENCIA_SIN_RATIFICAR' THEN
   v_res := public.budget_authorization_action(substr(p_key, 5)::uuid, CASE v_action WHEN 'APROBAR' THEN 'RATIFICAR' ELSE 'RECHAZAR' END, v_note);
   IF NOT COALESCE((v_res->>'success')::boolean, false) THEN RAISE EXCEPTION '%', v_res->>'error'; END IF;
  END IF;
  UPDATE public.budget_deviation_reviews SET status = CASE v_action WHEN 'APROBAR' THEN 'APROBADO' ELSE 'RECHAZADO' END, amount_pen = d.amount_pen,
   decision_note = v_note, decided_by = auth.uid(), decided_at = now() WHERE key = p_key;
 ELSE
  RAISE EXCEPTION 'Acción inválida';
 END IF;
 INSERT INTO public.budget_deviation_events(key, action, amount_pen, note, evidence, created_by) VALUES (p_key, v_action, d.amount_pen, v_note, v_evidence, auth.uid());
 RETURN jsonb_build_object('success', true, 'status', (SELECT status FROM public.budget_deviation_reviews WHERE key = p_key));
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.budget_deviation_action(text,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.budget_deviation_action(text,text,text,text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
