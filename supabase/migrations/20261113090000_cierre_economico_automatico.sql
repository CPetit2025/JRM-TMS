-- Cierre económico automático (criterio B + C aprobado):
--  C. Flete de flota propia: al cerrar la ruta (LIQUIDADO/CERRADO) se confirma solo con el flete vigente, que es lo que ya
--     consumió la partida (sin movimiento de partida) y queda aprobado. Si hubo una excepción, se reabre el ítem y se ajusta.
--  B. Ruta sin ningún costo (sin flete ni servicios especiales): su cierre económico queda «No aplica».
-- El cierre económico manual queda para lo tercerizado (transporte, montacarga, grúa, estiba) y las excepciones.
BEGIN;
SET LOCAL lock_timeout='60s';

ALTER TABLE public.economic_closures DROP CONSTRAINT IF EXISTS economic_closures_status_check;
ALTER TABLE public.economic_closures ADD CONSTRAINT economic_closures_status_check
 CHECK (status IN ('PENDIENTE','EN_REVISION','OBSERVADO','CIERRE_PARCIAL','CERRADO','NO_APLICA'));
ALTER TABLE public.economic_closure_events DROP CONSTRAINT IF EXISTS economic_closure_events_action_check;
ALTER TABLE public.economic_closure_events ADD CONSTRAINT economic_closure_events_action_check
 CHECK (action IN ('ENVIAR','APROBAR','OBSERVAR','REABRIR','NOTA','AGREGAR','AUTOMATICO'));

-- Cierre automático de una ruta cerrada. Idempotente: no toca fletes ya registrados ni cierres en curso.
CREATE OR REPLACE FUNCTION public.economic_auto_close(p_dispatch_id uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; s record; v_from text; v_to text; v_own boolean; v_mixed boolean; v_done text := NULL;
 v_reason text := 'Flete de flota propia confirmado automáticamente al cerrar la ruta';
BEGIN
 SELECT x.id, x.status, x.contract_id, COALESCE(x.freight_cost, 0) AS freight_cost,
   COALESCE(to_jsonb(x)->>'modalidad', CASE WHEN NULLIF(to_jsonb(x)->>'carrier_id', '') IS NOT NULL THEN 'TERCERO' ELSE 'PROPIA' END) AS modalidad
 INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id;
 IF NOT FOUND OR d.status NOT IN ('LIQUIDADO','CERRADO') THEN RETURN NULL; END IF;
 v_own := d.modalidad <> 'TERCERO';
 v_mixed := EXISTS (SELECT 1 FROM public.dispatch_request_freight WHERE dispatch_id = p_dispatch_id AND status <> 'LIBERADO');

 -- C · flete propio: final = vigente (ya consumido por la partida), aplicado y aprobado
 IF v_own THEN
  SELECT * INTO s FROM public.dispatch_freight_stages WHERE dispatch_id = p_dispatch_id FOR UPDATE;
  IF v_mixed THEN
   INSERT INTO public.dispatch_request_freight_stages(dispatch_id, request_id, agreed_pen, final_pen, final_applied_pen, econ_status, econ_approved_at)
   SELECT f.dispatch_id, f.request_id, f.amount_pen, f.amount_pen, f.amount_pen, 'APROBADO', now()
   FROM public.dispatch_request_freight f WHERE f.dispatch_id = p_dispatch_id AND f.status <> 'LIBERADO'
   ON CONFLICT (dispatch_id, request_id) DO UPDATE SET final_pen = EXCLUDED.final_pen, final_applied_pen = EXCLUDED.final_applied_pen,
     econ_status = 'APROBADO', econ_approved_at = now(), updated_at = now()
   WHERE dispatch_request_freight_stages.final_pen IS NULL AND dispatch_request_freight_stages.econ_status IS NULL;
  END IF;
  IF (d.freight_cost > 0 OR COALESCE(s.agreed_pen, 0) > 0) AND s.final_pen IS NULL THEN
   INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, base_pen, extras_pen, final_pen, executed_as_planned, final_reason, final_at,
     final_applied_pen, econ_status, econ_approved_at)
   VALUES (p_dispatch_id, d.freight_cost, d.freight_cost, 0, d.freight_cost, true, v_reason, now(), d.freight_cost, 'APROBADO', now())
   ON CONFLICT (dispatch_id) DO UPDATE SET base_pen = EXCLUDED.base_pen, extras_pen = 0, final_pen = EXCLUDED.final_pen, executed_as_planned = true,
     final_reason = EXCLUDED.final_reason, final_at = now(), final_applied_pen = EXCLUDED.final_applied_pen, econ_status = 'APROBADO', econ_approved_at = now(), updated_at = now();
   INSERT INTO public.service_cost_events(service_kind, dispatch_id, contract_id, concept, stage, old_amount, new_amount, new_status, detail, reason, created_by)
   VALUES ('FLETE', p_dispatch_id, d.contract_id, 'FLETE', 'FINAL', NULL, d.freight_cost, d.status,
    jsonb_build_object('automatico', true, 'modalidad', d.modalidad, 'agreed_pen', s.agreed_pen), v_reason, auth.uid());
   v_done := 'FLETE_PROPIO';
  END IF;
 END IF;

 -- B y estado de la ruta: solo se actualiza un cierre que nadie ha trabajado todavía
 INSERT INTO public.economic_closures(dispatch_id) VALUES (p_dispatch_id) ON CONFLICT (dispatch_id) DO NOTHING;
 SELECT status INTO v_from FROM public.economic_closures WHERE dispatch_id = p_dispatch_id FOR UPDATE;
 IF v_from <> 'PENDIENTE' THEN RETURN v_from; END IF;
 v_to := CASE WHEN jsonb_array_length(public.economic_route_items(p_dispatch_id)) = 0 THEN 'NO_APLICA' ELSE public.economic_route_derive(p_dispatch_id) END;
 IF v_to IS DISTINCT FROM v_from THEN
  UPDATE public.economic_closures SET status = v_to, updated_at = now(),
   closed_at = CASE WHEN v_to IN ('CERRADO','NO_APLICA') THEN now() END,
   observation = CASE v_to WHEN 'NO_APLICA' THEN 'Ruta sin costos: no requiere cierre económico' ELSE observation END
  WHERE dispatch_id = p_dispatch_id;
  INSERT INTO public.economic_closure_events(dispatch_id, action, from_status, to_status, reason, detail, created_by)
  VALUES (p_dispatch_id, 'AUTOMATICO', v_from, v_to,
   CASE v_to WHEN 'NO_APLICA' THEN 'Ruta sin costos: no requiere cierre económico' ELSE v_reason END,
   jsonb_build_object('criterio', CASE v_to WHEN 'NO_APLICA' THEN 'SIN_COSTO' ELSE COALESCE(v_done, 'ESTADO') END), auth.uid());
 END IF;
 RETURN v_to;
END $$;
REVOKE ALL ON FUNCTION public.economic_auto_close(uuid) FROM PUBLIC,anon,authenticated;

-- Al cerrar la ruta en Torre de Control. Nunca impide cerrar la ruta: si algo falla, el cierre económico queda manual.
CREATE OR REPLACE FUNCTION public.dispatch_economic_auto_close() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 BEGIN
  PERFORM public.economic_auto_close(NEW.id);
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Cierre económico automático de % no aplicado: %', NEW.id, SQLERRM;
 END;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_economic_auto_close() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_economic_auto_close ON public.dispatches;
CREATE TRIGGER dispatch_economic_auto_close AFTER UPDATE OF status ON public.dispatches
 FOR EACH ROW WHEN (NEW.status IN ('LIQUIDADO','CERRADO') AND OLD.status IS DISTINCT FROM NEW.status)
 EXECUTE FUNCTION public.dispatch_economic_auto_close();

-- Rutas ya cerradas del último año con el cierre económico sin trabajar
DO $backfill$
DECLARE r record;
BEGIN
 FOR r IN SELECT x.id FROM public.dispatches x
          LEFT JOIN public.economic_closures c ON c.dispatch_id = x.id
          WHERE x.status IN ('LIQUIDADO','CERRADO') AND COALESCE(c.status, 'PENDIENTE') = 'PENDIENTE'
            AND COALESCE(x.scheduled_departure, now()) >= now() - interval '400 days' LOOP
  BEGIN
   PERFORM public.economic_auto_close(r.id);
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'Cierre económico automático de % no aplicado: %', r.id, SQLERRM;
  END;
 END LOOP;
END $backfill$;

NOTIFY pgrst,'reload schema';
COMMIT;
