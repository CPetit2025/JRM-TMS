-- Operaciones, fase 2 · integridad operativa.
-- 1) Tripulación: al programar, set_route_auxiliaries escribe route_auxiliaries (Personal/HHEE) y dispatch_crew; al
--    corregirla desde el Expediente, set_dispatch_crew solo escribía dispatch_crew y route_auxiliaries quedaba
--    desactualizada. Un disparador mantiene route_auxiliaries según los AUXILIAR activos de dispatch_crew (solo con la
--    ruta programada y para quien tiene ficha en Personal). No se reescriben set_dispatch_crew ni set_route_auxiliaries.
-- 2) «Finalizar ruta» desde Monitoreo: una sola operación. Primero pasa la ruta a ENTREGADO con
--    transition_dispatch_status (que exige todas las paradas entregadas); solo si lo logra registra el evento FIN_RUTA.
--    Intervención del supervisor: motivo obligatorio.
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Auxiliares de la ruta según la tripulación
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_crew_route_auxiliaries_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_status text; v_was boolean; v_is boolean;
BEGIN
 SELECT status INTO v_status FROM public.dispatches WHERE id = NEW.dispatch_id;
 IF v_status IS DISTINCT FROM 'PROGRAMADO' THEN RETURN NULL; END IF;
 v_was := TG_OP = 'UPDATE' AND OLD.removed_at IS NULL AND OLD.crew_role = 'AUXILIAR';
 v_is := NEW.removed_at IS NULL AND NEW.crew_role = 'AUXILIAR';
 IF v_was AND NOT v_is THEN
  DELETE FROM public.route_auxiliaries a USING public.hhee_people hp
  WHERE a.dispatch_id = NEW.dispatch_id AND a.person_id = hp.id AND hp.profile_id = OLD.profile_id;
 ELSIF v_is AND NOT v_was THEN
  INSERT INTO public.route_auxiliaries(dispatch_id, person_id, assigned_by)
  SELECT NEW.dispatch_id, hp.id, auth.uid() FROM public.hhee_people hp
  WHERE hp.profile_id = NEW.profile_id AND COALESCE(hp.active, true)
    AND NOT EXISTS (SELECT 1 FROM public.route_auxiliaries a JOIN public.hhee_people h2 ON h2.id = a.person_id
                    WHERE a.dispatch_id = NEW.dispatch_id AND h2.profile_id = NEW.profile_id)
  ORDER BY hp.id LIMIT 1
  ON CONFLICT (dispatch_id, person_id) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_crew_route_auxiliaries_sync() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS dispatch_crew_route_auxiliaries_sync ON public.dispatch_crew;
CREATE TRIGGER dispatch_crew_route_auxiliaries_sync AFTER INSERT OR UPDATE OF removed_at, crew_role ON public.dispatch_crew
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_crew_route_auxiliaries_sync();

-- Rutas programadas desalineadas hoy: se agregan los auxiliares activos que faltan y se retiran los que ya no están
INSERT INTO public.route_auxiliaries(dispatch_id, person_id, assigned_by)
SELECT DISTINCT ON (c.dispatch_id, c.profile_id) c.dispatch_id, hp.id, c.assigned_by
FROM public.dispatch_crew c JOIN public.dispatches d ON d.id = c.dispatch_id JOIN public.hhee_people hp ON hp.profile_id = c.profile_id
WHERE d.status = 'PROGRAMADO' AND c.removed_at IS NULL AND c.crew_role = 'AUXILIAR' AND COALESCE(hp.active, true)
  AND NOT EXISTS (SELECT 1 FROM public.route_auxiliaries a JOIN public.hhee_people h2 ON h2.id = a.person_id
                  WHERE a.dispatch_id = c.dispatch_id AND h2.profile_id = c.profile_id)
ORDER BY c.dispatch_id, c.profile_id, hp.id
ON CONFLICT (dispatch_id, person_id) DO NOTHING;
DELETE FROM public.route_auxiliaries a USING public.dispatches d, public.hhee_people hp
WHERE d.id = a.dispatch_id AND hp.id = a.person_id AND d.status = 'PROGRAMADO' AND hp.profile_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.dispatch_crew c WHERE c.dispatch_id = a.dispatch_id AND c.profile_id = hp.profile_id
                  AND c.removed_at IS NULL AND c.crew_role = 'AUXILIAR');

-- ------------------------------------------------------------
-- 2. Finalizar ruta desde Monitoreo (intervención del supervisor)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_route_supervised(p_dispatch_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_res jsonb;
BEGIN
 SELECT x.id, x.site_id, x.status, x.dispatch_number INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF v_reason IS NULL OR length(v_reason) < 5 THEN RAISE EXCEPTION 'Indique el motivo de la intervención (mínimo 5 caracteres)'; END IF;
 IF length(v_reason) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;
 v_res := public.transition_dispatch_status(p_dispatch_id, 'ENTREGADO', 'Ruta finalizada desde Monitoreo (supervisor): ' || v_reason);
 IF NOT COALESCE((v_res->>'success')::boolean, false) THEN
  RAISE EXCEPTION '%', COALESCE(v_res->>'error', 'No se puede finalizar la ruta: todas las paradas deben estar entregadas');
 END IF;
 INSERT INTO public.dispatch_events(dispatch_id, event_type, description, created_by)
 VALUES (p_dispatch_id, 'FIN_RUTA', 'Intervención del supervisor: ' || v_reason, auth.uid()::text);
 RETURN jsonb_build_object('success', true, 'status', 'ENTREGADO');
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.finish_route_supervised(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finish_route_supervised(uuid,text) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
