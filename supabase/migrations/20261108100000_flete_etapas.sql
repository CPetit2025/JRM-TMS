-- Etapa 3 · Flete con etapas: referencial (solicitud) → acordado (programación) → final (después de la ejecución), sin
-- sobrescribir. dispatches.freight_cost sigue siendo el flete vigente que mueve la partida; aparte se conserva el acordado
-- y el final por ruta (dispatch_freight_stages) y por OT en rutas mixtas (dispatch_request_freight_stages).
-- dispatch_request_freight no se modifica: su guarda reference_freight_guard revalida cada UPDATE y rechaza filas históricas.
-- Cada cambio deja un evento FLETE en service_cost_events (Etapa 2). La partida no se toca: el costo final la impacta
-- en el cierre económico (Etapa 4).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Etapas del flete por ruta (tabla propia: no se reescriben despachos ni se disparan sus validaciones)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dispatch_freight_stages (
  dispatch_id          uuid PRIMARY KEY REFERENCES public.dispatches(id) ON DELETE CASCADE,
  agreed_pen           numeric(15,2) CHECK (agreed_pen >= 0),
  agreed_at            timestamptz,
  agreed_by            uuid,
  base_pen             numeric(15,2) CHECK (base_pen >= 0),
  extras_pen           numeric(15,2) NOT NULL DEFAULT 0 CHECK (extras_pen >= 0),
  final_pen            numeric(15,2) CHECK (final_pen >= 0),
  executed_as_planned  boolean,
  final_reason         text,
  final_by             uuid,
  final_at             timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.dispatch_freight_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_freight_stages;
CREATE POLICY security_active_account ON public.dispatch_freight_stages AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
-- Lectura por dispatch_freight_summary; escritura por disparadores y register_dispatch_freight_final
REVOKE ALL ON public.dispatch_freight_stages FROM PUBLIC, anon, authenticated;

-- Por OT en rutas mixtas
CREATE TABLE IF NOT EXISTS public.dispatch_request_freight_stages (
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  request_id  uuid NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
  agreed_pen  numeric(15,2) CHECK (agreed_pen >= 0),
  final_pen   numeric(15,2) CHECK (final_pen >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispatch_id, request_id)
);
-- Regla C55: la FK a la solicitud cubierta por un índice no parcial
CREATE INDEX IF NOT EXISTS dispatch_request_freight_stages_request_idx ON public.dispatch_request_freight_stages(request_id);
ALTER TABLE public.dispatch_request_freight_stages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.dispatch_request_freight_stages;
CREATE POLICY security_active_account ON public.dispatch_request_freight_stages AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.dispatch_request_freight_stages FROM PUBLIC, anon, authenticated;
-- Rutas mixtas existentes: el acordado es el monto vigente de cada OT
INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen)
SELECT dispatch_id, request_id, amount_pen FROM public.dispatch_request_freight
ON CONFLICT (dispatch_id, request_id) DO NOTHING;

-- Un ajuste del flete después de la salida no es un nuevo acuerdo: etapa AJUSTE.
ALTER TABLE public.service_cost_events DROP CONSTRAINT IF EXISTS service_cost_events_stage_check;
ALTER TABLE public.service_cost_events ADD CONSTRAINT service_cost_events_stage_check
 CHECK (stage IN ('REFERENCIAL','ACORDADO','AJUSTE','FINAL','ESTADO'));

-- ------------------------------------------------------------
-- 2. Acordado: se fija al programar y se renegocia solo mientras la ruta está programada.
--    Después de la salida, un cambio del flete vigente queda como AJUSTE y el acordado se conserva.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_freight_stage_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text := NULLIF(btrim(COALESCE(current_setting('tms.cost_reason', true), '')), '');
BEGIN
 IF TG_OP = 'INSERT' OR NEW.status = 'PROGRAMADO' THEN
  INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, agreed_at, agreed_by)
  VALUES (NEW.id, COALESCE(NEW.freight_cost, 0), now(), auth.uid())
  ON CONFLICT (dispatch_id) DO UPDATE SET agreed_pen = EXCLUDED.agreed_pen, agreed_at = now(), agreed_by = auth.uid(), updated_at = now();
  INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, new_status, reason, created_by)
  VALUES ('FLETE', NEW.id, NEW.contract_id, 'FLETE', 'ACORDADO', CASE WHEN TG_OP = 'UPDATE' THEN OLD.freight_cost END, COALESCE(NEW.freight_cost, 0),
   NEW.status, v_reason, auth.uid());
 ELSE
  INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, old_status, new_status, reason, created_by)
  VALUES ('FLETE', NEW.id, NEW.contract_id, 'FLETE', 'AJUSTE', OLD.freight_cost, NEW.freight_cost, OLD.status, NEW.status, v_reason, auth.uid());
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_stage_sync() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_freight_stage_insert ON public.dispatches;
CREATE TRIGGER dispatch_freight_stage_insert AFTER INSERT ON public.dispatches
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_freight_stage_sync();
DROP TRIGGER IF EXISTS dispatch_freight_stage_update ON public.dispatches;
CREATE TRIGGER dispatch_freight_stage_update AFTER UPDATE OF freight_cost ON public.dispatches
 FOR EACH ROW WHEN (NEW.freight_cost IS DISTINCT FROM OLD.freight_cost) EXECUTE FUNCTION public.dispatch_freight_stage_sync();

-- Por OT: el acordado se fija al reservar y sigue al monto solo mientras la ruta está programada.
CREATE OR REPLACE FUNCTION public.dispatch_request_freight_agreed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' OR (NEW.amount_pen IS DISTINCT FROM OLD.amount_pen AND (SELECT status FROM public.dispatches WHERE id = NEW.dispatch_id) = 'PROGRAMADO') THEN
  INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen) VALUES (NEW.dispatch_id, NEW.request_id, NEW.amount_pen)
  ON CONFLICT (dispatch_id, request_id) DO UPDATE SET agreed_pen = EXCLUDED.agreed_pen, updated_at = now();
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_request_freight_agreed() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_request_freight_agreed ON public.dispatch_request_freight;
CREATE TRIGGER dispatch_request_freight_agreed AFTER INSERT OR UPDATE OF amount_pen ON public.dispatch_request_freight
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_request_freight_agreed();

-- Un flete corregido en Servicios de la OT con la ruta ya cerrada no cambia dispatches.freight_cost: se registra aquí.
CREATE OR REPLACE FUNCTION public.contract_freight_amount_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.service_type = 'FLETE' AND NEW.dispatch_id IS NOT NULL AND NEW.amount_pen IS DISTINCT FROM OLD.amount_pen
    AND (SELECT status FROM public.dispatches WHERE id = NEW.dispatch_id) IN ('LIQUIDADO','CERRADO') THEN
  INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, detail, reason, created_by)
  VALUES ('FLETE', NEW.dispatch_id, NEW.contract_id, 'FLETE', 'AJUSTE', OLD.amount_pen, NEW.amount_pen, jsonb_build_object('contract_service_id', NEW.id),
   NULLIF(btrim(COALESCE(current_setting('tms.cost_reason', true), '')), ''), auth.uid());
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.contract_freight_amount_event() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS contract_freight_amount_event ON public.contract_services;
CREATE TRIGGER contract_freight_amount_event AFTER UPDATE OF amount_pen ON public.contract_services
 FOR EACH ROW EXECUTE FUNCTION public.contract_freight_amount_event();

-- Editar el monto de un servicio de la OT con motivo (queda en el historial de costos).
CREATE OR REPLACE FUNCTION public.update_contract_service_amount_with_reason(p_service_id uuid, p_new_amount numeric, p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_ok boolean;
BEGIN
 IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 500 THEN RAISE EXCEPTION 'Indique el motivo del cambio de monto (mínimo 5 caracteres)'; END IF;
 PERFORM set_config('tms.cost_reason', v_reason, true);
 v_ok := public.update_contract_service_amount(p_service_id, p_new_amount);
 PERFORM set_config('tms.cost_reason', '', true);
 RETURN v_ok;
END $$;
REVOKE ALL ON FUNCTION public.update_contract_service_amount_with_reason(uuid,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.update_contract_service_amount_with_reason(uuid,numeric,text) TO authenticated;

-- ------------------------------------------------------------
-- 3. Final: después de la ejecución. p = { executed_as_planned, base_pen (si no fue conforme a lo programado),
--    extras_pen, reason, allocation: [{ request_id, final_pen }] (rutas mixtas; sin ella se reparte según lo acordado) }
--    final = base + adicionales; base = acordado si se ejecutó conforme. Toda diferencia con lo acordado exige motivo.
--    Se puede corregir: el historial conserva cada registro.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_dispatch_freight_final(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; e jsonb; v_agreed numeric; v_as_planned boolean; v_base numeric; v_extras numeric; v_final numeric;
 v_reason text; v_rows int; v_sum numeric := 0; v_alloc jsonb := '{}'::jsonb; v_agreed_total numeric; v_left numeric; r record; v_i int := 0; v_share numeric;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios')) THEN
  RAISE EXCEPTION 'Sin permiso para registrar el flete final';
 END IF;
 SELECT x.id, x.status, x.site_id, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN
  RAISE EXCEPTION 'El flete final se registra después de la ejecución del servicio';
 END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos del flete final inválidos'; END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 v_agreed := COALESCE(s.agreed_pen, d.freight_cost);  -- rutas anteriores a esta etapa: el flete vigente
 v_as_planned := COALESCE((p->>'executed_as_planned')::boolean, true);
 v_base := CASE WHEN v_as_planned THEN v_agreed ELSE NULLIF(p->>'base_pen','')::numeric END;
 v_extras := COALESCE(NULLIF(p->>'extras_pen','')::numeric, 0);
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_base IS NULL OR v_base < 0 OR v_base > 10000000 OR v_base <> round(v_base, 2) THEN
  RAISE EXCEPTION 'Indique el flete ejecutado (dos decimales)';
 END IF;
 IF v_extras < 0 OR v_extras > 10000000 OR v_extras <> round(v_extras, 2) THEN RAISE EXCEPTION 'Adicionales inválidos (dos decimales)'; END IF;
 v_final := v_base + v_extras;
 IF v_final <> v_agreed AND (v_reason IS NULL OR length(v_reason) < 5) THEN
  RAISE EXCEPTION 'Justifique la diferencia con el flete acordado (S/ % → S/ %)', v_agreed, v_final;
 END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;

 -- Rutas mixtas: el final se imputa por OT sin duplicar (suma exacta)
 SELECT count(*), COALESCE(sum(COALESCE(st.agreed_pen, f.amount_pen)), 0) INTO v_rows, v_agreed_total
 FROM public.dispatch_request_freight f LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
 WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO';
 IF v_rows > 0 THEN
  IF jsonb_typeof(p->'allocation') = 'array' AND jsonb_array_length(p->'allocation') > 0 THEN
   FOR e IN SELECT value FROM jsonb_array_elements(p->'allocation') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND request_id = NULLIF(e->>'request_id','')::uuid AND status <> 'LIBERADO') THEN
     RAISE EXCEPTION 'El servicio del reparto no pertenece a esta ruta';
    END IF;
    v_share := NULLIF(e->>'final_pen','')::numeric;
    IF v_share IS NULL OR v_share < 0 OR v_share <> round(v_share, 2) OR v_alloc ? (e->>'request_id') THEN RAISE EXCEPTION 'Reparto del flete final inválido'; END IF;
    v_alloc := v_alloc || jsonb_build_object(e->>'request_id', v_share); v_sum := v_sum + v_share;
   END LOOP;
   IF (SELECT count(*) FROM jsonb_object_keys(v_alloc)) <> v_rows OR v_sum <> v_final THEN
    RAISE EXCEPTION 'El reparto por OT debe cubrir todos los servicios y sumar el flete final (S/ %)', v_final;
   END IF;
  ELSE
   -- Proporcional a lo acordado por OT; el redondeo queda en el último servicio
   v_left := v_final;
   FOR r IN SELECT f.request_id, COALESCE(st.agreed_pen, f.amount_pen) AS agreed FROM public.dispatch_request_freight f
            LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
            WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO' ORDER BY f.contract_id, f.request_id LOOP
    v_i := v_i + 1;
    v_share := CASE WHEN v_i = v_rows THEN v_left
                    WHEN v_agreed_total > 0 THEN round(v_final * r.agreed / v_agreed_total, 2) ELSE round(v_final / v_rows, 2) END;
    v_alloc := v_alloc || jsonb_build_object(r.request_id::text, v_share); v_left := v_left - v_share;
   END LOOP;
  END IF;
  INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen, final_pen)
  SELECT f.dispatch_id, f.request_id, f.amount_pen, (v_alloc->>(f.request_id::text))::numeric
  FROM public.dispatch_request_freight f WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO'
  ON CONFLICT (dispatch_id, request_id) DO UPDATE SET final_pen = EXCLUDED.final_pen, updated_at = now();
 END IF;

 INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, base_pen, extras_pen, final_pen, executed_as_planned, final_reason, final_by, final_at)
 VALUES (p_dispatch_id, v_agreed, v_base, v_extras, v_final, v_as_planned, v_reason, auth.uid(), now())
 ON CONFLICT (dispatch_id) DO UPDATE SET agreed_pen = COALESCE(dispatch_freight_stages.agreed_pen, EXCLUDED.agreed_pen), base_pen = EXCLUDED.base_pen,
  extras_pen = EXCLUDED.extras_pen, final_pen = EXCLUDED.final_pen, executed_as_planned = EXCLUDED.executed_as_planned,
  final_reason = EXCLUDED.final_reason, final_by = EXCLUDED.final_by, final_at = EXCLUDED.final_at, updated_at = now();
 INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, new_status, detail, reason, created_by)
 VALUES ('FLETE', p_dispatch_id, d.contract_id, 'FLETE', 'FINAL', s.final_pen, v_final, d.status,
  jsonb_build_object('agreed_pen', v_agreed, 'base_pen', v_base, 'extras_pen', v_extras, 'executed_as_planned', v_as_planned, 'allocation', v_alloc),
  v_reason, auth.uid());
 RETURN jsonb_build_object('success', true, 'agreed_pen', v_agreed, 'final_pen', v_final, 'difference_pen', v_final - v_agreed, 'allocation', v_alloc);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.register_dispatch_freight_final(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_dispatch_freight_final(uuid,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 4. Resumen del flete de una ruta: referencial, acordado, vigente y final (total y por OT)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_freight_summary(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_name text;
BEGIN
 IF NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
   OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('contratos-servicios')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al flete de la ruta');
 END IF;
 SELECT x.id, x.status, x.site_id, COALESCE(x.freight_cost, 0) AS freight_cost INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id;
 SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
 INTO v_name FROM public.profiles pr WHERE pr.id = s.final_by;
 RETURN jsonb_build_object('success', true, 'status', d.status,
  'referential_pen', (SELECT COALESCE(sum(COALESCE(t.service_cost, 0)), 0) FROM public.dispatch_requests dr JOIN public.transport_requests t ON t.id = dr.transport_request_id WHERE dr.dispatch_id = p_dispatch_id),
  'agreed_pen', COALESCE(s.agreed_pen, d.freight_cost), 'agreed_recorded', s.agreed_pen IS NOT NULL, 'current_pen', d.freight_cost,
  'base_pen', s.base_pen, 'extras_pen', s.extras_pen, 'final_pen', s.final_pen, 'executed_as_planned', s.executed_as_planned,
  'final_reason', s.final_reason, 'final_at', s.final_at, 'final_by', v_name,
  'can_register_final', d.status NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO')
    AND (public.has_tms_permission('despacho') OR public.has_tms_permission('contratos-servicios')),
  'by_request', COALESCE((SELECT jsonb_agg(jsonb_build_object('request_id', f.request_id, 'request_number', t.request_number,
     'contract_code', (SELECT c.code FROM public.contracts c WHERE c.id = f.contract_id), 'referential_pen', COALESCE(t.service_cost, 0),
     'agreed_pen', COALESCE(st.agreed_pen, f.amount_pen), 'current_pen', f.amount_pen, 'final_pen', st.final_pen, 'status', f.status)
    ORDER BY t.request_number)
   FROM public.dispatch_request_freight f JOIN public.transport_requests t ON t.id = f.request_id
   LEFT JOIN public.dispatch_request_freight_stages st ON st.dispatch_id = f.dispatch_id AND st.request_id = f.request_id
   WHERE f.dispatch_id = p_dispatch_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.dispatch_freight_summary(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.dispatch_freight_summary(uuid) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
