-- Etapa D · Sustento del acordado al programar y nuevas unidades de cobro.
-- 1) Servicio especial heredado de la solicitud: si el monto acordado difiere del referencial (estimated_pen con tarifa
--    o costo manual), se exige motivo y queda en agreed_reason y en su evento ACORDADO. Las líneas «sin tarifa» no lo piden.
-- 2) Flete de la ruta: si difiere del referencial (suma de service_cost de las solicitudes), se exige p.freight_reason;
--    llega al evento ACORDADO por tms.cost_reason y queda en dispatch_freight_stages.agreed_reason.
--    Sin motivo: recojos con flota propia y Nota de Salida con flete 0.
-- 3) Unidades UNIDAD y TONELADA (grúa, estiba y otros; montacarga sigue por hora o servicio): se cobra
--    max(cantidad, mínimo), sin fracción ni multiplicar por trabajadores.
BEGIN;
SET LOCAL lock_timeout='60s';

-- ------------------------------------------------------------
-- 1. Columnas y regla de modalidades (se conservan las demás condiciones del acuerdo)
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_freight_stages ADD COLUMN IF NOT EXISTS agreed_reason text;

ALTER TABLE public.transport_unloading_costs DROP CONSTRAINT IF EXISTS transport_unloading_costs_agreement_check;
ALTER TABLE public.transport_unloading_costs ADD CONSTRAINT transport_unloading_costs_agreement_check CHECK (
 (billing_unit IS NULL OR billing_unit IN ('SERVICIO','HORA','JORNADA','UNIDAD','TONELADA'))
 AND (agreed_rate IS NULL OR agreed_rate > 0) AND (agreed_qty IS NULL OR agreed_qty > 0)
 AND (workers IS NULL OR workers BETWEEN 1 AND 200) AND (min_billable_qty IS NULL OR min_billable_qty >= 0)
 AND (fraction_minutes IS NULL OR fraction_minutes IN (15,30,60)));

-- ------------------------------------------------------------
-- 2. Cantidad facturable: UNIDAD y TONELADA cobran max(cantidad, mínimo), sin fracción
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.economic_billable_qty(p_unit text, p_qty numeric, p_fraction integer, p_min numeric) RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN COALESCE(p_qty, 0) <= 0 THEN 0
  WHEN p_unit = 'HORA' THEN round(greatest(ceil(p_qty * 60 / COALESCE(p_fraction, 60)) * COALESCE(p_fraction, 60) / 60.0, COALESCE(p_min, 0)), 2)
  WHEN p_unit IN ('JORNADA','UNIDAD','TONELADA') THEN round(greatest(p_qty, COALESCE(p_min, 0)), 2)
  ELSE round(p_qty, 2) END
$$;

-- Costo final: por unidad o tonelada la tarifa no se multiplica por trabajadores.
-- p = { executed_qty, workers?, extras_pen?, reason?, final_pen? (servicio sin acuerdo de tarifa) }
CREATE OR REPLACE FUNCTION public.validate_service_final(p_line_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l record; d record; v_qty numeric; v_workers int; v_extras numeric; v_reason text; v_billable numeric; v_base numeric; v_final numeric;
 v_reference numeric; v_hours numeric;
BEGIN
 IF NOT (public.has_tms_permission('despacho') OR public.has_tms_permission('cierre-economico')) THEN RAISE EXCEPTION 'Sin permiso para validar costos finales'; END IF;
 SELECT * INTO l FROM public.transport_unloading_costs WHERE id = p_line_id FOR UPDATE;
 IF NOT FOUND OR l.dispatch_id IS NULL OR l.status NOT IN ('PLANIFICADO','CONSUMIDO') THEN RAISE EXCEPTION 'Servicio no disponible para validar'; END IF;
 SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = l.dispatch_id;
 IF d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id) THEN RAISE EXCEPTION 'Despacho inexistente'; END IF;
 IF d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','CANCELADO') THEN RAISE EXCEPTION 'El costo final se valida después de la ejecución'; END IF;
 IF public.economic_closure_status(d.id) IN ('EN_REVISION','CERRADO') THEN
  RAISE EXCEPTION 'El cierre económico de la ruta está en revisión o cerrado: obsérvelo o reábralo para corregir';
 END IF;
 IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'Datos inválidos'; END IF;
 v_extras := COALESCE(NULLIF(p->>'extras_pen','')::numeric, 0);
 v_reason := NULLIF(btrim(COALESCE(p->>'reason','')),'');
 IF v_extras < 0 OR v_extras > 10000000 OR v_extras <> round(v_extras, 2) THEN RAISE EXCEPTION 'Adicionales inválidos (dos decimales)'; END IF;
 IF length(COALESCE(v_reason,'')) > 1000 THEN RAISE EXCEPTION 'Motivo demasiado extenso'; END IF;

 IF l.agreed_rate IS NOT NULL THEN
  v_qty := NULLIF(p->>'executed_qty','')::numeric;
  IF v_qty IS NULL AND l.concept = 'MONTACARGAS' THEN  -- horas liquidadas del montacarga vinculado
   SELECT final_hours INTO v_hours FROM public.route_forklifts WHERE unloading_cost_id = l.id;
   v_qty := v_hours;
  END IF;
  IF v_qty IS NULL OR v_qty < 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2) THEN
   RAISE EXCEPTION 'Indique la cantidad ejecutada (horas, jornadas, servicios, unidades o toneladas)';
  END IF;
  v_workers := CASE WHEN l.concept = 'ESTIBA' AND COALESCE(l.billing_unit, 'SERVICIO') NOT IN ('UNIDAD','TONELADA')
   THEN COALESCE(NULLIF(p->>'workers','')::int, l.workers, 1) END;
  IF v_workers IS NOT NULL AND (v_workers < 1 OR v_workers > 200) THEN RAISE EXCEPTION 'Cantidad de trabajadores inválida'; END IF;
  v_billable := public.economic_billable_qty(l.billing_unit, v_qty, l.fraction_minutes, l.min_billable_qty);
  v_base := round(l.agreed_rate * v_billable * COALESCE(v_workers, 1), 2);
 ELSE
  v_base := NULLIF(p->>'final_pen','')::numeric;
  IF v_base IS NULL OR v_base < 0 OR v_base > 10000000 OR v_base <> round(v_base, 2) THEN RAISE EXCEPTION 'Indique el costo final del servicio (sin tarifa acordada)'; END IF;
  v_qty := NULLIF(p->>'executed_qty','')::numeric;
 END IF;
 v_final := v_base + v_extras;
 v_reference := COALESCE(l.planned_pen, l.actual_pen, l.estimated_pen, 0);
 IF (v_final <> v_reference OR v_extras > 0) AND (v_reason IS NULL OR length(v_reason) < 5) THEN
  RAISE EXCEPTION 'Justifique la diferencia con el costo acordado de % (S/ % → S/ %)', lower(l.concept), v_reference, v_final;
 END IF;
 UPDATE public.transport_unloading_costs SET final_executed_qty = v_qty, final_workers = v_workers, final_billable_qty = v_billable,
  final_extras_pen = v_extras, final_pen = v_final, final_reason = v_reason, final_validated_by = auth.uid(), final_validated_at = now()
 WHERE id = p_line_id;
 INSERT INTO public.service_cost_events(unloading_cost_id, transport_request_id, dispatch_id, contract_id, concept, stage, old_amount, new_amount, old_status, new_status, detail, reason, created_by)
 VALUES (l.id, l.transport_request_id, l.dispatch_id, l.contract_id, l.concept, 'FINAL', l.final_pen, v_final, l.status, l.status,
  jsonb_build_object('validated', true, 'reference_pen', v_reference, 'executed_qty', v_qty, 'billable_qty', v_billable, 'workers', v_workers,
   'base_pen', v_base, 'extras_pen', v_extras), v_reason, auth.uid());
 RETURN jsonb_build_object('success', true, 'final_pen', v_final, 'base_pen', v_base, 'billable_qty', v_billable, 'reference_pen', v_reference,
  'difference_pen', v_final - v_reference);
EXCEPTION WHEN raise_exception THEN
 RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.validate_service_final(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.validate_service_final(uuid,jsonb) TO authenticated;

-- ------------------------------------------------------------
-- 3. Flete acordado: el motivo (tms.cost_reason) también queda en la etapa de la ruta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_freight_stage_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reason text := NULLIF(btrim(COALESCE(current_setting('tms.cost_reason', true), '')), '');
BEGIN
 IF TG_OP = 'INSERT' OR NEW.status = 'PROGRAMADO' THEN
  INSERT INTO public.dispatch_freight_stages(dispatch_id, agreed_pen, agreed_at, agreed_by, agreed_reason)
  VALUES (NEW.id, COALESCE(NEW.freight_cost, 0), now(), auth.uid(), v_reason)
  ON CONFLICT (dispatch_id) DO UPDATE SET agreed_pen = EXCLUDED.agreed_pen, agreed_at = now(), agreed_by = auth.uid(),
   agreed_reason = EXCLUDED.agreed_reason, updated_at = now();
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

-- ------------------------------------------------------------
-- 4. Acuerdo de servicios al programar (misma lógica de 20261107090000_costo_acordado_servicios) +
--    motivo cuando el acordado de una línea heredada difiere de su referencial + unidades UNIDAD y TONELADA.
--    p = { items: [{ id?, transport_request_id, concept, description, supplier_id, billing_unit, agreed_rate,
--                    agreed_qty, workers?, min_billable_qty?, fraction_minutes?, reason? }],
--          removed: [{ id, reason }] }
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_special_service_agreements(p_dispatch_id uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d record; f record; l record; e jsonb; v_items jsonb := '[]'; v_removed uuid[] := '{}'; v_seen uuid[] := '{}';
 v_id uuid; v_req uuid; v_concept text; v_supplier uuid; v_category text; v_unit text; v_rate numeric; v_qty numeric; v_workers int;
 v_min numeric; v_fraction int; v_reason text; v_amount numeric; v_plan jsonb; v_result jsonb; v_forklift_line uuid; v_old jsonb := '{}'::jsonb;
 v_count int := 0; v_referential numeric;
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
  v_id := NULLIF(e->>'id','')::uuid; v_reason := NULLIF(btrim(COALESCE(e->>'reason','')),''); v_referential := NULL;
  IF v_id IS NOT NULL THEN
   IF v_id = ANY(v_removed) OR v_id = ANY(v_seen) THEN RAISE EXCEPTION 'Servicio duplicado'; END IF;
   SELECT u.* INTO l FROM public.transport_unloading_costs u
   WHERE u.id = v_id AND u.status IN ('ESTIMADO','PLANIFICADO') AND COALESCE(u.dispatch_id,p_dispatch_id) = p_dispatch_id
     AND EXISTS (SELECT 1 FROM public.dispatch_requests dr WHERE dr.dispatch_id=p_dispatch_id AND dr.transport_request_id=u.transport_request_id) FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Servicio especial no disponible en esta ruta'; END IF;
   v_req := l.transport_request_id; v_concept := l.concept;
   v_seen := array_append(v_seen, v_id);
   -- Referencial de la solicitud: con tarifa o costo manual. «Sin tarifa» (0 sin costo manual) no exige motivo.
   IF NOT COALESCE((to_jsonb(l)->>'tariff_missing')::boolean, false) OR to_jsonb(l)->>'estimated_source' = 'MANUAL' THEN
    v_referential := COALESCE(l.estimated_pen, 0);
   END IF;
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
  IF v_unit NOT IN ('SERVICIO','HORA','JORNADA','UNIDAD','TONELADA')
     OR (v_unit = 'JORNADA' AND v_concept IN ('MONTACARGAS','GRUA'))
     OR (v_unit IN ('UNIDAD','TONELADA') AND v_concept = 'MONTACARGAS') THEN
   RAISE EXCEPTION 'Modalidad de cobro inválida para %', lower(v_concept);
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 OR v_rate > 1000000 OR v_rate <> round(v_rate, 2) THEN RAISE EXCEPTION 'Ingrese la tarifa acordada de % (mayor a cero, dos decimales)', lower(v_concept); END IF;
  IF v_qty <= 0 OR v_qty > 10000 OR v_qty <> round(v_qty, 2) THEN RAISE EXCEPTION 'Cantidad acordada inválida para %', lower(v_concept); END IF;
  IF v_unit = 'SERVICIO' THEN v_min := NULL; v_fraction := NULL; END IF;
  IF v_unit <> 'HORA' THEN v_fraction := NULL; END IF;
  IF v_unit IN ('UNIDAD','TONELADA') THEN v_workers := NULL; END IF;  -- tarifa por unidad o tonelada, no por trabajador
  IF v_workers IS NOT NULL AND (v_workers < 1 OR v_workers > 200) THEN RAISE EXCEPTION 'Cantidad de trabajadores inválida'; END IF;
  IF v_min IS NOT NULL AND (v_min < 0 OR v_min > 1000) THEN RAISE EXCEPTION 'Mínimo facturable inválido'; END IF;
  IF v_fraction IS NOT NULL AND v_fraction NOT IN (15,30,60) THEN RAISE EXCEPTION 'La fracción de cobro debe ser de 15, 30 o 60 minutos'; END IF;
  v_amount := round(v_rate * greatest(v_qty, COALESCE(v_min, 0)) * COALESCE(v_workers, 1), 2);
  IF v_referential IS NOT NULL AND v_amount <> v_referential AND (v_reason IS NULL OR length(v_reason) < 5) THEN
   RAISE EXCEPTION 'Justifique la diferencia del costo acordado de % con el referencial (S/ % → S/ %)', lower(v_concept), v_referential, v_amount;
  END IF;

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

-- ------------------------------------------------------------
-- 5. schedule_route_resources: misma lógica de 20261107090000_costo_acordado_servicios + motivo del flete
--    (p.freight_reason) cuando el flete de la ruta difiere del referencial de las solicitudes.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_route_resources(p jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_result jsonb; f jsonb:=p->'forklift'; hp public.hhee_people; v_person uuid; v_supplier_person uuid; v_name text; v_doc text; v_rate numeric;
 v_license text; v_expiration date; v_phone text; v_registered_plate text; v_stop uuid; v_stops uuid[];
 v_freight numeric; v_freight_ref numeric; v_freight_reason text; v_all_pickups boolean; v_customer_pickup boolean;
BEGIN
 IF NOT public.has_tms_permission('despacho') THEN RAISE EXCEPTION 'Sin permiso para programar rutas'; END IF;
 -- Flete acordado vs. referencial (suma del costo de las solicitudes). Recojos con flota propia y Nota de Salida sin flete: sin motivo.
 v_freight := COALESCE(NULLIF(p->>'p_freight_cost','')::numeric, 0);
 v_freight_reason := NULLIF(btrim(COALESCE(p->>'freight_reason','')),'');
 SELECT COALESCE(sum(COALESCE(t.service_cost, 0)), 0), COALESCE(bool_and(to_jsonb(t)->>'request_type' = 'RECOJO'), false),
  COALESCE(bool_or(to_jsonb(t)->>'attention_mode' = 'RECOJO_CLIENTE'), false)
 INTO v_freight_ref, v_all_pickups, v_customer_pickup
 FROM public.transport_requests t
 WHERE t.id IN (SELECT NULLIF(j->>'id','')::uuid FROM jsonb_array_elements(COALESCE(p->'p_requests','[]'::jsonb)) j);
 IF round(v_freight, 2) <> round(v_freight_ref, 2)
    AND NOT (v_freight = 0 AND (p->>'p_document_type' = 'NOTA_SALIDA' OR v_customer_pickup OR (COALESCE(p->>'mode','') <> 'TERCERO' AND v_all_pickups))) THEN
  IF v_freight_reason IS NULL OR length(v_freight_reason) < 5 THEN
   RAISE EXCEPTION 'Justifique la diferencia del flete con el referencial de las solicitudes (S/ % → S/ %)', round(v_freight_ref, 2), round(v_freight, 2);
  END IF;
  IF length(v_freight_reason) > 500 THEN RAISE EXCEPTION 'Motivo del flete demasiado extenso'; END IF;
 ELSE
  v_freight_reason := NULL;
 END IF;
 -- El evento ACORDADO del flete (dispatch_freight_stage_sync) toma el motivo al crear el despacho.
 PERFORM set_config('tms.cost_reason', COALESCE(v_freight_reason, ''), true);
 IF p->>'mode'='TERCERO' THEN
  v_id:=public.schedule_dispatch_tercero((p->>'p_carrier_id')::uuid,p->>'p_plate',p->>'p_conductor',p->>'p_telefono',p->>'p_doc',
   (p->>'p_departure')::timestamptz,(p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->'p_requests');
 ELSE
  v_id:=public.schedule_dispatch((p->>'p_driver_id')::uuid,p->>'p_vehicle_plate',(p->>'p_departure')::timestamptz,
   (p->>'p_estimated_km')::numeric,(p->>'p_freight_cost')::numeric,(p->>'p_contract_id')::uuid,p->>'p_document_type',p->'p_requests');
 END IF;
 PERFORM set_config('tms.cost_reason', '', true);
 IF v_freight_reason IS NOT NULL THEN
  UPDATE public.dispatch_freight_stages SET agreed_reason = v_freight_reason, updated_at = now() WHERE dispatch_id = v_id AND agreed_reason IS DISTINCT FROM v_freight_reason;
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
