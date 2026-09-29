-- ============================================================
-- TARIFARIO DE TRANSPORTE — freight_rates como fuente única de tarifas (flete, paradas y descarga)
-- ============================================================
-- Reglas (docs/despacho/07-tarifario-transporte.md):
--  * Se evoluciona freight_rates (no se crea otra tabla): concepto, tipo de unidad, alcance (general / cliente /
--    contrato), vigencia, base de cobro y precio al cliente. Las filas actuales se conservan: FLETE, alcance
--    GENERAL, vigentes; el tipo de unidad se completa con su tipo y capacidad; la placa queda como excepción.
--  * quote_transport calcula el costo: flete del destino de mayor tarifa + monto por cada parada adicional +
--    descarga. Prioridad de tarifa: contrato > cliente > general; con placa, su tarifa específica primero.
--  * La solicitud y el despacho guardan el desglose con el que se calcularon (la historia no cambia si cambia la tarifa).
--  * Seguridad: se elimina el acceso "allow all"; leen los módulos que cotizan y edita el permiso tarifas.
BEGIN;

-- ------------------------------------------------------------
-- 1. Estructura (sin pérdida de datos)
-- ------------------------------------------------------------
ALTER TABLE public.freight_rates
  ADD COLUMN IF NOT EXISTS concept       text NOT NULL DEFAULT 'FLETE',
  ADD COLUMN IF NOT EXISTS vehicle_class text,
  ADD COLUMN IF NOT EXISTS department    text,
  ADD COLUMN IF NOT EXISTS province      text,
  ADD COLUMN IF NOT EXISTS scope         text NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS client_id     uuid,
  ADD COLUMN IF NOT EXISTS contract_id   uuid,
  ADD COLUMN IF NOT EXISTS rate_basis    text NOT NULL DEFAULT 'VIAJE',
  ADD COLUMN IF NOT EXISTS client_price  numeric(12,2),
  ADD COLUMN IF NOT EXISTS valid_from    date NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS valid_to      date,
  ADD COLUMN IF NOT EXISTS is_active     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notes         text,
  ADD COLUMN IF NOT EXISTS updated_by    uuid;

-- Paradas y descarga no dependen de destino ni de unidad: esas columnas dejan de ser obligatorias (si existen)
DO $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['district', 'vehicle_type', 'origin'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'freight_rates'
               AND column_name = c AND is_nullable = 'NO') THEN
      EXECUTE format('ALTER TABLE public.freight_rates ALTER COLUMN %I DROP NOT NULL', c);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.freight_rates DROP CONSTRAINT IF EXISTS freight_rates_concept_check;
ALTER TABLE public.freight_rates ADD CONSTRAINT freight_rates_concept_check
  CHECK (concept IN ('FLETE', 'PARADA_ADICIONAL', 'MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS', 'ESPERA_HORA'));
ALTER TABLE public.freight_rates DROP CONSTRAINT IF EXISTS freight_rates_scope_check;
ALTER TABLE public.freight_rates ADD CONSTRAINT freight_rates_scope_check CHECK (
  (scope = 'GENERAL') OR (scope = 'CLIENTE' AND client_id IS NOT NULL) OR (scope = 'CONTRATO' AND contract_id IS NOT NULL));
ALTER TABLE public.freight_rates DROP CONSTRAINT IF EXISTS freight_rates_basis_check;
ALTER TABLE public.freight_rates ADD CONSTRAINT freight_rates_basis_check CHECK (rate_basis IN ('VIAJE', 'TONELADA', 'UNIDAD', 'HORA'));
ALTER TABLE public.freight_rates DROP CONSTRAINT IF EXISTS freight_rates_validity_check;
ALTER TABLE public.freight_rates ADD CONSTRAINT freight_rates_validity_check CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- Tipo de unidad de las tarifas actuales: "<tipo> <capacidad> t" (p. ej. "Trailer 32 t")
UPDATE public.freight_rates r SET vehicle_class = trim(concat_ws(' ',
    NULLIF(trim(to_jsonb(r)->>'vehicle_type'), ''),
    CASE WHEN (to_jsonb(r)->>'capacity_ton')::numeric > 0 THEN to_char((to_jsonb(r)->>'capacity_ton')::numeric, 'FM999990.##') || ' t' END))
WHERE r.vehicle_class IS NULL AND r.concept = 'FLETE'
  AND COALESCE(NULLIF(trim(to_jsonb(r)->>'vehicle_type'), ''), to_jsonb(r)->>'capacity_ton') IS NOT NULL;

CREATE INDEX IF NOT EXISTS freight_rates_lookup ON public.freight_rates (concept, is_active);

-- Desglose guardado en la solicitud y en el despacho
ALTER TABLE public.transport_requests
  ADD COLUMN IF NOT EXISTS cost_breakdown       jsonb,
  ADD COLUMN IF NOT EXISTS cost_source          text,
  ADD COLUMN IF NOT EXISTS cost_override_reason text;
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS freight_breakdown jsonb;

-- ------------------------------------------------------------
-- 2. Permisos y seguridad
-- ------------------------------------------------------------
-- El Jefe de Distribución (aprobación de Caja) mantiene el tarifario junto con quien ya tenía "tarifas"
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["tarifas"]'::jsonb) p)
WHERE (permissions ? 'caja-aprobacion' OR permissions ? 'caja-aprobacion:write') AND NOT (permissions ? 'tarifas' OR permissions ? 'tarifas:write');

CREATE OR REPLACE FUNCTION public.can_read_tariffs()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.has_tms_read_permission('tarifas') OR public.has_tms_read_permission('despacho')
      OR public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('clientes')
      OR public.has_tms_read_permission('contratos-servicios') OR public.has_caja_read_access();
$$;

ALTER TABLE public.freight_rates ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'freight_rates'
    AND policyname <> 'tms_admin_full_access'
  LOOP EXECUTE format('DROP POLICY %I ON public.freight_rates', p.policyname); END LOOP;
END $$;
CREATE POLICY freight_rates_read ON public.freight_rates FOR SELECT TO authenticated USING (public.can_read_tariffs());
CREATE POLICY freight_rates_write ON public.freight_rates FOR ALL TO authenticated
  USING (public.has_tms_permission('tarifas')) WITH CHECK (public.has_tms_permission('tarifas'));
REVOKE ALL ON public.freight_rates FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.freight_rates TO authenticated;

CREATE OR REPLACE FUNCTION public.freight_rates_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_by := COALESCE(auth.uid(), NEW.updated_by);
  NEW.concept := upper(NEW.concept);
  IF NEW.concept <> 'FLETE' THEN NEW.rate_basis := CASE WHEN NEW.rate_basis = 'VIAJE' THEN 'UNIDAD' ELSE NEW.rate_basis END; END IF;
  IF NEW.concept = 'FLETE' AND NULLIF(trim(COALESCE(NEW.district, '')), '') IS NULL THEN
    RAISE EXCEPTION 'La tarifa de flete necesita el distrito de destino';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS freight_rates_stamp ON public.freight_rates;
CREATE TRIGGER freight_rates_stamp BEFORE INSERT OR UPDATE ON public.freight_rates
  FOR EACH ROW EXECUTE FUNCTION public.freight_rates_stamp();

-- ------------------------------------------------------------
-- 3. Selección de tarifa y cotización
-- ------------------------------------------------------------
-- Tarifa vigente para un concepto: contrato > cliente > general; placa específica primero; la más específica gana
CREATE OR REPLACE FUNCTION public.tariff_pick(p_concept text, p_class text, p_plate text, p_district text,
  p_client uuid, p_contract uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(x) FROM (
    SELECT r.id, r.concept, r.rate, r.rate_basis, r.scope, r.client_price, r.vehicle_class, r.plate_number, r.district,
           to_jsonb(r)->>'zone' AS zone
    FROM public.freight_rates r
    WHERE r.is_active AND r.concept = p_concept
      AND p_date >= r.valid_from AND (r.valid_to IS NULL OR p_date <= r.valid_to)
      AND (r.scope = 'GENERAL' OR (r.scope = 'CLIENTE' AND r.client_id = p_client) OR (r.scope = 'CONTRATO' AND r.contract_id = p_contract))
      AND (CASE WHEN p_concept = 'FLETE' THEN public.norm_address(r.district) = public.norm_address(p_district)
                ELSE r.district IS NULL OR public.norm_address(r.district) = public.norm_address(p_district) END)
      AND (r.plate_number IS NULL OR p_plate IS NULL OR r.plate_number = p_plate)
      AND (r.vehicle_class IS NULL OR p_class IS NULL OR r.vehicle_class = p_class OR r.plate_number = p_plate)
    ORDER BY CASE r.scope WHEN 'CONTRATO' THEN 3 WHEN 'CLIENTE' THEN 2 ELSE 1 END DESC,
             COALESCE(p_plate IS NOT NULL AND r.plate_number = p_plate, false) DESC,
             (r.district IS NOT NULL) DESC, (r.vehicle_class IS NOT NULL) DESC,
             r.rate DESC  -- sin unidad definida, la tarifa más alta (conservador para la partida)
    LIMIT 1) x;
$$;

-- p_stops = [{district, department, province}] · p_unloading = [{concept, quantity}]
CREATE OR REPLACE FUNCTION public.quote_transport(p_contract_id uuid, p_stops jsonb, p_weight_kg numeric DEFAULT NULL,
  p_vehicle_class text DEFAULT NULL, p_plate text DEFAULT NULL, p_unloading jsonb DEFAULT '[]'::jsonb, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_client   uuid;
  v_class    text := NULLIF(trim(COALESCE(p_vehicle_class, '')), '');
  v_plate    text := NULLIF(upper(trim(COALESCE(p_plate, ''))), '');
  v_suggest  boolean := false;
  v_stops    text[];
  v_lines    jsonb := '[]'::jsonb;
  v_missing  text[] := '{}';
  v_main     jsonb;
  v_main_amt numeric := 0;
  v_main_dst text;
  t          jsonb;
  d          text;
  v_amt      numeric;
  v_qty      numeric;
  v_item     jsonb;
  v_freight  numeric := 0;
  v_unload   numeric := 0;
  v_client_total numeric := 0;
  v_client_ok    boolean := true;
BEGIN
  IF NOT public.can_read_tariffs() THEN RAISE EXCEPTION 'Sin permiso para consultar el tarifario'; END IF;
  SELECT (to_jsonb(c)->>'client_id')::uuid INTO v_client FROM public.contracts c WHERE c.id = p_contract_id;
  SELECT array_agg(DISTINCT NULLIF(trim(value->>'district'), '')) FILTER (WHERE NULLIF(trim(value->>'district'), '') IS NOT NULL)
  INTO v_stops FROM jsonb_array_elements(COALESCE(p_stops, '[]'::jsonb));
  v_stops := COALESCE(v_stops, '{}');

  -- Tipo de unidad: el indicado, el de la placa, o el menor que soporta el peso y tiene tarifa a todos los destinos
  IF v_class IS NULL AND v_plate IS NOT NULL THEN
    SELECT vehicle_class INTO v_class FROM public.freight_rates WHERE plate_number = v_plate AND vehicle_class IS NOT NULL LIMIT 1;
  END IF;
  IF v_class IS NULL AND v_plate IS NULL AND p_weight_kg IS NOT NULL AND p_weight_kg > 0 THEN
    SELECT c.vehicle_class INTO v_class FROM (
      SELECT vehicle_class, max((to_jsonb(r)->>'capacity_ton')::numeric) AS cap FROM public.freight_rates r
      WHERE r.is_active AND r.concept = 'FLETE' AND r.vehicle_class IS NOT NULL GROUP BY vehicle_class) c
    WHERE COALESCE(c.cap, 0) * 1000 >= p_weight_kg
    ORDER BY (SELECT bool_and(public.tariff_pick('FLETE', c.vehicle_class, NULL, s, v_client, p_contract_id, p_date) IS NOT NULL)
              FROM unnest(v_stops) s) DESC NULLS LAST, c.cap ASC
    LIMIT 1;
    v_suggest := v_class IS NOT NULL;
  END IF;

  -- Flete: se toma el destino de mayor tarifa; el resto son paradas adicionales
  FOREACH d IN ARRAY v_stops LOOP
    t := public.tariff_pick('FLETE', v_class, v_plate, d, v_client, p_contract_id, p_date);
    IF t IS NULL THEN v_missing := v_missing || ('Sin tarifa de flete a ' || d || COALESCE(' para ' || v_class, '')); CONTINUE; END IF;
    v_amt := (t->>'rate')::numeric * CASE WHEN t->>'rate_basis' = 'TONELADA' THEN COALESCE(p_weight_kg, 0) / 1000 ELSE 1 END;
    IF v_main IS NULL OR v_amt > v_main_amt THEN v_main := t; v_main_amt := v_amt; v_main_dst := d; END IF;
  END LOOP;
  IF v_main IS NOT NULL THEN
    v_lines := v_lines || jsonb_build_object('concept', 'FLETE', 'label', 'Flete a ' || v_main_dst, 'district', v_main_dst,
      'rate_id', v_main->>'id', 'scope', v_main->>'scope', 'basis', v_main->>'rate_basis', 'quantity',
      CASE WHEN v_main->>'rate_basis' = 'TONELADA' THEN round(COALESCE(p_weight_kg, 0) / 1000, 3) ELSE 1 END,
      'unit_rate', (v_main->>'rate')::numeric, 'amount', round(v_main_amt, 2),
      'client_amount', (v_main->>'client_price')::numeric);
    v_freight := v_main_amt;
    IF v_main->>'client_price' IS NULL THEN v_client_ok := false; ELSE v_client_total := v_client_total + (v_main->>'client_price')::numeric; END IF;
    IF cardinality(v_stops) > 1 THEN
      t := public.tariff_pick('PARADA_ADICIONAL', v_class, v_plate, NULL, v_client, p_contract_id, p_date);
      IF t IS NULL THEN
        v_missing := v_missing || ('Sin tarifa de parada adicional (' || (cardinality(v_stops) - 1) || ' paradas)');
      ELSE
        v_amt := (t->>'rate')::numeric * (cardinality(v_stops) - 1);
        v_lines := v_lines || jsonb_build_object('concept', 'PARADA_ADICIONAL', 'label', 'Paradas adicionales',
          'rate_id', t->>'id', 'scope', t->>'scope', 'basis', t->>'rate_basis', 'quantity', cardinality(v_stops) - 1,
          'unit_rate', (t->>'rate')::numeric, 'amount', round(v_amt, 2),
          'client_amount', (t->>'client_price')::numeric * (cardinality(v_stops) - 1));
        v_freight := v_freight + v_amt;
        IF t->>'client_price' IS NULL THEN v_client_ok := false; ELSE v_client_total := v_client_total + (t->>'client_price')::numeric * (cardinality(v_stops) - 1); END IF;
      END IF;
    END IF;
  END IF;

  -- Descarga según el tarifario
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_unloading, '[]'::jsonb)) LOOP
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 1);
    t := public.tariff_pick(upper(v_item->>'concept'), v_class, v_plate, v_main_dst, v_client, p_contract_id, p_date);
    IF t IS NULL THEN v_missing := v_missing || ('Sin tarifa de ' || lower(v_item->>'concept')); CONTINUE; END IF;
    v_amt := (t->>'rate')::numeric * v_qty;
    v_lines := v_lines || jsonb_build_object('concept', upper(v_item->>'concept'), 'label', initcap(lower(v_item->>'concept')),
      'rate_id', t->>'id', 'scope', t->>'scope', 'basis', t->>'rate_basis', 'quantity', v_qty,
      'unit_rate', (t->>'rate')::numeric, 'amount', round(v_amt, 2), 'client_amount', (t->>'client_price')::numeric * v_qty);
    v_unload := v_unload + v_amt;
    IF t->>'client_price' IS NULL THEN v_client_ok := false; ELSE v_client_total := v_client_total + (t->>'client_price')::numeric * v_qty; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'vehicle_class', v_class, 'vehicle_class_suggested', v_suggest, 'plate', v_plate, 'stops', to_jsonb(v_stops),
    'lines', v_lines, 'freight_total', round(v_freight, 2), 'unloading_total', round(v_unload, 2),
    'total', round(v_freight + v_unload, 2),
    'client_total', CASE WHEN v_client_ok AND jsonb_array_length(v_lines) > 0 THEN round(v_client_total, 2) END,
    'missing', to_jsonb(v_missing), 'quoted_at', now(), 'quote_date', p_date);
END $$;

-- ------------------------------------------------------------
-- 4. Guardar el desglose en la solicitud y en el despacho
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_request_cost_quote(p_request_id uuid, p_breakdown jsonb, p_source text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; v_source text := upper(COALESCE(p_source, ''));
BEGIN
  SELECT t.id, t.status, COALESCE(t.service_cost, 0) AS service_cost INTO r FROM public.transport_requests t WHERE t.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Solicitud inexistente'); END IF;
  IF NOT (public.has_tms_permission('solicitudes') OR (public.is_contract_administrator() AND public.has_assigned_request(p_request_id, true))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar la solicitud');
  END IF;
  IF public.is_contract_administrator() AND NOT public.has_assigned_request(p_request_id, true) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OT no asignada');
  END IF;
  IF r.status NOT IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'OBSERVADA') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El costo se calcula antes de la aprobación (estado actual: ' || r.status || ')');
  END IF;
  IF v_source NOT IN ('TARIFARIO', 'MANUAL') THEN RETURN jsonb_build_object('success', false, 'error', 'Origen del costo inválido'); END IF;
  -- Un costo distinto al del tarifario necesita motivo
  IF v_source = 'MANUAL' AND COALESCE((p_breakdown->>'freight_total')::numeric, 0) > 0
     AND round(r.service_cost, 2) <> round((p_breakdown->>'freight_total')::numeric, 2)
     AND NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo por el que el costo difiere del tarifario');
  END IF;
  UPDATE public.transport_requests SET cost_breakdown = p_breakdown, cost_source = v_source,
    cost_override_reason = CASE WHEN v_source = 'MANUAL' THEN NULLIF(trim(COALESCE(p_reason, '')), '') END
  WHERE id = p_request_id;
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.set_dispatch_freight_quote(p_dispatch_id uuid, p_breakdown jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  IF NOT public.has_tms_permission('despacho') THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  SELECT x.id, x.status, x.site_id INTO d FROM public.dispatches x WHERE x.id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR (d.site_id IS NOT NULL AND NOT public.can_access_site(d.site_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho inexistente');
  END IF;
  IF d.status <> 'PROGRAMADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El despacho ya no está programado'); END IF;
  UPDATE public.dispatches SET freight_breakdown = p_breakdown WHERE id = p_dispatch_id;
  RETURN jsonb_build_object('success', true);
END $$;

REVOKE ALL ON FUNCTION public.can_read_tariffs(), public.tariff_pick(text, text, text, text, uuid, uuid, date),
  public.quote_transport(uuid, jsonb, numeric, text, text, jsonb, date), public.set_request_cost_quote(uuid, jsonb, text, text),
  public.set_dispatch_freight_quote(uuid, jsonb), public.freight_rates_stamp() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_tariffs(), public.quote_transport(uuid, jsonb, numeric, text, text, jsonb, date),
  public.set_request_cost_quote(uuid, jsonb, text, text), public.set_dispatch_freight_quote(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tariff_pick(text, text, text, text, uuid, uuid, date) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
