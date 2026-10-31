-- Cierre económico que siempre puede cerrarse (Operaciones, fase 1).
-- 1) Un costo que aparece después del cierre (gasto de Caja «No planificado», servicio agregado, flete) ya no queda
--    escondido ni trabado: si la ruta estaba «Cerrada» o «No aplica», al confirmar la transacción su estado vuelve a
--    calcularse desde los ítems (Cierre parcial / Por cerrar), con un evento AUTOMATICO en el historial. Los ítems ya
--    aprobados no se tocan ni se mueve la partida. Disparadores diferidos: corren al final, cuando las acciones del cierre
--    ya registraron su propio estado, y nunca bloquean a Caja (errores solo como WARNING).
-- 2) La bandeja no muestra «No aplica» si la ruta tiene costos.
-- 3) «Agregar servicio» no duplica un montacarga, grúa o estiba que ya existe para la solicitud: se corrige el existente.
-- 4) economic_settings.max_pending_days: días de espera desde los que la bandeja marca la ruta como atrasada.
-- Se corrigen las rutas que hoy están en esa situación (solo su estado; sin movimiento de partida).
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.economic_settings ADD COLUMN IF NOT EXISTS max_pending_days integer NOT NULL DEFAULT 7;
DO $c$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='economic_settings_max_pending_days_check') THEN
  ALTER TABLE public.economic_settings ADD CONSTRAINT economic_settings_max_pending_days_check CHECK (max_pending_days BETWEEN 1 AND 365);
 END IF;
END $c$;

CREATE OR REPLACE FUNCTION public.economic_settings_get() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s record;
BEGIN
 SELECT deviation_pct, deviation_pen, max_pending_days INTO s FROM public.economic_settings WHERE id;
 RETURN jsonb_build_object('deviation_pct', COALESCE(s.deviation_pct, 10), 'deviation_pen', COALESCE(s.deviation_pen, 100),
  'max_pending_days', COALESCE(s.max_pending_days, 7));
END $$;
REVOKE ALL ON FUNCTION public.economic_settings_get() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_settings_get() TO authenticated;

-- ------------------------------------------------------------
-- 1. Reapertura automática por un costo nuevo después del cierre
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_route_resync(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_from text; v_route text; v_items jsonb; v_to text; v_labels text;
BEGIN
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR v_from NOT IN ('NO_APLICA','CERRADO') THEN RETURN v_from; END IF;
 SELECT status INTO v_route FROM public.dispatches WHERE id = p_dispatch_id;
 IF v_route NOT IN ('RETORNO_COMPLETADO','CIERRE_OPERATIVO','LIQUIDADO','CERRADO') THEN RETURN v_from; END IF;
 v_items := COALESCE(public.economic_route_items(p_dispatch_id), '[]'::jsonb);
 SELECT string_agg(COALESCE(CASE WHEN i->>'concept' = 'FLETE' THEN 'Transporte' ELSE public.unloading_concept_label(i->>'concept') END, i->>'concept')
   || COALESCE(' · ' || (i->>'request_number'), ''), ', ')
 INTO v_labels FROM jsonb_array_elements(v_items) i WHERE i->>'status' <> 'APROBADO';
 IF v_labels IS NULL THEN RETURN v_from; END IF;
 v_to := public.economic_route_derive(p_dispatch_id);
 IF v_to IN ('CERRADO','NO_APLICA') THEN v_to := 'PENDIENTE'; END IF;
 UPDATE public.economic_closures SET status = v_to, closed_by = NULL, closed_at = NULL, updated_at = now(),
  observation = left('Costo nuevo después del cierre: ' || v_labels, 1000)
 WHERE dispatch_id = p_dispatch_id;
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, 'AUTOMATICO', v_from, v_to, left('Costo nuevo después del cierre: ' || v_labels, 1000),
  jsonb_build_object('criterio', 'COSTO_NUEVO'), auth.uid());
 RETURN v_to;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_resync(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.economic_route_resync_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.dispatch_id IS NOT NULL THEN
  BEGIN
   PERFORM public.economic_route_resync(NEW.dispatch_id);
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'Cierre económico de % no recalculado: %', NEW.dispatch_id, SQLERRM;
  END;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.economic_route_resync_trigger() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS economic_route_resync ON public.transport_unloading_costs;
CREATE CONSTRAINT TRIGGER economic_route_resync AFTER INSERT OR UPDATE ON public.transport_unloading_costs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.economic_route_resync_trigger();
DROP TRIGGER IF EXISTS economic_route_resync ON public.dispatch_freight_stages;
CREATE CONSTRAINT TRIGGER economic_route_resync AFTER INSERT OR UPDATE ON public.dispatch_freight_stages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.economic_route_resync_trigger();
DROP TRIGGER IF EXISTS economic_route_resync ON public.dispatch_request_freight_stages;
CREATE CONSTRAINT TRIGGER economic_route_resync AFTER INSERT OR UPDATE ON public.dispatch_request_freight_stages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.economic_route_resync_trigger();

-- ------------------------------------------------------------
-- 2. Estado de la bandeja (reescrita de 20261122110000): «No aplica» solo sin costos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_queue_key(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE st jsonb := public.economic_route_state(p_dispatch_id); it jsonb := COALESCE(public.economic_route_items(p_dispatch_id), '[]'::jsonb);
BEGIN
 IF st->>'status' = 'NO_APLICA' AND jsonb_array_length(it) = 0 THEN RETURN 'NO_APLICA'; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(it) x WHERE x->>'status' = 'EN_REVISION') THEN RETURN 'POR_APROBAR'; END IF;
 IF jsonb_array_length(it) > 0 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(it) x WHERE x->>'status' IS DISTINCT FROM 'APROBADO') THEN RETURN 'CERRADO'; END IF;
 IF jsonb_array_length(it) = 0 AND st->>'status' IN ('CERRADO','NO_APLICA') THEN RETURN st->>'status'; END IF;
 RETURN 'POR_CERRAR';
END $$;
REVOKE ALL ON FUNCTION public.economic_queue_key(uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Servicio agregado en el cierre (reescrita de 20261111120000): sin duplicar montacarga, grúa o estiba, y también
--    sobre una ruta ya cerrada (el estado se recalcula desde los ítems).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_add_service(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; t record; v_concept text; v_final numeric; v_reason text; v_supplier uuid; v_supplier_name text; v_description text; v_id uuid; v_status text; v_to text;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para agregar servicios en el cierre'; END IF;
 SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN RAISE EXCEPTION 'Los servicios del cierre se agregan después de la ejecución'; END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos inválidos'; END IF;
 SELECT tr.id, tr.contract_id, tr.request_number INTO t FROM public.transport_requests tr
 WHERE tr.id = NULLIF(p->>'transport_request_id','')::uuid
   AND EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id = p_dispatch_id AND dr.transport_request_id = tr.id);
 IF NOT FOUND THEN RAISE EXCEPTION 'Elija una solicitud de la ruta'; END IF;
 v_concept := upper(COALESCE(p->>'concept',''));
 IF v_concept NOT IN ('MONTACARGAS','GRUA','ESTIBA','OTROS') THEN RAISE EXCEPTION 'Tipo de servicio inválido'; END IF;
 IF v_concept <> 'OTROS' AND EXISTS (SELECT 1 FROM public.transport_unloading_costs u WHERE u.dispatch_id = p_dispatch_id
     AND u.transport_request_id = t.id AND u.concept = v_concept AND u.status IN ('PLANIFICADO','CONSUMIDO')) THEN
  RAISE EXCEPTION 'La solicitud % ya tiene % en esta ruta: corrija su costo final (cantidad o adicionales) en lugar de agregar otro',
   t.request_number, lower(public.unloading_concept_label(v_concept));
 END IF;
 v_final := NULLIF(p->>'final_pen','')::numeric;
 IF v_final IS NULL OR v_final <= 0 OR v_final > 10000000 OR v_final <> round(v_final, 2) THEN RAISE EXCEPTION 'Indique el costo final del servicio (mayor a 0, dos decimales)'; END IF;
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique por qué se agrega el servicio en el cierre (mínimo 5 caracteres)'; END IF;
 IF length(v_reason) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 v_description := NULLIF(btrim(COALESCE(p->>'description','')),'');
 IF length(COALESCE(v_description,'')) > 300 THEN RAISE EXCEPTION 'Descripción demasiado extensa'; END IF;
 v_supplier := NULLIF(p->>'supplier_id','')::uuid;
 IF v_supplier IS NOT NULL THEN
  SELECT business_name INTO v_supplier_name FROM public.suppliers WHERE id = v_supplier;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proveedor inexistente'; END IF;
 END IF;

 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_status FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 PERFORM set_config('tms.cost_reason', v_reason, true);
 INSERT INTO public.transport_unloading_costs(transport_request_id, dispatch_id, contract_id, concept, description, estimated_pen, planned_pen, status, origin,
  supplier_id, provider_name, created_by, planned_by, planned_at,
  final_extras_pen, final_pen, final_reason, final_validated_by, final_validated_at)
 VALUES (t.id, p_dispatch_id, t.contract_id, v_concept, COALESCE(v_description, 'Agregado en el cierre económico'), 0, 0, 'PLANIFICADO', 'CIERRE',
  v_supplier, v_supplier_name, auth.uid(), auth.uid(), now(),
  0, v_final, v_reason, auth.uid(), now())
 RETURNING id INTO v_id;
 PERFORM set_config('tms.cost_reason', '', true);
 INSERT INTO public.service_cost_events(unloading_cost_id, transport_request_id, dispatch_id, contract_id, concept, stage, old_amount, new_amount, old_status, new_status, detail, reason, created_by)
 VALUES (v_id, t.id, p_dispatch_id, t.contract_id, v_concept, 'FINAL', NULL, v_final, 'PLANIFICADO', 'PLANIFICADO',
  jsonb_build_object('validated', true, 'origin', 'CIERRE', 'reference_pen', 0, 'base_pen', v_final, 'extras_pen', 0), v_reason, auth.uid());
 v_to := public.economic_route_sync(p_dispatch_id, 'AGREGAR', NULL);
 INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
 VALUES (p_dispatch_id, 'AGREGAR', v_status, v_to, v_reason,
  jsonb_build_object('unloading_cost_id', v_id, 'concept', v_concept, 'final_pen', v_final, 'supplier', v_supplier_name), auth.uid());
 RETURN jsonb_build_object('success', true, 'id', v_id, 'status', v_to);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.economic_add_service(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.economic_add_service(uuid,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 4. Rutas que hoy están «Cerradas» o «No aplica» con costos sin aprobar: vuelven a la bandeja (solo estado)
-- ------------------------------------------------------------
DO $backfill$
DECLARE r record;
BEGIN
 FOR r IN SELECT c.dispatch_id FROM public.economic_closures c WHERE c.status IN ('NO_APLICA','CERRADO') LOOP
  BEGIN
   PERFORM public.economic_route_resync(r.dispatch_id);
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'Cierre económico de % no recalculado: %', r.dispatch_id, SQLERRM;
  END;
 END LOOP;
END $backfill$;

NOTIFY pgrst,'reload schema';
COMMIT;
