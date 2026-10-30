-- Etapa 1 · Servicios especiales: la descarga pedida en la solicitud (grúa, montacarga, estiba)
-- se hereda al armar la ruta, el montacarga queda vinculado a su línea de costo (sin doble conteo),
-- cada línea registra su origen y "sin tarifa" ya no se confunde con S/ 0.
-- transport_unloading_costs sigue siendo la única línea por servicio.
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Columnas nuevas (producción no coincide con el repo: todo IF NOT EXISTS)
-- ------------------------------------------------------------
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS estimated_source text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS tariff_missing boolean NOT NULL DEFAULT false;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS manual_reason text;
ALTER TABLE public.route_forklifts ADD COLUMN IF NOT EXISTS unloading_cost_id uuid;

DO $constraints$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_origin_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_origin_check
   CHECK (origin IN ('SOLICITUD','PROGRAMACION','CAJA'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_estimated_source_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_estimated_source_check
   CHECK (estimated_source IS NULL OR estimated_source IN ('TARIFA','MANUAL'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_manual_reason_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_manual_reason_check
   CHECK (estimated_source IS DISTINCT FROM 'MANUAL' OR length(btrim(COALESCE(manual_reason,'')))>=3);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='route_forklifts_unloading_cost_fk') THEN
  ALTER TABLE public.route_forklifts ADD CONSTRAINT route_forklifts_unloading_cost_fk
   FOREIGN KEY (unloading_cost_id) REFERENCES public.transport_unloading_costs(id) ON DELETE SET NULL;
 END IF;
END $constraints$;
-- Una línea de costo respalda a un solo servicio de montacarga.
CREATE UNIQUE INDEX IF NOT EXISTS route_forklifts_unloading_cost_key ON public.route_forklifts(unloading_cost_id) WHERE unloading_cost_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Origen: respaldo histórico y valor por defecto en cada alta
-- ------------------------------------------------------------
-- CAJA: la línea no planificada que crea Caja. PROGRAMACION: creada al planificar el despacho
-- (planned_at = created_at) o creada después de armarse su ruta. El resto viene de la solicitud.
UPDATE public.transport_unloading_costs t SET origin = CASE
  WHEN t.description = 'No planificado · gasto de Caja' THEN 'CAJA'
  WHEN t.planned_by IS NOT NULL AND (to_jsonb(t)->>'planned_at') IS NOT NULL AND (to_jsonb(t)->>'created_at') IS NOT NULL
   AND abs(extract(epoch FROM (to_jsonb(t)->>'planned_at')::timestamptz - (to_jsonb(t)->>'created_at')::timestamptz)) < 2 THEN 'PROGRAMACION'
  WHEN EXISTS (SELECT 1 FROM public.dispatches d WHERE d.id = t.dispatch_id
   AND (to_jsonb(d)->>'created_at') IS NOT NULL AND (to_jsonb(t)->>'created_at') IS NOT NULL
   AND (to_jsonb(t)->>'created_at')::timestamptz >= (to_jsonb(d)->>'created_at')::timestamptz) THEN 'PROGRAMACION'
  ELSE 'SOLICITUD' END
WHERE t.origin IS NULL;
-- Las estimaciones históricas en 0 eran "sin tarifa" (el tarifario dejaba 0 = por cotizar).
UPDATE public.transport_unloading_costs SET tariff_missing = true
WHERE status = 'ESTIMADO' AND COALESCE(estimated_pen,0) = 0 AND estimated_source IS NULL AND NOT tariff_missing;

-- Cada flujo inserta con su estado propio; el disparador fija el origen cuando el flujo no lo indica
-- (plan_dispatch_unloading inserta PLANIFICADO, Caja inserta su descripción, la solicitud inserta ESTIMADO).
CREATE OR REPLACE FUNCTION public.transport_unloading_costs_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.origin IS NULL THEN
  NEW.origin := CASE WHEN NEW.description = 'No planificado · gasto de Caja' THEN 'CAJA'
   WHEN NEW.status = 'PLANIFICADO' OR NEW.planned_by IS NOT NULL THEN 'PROGRAMACION' ELSE 'SOLICITUD' END;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.transport_unloading_costs_origin() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS transport_unloading_costs_origin ON public.transport_unloading_costs;
CREATE TRIGGER transport_unloading_costs_origin BEFORE INSERT ON public.transport_unloading_costs
 FOR EACH ROW EXECUTE FUNCTION public.transport_unloading_costs_origin();
ALTER TABLE public.transport_unloading_costs ALTER COLUMN origin SET NOT NULL;

-- ------------------------------------------------------------
-- 3. Solicitud: origen SOLICITUD y costo manual referencial cuando no hay tarifa
--    p_items = [{concept, description, estimated_pen, estimated_source?: 'MANUAL', manual_reason?}]
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_request_unloading_costs(p_request_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r        record;
  b        public.contract_budgets%ROWTYPE;
  v_item   jsonb;
  v_amount numeric;
  v_manual boolean;
  v_reason text;
  v_total  numeric := 0;
  v_cost   numeric;
BEGIN
  SELECT t.id, t.status, t.contract_id, t.request_number, COALESCE(t.service_cost, 0) AS service_cost, t.site_id
  INTO r FROM public.transport_requests t WHERE t.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud inexistente'); END IF;
  IF NOT public.can_access_site((SELECT site_id FROM public.transport_requests WHERE id=p_request_id)) THEN RETURN jsonb_build_object('success',false,'error','Sede no autorizada'); END IF;
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los costos de descarga se estiman antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Costos de descarga inválidos');
  END IF;

  DELETE FROM public.transport_unloading_costs WHERE transport_request_id = p_request_id AND status = 'ESTIMADO';
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_amount := COALESCE(NULLIF(v_item->>'estimated_pen', '')::numeric, 0);
    IF v_amount < 0 OR upper(COALESCE(v_item->>'concept', '')) NOT IN ('MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Concepto o monto de descarga inválido');
    END IF;
    -- Sin tarifa: el monto referencial manual exige motivo; sin monto queda "sin tarifa", nunca S/ 0 tarifado.
    v_manual := upper(COALESCE(v_item->>'estimated_source', '')) = 'MANUAL';
    v_reason := NULLIF(btrim(COALESCE(v_item->>'manual_reason', '')), '');
    IF v_manual AND (v_amount <= 0 OR v_amount <> round(v_amount, 2)) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Ingrese el costo referencial manual de ' || lower(v_item->>'concept') || ' (mayor a cero, dos decimales)');
    END IF;
    IF v_manual AND (v_reason IS NULL OR length(v_reason) < 3 OR length(v_reason) > 500) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del costo manual de ' || lower(v_item->>'concept') || ' (sin tarifa)');
    END IF;
    INSERT INTO public.transport_unloading_costs (transport_request_id, contract_id, concept, description, estimated_pen, created_by, cost_center_id,
      origin, estimated_source, manual_reason, tariff_missing)
    VALUES (p_request_id, r.contract_id, upper(v_item->>'concept'), NULLIF(trim(COALESCE(v_item->>'description', '')), ''), v_amount, auth.uid(),
      (SELECT cost_center_id FROM public.transport_requests WHERE id=p_request_id),
      'SOLICITUD', CASE WHEN v_manual THEN 'MANUAL' END, CASE WHEN v_manual THEN v_reason END, v_manual);
    v_total := v_total + v_amount;
  END LOOP;

  -- La partida debe cubrir flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := r.service_cost + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  IF r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0) THEN
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total, unloading_required = jsonb_array_length(p_items) > 0, status = 'OBSERVADA',
      budget_shortfall = v_cost - COALESCE(b.balance_pen, 0),
      budget_observation = 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga)'
    WHERE id = p_request_id;
  ELSE
    UPDATE public.transport_requests SET unloading_estimate_pen = v_total, unloading_required = jsonb_array_length(p_items) > 0,
      status = CASE WHEN status = 'OBSERVADA' THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
      budget_shortfall = 0, budget_observation = NULL
    WHERE id = p_request_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'unloading_estimate_pen', v_total,
    'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;

-- ------------------------------------------------------------
-- 4. Tarifario: una línea sin tarifa queda marcada y el monto manual no se sobrescribe con 0.
--    (Incluye el ajuste de recojos de 20261013180000_own_fleet_pickup_documentation.)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_request_tariff(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r         record;
  b         public.contract_budgets%ROWTYPE;
  v_weight  numeric;
  v_unload  jsonb;
  q         jsonb;
  v_total   numeric := 0;
  v_cost    numeric;
  l         record;
  v_amount  numeric;
BEGIN
  SELECT t.id, t.status, t.contract_id, to_jsonb(t) AS j INTO r FROM public.transport_requests t WHERE t.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud inexistente'); END IF;
  IF NOT public.can_access_site((SELECT site_id FROM public.transport_requests WHERE id=p_request_id)) THEN RETURN jsonb_build_object('success',false,'error','Sede no autorizada'); END IF;
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo se calcula antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;

  -- Peso: lo pedido por componente o, si no hay, el estimado de la solicitud
  IF to_regclass('public.transport_request_components') IS NOT NULL THEN
    EXECUTE 'SELECT sum(requested_weight_kg) FROM public.transport_request_components WHERE request_id = $1' INTO v_weight USING p_request_id;
  END IF;
  v_weight := COALESCE(NULLIF(v_weight, 0), NULLIF((r.j->>'estimated_weight')::numeric, 0));
  SELECT COALESCE(jsonb_agg(jsonb_build_object('concept', concept, 'quantity', 1)), '[]'::jsonb) INTO v_unload
  FROM public.transport_unloading_costs WHERE transport_request_id = p_request_id AND status = 'ESTIMADO';

  q := public.quote_transport(r.contract_id,
    jsonb_build_array(jsonb_build_object('district', r.j->>'delivery_district', 'province', r.j->>'delivery_province',
      'department', r.j->>'delivery_department')),
    v_weight, NULL, NULL, v_unload);

  IF r.j->>'attention_mode'='RECOJO_CLIENTE' OR r.j->>'request_type'='RECOJO' THEN
    q := q || jsonb_build_object('freight_total',0,'total',COALESCE((q->>'unloading_total')::numeric,0),'client_total',NULL,'vehicle_class',NULL,'vehicle_class_suggested',false,'missing',COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'missing') e WHERE e#>>'{}' NOT ILIKE '%flete%' AND e#>>'{}' NOT ILIKE '%parada adicional%'),'[]'::jsonb),'attention_mode',r.j->>'attention_mode','pickup_freight_not_valued',r.j->>'request_type'='RECOJO','lines',
      COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(q->'lines') e
        WHERE e->>'concept' NOT IN ('FLETE','PARADA_ADICIONAL')),'[]'::jsonb));
  END IF;
  PERFORM set_config('tms.tariff_apply', 'on', true);
  -- Montos de descarga desde el tarifario. Sin tarifa: se marca tariff_missing y se conserva el
  -- costo referencial manual (con motivo); sin manual queda en 0 = por cotizar, no "costo cero".
  FOR l IN SELECT id, concept, estimated_pen, estimated_source FROM public.transport_unloading_costs
           WHERE transport_request_id = p_request_id AND status = 'ESTIMADO' LOOP
    v_amount := NULL;
    SELECT (e->>'unit_rate')::numeric INTO v_amount FROM jsonb_array_elements(q->'lines') e WHERE e->>'concept' = l.concept LIMIT 1;
    IF l.estimated_source = 'MANUAL' THEN
      UPDATE public.transport_unloading_costs SET tariff_missing = v_amount IS NULL WHERE id = l.id;
      v_total := v_total + COALESCE(l.estimated_pen, 0);
    ELSE
      UPDATE public.transport_unloading_costs SET estimated_pen = COALESCE(v_amount, 0),
        estimated_source = CASE WHEN v_amount IS NULL THEN NULL ELSE 'TARIFA' END, tariff_missing = v_amount IS NULL, manual_reason = NULL
      WHERE id = l.id;
      v_total := v_total + COALESCE(v_amount, 0);
    END IF;
  END LOOP;

  -- Partida: flete + descarga; si no alcanza queda observada (se levanta al ampliar la partida)
  v_cost := COALESCE((q->>'freight_total')::numeric, 0) + v_total;
  SELECT * INTO b FROM public.contract_budgets WHERE contract_id = r.contract_id AND concept = 'PARTIDA_TRANSPORTE';
  UPDATE public.transport_requests SET
    service_cost = COALESCE((q->>'freight_total')::numeric, 0), unloading_estimate_pen = v_total,
    cost_breakdown = q, cost_source = 'TARIFARIO', cost_override_reason = NULL,
    status = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0) THEN 'OBSERVADA'
                  WHEN status = 'OBSERVADA' AND (budget_shortfall>0 OR budget_observation LIKE 'Partida insuficiente%') THEN 'PENDIENTE DE APROBACIÓN' ELSE status END,
    budget_shortfall = CASE WHEN r.contract_id IS NULL THEN 0 ELSE GREATEST(v_cost - COALESCE(b.balance_pen, 0), 0) END,
    budget_observation = CASE WHEN r.contract_id IS NOT NULL AND v_cost > COALESCE(b.balance_pen, 0)
      THEN 'Partida insuficiente: faltan S/ ' || round(v_cost - COALESCE(b.balance_pen, 0), 2) || ' (flete + descarga, referencial)' END
  WHERE id = p_request_id;
  PERFORM set_config('tms.tariff_apply', '', true);

  RETURN jsonb_build_object('success', true, 'quote', q, 'service_cost', COALESCE((q->>'freight_total')::numeric, 0),
    'unloading_estimate_pen', v_total, 'status', (SELECT status FROM public.transport_requests WHERE id = p_request_id));
END $$;

-- ------------------------------------------------------------
-- 5. Caja: la línea no planificada que crea un gasto aprobado queda con origen CAJA
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.caja_unloading_expense_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  l        public.transport_unloading_costs%ROWTYPE;
  v_ctr    uuid;
  v_req    uuid;
  v_amount numeric;
  v_line   uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.dispatch_id IS NULL
     OR upper(COALESCE(NEW.expense_type, '')) NOT IN ('ALQUILER_EQUIPO', 'CUADRILLA_ESTIBA') THEN
    RETURN NULL;
  END IF;

  IF NEW.status = 'APROBADO' THEN
    IF EXISTS (SELECT 1 FROM public.transport_unloading_costs WHERE expense_id = NEW.id) THEN RETURN NULL; END IF;
    v_amount := COALESCE((to_jsonb(NEW)->>'approved_amount')::numeric, NEW.amount);
    -- La línea planificada del mismo tipo en el despacho (la de monto más cercano); si no hay, se crea una no planificada
    SELECT * INTO l FROM public.transport_unloading_costs
    WHERE dispatch_id = NEW.dispatch_id AND status = 'PLANIFICADO' AND expense_id IS NULL
      AND concept = ANY (CASE WHEN upper(NEW.expense_type) = 'ALQUILER_EQUIPO' THEN ARRAY['MONTACARGAS', 'GRUA'] ELSE ARRAY['ESTIBA'] END)
    ORDER BY abs(COALESCE(planned_pen, 0) - v_amount), planned_at, id LIMIT 1 FOR UPDATE;  -- la más parecida al gasto
    IF FOUND THEN
      v_line := l.id;
    ELSE
      SELECT x.contract_id INTO v_ctr FROM public.dispatches x WHERE x.id = NEW.dispatch_id;
      SELECT r.transport_request_id, COALESCE(v_ctr, t.contract_id) INTO v_req, v_ctr
      FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id
      WHERE r.dispatch_id = NEW.dispatch_id ORDER BY t.request_number LIMIT 1;
      IF v_ctr IS NULL OR v_req IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.contract_budgets WHERE contract_id = v_ctr AND concept = 'PARTIDA_TRANSPORTE') THEN
        RETURN NULL;  -- viaje sin contrato/partida: el gasto queda solo en Caja
      END IF;
      INSERT INTO public.transport_unloading_costs (transport_request_id, dispatch_id, contract_id, concept, description, status, created_by, origin)
      VALUES (v_req, NEW.dispatch_id, v_ctr, CASE WHEN upper(NEW.expense_type) = 'ALQUILER_EQUIPO' THEN 'MONTACARGAS' ELSE 'ESTIBA' END,
        'No planificado · gasto de Caja', 'ESTIMADO', auth.uid(), 'CAJA')
      RETURNING id INTO v_line;
    END IF;
    PERFORM public.unloading_consume(v_line, v_amount, NEW.id, to_jsonb(NEW)->>'provider_name');

  ELSIF OLD.status = 'APROBADO' THEN
    -- Caja revirtió la aprobación: se anula el servicio y se devuelve el consumo (la reserva planificada se restituye)
    SELECT * INTO l FROM public.transport_unloading_costs WHERE expense_id = NEW.id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE public.contract_services SET status = 'ANULADO' WHERE id = l.contract_service_id;
    UPDATE public.contract_budgets SET consumed_pen = GREATEST(consumed_pen - COALESCE(l.actual_pen, 0), 0),
      reserved_pen = reserved_pen + CASE WHEN l.planned_pen IS NOT NULL THEN l.planned_pen ELSE 0 END, updated_at = now()
    WHERE contract_id = l.contract_id AND concept = 'PARTIDA_TRANSPORTE';
    UPDATE public.transport_unloading_costs SET status = CASE WHEN planned_pen IS NOT NULL THEN 'PLANIFICADO' ELSE 'ANULADO' END,
      actual_pen = NULL, expense_id = NULL, contract_service_id = NULL, consumed_by = NULL, consumed_at = NULL,
      void_reason = CASE WHEN planned_pen IS NULL THEN 'Caja revirtió la aprobación del gasto' ELSE void_reason END
    WHERE id = l.id;
  END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------
-- 6. Herencia en la ruta: las líneas pedidas (ESTIMADO) de sus paradas pasan a PLANIFICADO con el monto
--    de la solicitud a través de plan_dispatch_unloading (reserva de partida/OC incluida) y el montacarga
--    se vincula a la línea MONTACARGAS de su parada. Idempotente: volver a ejecutarlo no duplica líneas
--    ni reservas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inherit_route_unloading(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_items jsonb; v_result jsonb; v_stop uuid; v_line uuid; v_current uuid;
BEGIN
 IF EXISTS (SELECT 1 FROM public.transport_unloading_costs u JOIN public.dispatch_requests dr
   ON dr.transport_request_id=u.transport_request_id AND dr.dispatch_id=p_dispatch_id
   WHERE u.status='ESTIMADO' AND u.dispatch_id IS NULL) THEN
  -- La lista completa del despacho: lo ya planificado conserva su monto; lo pedido entra con su estimado.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',u.id,'planned_pen',COALESCE(u.planned_pen,u.estimated_pen,0)) ORDER BY u.created_at,u.id),'[]'::jsonb)
  INTO v_items FROM public.transport_unloading_costs u
  WHERE (u.dispatch_id=p_dispatch_id AND u.status='PLANIFICADO')
     OR (u.dispatch_id IS NULL AND u.status='ESTIMADO'
         AND u.transport_request_id IN (SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id=p_dispatch_id));
  v_result:=public.plan_dispatch_unloading(p_dispatch_id,v_items);
  -- plan_dispatch_unloading valida todo antes de aplicar: si rechaza (p. ej. OT sin partida), nada cambió.
  -- La ruta se programa igual; las líneas quedan ESTIMADO para planificarlas en Torre de Control.
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN
   INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
   VALUES(p_dispatch_id,'DESCARGA_NO_HEREDADA','La descarga solicitada no se pudo planificar al programar: '
    ||left(COALESCE(v_result->>'error','error desconocido'),300)||'. Planifíquela en Torre de Control.',COALESCE(auth.uid()::text,'system'));
  END IF;
 END IF;

 SELECT transport_request_id,unloading_cost_id INTO v_stop,v_current FROM public.route_forklifts WHERE dispatch_id=p_dispatch_id;
 IF FOUND AND v_stop IS NOT NULL THEN
  SELECT u.id INTO v_line FROM public.transport_unloading_costs u
  WHERE u.dispatch_id=p_dispatch_id AND u.transport_request_id=v_stop AND u.concept='MONTACARGAS' AND u.status IN ('PLANIFICADO','CONSUMIDO')
    AND NOT EXISTS (SELECT 1 FROM public.route_forklifts o WHERE o.unloading_cost_id=u.id AND o.dispatch_id<>p_dispatch_id)
  ORDER BY (u.id=v_current) DESC,u.created_at,u.id LIMIT 1;
  IF v_line IS DISTINCT FROM v_current THEN
   UPDATE public.route_forklifts SET unloading_cost_id=v_line WHERE dispatch_id=p_dispatch_id;
  END IF;
 END IF;
 RETURN jsonb_build_object('success',true,'forklift_unloading_cost_id',v_line,'warning',CASE WHEN v_result->>'success'='false' THEN v_result->>'error' END,
  'planned',(SELECT count(*) FROM public.transport_unloading_costs WHERE dispatch_id=p_dispatch_id AND status='PLANIFICADO'));
END $$;
REVOKE ALL ON FUNCTION public.inherit_route_unloading(uuid) FROM PUBLIC,anon,authenticated;

-- El vínculo sigue a la línea: si Torre de Control la retira o anula se desvincula; si planifica
-- la línea MONTACARGAS de la parada del montacarga (y no tenía), se vincula.
CREATE OR REPLACE FUNCTION public.route_forklift_unloading_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.route_forklifts SET unloading_cost_id=NULL
 WHERE unloading_cost_id=NEW.id AND (NEW.status NOT IN ('PLANIFICADO','CONSUMIDO') OR dispatch_id IS DISTINCT FROM NEW.dispatch_id);
 IF NEW.concept='MONTACARGAS' AND NEW.status='PLANIFICADO' AND NEW.dispatch_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.route_forklifts WHERE unloading_cost_id=NEW.id) THEN
  UPDATE public.route_forklifts SET unloading_cost_id=NEW.id
  WHERE dispatch_id=NEW.dispatch_id AND transport_request_id=NEW.transport_request_id AND unloading_cost_id IS NULL;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.route_forklift_unloading_link() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS route_forklift_unloading_link ON public.transport_unloading_costs;
CREATE TRIGGER route_forklift_unloading_link AFTER INSERT OR UPDATE OF status,dispatch_id ON public.transport_unloading_costs
 FOR EACH ROW EXECUTE FUNCTION public.route_forklift_unloading_link();

-- schedule_route_resources: misma lógica de 20261103120000_route_forklift_stop + herencia de servicios especiales.
CREATE OR REPLACE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_supplier_person uuid; v_name text; v_doc text; v_rate numeric;
 v_license text; v_expiration date; v_phone text; v_registered_plate text; v_stop uuid; v_stops uuid[];
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 IF p->>'mode'='TERCERO' THEN
  v_id:=public.schedule_dispatch_tercero((p->>'p_carrier_id')::uuid,p->>'p_plate',p->>'p_conductor',p->>'p_telefono',p->>'p_doc',
   (p->>'p_departure')::timestamptz,(p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->'p_requests');
 ELSE
  v_id:=public.schedule_dispatch((p->>'p_driver_id')::uuid,p->>'p_vehicle_plate',(p->>'p_departure')::timestamptz,
   (p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->>'p_document_type',p->'p_requests');
 END IF;
 IF p->>'mode'='TERCERO' THEN
  UPDATE public.dispatches SET tercero_license_number=NULLIF(btrim(p->>'p_tercero_license_number'),''),
   tercero_license_expiration=NULLIF(p->>'p_tercero_license_expiration','')::date WHERE id=v_id;
  IF NULLIF(p->>'p_supplier_personnel_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.full_name,x.document_number,x.license_number,x.license_expiration,x.phone FROM public.supplier_personnel x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING (p->>'p_supplier_personnel_id')::uuid,v_id;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El conductor no pertenece al transportista seleccionado o está inactivo'; END IF;
   UPDATE public.dispatches SET tercero_conductor=v_name,tercero_doc=v_doc,tercero_telefono=v_phone,tercero_license_number=v_license,tercero_license_expiration=v_expiration WHERE id=v_id;
  END IF;
  IF NULLIF(p->>'p_supplier_vehicle_id','') IS NOT NULL THEN
   EXECUTE 'SELECT x.plate FROM public.supplier_vehicles x JOIN public.carriers c ON c.supplier_id=x.supplier_id WHERE x.id=$1 AND c.id=(SELECT carrier_id FROM public.dispatches WHERE id=$2) AND x.is_active'
    INTO v_registered_plate USING (p->>'p_supplier_vehicle_id')::uuid,v_id;
   IF v_registered_plate IS NULL OR upper(regexp_replace(v_registered_plate,'[^A-Za-z0-9]','','g'))<>upper(regexp_replace((SELECT vehicle_plate FROM public.dispatches WHERE id=v_id),'[^A-Za-z0-9]','','g')) THEN
    RAISE EXCEPTION 'La placa seleccionada no corresponde a una unidad activa del transportista';
   END IF;
  END IF;
 END IF;
 IF jsonb_array_length(COALESCE(p->'auxiliaries','[]'::jsonb))>0 THEN
  v_result:=public.set_route_auxiliaries(v_id,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p->'auxiliaries')));
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 IF f IS NOT NULL AND f<>'null'::jsonb THEN
  v_stop:=NULLIF(f->>'transport_request_id','')::uuid;
  SELECT array_agg(dr.transport_request_id) INTO v_stops FROM public.dispatch_requests dr WHERE dr.dispatch_id=v_id;
  IF v_stop IS NULL AND cardinality(v_stops)=1 THEN v_stop:=v_stops[1]; END IF;
  IF v_stop IS NULL OR NOT COALESCE(v_stop=ANY(v_stops),false) THEN
   RAISE EXCEPTION 'Seleccione la parada de esta ruta donde se usará el montacarga';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.suppliers WHERE id=(f->>'supplier_id')::uuid AND is_active) THEN RAISE EXCEPTION 'Seleccione un proveedor activo de montacarga'; END IF;
  v_rate:=NULLIF(f->>'hourly_rate','')::numeric;
  IF v_rate IS NULL OR v_rate<=0 OR v_rate>100000 THEN RAISE EXCEPTION 'Ingrese una tarifa por hora válida'; END IF;
  v_person:=NULLIF(f->>'person_id','')::uuid;
  IF v_person IS NOT NULL THEN
   SELECT * INTO hp FROM public.hhee_people WHERE id=v_person AND active;
   IF NOT FOUND THEN RAISE EXCEPTION 'Montacarguista inactivo o inexistente'; END IF;
   v_name:=hp.name; v_doc:=hp.document_number;
  ELSE v_name:=btrim(f->>'operator_name'); v_doc:=NULLIF(btrim(f->>'document_number'),''); END IF;
  IF COALESCE(length(v_name),0)<3 OR length(v_name)>200 THEN RAISE EXCEPTION 'Indique el nombre del montacarguista'; END IF;
  IF length(COALESCE(f->>'notes',''))>1000 OR length(COALESCE(f->>'license_number',''))>100 OR length(COALESCE(v_doc,''))>50 OR length(COALESCE(f->>'phone',''))>50 THEN RAISE EXCEPTION 'Datos de montacarga demasiado extensos'; END IF;
  INSERT INTO public.route_forklifts(dispatch_id,supplier_id,person_id,operator_name,document_number,license_number,license_expiration,phone,notes,assigned_by,hourly_rate,transport_request_id)
   VALUES(v_id,(f->>'supplier_id')::uuid,v_person,v_name,v_doc,NULLIF(btrim(f->>'license_number'),''),NULLIF(f->>'license_expiration','')::date,NULLIF(btrim(f->>'phone'),''),NULLIF(btrim(f->>'notes'),''),auth.uid(),v_rate,v_stop);
  v_supplier_person:=NULLIF(f->>'supplier_personnel_id','')::uuid;
  IF v_supplier_person IS NOT NULL THEN
   EXECUTE 'SELECT full_name,document_number,license_number,license_expiration,phone FROM public.supplier_personnel WHERE id=$1 AND supplier_id=$2 AND is_active'
    INTO v_name,v_doc,v_license,v_expiration,v_phone USING v_supplier_person,(f->>'supplier_id')::uuid;
   IF v_name IS NULL THEN RAISE EXCEPTION 'El montacarguista no pertenece al proveedor seleccionado o está inactivo'; END IF;
   EXECUTE 'UPDATE public.route_forklifts SET supplier_personnel_id=$1,operator_name=$2,document_number=$3,license_number=$4,license_expiration=$5,phone=$6 WHERE dispatch_id=$7'
    USING v_supplier_person,v_name,v_doc,v_license,v_expiration,v_phone,v_id;
  END IF;
 END IF;
 -- Servicios especiales pedidos en la solicitud: pasan a la ruta (sin duplicar) y el montacarga se vincula.
 PERFORM public.inherit_route_unloading(v_id);
 RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.schedule_route_resources(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_route_resources(jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
