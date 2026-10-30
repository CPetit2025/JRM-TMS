-- Etapa 2 · Costo acordado por servicio especial. Al programar la ruta, cada servicio (grúa, montacarga, estiba, otros)
-- registra proveedor, modalidad de cobro, tarifa y cantidad; el monto acordado es planned_pen de su línea en
-- transport_unloading_costs (la misma línea que viene de la solicitud: no se duplica). Se suman las categorías de
-- proveedor GRUA y ESTIBA y un historial solo de inserción de cada cambio de costo (referencial, acordado, final).
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Proveedores de grúa y estiba (NOT VALID: no revalida filas históricas de producción)
-- ------------------------------------------------------------
ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_category_check;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_category_check
 CHECK (category IN ('MATERIA_PRIMA','INSUMOS','PRODUCCION','PROYECTOS','SERVICIOS','OTROS','TRANSPORTE','MONTACARGA','GRUA','ESTIBA')) NOT VALID;

-- ------------------------------------------------------------
-- 2. Acuerdo por línea de servicio
-- ------------------------------------------------------------
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS supplier_id uuid;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS billing_unit text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS agreed_rate numeric(15,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS agreed_qty numeric(10,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS workers integer;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS min_billable_qty numeric(10,2);
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS fraction_minutes integer;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS agreed_reason text;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS agreed_by uuid;
ALTER TABLE public.transport_unloading_costs ADD COLUMN IF NOT EXISTS agreed_at timestamptz;

DO $constraints$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_supplier_fk') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_supplier_fk
   FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transport_unloading_costs_agreement_check') THEN
  ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_agreement_check CHECK (
   (billing_unit IS NULL OR billing_unit IN ('SERVICIO','HORA','JORNADA'))
   AND (agreed_rate IS NULL OR agreed_rate > 0) AND (agreed_qty IS NULL OR agreed_qty > 0)
   AND (workers IS NULL OR workers BETWEEN 1 AND 200) AND (min_billable_qty IS NULL OR min_billable_qty >= 0)
   AND (fraction_minutes IS NULL OR fraction_minutes IN (15,30,60)));
 END IF;
END $constraints$;
-- Regla C55: toda FK nueva cubierta por un índice no parcial.
CREATE INDEX IF NOT EXISTS transport_unloading_costs_supplier_idx ON public.transport_unloading_costs(supplier_id);

-- ------------------------------------------------------------
-- 3. Historial de costos (solo inserción). Sin FK a la línea: el historial sobrevive aunque la solicitud
--    reemplace sus líneas estimadas. service_kind deja lugar al flete (Etapa 3).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.service_cost_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_kind         text NOT NULL DEFAULT 'DESCARGA' CHECK (service_kind IN ('DESCARGA','FLETE')),
  unloading_cost_id    uuid,
  transport_request_id uuid,
  dispatch_id          uuid,
  contract_id          uuid,
  concept              text,
  stage                text NOT NULL CHECK (stage IN ('REFERENCIAL','ACORDADO','FINAL','ESTADO')),
  old_amount           numeric(15,2),
  new_amount           numeric(15,2),
  old_status           text,
  new_status           text,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason               text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_cost_events_line_idx ON public.service_cost_events(unloading_cost_id, created_at);
CREATE INDEX IF NOT EXISTS service_cost_events_dispatch_idx ON public.service_cost_events(dispatch_id, created_at);
CREATE INDEX IF NOT EXISTS service_cost_events_request_idx ON public.service_cost_events(transport_request_id, created_at);
CREATE INDEX IF NOT EXISTS service_cost_events_contract_idx ON public.service_cost_events(contract_id, created_at);
ALTER TABLE public.service_cost_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.service_cost_events;
CREATE POLICY security_active_account ON public.service_cost_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
-- Lectura solo por service_cost_history; escritura solo por los disparadores y RPC de abajo
REVOKE ALL ON public.service_cost_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.service_cost_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'El historial de costos no se modifica ni se borra';
END $$;
REVOKE ALL ON FUNCTION public.service_cost_events_append_only() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS service_cost_events_append_only ON public.service_cost_events;
CREATE TRIGGER service_cost_events_append_only BEFORE UPDATE OR DELETE ON public.service_cost_events
 FOR EACH ROW EXECUTE FUNCTION public.service_cost_events_append_only();

-- Cada cambio de monto, acuerdo o estado de una línea deja su evento. El motivo llega por tms.cost_reason
-- (lo fijan las RPC); si no, el motivo propio de la línea (anulación o costo manual).
-- tms.cost_log_defer='on' lo suspende mientras set_special_service_agreements escribe su propio evento.
CREATE OR REPLACE FUNCTION public.log_unloading_cost_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text; v_by uuid := auth.uid(); v_agreement_changed boolean;
BEGIN
 IF COALESCE(current_setting('tms.cost_log_defer', true), '') = 'on' THEN RETURN NULL; END IF;
 v_reason := NULLIF(btrim(COALESCE(current_setting('tms.cost_reason', true), '')), '');
 IF TG_OP = 'INSERT' THEN
  INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,new_amount,new_status,detail,reason,created_by)
  VALUES (NEW.id,NEW.transport_request_id,NEW.dispatch_id,NEW.contract_id,NEW.concept,
   CASE NEW.status WHEN 'PLANIFICADO' THEN 'ACORDADO' WHEN 'CONSUMIDO' THEN 'FINAL' WHEN 'ANULADO' THEN 'ESTADO' ELSE 'REFERENCIAL' END,
   CASE NEW.status WHEN 'PLANIFICADO' THEN NEW.planned_pen WHEN 'CONSUMIDO' THEN NEW.actual_pen WHEN 'ANULADO' THEN NULL ELSE NEW.estimated_pen END,
   NEW.status, jsonb_build_object('origin',NEW.origin,'estimated_source',NEW.estimated_source,'tariff_missing',NEW.tariff_missing),
   COALESCE(v_reason, NEW.manual_reason, NEW.void_reason), v_by);
  RETURN NULL;
 END IF;
 IF NEW.estimated_pen IS DISTINCT FROM OLD.estimated_pen OR NEW.estimated_source IS DISTINCT FROM OLD.estimated_source THEN
  INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,old_amount,new_amount,old_status,new_status,detail,reason,created_by)
  VALUES (NEW.id,NEW.transport_request_id,NEW.dispatch_id,NEW.contract_id,NEW.concept,'REFERENCIAL',OLD.estimated_pen,NEW.estimated_pen,OLD.status,NEW.status,
   jsonb_build_object('estimated_source',NEW.estimated_source,'tariff_missing',NEW.tariff_missing),COALESCE(v_reason,NEW.manual_reason),v_by);
 END IF;
 v_agreement_changed := NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.billing_unit IS DISTINCT FROM OLD.billing_unit
  OR NEW.agreed_rate IS DISTINCT FROM OLD.agreed_rate OR NEW.agreed_qty IS DISTINCT FROM OLD.agreed_qty OR NEW.workers IS DISTINCT FROM OLD.workers
  OR NEW.min_billable_qty IS DISTINCT FROM OLD.min_billable_qty OR NEW.fraction_minutes IS DISTINCT FROM OLD.fraction_minutes;
 IF NEW.planned_pen IS DISTINCT FROM OLD.planned_pen OR v_agreement_changed THEN
  INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,old_amount,new_amount,old_status,new_status,detail,reason,created_by)
  VALUES (NEW.id,NEW.transport_request_id,COALESCE(NEW.dispatch_id,OLD.dispatch_id),NEW.contract_id,NEW.concept,'ACORDADO',OLD.planned_pen,NEW.planned_pen,OLD.status,NEW.status,
   jsonb_build_object('supplier_id',NEW.supplier_id,'billing_unit',NEW.billing_unit,'agreed_rate',NEW.agreed_rate,'agreed_qty',NEW.agreed_qty,
    'workers',NEW.workers,'min_billable_qty',NEW.min_billable_qty,'fraction_minutes',NEW.fraction_minutes),
   COALESCE(v_reason,NEW.agreed_reason),v_by);
 END IF;
 IF NEW.actual_pen IS DISTINCT FROM OLD.actual_pen THEN
  INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,old_amount,new_amount,old_status,new_status,detail,reason,created_by)
  VALUES (NEW.id,NEW.transport_request_id,NEW.dispatch_id,NEW.contract_id,NEW.concept,'FINAL',OLD.actual_pen,NEW.actual_pen,OLD.status,NEW.status,
   jsonb_build_object('provider_name',NEW.provider_name,'expense_id',NEW.expense_id),v_reason,v_by);
 ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.planned_pen IS NOT DISTINCT FROM OLD.planned_pen AND NOT v_agreement_changed
   AND NEW.estimated_pen IS NOT DISTINCT FROM OLD.estimated_pen THEN
  INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,old_status,new_status,reason,created_by)
  VALUES (NEW.id,NEW.transport_request_id,COALESCE(NEW.dispatch_id,OLD.dispatch_id),NEW.contract_id,NEW.concept,'ESTADO',OLD.status,NEW.status,
   COALESCE(v_reason,CASE WHEN NEW.status='ANULADO' THEN NEW.void_reason END),v_by);
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.log_unloading_cost_change() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS log_unloading_cost_change ON public.transport_unloading_costs;
CREATE TRIGGER log_unloading_cost_change AFTER INSERT OR UPDATE ON public.transport_unloading_costs
 FOR EACH ROW EXECUTE FUNCTION public.log_unloading_cost_change();

-- ------------------------------------------------------------
-- 4. Acuerdo de servicios al programar.
--    p = { items: [{ id?, transport_request_id, concept, description, supplier_id, billing_unit, agreed_rate,
--                    agreed_qty, workers?, min_billable_qty?, fraction_minutes?, reason? }],
--          removed: [{ id, reason }] }
--    · id: línea heredada (solicitud) o ya planificada; sin id = servicio agregado en programación (motivo obligatorio).
--    · Monto acordado = tarifa × max(cantidad, mínimo) × trabajadores; pasa a planned_pen por plan_dispatch_unloading
--      (reserva de partida u OC incluida). El montacarga vinculado toma proveedor y tarifa por hora de route_forklifts.
--    · removed: el servicio pedido no se programa; queda ANULADO con su motivo y libera su reserva.
--    Las líneas sin acuerdo conservan el monto heredado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_special_service_agreements(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; f record; l record; e jsonb; v_items jsonb := '[]'; v_removed uuid[] := '{}'; v_seen uuid[] := '{}';
 v_id uuid; v_req uuid; v_concept text; v_supplier uuid; v_category text; v_unit text; v_rate numeric; v_qty numeric; v_workers int;
 v_min numeric; v_fraction int; v_reason text; v_amount numeric; v_plan jsonb; v_result jsonb; v_forklift_line uuid; v_old jsonb := '{}'::jsonb;
 v_count int := 0;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Solo Programación y Ruteo acuerda los costos de los servicios'; END IF;
 SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
 IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status <> 'PROGRAMADO' THEN RAISE EXCEPTION 'Los costos acordados se registran mientras la ruta está programada'; END IF;
 IF p IS NULL OR jsonb_typeof(COALESCE(p->'items','[]'::jsonb)) <> 'array' OR jsonb_typeof(COALESCE(p->'removed','[]'::jsonb)) <> 'array' THEN
  RAISE EXCEPTION 'Servicios especiales inválidos';
 END IF;
 SELECT rf.transport_request_id, rf.supplier_id, rf.hourly_rate, rf.unloading_cost_id INTO f FROM public.route_forklifts rf WHERE rf.dispatch_id = p_dispatch_id;
 v_forklift_line := f.unloading_cost_id;

 -- Servicios pedidos que no se programan
 FOR e IN SELECT value FROM jsonb_array_elements(COALESCE(p->'removed','[]'::jsonb)) LOOP
  v_id := NULLIF(e->>'id','')::uuid; v_reason := NULLIF(btrim(COALESCE(e->>'reason','')),'');
  SELECT u.* INTO l FROM public.transport_unloading_costs u
  WHERE u.id = v_id AND u.status IN ('ESTIMADO','PLANIFICADO') AND COALESCE(u.dispatch_id,p_dispatch_id) = p_dispatch_id
    AND EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=p_dispatch_id AND dr.transport_request_id=u.transport_request_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Servicio a retirar no disponible en esta ruta'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
   RAISE EXCEPTION 'Indique el motivo para no programar % (mínimo 5 caracteres)', lower(l.concept);
  END IF;
  IF v_id = ANY(v_removed) THEN RAISE EXCEPTION 'Servicio duplicado'; END IF;
  v_removed := array_append(v_removed, v_id);
  v_old := v_old || jsonb_build_object(v_id::text, jsonb_build_object('amount', COALESCE(l.planned_pen, l.estimated_pen), 'status', l.status, 'reason', v_reason));
 END LOOP;

 -- Validación y cálculo de cada acuerdo
 FOR e IN SELECT value FROM jsonb_array_elements(COALESCE(p->'items','[]'::jsonb)) LOOP
  v_id := NULLIF(e->>'id','')::uuid; v_reason := NULLIF(btrim(COALESCE(e->>'reason','')),'');
  IF v_id IS NOT NULL THEN
   IF v_id = ANY(v_removed) OR v_id = ANY(v_seen) THEN RAISE EXCEPTION 'Servicio duplicado'; END IF;
   SELECT u.* INTO l FROM public.transport_unloading_costs u
   WHERE u.id = v_id AND u.status IN ('ESTIMADO','PLANIFICADO') AND COALESCE(u.dispatch_id,p_dispatch_id) = p_dispatch_id
     AND EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=p_dispatch_id AND dr.transport_request_id=u.transport_request_id) FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Servicio especial no disponible en esta ruta'; END IF;
   v_req := l.transport_request_id; v_concept := l.concept;
   v_seen := array_append(v_seen, v_id);
  ELSE
   v_req := NULLIF(e->>'transport_request_id','')::uuid; v_concept := upper(COALESCE(e->>'concept',''));
   IF NOT EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=p_dispatch_id AND dr.transport_request_id=v_req) THEN
    RAISE EXCEPTION 'La parada del servicio agregado no pertenece a esta ruta';
   END IF;
   IF v_concept NOT IN ('MONTACARGAS','GRUA','ESTIBA','OTROS') THEN RAISE EXCEPTION 'Tipo de servicio especial inválido'; END IF;
   IF v_reason IS NULL OR length(v_reason) < 5 THEN
    RAISE EXCEPTION 'Indique el motivo del servicio de % agregado en programación (mínimo 5 caracteres)', lower(v_concept);
   END IF;
  END IF;
  IF length(COALESCE(v_reason,'')) > 500 OR length(COALESCE(e->>'description','')) > 300 THEN RAISE EXCEPTION 'Datos del servicio demasiado extensos'; END IF;

  v_supplier := NULLIF(e->>'supplier_id','')::uuid; v_unit := upper(COALESCE(NULLIF(e->>'billing_unit',''),'SERVICIO'));
  v_rate := NULLIF(e->>'agreed_rate','')::numeric; v_qty := COALESCE(NULLIF(e->>'agreed_qty','')::numeric, 1);
  v_workers := CASE WHEN v_concept = 'ESTIBA' THEN COALESCE(NULLIF(e->>'workers','')::int, 1) END;
  v_min := NULLIF(e->>'min_billable_qty','')::numeric; v_fraction := NULLIF(e->>'fraction_minutes','')::int;
  -- El montacarga programado en la ruta es la fuente de su proveedor y tarifa por hora
  IF v_concept = 'MONTACARGAS' AND f.transport_request_id IS NOT NULL AND v_req = f.transport_request_id
     AND (v_id IS NOT DISTINCT FROM v_forklift_line OR (v_forklift_line IS NULL AND v_id IS NULL)
          OR (v_forklift_line IS NULL AND NOT EXISTS (SELECT 1 FROM public.route_forklifts o WHERE o.unloading_cost_id = v_id))) THEN
   v_supplier := f.supplier_id; v_unit := 'HORA'; v_rate := f.hourly_rate;
   v_forklift_line := COALESCE(v_id, '00000000-0000-0000-0000-000000000000'::uuid);  -- un solo acuerdo toma el montacarga
  END IF;
  SELECT s.category INTO v_category FROM public.suppliers s WHERE s.id = v_supplier AND s.is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Seleccione un proveedor activo para %', lower(v_concept); END IF;
  IF NOT v_category = ANY (CASE v_concept WHEN 'MONTACARGAS' THEN ARRAY['MONTACARGA','SERVICIOS'] WHEN 'GRUA' THEN ARRAY['GRUA','SERVICIOS']
     WHEN 'ESTIBA' THEN ARRAY['ESTIBA','SERVICIOS'] ELSE ARRAY['SERVICIOS','GRUA','ESTIBA','MONTACARGA','TRANSPORTE'] END) THEN
   RAISE EXCEPTION 'El proveedor no presta servicios de %', lower(v_concept);
  END IF;
  IF v_unit NOT IN ('SERVICIO','HORA','JORNADA') OR (v_unit = 'JORNADA' AND v_concept IN ('MONTACARGAS','GRUA')) THEN
   RAISE EXCEPTION 'Modalidad de cobro inválida para %', lower(v_concept);
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 1000000 OR v_rate <> round(v_rate, 2) THEN RAISE EXCEPTION 'Ingrese la tarifa acordada de % (mayor a cero, dos decimales)', lower(v_concept); END IF;
  IF v_qty <= 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2) THEN RAISE EXCEPTION 'Cantidad acordada inválida para %', lower(v_concept); END IF;
  IF v_unit = 'SERVICIO' THEN v_min := NULL; v_fraction := NULL; END IF;
  IF v_unit = 'JORNADA' THEN v_fraction := NULL; END IF;
  IF v_workers IS NOT NULL AND (v_workers < 1 OR v_workers > 200) THEN RAISE EXCEPTION 'Cantidad de trabajadores inválida'; END IF;
  IF v_min IS NOT NULL AND (v_min < 0 OR v_min > 1000) THEN RAISE EXCEPTION 'Mínimo facturable inválido'; END IF;
  IF v_fraction IS NOT NULL AND v_fraction NOT IN (15,30,60) THEN RAISE EXCEPTION 'La fracción de cobro debe ser de 15, 30 o 60 minutos'; END IF;
  v_amount := round(v_rate * greatest(v_qty, COALESCE(v_min, 0)) * COALESCE(v_workers, 1), 2);

  IF v_id IS NULL THEN
   -- Servicio agregado en programación: nace como línea propia (origen PROGRAMACION) y se planifica abajo.
   INSERT INTO public.transport_unloading_costs (transport_request_id, contract_id, concept, description, estimated_pen, status, created_by, origin, cost_center_id)
   SELECT v_req, t.contract_id, v_concept, NULLIF(btrim(COALESCE(e->>'description','')),''), 0, 'ESTIMADO', auth.uid(), 'PROGRAMACION',
     (to_jsonb(t)->>'cost_center_id')::uuid
   FROM public.transport_requests t WHERE t.id = v_req RETURNING id INTO v_id;
   v_seen := array_append(v_seen, v_id);
   v_old := v_old || jsonb_build_object(v_id::text, jsonb_build_object('amount', NULL, 'status', NULL, 'added', true));
  ELSE
   v_old := v_old || jsonb_build_object(v_id::text, jsonb_build_object('amount', COALESCE(l.planned_pen, l.estimated_pen), 'status', l.status));
  END IF;
  v_items := v_items || jsonb_build_array(jsonb_build_object('id', v_id, 'amount', v_amount, 'supplier_id', v_supplier, 'billing_unit', v_unit,
   'agreed_rate', v_rate, 'agreed_qty', v_qty, 'workers', v_workers, 'min_billable_qty', v_min, 'fraction_minutes', v_fraction,
   'reason', v_reason, 'description', NULLIF(btrim(COALESCE(e->>'description','')),'')));
 END LOOP;
 IF jsonb_array_length(v_items) = 0 AND cardinality(v_removed) = 0 THEN
  RETURN jsonb_build_object('success', true, 'agreed', 0, 'removed', 0);
 END IF;

 -- Lista completa del despacho para plan_dispatch_unloading: lo acordado con su monto, el resto como estaba.
 SELECT COALESCE(jsonb_agg(x ORDER BY ord), '[]'::jsonb) INTO v_plan FROM (
  SELECT 1 AS ord, jsonb_build_object('id', i->>'id', 'planned_pen', (i->>'amount')::numeric, 'description', i->>'description') AS x
  FROM jsonb_array_elements(v_items) i
  UNION ALL
  SELECT 2, jsonb_build_object('id', u.id, 'planned_pen', u.planned_pen)
  FROM public.transport_unloading_costs u
  WHERE u.dispatch_id = p_dispatch_id AND u.status = 'PLANIFICADO' AND NOT (u.id = ANY(v_removed)) AND NOT (u.id = ANY(v_seen))) q;

 PERFORM set_config('tms.cost_log_defer', 'on', true);
 v_result := public.plan_dispatch_unloading(p_dispatch_id, v_plan);
 IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
  PERFORM set_config('tms.cost_log_defer', '', true);
  RAISE EXCEPTION '%', COALESCE(v_result->>'error', 'No se pudo reservar el costo acordado');
 END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(v_items) LOOP
  UPDATE public.transport_unloading_costs SET supplier_id=(e->>'supplier_id')::uuid, billing_unit=e->>'billing_unit',
   agreed_rate=(e->>'agreed_rate')::numeric, agreed_qty=(e->>'agreed_qty')::numeric, workers=(e->>'workers')::int,
   min_billable_qty=(e->>'min_billable_qty')::numeric, fraction_minutes=(e->>'fraction_minutes')::int,
   agreed_reason=e->>'reason', agreed_by=auth.uid(), agreed_at=now()
  WHERE id=(e->>'id')::uuid;
  v_count := v_count + 1;
 END LOOP;
 UPDATE public.transport_unloading_costs SET status='ANULADO', dispatch_id=p_dispatch_id, planned_pen=NULL, planned_by=NULL, planned_at=NULL,
  void_reason=(v_old->(id::text))->>'reason'
 WHERE id = ANY(v_removed);
 PERFORM set_config('tms.cost_log_defer', '', true);

 -- Un evento por servicio: anterior → acordado (o retirado), con su motivo
 INSERT INTO public.service_cost_events(unloading_cost_id,transport_request_id,dispatch_id,contract_id,concept,stage,old_amount,new_amount,old_status,new_status,detail,reason,created_by)
 SELECT u.id, u.transport_request_id, p_dispatch_id, u.contract_id, u.concept,
  CASE WHEN u.status='ANULADO' THEN 'ESTADO' ELSE 'ACORDADO' END,
  ((v_old->(u.id::text))->>'amount')::numeric, CASE WHEN u.status='ANULADO' THEN NULL ELSE u.planned_pen END,
  (v_old->(u.id::text))->>'status', u.status,
  CASE WHEN u.status='ANULADO' THEN jsonb_build_object('removed_at_programming',true)
   ELSE jsonb_build_object('supplier_id',u.supplier_id,'billing_unit',u.billing_unit,'agreed_rate',u.agreed_rate,'agreed_qty',u.agreed_qty,
    'workers',u.workers,'min_billable_qty',u.min_billable_qty,'fraction_minutes',u.fraction_minutes,'origin',u.origin,
    'added_at_programming',COALESCE(((v_old->(u.id::text))->>'added')::boolean,false)) END,
  CASE WHEN u.status='ANULADO' THEN u.void_reason ELSE u.agreed_reason END, auth.uid()
 FROM public.transport_unloading_costs u WHERE u.id = ANY(v_seen) OR u.id = ANY(v_removed);

 RETURN jsonb_build_object('success', true, 'agreed', v_count, 'removed', cardinality(v_removed), 'reserved_delta', v_result->'reserved_delta');
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.set_special_service_agreements(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.set_special_service_agreements(uuid,jsonb) TO authenticated;

-- Torre de Control: replanificar montos de descarga exige motivo y lo deja en el historial.
CREATE OR REPLACE FUNCTION public.plan_dispatch_unloading_with_reason(p_dispatch_id uuid, p_items jsonb, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),''); v_result jsonb;
BEGIN
 IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
  RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del cambio de costos (mínimo 5 caracteres)');
 END IF;
 PERFORM set_config('tms.cost_reason', v_reason, true);
 v_result := public.plan_dispatch_unloading(p_dispatch_id, p_items);
 PERFORM set_config('tms.cost_reason', '', true);
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.plan_dispatch_unloading_with_reason(uuid,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.plan_dispatch_unloading_with_reason(uuid,jsonb,text) TO authenticated;

-- Historial de costos de las paradas de una ruta (con nombre de usuario y proveedor)
CREATE OR REPLACE FUNCTION public.service_cost_history(p_dispatch_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_site uuid;
BEGIN
 IF NOT (public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')
   OR public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('contratos-servicios')) THEN
  RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al historial de costos');
 END IF;
 SELECT site_id INTO v_site FROM public.dispatches WHERE id = p_dispatch_id;
 IF NOT FOUND OR (v_site IS NOT NULL AND NOT public.can_access_site(v_site)) THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente'); END IF;
 RETURN jsonb_build_object('success', true, 'events', COALESCE((
  SELECT jsonb_agg(jsonb_build_object('id', ev.id, 'unloading_cost_id', ev.unloading_cost_id, 'transport_request_id', ev.transport_request_id,
    'concept', ev.concept, 'stage', ev.stage, 'old_amount', ev.old_amount, 'new_amount', ev.new_amount, 'old_status', ev.old_status,
    'new_status', ev.new_status, 'reason', ev.reason, 'created_at', ev.created_at,
    'supplier', (SELECT s.business_name FROM public.suppliers s WHERE s.id = NULLIF(ev.detail->>'supplier_id','')::uuid),
    'detail', ev.detail, 'user', (SELECT COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(pr)->>'first_name', to_jsonb(pr)->>'last_name')), ''), to_jsonb(pr)->>'full_name')
      FROM public.profiles pr WHERE pr.id = ev.created_by))
   ORDER BY ev.created_at DESC, ev.id)
  FROM public.service_cost_events ev
  WHERE ev.dispatch_id = p_dispatch_id
     OR (ev.dispatch_id IS NULL AND ev.transport_request_id IN (SELECT transport_request_id FROM public.dispatch_requests WHERE dispatch_id = p_dispatch_id))), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.service_cost_history(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.service_cost_history(uuid) TO authenticated;

-- ------------------------------------------------------------
-- 5. schedule_route_resources: misma lógica de 20261105090000_herencia_servicios_especiales + acuerdos
--    (p.special_services). Si un acuerdo no es válido o no hay saldo, no se programa la ruta.
-- ------------------------------------------------------------
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
 -- Costos acordados con proveedores (y servicios agregados o retirados con motivo)
 IF p->'special_services' IS NOT NULL AND p->'special_services'<>'null'::jsonb THEN
  v_result:=public.set_special_service_agreements(v_id,p->'special_services');
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RAISE EXCEPTION '%',v_result->>'error'; END IF;
 END IF;
 RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.schedule_route_resources(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.schedule_route_resources(jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
