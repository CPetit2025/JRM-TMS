-- 20260927220000_f8_neumaticos.sql
-- FASE 8 — Gestión integral de neumáticos.
--
-- * Identidad individual: código interno único, serie/DOT, marca, modelo, medida, costo.
-- * Ciclo de vida solo por RPC (register_tire_event): COMPRA (automática al alta), INSTALACION,
--   ROTACION, DESMONTAJE, MEDICION, ENVIO_REENCAUCHE, RETORNO_REENCAUCHE, BAJA; posición única por
--   unidad; km recorridos por odómetro real; historial completo en tire_movements.
-- * Cocada bajo el límite ⇒ falla en el backlog (F3). Reemplaza check_tire_tread_depth, que escribía
--   columnas inexistentes de maintenance_requests.
-- * Indicadores: km del neumático, costo total (compra + reencauches), costo/km, desgaste y vida útil.
-- * Vocabulario sin tildes (se normalizan las variantes con tilde); RLS sin "todo permitido";
--   se elimina tire_status_logs (historial paralelo vacío y sin uso).

BEGIN;

-- ------------------------------------------------------------
-- 1. Neumáticos
-- ------------------------------------------------------------
-- vw_tire_metrics (sin uso) dependía del vocabulario con tildes y omitía reencauches: la reemplaza vw_tires
DROP VIEW IF EXISTS public.vw_tire_metrics;

ALTER TABLE public.tires
  ADD COLUMN IF NOT EXISTS serial_number text,
  ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES public.sites(id),
  ADD COLUMN IF NOT EXISTS installed_odometer numeric(12,2),
  ADD COLUMN IF NOT EXISTS retread_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retread_cost_total numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retreads int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS min_tread_mm numeric(5,2) NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS expected_life_km int,
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retire_reason text;

ALTER TABLE public.tires ALTER COLUMN total_km_travelled TYPE numeric(12,2);
ALTER TABLE public.tires ALTER COLUMN total_km_travelled SET DEFAULT 0;
UPDATE public.tires SET total_km_travelled = COALESCE(total_km_travelled, 0);

ALTER TABLE public.tires DROP CONSTRAINT IF EXISTS tires_estado_check;
UPDATE public.tires SET estado = CASE upper(estado) WHEN 'ALMACÉN' THEN 'ALMACEN' ELSE upper(estado) END;
ALTER TABLE public.tires ALTER COLUMN estado SET DEFAULT 'ALMACEN';
ALTER TABLE public.tires ADD CONSTRAINT tires_estado_check CHECK (estado IN ('ALMACEN', 'INSTALADO', 'REENCAUCHE', 'BAJA'));
ALTER TABLE public.tires DROP CONSTRAINT IF EXISTS tires_values_check;
ALTER TABLE public.tires ADD CONSTRAINT tires_values_check CHECK (
  COALESCE(costo, 0) >= 0 AND COALESCE(cocada_actual, 0) >= 0 AND COALESCE(cocada_original, 0) >= 0
  AND retread_count >= 0 AND retread_cost_total >= 0 AND total_km_travelled >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tire_position ON public.tires (vehiculo_actual_id, posicion_actual) WHERE estado = 'INSTALADO';

CREATE OR REPLACE FUNCTION public.guard_tire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.codigo_interno := upper(trim(NEW.codigo_interno));
  NEW.estado := CASE upper(COALESCE(NEW.estado, 'ALMACEN')) WHEN 'ALMACÉN' THEN 'ALMACEN' ELSE upper(COALESCE(NEW.estado, 'ALMACEN')) END;
  NEW.updated_at := now();
  IF NEW.vehiculo_actual_id IS NOT NULL THEN
    SELECT plate INTO NEW.current_vehicle_plate FROM public.vehicles WHERE id = NEW.vehiculo_actual_id;
  ELSE
    NEW.current_vehicle_plate := NULL;
  END IF;
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      -- Todo neumático nuevo entra al almacén; la instalación es un evento
      NEW.estado := 'ALMACEN'; NEW.vehiculo_actual_id := NULL; NEW.current_vehicle_plate := NULL; NEW.posicion_actual := NULL;
      NEW.total_km_travelled := 0; NEW.retread_count := 0; NEW.retread_cost_total := 0; NEW.installed_odometer := NULL;
      NEW.cocada_actual := COALESCE(NEW.cocada_actual, NEW.cocada_original);
    ELSIF NEW.estado IS DISTINCT FROM OLD.estado OR NEW.vehiculo_actual_id IS DISTINCT FROM OLD.vehiculo_actual_id
       OR NEW.posicion_actual IS DISTINCT FROM OLD.posicion_actual OR NEW.total_km_travelled IS DISTINCT FROM OLD.total_km_travelled
       OR NEW.cocada_actual IS DISTINCT FROM OLD.cocada_actual OR NEW.retread_count IS DISTINCT FROM OLD.retread_count
       OR NEW.retread_cost_total IS DISTINCT FROM OLD.retread_cost_total OR NEW.installed_odometer IS DISTINCT FROM OLD.installed_odometer THEN
      RAISE EXCEPTION 'Estado, posición, km, cocada y reencauches del neumático solo cambian con register_tire_event()'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_tire ON public.tires;
CREATE TRIGGER trg_guard_tire BEFORE INSERT OR UPDATE ON public.tires FOR EACH ROW EXECUTE FUNCTION public.guard_tire();

-- ------------------------------------------------------------
-- 2. Movimientos (historial)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_check_tire_tread_depth ON public.tire_movements;
DROP FUNCTION IF EXISTS public.check_tire_tread_depth();

ALTER TABLE public.tire_movements ALTER COLUMN current_odometer TYPE numeric(12,2);
ALTER TABLE public.tire_movements
  ADD COLUMN IF NOT EXISTS position_from text,
  ADD COLUMN IF NOT EXISTS km_accumulated numeric(12,2),
  ADD COLUMN IF NOT EXISTS cost numeric(12,2),
  ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL;
ALTER TABLE public.tire_movements DROP CONSTRAINT IF EXISTS tire_movements_tipo_movimiento_check;
UPDATE public.tire_movements SET tipo_movimiento = CASE upper(tipo_movimiento)
  WHEN 'INSTALACIÓN' THEN 'INSTALACION' WHEN 'ROTACIÓN' THEN 'ROTACION' WHEN 'MEDICIÓN' THEN 'MEDICION'
  WHEN 'RETIRO' THEN 'DESMONTAJE' ELSE upper(tipo_movimiento) END;
ALTER TABLE public.tire_movements ADD CONSTRAINT tire_movements_tipo_movimiento_check CHECK (tipo_movimiento IN
  ('COMPRA', 'INSTALACION', 'ROTACION', 'DESMONTAJE', 'MEDICION', 'ENVIO_REENCAUCHE', 'RETORNO_REENCAUCHE', 'BAJA'));

CREATE OR REPLACE FUNCTION public.forbid_direct_tire_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Los movimientos de neumáticos se registran con register_tire_event()' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS trg_forbid_direct_tire_movement ON public.tire_movements;
CREATE TRIGGER trg_forbid_direct_tire_movement BEFORE INSERT OR UPDATE OR DELETE ON public.tire_movements
FOR EACH ROW EXECUTE FUNCTION public.forbid_direct_tire_movement();

-- Compra automática al dar de alta
CREATE OR REPLACE FUNCTION public.tire_purchase_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.tire_movements (tire_id, tipo_movimiento, cocada, cost, provider_id, reason, created_by, created_at)
  VALUES (NEW.id, 'COMPRA', NEW.cocada_actual, NEW.costo, NEW.provider_id, 'Alta del neumático', auth.uid(), COALESCE(NEW.purchase_date::timestamptz, now()));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_tire_purchase_event ON public.tires;
CREATE TRIGGER trg_tire_purchase_event AFTER INSERT ON public.tires FOR EACH ROW EXECUTE FUNCTION public.tire_purchase_event();

-- ------------------------------------------------------------
-- 3. Eventos del ciclo de vida
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_tire_event(
  p_tire_id      uuid,
  p_event        text,
  p_vehicle_plate text    DEFAULT NULL,
  p_position     text    DEFAULT NULL,
  p_odometer     numeric DEFAULT NULL,
  p_tread_mm     numeric DEFAULT NULL,
  p_cost         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_provider_id  uuid    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t        public.tires%ROWTYPE;
  v        public.vehicles%ROWTYPE;
  v_event  text := upper(trim(p_event));
  v_odo    numeric;
  v_km     numeric := 0;
  v_pos    text := NULLIF(upper(trim(p_position)), '');
  v_read   jsonb;
  v_req    jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT (public.has_cmms_permission('flota') OR public.has_cmms_permission('ot')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para gestionar neumáticos');
  END IF;
  SELECT * INTO t FROM public.tires WHERE id = p_tire_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Neumático no encontrado');
  END IF;
  IF t.estado = 'BAJA' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El neumático está dado de baja');
  END IF;
  IF p_tread_mm IS NOT NULL AND (p_tread_mm < 0 OR p_tread_mm > COALESCE(t.cocada_original, 40)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cocada fuera de rango');
  END IF;

  -- Unidad de referencia: la indicada (instalación) o la actual del neumático
  IF v_event = 'INSTALACION' OR (v_event = 'ROTACION' AND p_vehicle_plate IS NOT NULL) THEN
    SELECT * INTO v FROM public.vehicles WHERE plate = upper(trim(p_vehicle_plate));
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada');
    END IF;
  ELSIF t.vehiculo_actual_id IS NOT NULL THEN
    SELECT * INTO v FROM public.vehicles WHERE id = t.vehiculo_actual_id;
  END IF;

  -- Lectura: la informada (se registra si es mayor) o la actual de la unidad
  IF v.id IS NOT NULL THEN
    IF p_odometer IS NOT NULL AND p_odometer < COALESCE(v.current_odometer, 0) THEN
      RETURN jsonb_build_object('success', false, 'error', 'El odómetro es menor al registrado (' || COALESCE(v.current_odometer, 0) || ')');
    END IF;
    IF p_odometer IS NOT NULL AND p_odometer > COALESCE(v.current_odometer, 0) THEN
      v_read := public.register_asset_reading(v.plate, p_odometer, NULL, 'NEUMATICOS', 'Evento de neumático ' || t.codigo_interno);
      IF NOT COALESCE((v_read->>'success')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', v_read->>'error');
      END IF;
    END IF;
    v_odo := COALESCE(p_odometer, v.current_odometer, 0);
  END IF;

  -- Km recorridos desde la instalación / última rotación
  IF t.estado = 'INSTALADO' AND v_event IN ('ROTACION', 'DESMONTAJE') THEN
    v_km := GREATEST(COALESCE(v_odo, 0) - COALESCE(t.installed_odometer, v_odo, 0), 0);
  END IF;

  IF v_event = 'INSTALACION' THEN
    IF t.estado <> 'ALMACEN' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se instala un neumático en almacén (estado ' || t.estado || ')');
    END IF;
    IF v_pos IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique la posición');
    END IF;
    IF EXISTS (SELECT 1 FROM public.tires WHERE vehiculo_actual_id = v.id AND posicion_actual = v_pos AND estado = 'INSTALADO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'La posición ' || v_pos || ' de ' || v.plate || ' está ocupada');
    END IF;
    UPDATE public.tires SET estado = 'INSTALADO', vehiculo_actual_id = v.id, posicion_actual = v_pos, installed_odometer = v_odo,
      cocada_actual = COALESCE(p_tread_mm, cocada_actual), site_id = v.site_id WHERE id = t.id;

  ELSIF v_event = 'ROTACION' THEN
    IF t.estado <> 'INSTALADO' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se rota un neumático instalado');
    END IF;
    IF v_pos IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique la nueva posición');
    END IF;
    IF EXISTS (SELECT 1 FROM public.tires WHERE vehiculo_actual_id = COALESCE(v.id, t.vehiculo_actual_id) AND posicion_actual = v_pos
               AND estado = 'INSTALADO' AND id <> t.id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La posición ' || v_pos || ' está ocupada; desmonte o rote primero el otro neumático');
    END IF;
    UPDATE public.tires SET vehiculo_actual_id = COALESCE(v.id, vehiculo_actual_id), posicion_actual = v_pos,
      total_km_travelled = total_km_travelled + v_km, installed_odometer = v_odo,
      cocada_actual = COALESCE(p_tread_mm, cocada_actual) WHERE id = t.id;

  ELSIF v_event = 'DESMONTAJE' THEN
    IF t.estado <> 'INSTALADO' THEN
      RETURN jsonb_build_object('success', false, 'error', 'El neumático no está instalado');
    END IF;
    UPDATE public.tires SET estado = 'ALMACEN', vehiculo_actual_id = NULL, posicion_actual = NULL, installed_odometer = NULL,
      total_km_travelled = total_km_travelled + v_km, cocada_actual = COALESCE(p_tread_mm, cocada_actual) WHERE id = t.id;

  ELSIF v_event = 'MEDICION' THEN
    IF p_tread_mm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique la cocada medida');
    END IF;
    UPDATE public.tires SET cocada_actual = p_tread_mm WHERE id = t.id;

  ELSIF v_event = 'ENVIO_REENCAUCHE' THEN
    IF t.estado <> 'ALMACEN' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Desmonte el neumático antes de enviarlo a reencauche');
    END IF;
    IF t.retread_count >= t.max_retreads THEN
      RETURN jsonb_build_object('success', false, 'error', 'Alcanzó el máximo de ' || t.max_retreads || ' reencauches: evalúe la baja');
    END IF;
    UPDATE public.tires SET estado = 'REENCAUCHE' WHERE id = t.id;

  ELSIF v_event = 'RETORNO_REENCAUCHE' THEN
    IF t.estado <> 'REENCAUCHE' THEN
      RETURN jsonb_build_object('success', false, 'error', 'El neumático no está en reencauche');
    END IF;
    IF p_cost IS NULL OR p_cost < 0 OR p_tread_mm IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Registre el costo y la cocada del reencauche');
    END IF;
    UPDATE public.tires SET estado = 'ALMACEN', retread_count = retread_count + 1, retread_cost_total = retread_cost_total + p_cost,
      cocada_actual = p_tread_mm WHERE id = t.id;

  ELSIF v_event = 'BAJA' THEN
    IF t.estado = 'INSTALADO' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Desmonte el neumático antes de darlo de baja');
    END IF;
    IF NULLIF(trim(p_notes), '') IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'La baja requiere un motivo');
    END IF;
    UPDATE public.tires SET estado = 'BAJA', retired_at = now(), retire_reason = p_notes WHERE id = t.id;

  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Evento no válido: ' || COALESCE(p_event, 'NULL'));
  END IF;

  INSERT INTO public.tire_movements (tire_id, tipo_movimiento, vehicle_plate, vehicle_id, posicion, position_from, current_odometer,
                                     cocada, km_accumulated, cost, provider_id, reason, created_by)
  VALUES (t.id, v_event, v.plate, v.id,
          CASE WHEN v_event IN ('INSTALACION', 'ROTACION') THEN v_pos ELSE t.posicion_actual END,
          CASE WHEN v_event IN ('ROTACION', 'DESMONTAJE') THEN t.posicion_actual END,
          v_odo, COALESCE(p_tread_mm, t.cocada_actual), NULLIF(v_km, 0), p_cost, p_provider_id, p_notes, auth.uid());

  -- Cocada bajo el mínimo de un neumático instalado ⇒ falla al backlog (sin duplicar en el día)
  IF p_tread_mm IS NOT NULL AND p_tread_mm < t.min_tread_mm
     AND (SELECT estado FROM public.tires WHERE id = t.id) = 'INSTALADO' AND v.plate IS NOT NULL THEN
    INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, source, odometer_at_report, reported_by, notes)
    VALUES (v.plate, 'Neumático ' || t.codigo_interno || ' en posición ' || COALESCE(v_pos, t.posicion_actual, '?')
                     || ' con cocada ' || p_tread_mm || ' mm bajo el mínimo (' || t.min_tread_mm || ' mm)',
            'ALTA', 'REPORTADA', 'MANTENIMIENTO', v_odo, auth.uid(), 'Generada por medición de neumático')
    ON CONFLICT DO NOTHING;
    v_req := jsonb_build_object('tread_alert', true);
  END IF;

  RETURN jsonb_build_object('success', true, 'event', v_event, 'km_accumulated', v_km) || COALESCE(v_req, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.register_tire_event(uuid, text, text, text, numeric, numeric, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_tire_event(uuid, text, text, text, numeric, numeric, numeric, text, uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Indicadores
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_tires
WITH (security_invoker = true) AS
SELECT
  t.id, t.codigo_interno, t.serial_number, t.dot, t.marca, t.modelo, t.medida, t.estado, t.site_id,
  t.current_vehicle_plate AS vehicle_plate, t.vehiculo_actual_id AS vehicle_id, t.posicion_actual AS position,
  t.purchase_date, t.costo AS purchase_cost, t.retread_count, t.max_retreads, t.retread_cost_total,
  t.cocada_original, t.cocada_actual, t.min_tread_mm, t.expected_life_km, t.retired_at, t.retire_reason,
  prov.business_name AS provider_name,
  t.total_km_travelled + CASE WHEN t.estado = 'INSTALADO'
                              THEN GREATEST(COALESCE(v.current_odometer, 0) - COALESCE(t.installed_odometer, v.current_odometer, 0), 0)
                              ELSE 0 END AS km_total,
  COALESCE(t.costo, 0) + t.retread_cost_total AS cost_total,
  CASE WHEN t.total_km_travelled + CASE WHEN t.estado = 'INSTALADO'
                                      THEN GREATEST(COALESCE(v.current_odometer, 0) - COALESCE(t.installed_odometer, v.current_odometer, 0), 0) ELSE 0 END > 0
       THEN round((COALESCE(t.costo, 0) + t.retread_cost_total)
                  / (t.total_km_travelled + CASE WHEN t.estado = 'INSTALADO'
                                                 THEN GREATEST(COALESCE(v.current_odometer, 0) - COALESCE(t.installed_odometer, v.current_odometer, 0), 0) ELSE 0 END), 4)
  END AS cost_per_km,
  CASE WHEN COALESCE(t.cocada_original, 0) > t.min_tread_mm
       THEN round(100 * (t.cocada_original - COALESCE(t.cocada_actual, t.cocada_original)) / (t.cocada_original - t.min_tread_mm), 1) END AS wear_pct,
  CASE WHEN t.estado = 'BAJA' THEN 'BAJA'
       WHEN t.cocada_actual IS NOT NULL AND t.cocada_actual < t.min_tread_mm THEN 'CAMBIAR'
       WHEN t.cocada_actual IS NOT NULL AND t.cocada_actual < t.min_tread_mm + 1 THEN 'POR_CAMBIAR'
       ELSE 'OK' END AS tread_status,
  (SELECT max(m.created_at) FROM public.tire_movements m WHERE m.tire_id = t.id AND m.tipo_movimiento = 'MEDICION') AS last_measured_at
FROM public.tires t
LEFT JOIN public.vehicles v ON v.id = t.vehiculo_actual_id
LEFT JOIN public.maintenance_providers prov ON prov.id = t.provider_id;
GRANT SELECT ON public.vw_tires TO authenticated, service_role;

CREATE OR REPLACE VIEW public.vw_tire_history
WITH (security_invoker = true) AS
SELECT m.id, m.tire_id, t.codigo_interno, m.tipo_movimiento, m.created_at, m.vehicle_plate, m.position_from, m.posicion AS position,
  m.current_odometer, m.cocada, m.km_accumulated, m.cost, m.reason,
  prov.business_name AS provider_name, NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), '') AS created_by_name
FROM public.tire_movements m
JOIN public.tires t ON t.id = m.tire_id
LEFT JOIN public.maintenance_providers prov ON prov.id = m.provider_id
LEFT JOIN public.profiles p ON p.id = m.created_by;
GRANT SELECT ON public.vw_tire_history TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. RLS y limpieza
-- ------------------------------------------------------------
DROP POLICY IF EXISTS "Enable all for authenticated on tires" ON public.tires;
DROP POLICY IF EXISTS "Enable all for authenticated on tire_movements" ON public.tire_movements;
CREATE POLICY tires_read ON public.tires FOR SELECT TO authenticated
  USING (public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));
CREATE POLICY tires_write ON public.tires FOR INSERT TO authenticated WITH CHECK (public.has_cmms_permission('flota'));
CREATE POLICY tires_update ON public.tires FOR UPDATE TO authenticated
  USING (public.has_cmms_permission('flota')) WITH CHECK (public.has_cmms_permission('flota'));
CREATE POLICY tire_movements_read ON public.tire_movements FOR SELECT TO authenticated
  USING (public.has_cmms_read_permission('flota') OR public.has_cmms_read_permission('ot'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tire_status_logs) THEN
    RAISE EXCEPTION 'tire_status_logs tiene datos: migrarlos a tire_movements antes de eliminarla';
  END IF;
END $$;
DROP TABLE IF EXISTS public.tire_status_logs;

NOTIFY pgrst, 'reload schema';

COMMIT;
