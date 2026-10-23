-- ============================================================
-- Mantenimiento de flota: registro único de mantenimiento (historial del Excel + nuevo), lecturas de medidor
-- validadas, equivalencias de activos y proveedores, importación idempotente y reglas para las OT.
--  * Activos: se extiende `vehicles` (no hay tabla de activos nueva). `fe_assets` sigue como ficha económica.
--  * `mant_registros` es la fuente única del gasto de mantenimiento. `fe_maint` (Eficiencia y Plan) pasa a ser una
--    copia derivada que se regenera desde aquí (`mant_sync_fe_maint`), también después de una carga de Eficiencia.
--  * Se conserva siempre el dato original (tipo_origen, km_hrs_original, fila completa) junto al corregido.
-- Reglas: docs/mantenimiento-flota.md. Prueba: supabase/tests/caja_c136_mant_registros_flota.test.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. Permisos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_flota_can_view() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (r.name = 'Administrador' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.permissions, '[]'::jsonb)) x WHERE x LIKE 'mantenimiento-%')));
$$;
-- Importar: Administrador, «Presupuesto y planificación anual» con escritura, o una conexión de servicio (script)
CREATE OR REPLACE FUNCTION public.mant_flota_can_import() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Conexión directa a la base (script, sin JWT) o llave de servicio; si no, permiso del usuario
  SELECT (session_user NOT IN ('authenticator', 'anon', 'authenticated') AND auth.uid() IS NULL)
    OR COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
    OR EXISTS (SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid() AND p.is_active
        AND (r.name = 'Administrador' OR COALESCE(r.permissions, '[]'::jsonb) ? 'mantenimiento-finanzas:write'));
$$;

-- ------------------------------------------------------------
-- 2. Activos: columnas nuevas en vehicles
-- ------------------------------------------------------------
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS asset_class text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS meter_type text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS assigned_area text;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS manufacture_year integer;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS decommissioned_at date;
ALTER TABLE public.vehicles ADD COLUMN IF NOT EXISTS decommission_reason text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_asset_class_check') THEN
    ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_asset_class_check
      CHECK (asset_class IS NULL OR asset_class IN ('VEHICULAR', 'MONTACARGAS', 'ELEVACION', 'APILADOR', 'TRANSPALETA')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_meter_type_check') THEN
    ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_meter_type_check CHECK (meter_type IS NULL OR meter_type IN ('KM', 'HORAS')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicles_manufacture_year_check') THEN
    ALTER TABLE public.vehicles ADD CONSTRAINT vehicles_manufacture_year_check
      CHECK (manufacture_year IS NULL OR manufacture_year BETWEEN 1950 AND 2100) NOT VALID;
  END IF;
END $$;

-- Clase y medidor sugeridos desde el tipo actual (solo donde están vacíos; se corrigen en la ficha)
UPDATE public.vehicles v SET asset_class = CASE
    WHEN v.type IN ('CAMION', 'CAMIONETA', 'FURGON', 'TRAILER', 'TRACTO', 'SEMIRREMOLQUE') THEN 'VEHICULAR'
    WHEN v.type = 'MONTACARGAS' THEN 'MONTACARGAS'
    WHEN v.type = 'APILADOR' THEN 'APILADOR'
    WHEN v.type = 'TRANSPALETA' THEN 'TRANSPALETA'
    WHEN EXISTS (SELECT 1 FROM public.fe_assets a WHERE a.vehicle_id = v.id AND a.clase = 'ELEVACION') THEN 'ELEVACION'
    WHEN EXISTS (SELECT 1 FROM public.fe_assets a WHERE a.vehicle_id = v.id AND a.clase = 'MONTACARGA') THEN 'MONTACARGAS'
  END
WHERE v.asset_class IS NULL;
UPDATE public.vehicles SET meter_type = CASE WHEN asset_class = 'VEHICULAR' THEN 'KM' ELSE 'HORAS' END
WHERE meter_type IS NULL AND asset_class IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Normalización y equivalencias revisables
-- ------------------------------------------------------------
-- Texto para comparar: mayúsculas, sin tildes, sin signos y con espacios simples
CREATE OR REPLACE FUNCTION public.mant_norm(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(regexp_replace(regexp_replace(translate(upper(COALESCE(p, '')), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'), '[^A-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')), '');
$$;

CREATE TABLE IF NOT EXISTS public.mant_activo_alias (
  nombre_norm   text PRIMARY KEY,
  nombre_origen text NOT NULL,
  vehicle_id    uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  fe_code       text,
  revisado      boolean NOT NULL DEFAULT false,
  revisado_por  uuid,
  revisado_at   timestamptz,
  nota          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mant_activo_alias_vehicle ON public.mant_activo_alias (vehicle_id);

CREATE TABLE IF NOT EXISTS public.mant_proveedor_alias (
  nombre_norm   text PRIMARY KEY,
  nombre_origen text NOT NULL,
  provider_id   uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
  revisado      boolean NOT NULL DEFAULT false,
  revisado_por  uuid,
  revisado_at   timestamptz,
  nota          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mant_proveedor_alias_provider ON public.mant_proveedor_alias (provider_id);

-- ------------------------------------------------------------
-- 4. Importaciones, registro único y lecturas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mant_importaciones (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  archivo      text NOT NULL,
  huella       text NOT NULL,
  hoja         text,
  filas        integer NOT NULL DEFAULT 0,
  insertados   integer NOT NULL DEFAULT 0,
  actualizados integer NOT NULL DEFAULT 0,
  sin_cambio   integer NOT NULL DEFAULT 0,
  rechazados   integer NOT NULL DEFAULT 0,
  dudosos      integer NOT NULL DEFAULT 0,
  reporte      jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado       text NOT NULL DEFAULT 'EN_CURSO' CHECK (estado IN ('EN_CURSO', 'APLICADA', 'FALLIDA')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE TABLE IF NOT EXISTS public.mant_registros (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clave_natural      text NOT NULL UNIQUE,
  origen             text NOT NULL CHECK (origen IN ('EXCEL', 'OT', 'CAJA', 'MANUAL')),
  import_id          uuid REFERENCES public.mant_importaciones(id) ON DELETE SET NULL,
  hoja               text,
  fila               integer,
  fila_original      jsonb,
  work_order_id      uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  -- Activo
  activo_original    text NOT NULL,
  vehicle_id         uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  clase_activo       text,
  -- Documento y monto
  fecha              date,
  proveedor_original text,
  provider_id        uuid REFERENCES public.maintenance_providers(id) ON DELETE SET NULL,
  factura            text,
  rq                 text,
  monto              numeric(14, 2),
  moneda             text NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN', 'USD')),
  incluye_igv        boolean,
  tipo_cambio        numeric(10, 4),
  monto_pen          numeric(14, 2),
  descripcion        text,
  -- Clasificación (original y corregida)
  tipo               text CHECK (tipo IS NULL OR tipo IN ('PREVENTIVO', 'CORRECTIVO', 'MEJORA')),
  tipo_origen        text,
  criterio_tipo      text,
  area               text,
  categoria_costo    text,
  intervencion_mayor boolean,
  -- Taller
  ingreso_at         timestamptz,
  salida_at          timestamptz,
  dias_fuera         numeric(8, 2),
  autorizado_por     text,
  -- Medidor (original y validado)
  km_hrs_original    numeric,
  km_hrs_validado    numeric,
  obs_medidor        text,
  prox_mantto        numeric,
  dia_con_correctivo boolean,
  anio_fabricacion   integer,
  -- Calidad
  faltantes          text[] NOT NULL DEFAULT '{}',
  observaciones      text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mant_registros_vehicle_fecha ON public.mant_registros (vehicle_id, fecha);
CREATE INDEX IF NOT EXISTS mant_registros_import ON public.mant_registros (import_id);
CREATE INDEX IF NOT EXISTS mant_registros_wo ON public.mant_registros (work_order_id);
CREATE INDEX IF NOT EXISTS mant_registros_provider ON public.mant_registros (provider_id);

CREATE TABLE IF NOT EXISTS public.mant_lecturas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     uuid REFERENCES public.vehicles(id) ON DELETE CASCADE,
  activo_original text,
  fecha_at       timestamptz NOT NULL,
  valor          numeric NOT NULL,
  unidad         text NOT NULL CHECK (unidad IN ('KM', 'HORAS')),
  obs_calidad    text NOT NULL DEFAULT 'OK',
  valor_validado numeric,
  origen         text NOT NULL CHECK (origen IN ('EXCEL', 'ORDEN', 'INSPECCION', 'MANUAL', 'TURNO')),
  ref_id         uuid,
  motivo         text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mant_lecturas_vehicle_fecha ON public.mant_lecturas (vehicle_id, fecha_at);
CREATE UNIQUE INDEX IF NOT EXISTS mant_lecturas_ref ON public.mant_lecturas (origen, ref_id) WHERE ref_id IS NOT NULL;

-- Seguridad: lectura por funciones; sin acceso directo
ALTER TABLE public.mant_activo_alias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.mant_activo_alias;
CREATE POLICY security_active_account ON public.mant_activo_alias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.mant_activo_alias FROM PUBLIC, anon, authenticated;
ALTER TABLE public.mant_proveedor_alias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.mant_proveedor_alias;
CREATE POLICY security_active_account ON public.mant_proveedor_alias AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.mant_proveedor_alias FROM PUBLIC, anon, authenticated;
ALTER TABLE public.mant_importaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.mant_importaciones;
CREATE POLICY security_active_account ON public.mant_importaciones AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.mant_importaciones FROM PUBLIC, anon, authenticated;
ALTER TABLE public.mant_registros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.mant_registros;
CREATE POLICY security_active_account ON public.mant_registros AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.mant_registros FROM PUBLIC, anon, authenticated;
ALTER TABLE public.mant_lecturas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.mant_lecturas;
CREATE POLICY security_active_account ON public.mant_lecturas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.mant_lecturas FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Reglas de validación (compartidas por la importación y las OT)
-- ------------------------------------------------------------
-- Una reparación, un cambio de componente o un cambio de motor nunca es preventivo. Devuelve el motivo o NULL.
-- Los cambios de consumibles (aceite, filtros, refrigerante, grasa, llantas) sí pueden ser preventivos.
CREATE OR REPLACE FUNCTION public.mant_tipo_violacion(p_tipo text, p_texto text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN upper(COALESCE(p_tipo, '')) NOT IN ('PREVENTIVO', 'PREVENTIVA') THEN NULL
    WHEN public.mant_norm(p_texto) ~ '\m(REPAR\w*|AVERIA\w*|FALLA\w*|OVERHAUL|RECTIFIC\w*|REEMPLAZO DE (MOTOR|CAJA|BOMBA|EMBRAGUE|ALTERNADOR|ARRANCADOR|TURBO|RADIADOR|DIFERENCIAL|COMPRESOR|CILINDRO))'
      THEN 'La descripción indica una reparación: no puede registrarse como preventivo'
    WHEN public.mant_norm(p_texto) ~ '\mCAMBIO (DE |DEL )?(MOTOR|CAJA|BOMBA|EMBRAGUE|ALTERNADOR|ARRANCADOR|MOTOR DE ARRANQUE|TURBO|RADIADOR|DIFERENCIAL|COMPRESOR|CILINDRO|INYECTOR\w*|RODAMIENTO\w*|RODAJE\w*|CREMALLERA|CARDAN|PISTON\w*|CULATA|CONTACTOR\w*|TARJETA|CONTROLADOR|MOTOR ELECTRICO|MOTOR DE TRACCION|MOTOR HIDRAULICO|BATERIA\w*)'
      THEN 'La descripción indica un cambio de componente: no puede registrarse como preventivo'
  END;
$$;

-- Lectura contra la anterior del mismo activo: retroceso o avance diario mayor a 16 h (equipos) o 1.200 km (vehículos)
CREATE OR REPLACE FUNCTION public.mant_lectura_check(p_vehicle uuid, p_fecha timestamptz, p_valor numeric, p_unidad text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_prev_val numeric; v_prev_at timestamptz; v_dias numeric; v_por_dia numeric; v_lim numeric := CASE WHEN p_unidad = 'KM' THEN 1200 ELSE 16 END;
BEGIN
  IF p_valor IS NULL THEN RETURN jsonb_build_object('ok', false, 'obs', 'SIN LECTURA', 'mensaje', 'Falta la lectura del ' || CASE WHEN p_unidad = 'KM' THEN 'odómetro' ELSE 'horómetro' END); END IF;
  IF p_valor < 0 THEN RETURN jsonb_build_object('ok', false, 'obs', 'NEGATIVA', 'mensaje', 'La lectura no puede ser negativa'); END IF;
  SELECT valor, fecha_at INTO v_prev_val, v_prev_at FROM (
    SELECT COALESCE(l.valor_validado, l.valor) AS valor, l.fecha_at FROM public.mant_lecturas l
    WHERE l.vehicle_id = p_vehicle AND l.unidad = p_unidad AND l.fecha_at < p_fecha
      AND l.obs_calidad IN ('OK', 'CONFIRMADA', 'SIN REVISAR')  -- las del historial sin revisión cuentan; las marcadas con problema no
    UNION ALL
    SELECT CASE WHEN p_unidad = 'KM' THEN o.odometer_value ELSE o.hours_value END, o.created_at FROM public.vehicle_odometer_logs o
    JOIN public.vehicles v ON v.id = p_vehicle AND v.plate = o.vehicle_plate
    WHERE o.created_at < p_fecha AND (CASE WHEN p_unidad = 'KM' THEN o.odometer_value ELSE o.hours_value END) IS NOT NULL
  ) x ORDER BY fecha_at DESC LIMIT 1;
  IF v_prev_val IS NULL THEN RETURN jsonb_build_object('ok', true, 'obs', 'OK', 'mensaje', 'Primera lectura del activo'); END IF;
  IF p_valor < v_prev_val THEN
    RETURN jsonb_build_object('ok', false, 'obs', 'RETROCESO', 'anterior', v_prev_val, 'anterior_at', v_prev_at,
      'mensaje', format('La lectura (%s) es menor que la anterior (%s del %s)', p_valor, v_prev_val, to_char(v_prev_at AT TIME ZONE 'America/Lima', 'DD/MM/YYYY')));
  END IF;
  v_dias := GREATEST(EXTRACT(EPOCH FROM (p_fecha - v_prev_at)) / 86400.0, 1);
  v_por_dia := (p_valor - v_prev_val) / v_dias;
  IF v_por_dia > v_lim THEN
    RETURN jsonb_build_object('ok', false, 'obs', 'SALTO ANÓMALO', 'anterior', v_prev_val, 'anterior_at', v_prev_at, 'por_dia', round(v_por_dia, 1),
      'mensaje', format('Avance de %s %s por día desde la lectura anterior (%s): supera %s', round(v_por_dia, 1), CASE WHEN p_unidad = 'KM' THEN 'km' ELSE 'h' END, v_prev_val, v_lim));
  END IF;
  RETURN jsonb_build_object('ok', true, 'obs', 'OK', 'anterior', v_prev_val, 'anterior_at', v_prev_at, 'por_dia', round(v_por_dia, 1));
END $$;

-- ------------------------------------------------------------
-- 6. Reglas de las OT desde ahora
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS meter_reading numeric;
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS meter_override_reason text;
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS includes_igv boolean;
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS exchange_rate numeric(10, 4);
ALTER TABLE public.maintenance_work_orders ADD COLUMN IF NOT EXISTS requisition text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mwo_currency_check') THEN
    ALTER TABLE public.maintenance_work_orders ADD CONSTRAINT mwo_currency_check CHECK (currency IS NULL OR currency IN ('PEN', 'USD')) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.mant_ot_reglas() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_texto text := concat_ws(' ', NEW.description, NEW.diagnosis, NEW.diagnostic, NEW.activities_performed, NEW.tasks::text);
  v_viol text; v_unidad text; v_chk jsonb; v_vid uuid := NEW.vehicle_id;
BEGIN
  -- Tipo: obligatorio y coherente con lo descrito (en cualquier momento)
  v_viol := public.mant_tipo_violacion(NEW.order_type, v_texto);
  IF v_viol IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.order_type IS DISTINCT FROM OLD.order_type OR v_texto IS DISTINCT FROM concat_ws(' ', OLD.description, OLD.diagnosis, OLD.diagnostic, OLD.activities_performed, OLD.tasks::text)) THEN
    RAISE EXCEPTION 'OT %: %. Cámbiela a CORRECTIVA o MEJORA.', COALESCE(NEW.ot_code, NEW.ot_number, ''), v_viol USING ERRCODE = 'check_violation';
  END IF;
  -- Al terminar: tipo, ingreso y salida de taller, lectura validada y moneda con IGV
  IF NEW.status = 'TERMINADA' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'TERMINADA') THEN
    IF NEW.order_type IS NULL THEN RAISE EXCEPTION 'Indique el tipo de mantenimiento antes de terminar la OT' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.downtime_start IS NULL OR NEW.downtime_end IS NULL THEN
      RAISE EXCEPTION 'Registre la fecha y hora de ingreso y de salida de taller antes de terminar la OT' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.downtime_end < NEW.downtime_start THEN RAISE EXCEPTION 'La salida de taller es anterior al ingreso' USING ERRCODE = 'check_violation'; END IF;
    IF v_vid IS NULL AND NEW.vehicle_plate IS NOT NULL THEN SELECT id INTO v_vid FROM public.vehicles WHERE plate = NEW.vehicle_plate LIMIT 1; END IF;
    SELECT COALESCE(meter_type, CASE WHEN asset_class = 'VEHICULAR' OR type IN ('CAMION', 'CAMIONETA', 'FURGON', 'TRAILER', 'TRACTO', 'SEMIRREMOLQUE') THEN 'KM' ELSE 'HORAS' END)
      INTO v_unidad FROM public.vehicles WHERE id = v_vid;
    v_unidad := COALESCE(v_unidad, 'KM');
    v_chk := public.mant_lectura_check(v_vid, NEW.downtime_end, NEW.meter_reading, v_unidad);
    IF NEW.meter_reading IS NULL THEN RAISE EXCEPTION '%', v_chk->>'mensaje' USING ERRCODE = 'check_violation'; END IF;
    IF NOT (v_chk->>'ok')::boolean AND length(btrim(COALESCE(NEW.meter_override_reason, ''))) < 5 THEN
      RAISE EXCEPTION '%. Corrija la lectura o confirme con el motivo.', v_chk->>'mensaje' USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(NEW.total_cost, NEW.final_cost_pen, 0) > 0 AND (NEW.currency IS NULL OR NEW.includes_igv IS NULL) THEN
      RAISE EXCEPTION 'Indique la moneda (PEN o USD) y si el monto incluye IGV' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.currency = 'USD' AND NEW.exchange_rate IS NULL THEN RAISE EXCEPTION 'Indique el tipo de cambio del monto en USD' USING ERRCODE = 'check_violation'; END IF;
    IF v_vid IS NOT NULL THEN
      INSERT INTO public.mant_lecturas (vehicle_id, fecha_at, valor, unidad, obs_calidad, valor_validado, origen, ref_id, motivo, created_by)
      VALUES (v_vid, NEW.downtime_end, NEW.meter_reading, v_unidad, CASE WHEN (v_chk->>'ok')::boolean THEN 'OK' ELSE 'CONFIRMADA' END,
        NEW.meter_reading, 'ORDEN', NEW.id, CASE WHEN (v_chk->>'ok')::boolean THEN NULL ELSE concat(v_chk->>'obs', ': ', NEW.meter_override_reason) END, auth.uid())
      ON CONFLICT (origen, ref_id) WHERE ref_id IS NOT NULL DO UPDATE SET valor = EXCLUDED.valor, fecha_at = EXCLUDED.fecha_at, valor_validado = EXCLUDED.valor_validado,
        obs_calidad = EXCLUDED.obs_calidad, motivo = EXCLUDED.motivo;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mant_ot_reglas ON public.maintenance_work_orders;
CREATE TRIGGER mant_ot_reglas BEFORE INSERT OR UPDATE ON public.maintenance_work_orders FOR EACH ROW EXECUTE FUNCTION public.mant_ot_reglas();

-- Vista previa para la pantalla (antes de terminar): valida tipo y lectura sin guardar
CREATE OR REPLACE FUNCTION public.mant_ot_prevalidar(p_order uuid, p_meter numeric, p_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o public.maintenance_work_orders; v_vid uuid; v_unidad text;
BEGIN
  IF NOT public.mant_flota_can_view() THEN RAISE EXCEPTION 'Sin permiso'; END IF;
  SELECT * INTO o FROM public.maintenance_work_orders WHERE id = p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'La OT no existe'; END IF;
  v_vid := o.vehicle_id;
  IF v_vid IS NULL THEN SELECT id INTO v_vid FROM public.vehicles WHERE plate = o.vehicle_plate LIMIT 1; END IF;
  SELECT COALESCE(meter_type, CASE WHEN asset_class = 'VEHICULAR' THEN 'KM' ELSE 'HORAS' END) INTO v_unidad FROM public.vehicles WHERE id = v_vid;
  RETURN jsonb_build_object('unidad', COALESCE(v_unidad, 'KM'),
    'lectura', public.mant_lectura_check(v_vid, COALESCE(p_end, now()), p_meter, COALESCE(v_unidad, 'KM')),
    -- aviso para el formulario: qué pasaría si se marca como preventivo (el tipo elegido aún no está guardado)
    'tipo', public.mant_tipo_violacion('PREVENTIVO', concat_ws(' ', o.description, o.diagnosis, o.diagnostic, o.activities_performed, o.tasks::text)));
END $$;

-- ------------------------------------------------------------
-- 7. Importación (la llama scripts/mant-import.cjs; idempotente por clave natural)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_import_begin(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.mant_flota_can_import() THEN RAISE EXCEPTION 'Sin permiso para importar mantenimiento'; END IF;
  INSERT INTO public.mant_importaciones (archivo, huella, hoja, filas, created_by)
  VALUES (p->>'archivo', p->>'huella', p->>'hoja', COALESCE((p->>'filas')::int, 0), auth.uid()) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Alias: crea las equivalencias que falten (sin revisar) y devuelve el vínculo actual
CREATE OR REPLACE FUNCTION public.mant_import_alias(p_activos jsonb, p_proveedores jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.mant_flota_can_import() THEN RAISE EXCEPTION 'Sin permiso para importar mantenimiento'; END IF;
  INSERT INTO public.mant_activo_alias (nombre_norm, nombre_origen, fe_code, vehicle_id)
  SELECT public.mant_norm(x->>'nombre'), x->>'nombre', public.fe_code(x->>'nombre'),
    (SELECT v.id FROM public.vehicles v WHERE public.mant_norm(v.plate) = public.mant_norm(public.fe_code(x->>'nombre'))
       OR public.mant_norm(v.internal_code) = public.mant_norm(x->>'nombre') OR public.mant_norm(v.display_name) = public.mant_norm(x->>'nombre')
       OR v.id = (SELECT a.vehicle_id FROM public.fe_assets a WHERE a.code = public.fe_code(x->>'nombre')) LIMIT 1)
  FROM jsonb_array_elements(COALESCE(p_activos, '[]')) x WHERE public.mant_norm(x->>'nombre') IS NOT NULL
  ON CONFLICT (nombre_norm) DO NOTHING;
  -- Proveedores: un proveedor por grupo de nombres equivalentes (la agrupación la propone el script; se revisa después)
  -- El Excel no trae RUC: se registra un código provisional «PENDIENTE-…» (no es un RUC) para completarlo después
  INSERT INTO public.maintenance_providers (ruc, business_name, specialty, is_active)
  SELECT DISTINCT 'PENDIENTE-' || left(md5(public.mant_norm(x->>'canonico')), 10), x->>'canonico', 'Creado desde el historial de mantenimiento: completar RUC', true
  FROM jsonb_array_elements(COALESCE(p_proveedores, '[]')) x
  WHERE public.mant_norm(x->>'canonico') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.maintenance_providers mp WHERE public.mant_norm(mp.business_name) = public.mant_norm(x->>'canonico'))
    AND NOT EXISTS (SELECT 1 FROM public.mant_proveedor_alias a WHERE a.nombre_norm = public.mant_norm(x->>'nombre'))
  ON CONFLICT (ruc) DO NOTHING;
  INSERT INTO public.mant_proveedor_alias (nombre_norm, nombre_origen, provider_id, nota)
  SELECT public.mant_norm(x->>'nombre'), x->>'nombre',
    (SELECT mp.id FROM public.maintenance_providers mp WHERE public.mant_norm(mp.business_name) = public.mant_norm(x->>'canonico') ORDER BY mp.created_at LIMIT 1),
    NULLIF(x->>'nota', '')
  FROM jsonb_array_elements(COALESCE(p_proveedores, '[]')) x WHERE public.mant_norm(x->>'nombre') IS NOT NULL
  ON CONFLICT (nombre_norm) DO NOTHING;
  RETURN jsonb_build_object(
    'activos', (SELECT COALESCE(jsonb_object_agg(nombre_norm, jsonb_build_object('vehicle_id', vehicle_id, 'fe_code', fe_code, 'revisado', revisado)), '{}') FROM public.mant_activo_alias),
    'proveedores', (SELECT COALESCE(jsonb_object_agg(a.nombre_norm, jsonb_build_object('provider_id', a.provider_id, 'nombre', mp.business_name, 'revisado', a.revisado)), '{}')
      FROM public.mant_proveedor_alias a LEFT JOIN public.maintenance_providers mp ON mp.id = a.provider_id));
END $$;

CREATE OR REPLACE FUNCTION public.mant_import_rows(p_import uuid, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; v_ins int := 0; v_upd int := 0; v_same int := 0; v_old public.mant_registros; v_new public.mant_registros;
BEGIN
  IF NOT public.mant_flota_can_import() THEN RAISE EXCEPTION 'Sin permiso para importar mantenimiento'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_new := jsonb_populate_record(NULL::public.mant_registros, r);
    v_new.vehicle_id := (SELECT vehicle_id FROM public.mant_activo_alias WHERE nombre_norm = public.mant_norm(v_new.activo_original));
    v_new.provider_id := (SELECT provider_id FROM public.mant_proveedor_alias WHERE nombre_norm = public.mant_norm(v_new.proveedor_original));
    SELECT * INTO v_old FROM public.mant_registros WHERE clave_natural = v_new.clave_natural;
    IF NOT FOUND THEN
      INSERT INTO public.mant_registros (clave_natural, origen, import_id, hoja, fila, fila_original, activo_original, vehicle_id, clase_activo, fecha,
        proveedor_original, provider_id, factura, rq, monto, moneda, incluye_igv, tipo_cambio, monto_pen, descripcion, tipo, tipo_origen, criterio_tipo, area,
        categoria_costo, intervencion_mayor, ingreso_at, salida_at, dias_fuera, autorizado_por, km_hrs_original, km_hrs_validado, obs_medidor, prox_mantto,
        dia_con_correctivo, anio_fabricacion, faltantes, observaciones)
      VALUES (v_new.clave_natural, 'EXCEL', p_import, v_new.hoja, v_new.fila, v_new.fila_original, v_new.activo_original, v_new.vehicle_id, v_new.clase_activo,
        v_new.fecha, v_new.proveedor_original, v_new.provider_id, v_new.factura, v_new.rq, v_new.monto, COALESCE(v_new.moneda, 'PEN'), v_new.incluye_igv,
        v_new.tipo_cambio, v_new.monto_pen, v_new.descripcion, v_new.tipo, v_new.tipo_origen, v_new.criterio_tipo, v_new.area, v_new.categoria_costo,
        v_new.intervencion_mayor, v_new.ingreso_at, v_new.salida_at, v_new.dias_fuera, v_new.autorizado_por, v_new.km_hrs_original, v_new.km_hrs_validado,
        v_new.obs_medidor, v_new.prox_mantto, v_new.dia_con_correctivo, v_new.anio_fabricacion, COALESCE(v_new.faltantes, '{}'), COALESCE(v_new.observaciones, '{}'));
      v_ins := v_ins + 1;
    ELSIF (v_old.tipo, v_old.criterio_tipo, v_old.km_hrs_validado, v_old.obs_medidor, v_old.dia_con_correctivo, v_old.area, v_old.categoria_costo,
           v_old.ingreso_at, v_old.salida_at, v_old.dias_fuera, v_old.prox_mantto, v_old.vehicle_id, v_old.provider_id, v_old.rq)
          IS DISTINCT FROM
          (v_new.tipo, v_new.criterio_tipo, v_new.km_hrs_validado, v_new.obs_medidor, v_new.dia_con_correctivo, v_new.area, v_new.categoria_costo,
           v_new.ingreso_at, v_new.salida_at, v_new.dias_fuera, v_new.prox_mantto, v_new.vehicle_id, v_new.provider_id, v_new.rq) THEN
      -- Misma línea (misma clave): se actualizan solo las correcciones; el dato original no cambia
      UPDATE public.mant_registros SET tipo = v_new.tipo, criterio_tipo = v_new.criterio_tipo, km_hrs_validado = v_new.km_hrs_validado,
        obs_medidor = v_new.obs_medidor, dia_con_correctivo = v_new.dia_con_correctivo, area = v_new.area, categoria_costo = v_new.categoria_costo,
        ingreso_at = v_new.ingreso_at, salida_at = v_new.salida_at, dias_fuera = v_new.dias_fuera, prox_mantto = v_new.prox_mantto,
        vehicle_id = v_new.vehicle_id, provider_id = v_new.provider_id, rq = v_new.rq, faltantes = COALESCE(v_new.faltantes, '{}'),
        observaciones = COALESCE(v_new.observaciones, '{}'), import_id = p_import, updated_at = now()
      WHERE id = v_old.id;
      v_upd := v_upd + 1;
    ELSE
      v_same := v_same + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('insertados', v_ins, 'actualizados', v_upd, 'sin_cambio', v_same);
END $$;

CREATE OR REPLACE FUNCTION public.mant_import_finish(p_import uuid, p_reporte jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tot jsonb; n_fe int;
BEGIN
  IF NOT public.mant_flota_can_import() THEN RAISE EXCEPTION 'Sin permiso para importar mantenimiento'; END IF;
  -- Lecturas del Excel (una por registro con lectura), con su observación de calidad
  INSERT INTO public.mant_lecturas (vehicle_id, activo_original, fecha_at, valor, unidad, obs_calidad, valor_validado, origen, ref_id)
  SELECT r.vehicle_id, r.activo_original, (r.fecha + time '12:00') AT TIME ZONE 'America/Lima', r.km_hrs_original,
    CASE WHEN COALESCE(v.meter_type, CASE WHEN r.clase_activo ~ 'VEHIC' THEN 'KM' ELSE 'HORAS' END) = 'KM' THEN 'KM' ELSE 'HORAS' END,
    COALESCE(r.obs_medidor, 'SIN REVISAR'), r.km_hrs_validado, 'EXCEL', r.id
  FROM public.mant_registros r LEFT JOIN public.vehicles v ON v.id = r.vehicle_id
  WHERE r.origen = 'EXCEL' AND r.km_hrs_original IS NOT NULL AND r.fecha IS NOT NULL
  ON CONFLICT (origen, ref_id) WHERE ref_id IS NOT NULL DO UPDATE SET obs_calidad = EXCLUDED.obs_calidad, valor_validado = EXCLUDED.valor_validado,
    vehicle_id = EXCLUDED.vehicle_id;
  n_fe := public.mant_sync_fe_maint();
  SELECT jsonb_build_object('registros', count(*), 'monto', sum(monto_pen)) INTO v_tot FROM public.mant_registros WHERE origen = 'EXCEL';
  UPDATE public.mant_importaciones SET estado = 'APLICADA', finished_at = now(), reporte = COALESCE(p_reporte, '{}') || jsonb_build_object('totales_base', v_tot, 'fe_maint', n_fe),
    insertados = COALESCE((p_reporte->>'insertados')::int, 0), actualizados = COALESCE((p_reporte->>'actualizados')::int, 0),
    sin_cambio = COALESCE((p_reporte->>'sin_cambio')::int, 0), rechazados = COALESCE((p_reporte->>'rechazados')::int, 0),
    dudosos = COALESCE((p_reporte->>'dudosos')::int, 0)
  WHERE id = p_import;
  RETURN jsonb_build_object('success', true, 'totales_base', v_tot, 'fe_maint', n_fe);
END $$;

-- ------------------------------------------------------------
-- 8. fe_maint como copia derivada de mant_registros (Eficiencia de Flota y Plan de mantenimiento la siguen leyendo)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_sync_fe_maint() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mant_registros WHERE origen = 'EXCEL') THEN RETURN 0; END IF;
  DELETE FROM public.fe_maint WHERE true;
  INSERT INTO public.fe_maint (upload_id, asset_code, fecha, monto, proveedor, factura, km_hrs, tipo, categoria, mayor, dias_fuera, area, detalle,
    prox_mantto, fecha_ingreso, fecha_salida, tipo_real, amortizable)
  SELECT NULL, COALESCE(a.fe_code, public.fe_code(r.activo_original)), r.fecha, r.monto_pen, COALESCE(mp.business_name, r.proveedor_original), r.factura,
    COALESCE(r.km_hrs_validado, CASE WHEN r.obs_medidor IS NULL THEN r.km_hrs_original END),
    COALESCE(r.tipo_origen, r.tipo), r.categoria_costo, COALESCE(r.intervencion_mayor, false), r.dias_fuera, r.area, r.descripcion, r.prox_mantto,
    r.ingreso_at::date, r.salida_at::date,
    CASE WHEN public.fe_tipo_real(r.tipo_origen, r.categoria_costo, r.descripcion) = 'NEUMATICOS' THEN 'NEUMATICOS'
         ELSE COALESCE(r.tipo, public.fe_tipo_real(r.tipo_origen, r.categoria_costo, r.descripcion)) END,
    (COALESCE(r.categoria_costo, '') ~ 'LLANTA|NEUM' OR COALESCE(r.intervencion_mayor, false))
  FROM public.mant_registros r
  LEFT JOIN public.mant_activo_alias a ON a.nombre_norm = public.mant_norm(r.activo_original)
  LEFT JOIN public.maintenance_providers mp ON mp.id = r.provider_id
  WHERE r.origen = 'EXCEL';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Después de aplicar una carga de Eficiencia de Flota, el mantenimiento vuelve a salir del registro único
CREATE OR REPLACE FUNCTION public.mant_trg_fe_upload_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Las pruebas de Eficiencia (C28) desactivan la resincronización en su transacción: SET LOCAL mant.sync_fe_maint = 'off'
  IF NEW.status = 'APLICADA' AND OLD.status IS DISTINCT FROM 'APLICADA' AND COALESCE(current_setting('mant.sync_fe_maint', true), '') <> 'off' THEN
    PERFORM public.mant_sync_fe_maint();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mant_fe_upload_sync ON public.fe_uploads;
CREATE TRIGGER mant_fe_upload_sync AFTER UPDATE OF status ON public.fe_uploads FOR EACH ROW EXECUTE FUNCTION public.mant_trg_fe_upload_sync();

-- ------------------------------------------------------------
-- 9. Lecturas y consulta para las pantallas
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_registrar_lectura(p_vehicle uuid, p_fecha timestamptz, p_valor numeric, p_origen text, p_motivo text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_unidad text; v_chk jsonb;
BEGIN
  IF NOT public.mant_flota_can_view() THEN RAISE EXCEPTION 'Sin permiso'; END IF;
  IF p_origen NOT IN ('MANUAL', 'INSPECCION', 'TURNO') THEN RAISE EXCEPTION 'Origen no válido'; END IF;
  SELECT COALESCE(meter_type, CASE WHEN asset_class = 'VEHICULAR' THEN 'KM' ELSE 'HORAS' END) INTO v_unidad FROM public.vehicles WHERE id = p_vehicle;
  IF v_unidad IS NULL THEN RAISE EXCEPTION 'El activo no existe'; END IF;
  v_chk := public.mant_lectura_check(p_vehicle, COALESCE(p_fecha, now()), p_valor, v_unidad);
  IF NOT (v_chk->>'ok')::boolean AND length(btrim(COALESCE(p_motivo, ''))) < 5 THEN
    RETURN jsonb_build_object('success', false, 'requiere_motivo', true, 'check', v_chk, 'error', (v_chk->>'mensaje') || '. Confirme con el motivo.');
  END IF;
  INSERT INTO public.mant_lecturas (vehicle_id, fecha_at, valor, unidad, obs_calidad, valor_validado, origen, motivo, created_by)
  VALUES (p_vehicle, COALESCE(p_fecha, now()), p_valor, v_unidad, CASE WHEN (v_chk->>'ok')::boolean THEN 'OK' ELSE 'CONFIRMADA' END, p_valor, p_origen,
    CASE WHEN (v_chk->>'ok')::boolean THEN NULL ELSE concat(v_chk->>'obs', ': ', p_motivo) END, auth.uid());
  RETURN jsonb_build_object('success', true, 'check', v_chk);
END $$;

-- Ficha de activo: clase, medidor, área, año y baja (Administrador o Flota con escritura)
CREATE OR REPLACE FUNCTION public.mant_activo_guardar(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := NULLIF(p->>'id', '')::uuid; v_ok boolean; v_carrier uuid;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.profiles pr JOIN public.roles r ON r.id = pr.role_id WHERE pr.id = auth.uid() AND pr.is_active
    AND (r.name = 'Administrador' OR COALESCE(r.permissions, '[]'::jsonb) ?| ARRAY['mantenimiento-flota:write', 'mantenimiento-flota'])) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'Sin permiso para editar activos (Flota 360° con escritura)'; END IF;
  IF COALESCE(p->>'asset_class', '') NOT IN ('VEHICULAR', 'MONTACARGAS', 'ELEVACION', 'APILADOR', 'TRANSPALETA') THEN RAISE EXCEPTION 'Clase de activo no válida'; END IF;
  IF COALESCE(p->>'meter_type', '') NOT IN ('KM', 'HORAS') THEN RAISE EXCEPTION 'Indique si el medidor es en km u horas'; END IF;
  IF v_id IS NULL THEN
    IF COALESCE(btrim(p->>'plate'), '') = '' THEN RAISE EXCEPTION 'Indique la placa o el código del activo'; END IF;
    IF EXISTS (SELECT 1 FROM public.vehicles WHERE upper(plate) = upper(btrim(p->>'plate'))) THEN RAISE EXCEPTION 'Ya existe un activo con esa placa o código'; END IF;
    -- Flota propia: el transportista propio (como el registro de equipos de la migración 20261004140000)
    BEGIN
      EXECUTE $q$SELECT id FROM public.carriers ORDER BY (upper(COALESCE(type::text, '')) = 'PROPIO') DESC, created_at NULLS LAST LIMIT 1$q$ INTO v_carrier;
    EXCEPTION WHEN OTHERS THEN v_carrier := NULL; END;
    INSERT INTO public.vehicles (plate, carrier_id, type, brand, model, status, internal_code, serial_number, asset_class, display_name, meter_type, assigned_area, manufacture_year)
    VALUES (upper(btrim(p->>'plate')), v_carrier,
      CASE p->>'asset_class' WHEN 'VEHICULAR' THEN COALESCE(NULLIF(p->>'type', ''), 'CAMION') WHEN 'MONTACARGAS' THEN 'MONTACARGAS' WHEN 'APILADOR' THEN 'APILADOR'
        WHEN 'TRANSPALETA' THEN 'TRANSPALETA' ELSE 'OTRO' END,
      NULLIF(p->>'brand', ''), NULLIF(p->>'model', ''), 'DISPONIBLE', NULLIF(p->>'internal_code', ''), NULLIF(p->>'serial_number', ''),
      p->>'asset_class', NULLIF(p->>'display_name', ''), p->>'meter_type', NULLIF(p->>'assigned_area', ''), NULLIF(p->>'manufacture_year', '')::int)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.vehicles SET asset_class = p->>'asset_class', display_name = NULLIF(p->>'display_name', ''), meter_type = p->>'meter_type',
      assigned_area = NULLIF(p->>'assigned_area', ''), manufacture_year = NULLIF(p->>'manufacture_year', '')::int,
      brand = COALESCE(NULLIF(p->>'brand', ''), brand), model = COALESCE(NULLIF(p->>'model', ''), model),
      serial_number = COALESCE(NULLIF(p->>'serial_number', ''), serial_number), internal_code = COALESCE(NULLIF(p->>'internal_code', ''), internal_code),
      decommissioned_at = NULLIF(p->>'decommissioned_at', '')::date, decommission_reason = NULLIF(p->>'decommission_reason', '')
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'El activo no existe'; END IF;
  END IF;
  IF NULLIF(p->>'decommissioned_at', '') IS NOT NULL AND length(btrim(COALESCE(p->>'decommission_reason', ''))) < 5 THEN
    RAISE EXCEPTION 'Indique el motivo de la baja';
  END IF;
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.mant_activos_lista() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.mant_flota_can_view() THEN RAISE EXCEPTION 'Sin permiso'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'plate', v.plate, 'type', v.type, 'brand', v.brand, 'model', v.model,
    'internal_code', v.internal_code, 'serial_number', v.serial_number, 'asset_class', v.asset_class, 'display_name', v.display_name,
    'meter_type', v.meter_type, 'assigned_area', v.assigned_area, 'manufacture_year', v.manufacture_year, 'status', v.status,
    'decommissioned_at', v.decommissioned_at, 'decommission_reason', v.decommission_reason,
    'registros', (SELECT count(*) FROM public.mant_registros r WHERE r.vehicle_id = v.id),
    'monto', (SELECT sum(monto_pen) FROM public.mant_registros r WHERE r.vehicle_id = v.id),
    'ultima_lectura', (SELECT jsonb_build_object('valor', l.valor, 'fecha', l.fecha_at, 'obs', l.obs_calidad) FROM public.mant_lecturas l
      WHERE l.vehicle_id = v.id ORDER BY l.fecha_at DESC LIMIT 1)) ORDER BY v.asset_class NULLS LAST, v.plate)
    FROM public.vehicles v WHERE v.asset_class IS NOT NULL OR v.type IN ('MONTACARGAS', 'APILADOR', 'TRANSPALETA')
      OR EXISTS (SELECT 1 FROM public.mant_registros r WHERE r.vehicle_id = v.id)), '[]'::jsonb);
END $$;

-- Equivalencias: revisar o reasignar (Administrador o Presupuesto con escritura)
CREATE OR REPLACE FUNCTION public.mant_alias_revisar(p_tipo text, p_nombre_norm text, p_destino uuid, p_nota text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.mant_flota_can_import() THEN RAISE EXCEPTION 'Sin permiso para revisar equivalencias'; END IF;
  IF p_tipo = 'ACTIVO' THEN
    UPDATE public.mant_activo_alias SET vehicle_id = p_destino, revisado = true, revisado_por = auth.uid(), revisado_at = now(), nota = p_nota WHERE nombre_norm = p_nombre_norm;
    IF NOT FOUND THEN RAISE EXCEPTION 'La equivalencia no existe'; END IF;
    UPDATE public.mant_registros r SET vehicle_id = p_destino, updated_at = now() WHERE public.mant_norm(r.activo_original) = p_nombre_norm;
    UPDATE public.mant_lecturas l SET vehicle_id = p_destino FROM public.mant_registros r
    WHERE l.origen = 'EXCEL' AND l.ref_id = r.id AND public.mant_norm(r.activo_original) = p_nombre_norm;
  ELSIF p_tipo = 'PROVEEDOR' THEN
    UPDATE public.mant_proveedor_alias SET provider_id = p_destino, revisado = true, revisado_por = auth.uid(), revisado_at = now(), nota = p_nota WHERE nombre_norm = p_nombre_norm;
    IF NOT FOUND THEN RAISE EXCEPTION 'La equivalencia no existe'; END IF;
    UPDATE public.mant_registros r SET provider_id = p_destino, updated_at = now() WHERE public.mant_norm(r.proveedor_original) = p_nombre_norm;
  ELSE RAISE EXCEPTION 'Tipo no válido'; END IF;
  PERFORM public.mant_sync_fe_maint();
  RETURN jsonb_build_object('success', true);
END $$;

CREATE OR REPLACE FUNCTION public.mant_alias_lista() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.mant_flota_can_view() THEN RAISE EXCEPTION 'Sin permiso'; END IF;
  RETURN jsonb_build_object(
    'activos', COALESCE((SELECT jsonb_agg(jsonb_build_object('nombre_norm', a.nombre_norm, 'nombre_origen', a.nombre_origen, 'vehicle_id', a.vehicle_id,
      'plate', v.plate, 'revisado', a.revisado, 'nota', a.nota, 'registros', (SELECT count(*) FROM public.mant_registros r WHERE public.mant_norm(r.activo_original) = a.nombre_norm)) ORDER BY a.nombre_origen)
      FROM public.mant_activo_alias a LEFT JOIN public.vehicles v ON v.id = a.vehicle_id), '[]'),
    'proveedores', COALESCE((SELECT jsonb_agg(jsonb_build_object('nombre_norm', a.nombre_norm, 'nombre_origen', a.nombre_origen, 'provider_id', a.provider_id,
      'proveedor', mp.business_name, 'revisado', a.revisado, 'nota', a.nota, 'registros', (SELECT count(*) FROM public.mant_registros r WHERE public.mant_norm(r.proveedor_original) = a.nombre_norm)) ORDER BY mp.business_name, a.nombre_origen)
      FROM public.mant_proveedor_alias a LEFT JOIN public.maintenance_providers mp ON mp.id = a.provider_id), '[]'),
    'importaciones', COALESCE((SELECT jsonb_agg(to_jsonb(i) - 'reporte' ORDER BY i.created_at DESC) FROM public.mant_importaciones i), '[]'));
END $$;

-- ------------------------------------------------------------
-- 10. Privilegios
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mant_flota_can_view() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_flota_can_import() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_norm(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_tipo_violacion(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_lectura_check(uuid, timestamptz, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_ot_reglas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_ot_prevalidar(uuid, numeric, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_import_begin(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_import_alias(jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_import_rows(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_import_finish(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_sync_fe_maint() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_trg_fe_upload_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_registrar_lectura(uuid, timestamptz, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_activo_guardar(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_activos_lista() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_alias_revisar(text, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_alias_lista() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mant_flota_can_view(), public.mant_flota_can_import(), public.mant_norm(text), public.mant_tipo_violacion(text, text),
  public.mant_ot_prevalidar(uuid, numeric, timestamptz), public.mant_import_begin(jsonb), public.mant_import_alias(jsonb, jsonb),
  public.mant_import_rows(uuid, jsonb), public.mant_import_finish(uuid, jsonb), public.mant_registrar_lectura(uuid, timestamptz, numeric, text, text),
  public.mant_activo_guardar(jsonb), public.mant_activos_lista(), public.mant_alias_revisar(text, text, uuid, text), public.mant_alias_lista() TO authenticated;
