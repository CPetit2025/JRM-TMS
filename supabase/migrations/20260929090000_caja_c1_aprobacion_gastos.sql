-- ============================================================
-- CAJA DE TRANSPORTE — C1: Registro y aprobación de gastos
-- ============================================================
-- Hallazgos corregidos (docs/caja/01-c1-aprobacion-gastos.md):
--   * Cualquier usuario con `caja-gastos` podía aprobar (incluso sus propios gastos): la política de
--     UPDATE no separaba registrar de aprobar. Ahora la aprobación es exclusiva del permiso
--     `caja-aprobacion` (Administrador y Jefe de Distribución) y pasa por `review_dispatch_expense`.
--   * El gasto se insertaba con el estado que enviara el cliente; ahora siempre nace PENDIENTE.
--   * Observar sobrescribía la descripción (se perdía el sustento). La revisión va en campos propios
--     y queda en el historial `dispatch_expense_events`.
--   * Los datos del comprobante iban concatenados en `description`: ahora son columnas, con bloqueo
--     de comprobantes duplicados y validación del dígito verificador del RUC.
--   * Repuestos y llantas sumaban como Operación en el TCO: la categoría del libro sale del catálogo
--     `expense_categories`, y se usa el monto aprobado (ajustes parciales).
--   * Los aprobadores no podían ver las fotos del conductor (bucket privado); las de Caja web eran públicas.
BEGIN;

-- ------------------------------------------------------------
-- 1. Rol Jefe de Distribución
-- ------------------------------------------------------------
INSERT INTO public.roles (name, description, permissions)
VALUES ('Jefe de Distribución', 'Supervisa la operación de distribución y aprueba los gastos de viaje de la caja de transporte',
        '["dashboard","despacho:read","monitoreo:read","torre-control:read","caja","caja-gastos","caja-aprobacion","caja-liquidaciones"]'::jsonb)
ON CONFLICT (name) DO UPDATE
SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(public.roles.permissions, '[]'::jsonb) || EXCLUDED.permissions) p),
    description = COALESCE(public.roles.description, EXCLUDED.description);

-- ------------------------------------------------------------
-- 2. Catálogo de categorías y parámetros de caja
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_categories (
  code             text PRIMARY KEY,
  label            text NOT NULL,
  group_label      text NOT NULL DEFAULT 'Gastos de ruta',
  ledger_category  text NOT NULL CHECK (ledger_category IN ('OPERACION', 'COMBUSTIBLE', 'MANTENIMIENTO', 'NEUMATICOS')),
  requires_receipt boolean NOT NULL DEFAULT true,
  max_amount       numeric(12,2) CHECK (max_amount IS NULL OR max_amount > 0),
  is_active        boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 100
);
INSERT INTO public.expense_categories (code, label, group_label, ledger_category, requires_receipt, sort_order) VALUES
  ('COMBUSTIBLE',      'Combustible',                         'Gastos de ruta',            'COMBUSTIBLE',   true,  10),
  ('PEAJE',            'Peaje',                               'Gastos de ruta',            'OPERACION',     true,  20),
  ('ALIMENTACION',     'Alimentación',                        'Gastos de ruta',            'OPERACION',     false, 30),
  ('VIATICOS',         'Viáticos',                            'Gastos de ruta',            'OPERACION',     false, 31),
  ('HOSPEDAJE',        'Hospedaje',                           'Gastos de ruta',            'OPERACION',     true,  40),
  ('ESTACIONAMIENTO',  'Estacionamiento / Balanza',           'Gastos de ruta',            'OPERACION',     false, 50),
  ('LAVADO',           'Lavado de unidad',                    'Gastos de ruta',            'OPERACION',     true,  60),
  ('ALQUILER_EQUIPO',  'Alquiler de equipo (montacargas, grúa)', 'Maniobras y operaciones', 'OPERACION',     true,  70),
  ('CUADRILLA_ESTIBA', 'Cuadrilla / Estiba',                  'Maniobras y operaciones',   'OPERACION',     true,  80),
  ('MANIOBRAS',        'Otras maniobras',                     'Maniobras y operaciones',   'OPERACION',     true,  90),
  ('REPUESTOS',        'Repuestos / Reparación rápida',       'Mantenimiento en ruta',     'MANTENIMIENTO', true, 100),
  ('LLANTAS_PARCHADO', 'Parchado / Llantas',                  'Mantenimiento en ruta',     'NEUMATICOS',    true, 110),
  ('OTROS',            'Otros gastos',                        'Otros',                     'OPERACION',     true, 200)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.caja_settings (
  id                            boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Montos iguales o mayores requieren la confirmación del Administrador (NULL = desactivada)
  double_approval_threshold     numeric(12,2) CHECK (double_approval_threshold IS NULL OR double_approval_threshold > 0),
  -- Plazo para rendir un viaje tras el retorno; vencido, no se entregan nuevos anticipos
  settlement_due_hours          int NOT NULL DEFAULT 48 CHECK (settlement_due_hours > 0),
  -- Rendimiento de combustible: valor por defecto y tolerancia de la alerta
  default_km_per_gallon         numeric(8,2) NOT NULL DEFAULT 10 CHECK (default_km_per_gallon > 0),
  fuel_efficiency_tolerance_pct numeric(5,2) NOT NULL DEFAULT 25 CHECK (fuel_efficiency_tolerance_pct BETWEEN 1 AND 90),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
INSERT INTO public.caja_settings (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Grifos / estaciones (con o sin línea de crédito)
CREATE TABLE IF NOT EXISTS public.fuel_stations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruc           text,
  name          text NOT NULL,
  address       text,
  has_credit    boolean NOT NULL DEFAULT false,
  credit_limit  numeric(12,2) CHECK (credit_limit IS NULL OR credit_limit > 0),
  billing_cycle text NOT NULL DEFAULT 'MENSUAL' CHECK (billing_cycle IN ('SEMANAL', 'QUINCENAL', 'MENSUAL')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_stations_ruc_name ON public.fuel_stations (COALESCE(ruc, ''), upper(name));

-- Parámetros de combustible por unidad (alertas de rendimiento y tanque)
ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS fuel_tank_capacity_gal numeric(8,2) CHECK (fuel_tank_capacity_gal IS NULL OR fuel_tank_capacity_gal > 0),
  ADD COLUMN IF NOT EXISTS expected_km_per_gallon numeric(8,2) CHECK (expected_km_per_gallon IS NULL OR expected_km_per_gallon > 0);

-- ------------------------------------------------------------
-- 3. Gasto: comprobante, asignación y revisión en columnas propias
-- ------------------------------------------------------------
ALTER TABLE public.dispatch_expenses
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'APP',
  ADD COLUMN IF NOT EXISTS vehicle_plate        text,
  ADD COLUMN IF NOT EXISTS site_id              uuid REFERENCES public.sites(id),
  ADD COLUMN IF NOT EXISTS expense_date         date,
  ADD COLUMN IF NOT EXISTS currency             text NOT NULL DEFAULT 'PEN',
  ADD COLUMN IF NOT EXISTS document_type        text,
  ADD COLUMN IF NOT EXISTS document_series      text,
  ADD COLUMN IF NOT EXISTS document_number      text,
  ADD COLUMN IF NOT EXISTS provider_ruc         text,
  ADD COLUMN IF NOT EXISTS provider_name        text,
  ADD COLUMN IF NOT EXISTS is_billable          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transport_request_id uuid REFERENCES public.transport_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS original_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS approved_amount      numeric(12,2),
  ADD COLUMN IF NOT EXISTS review_comment       text,
  ADD COLUMN IF NOT EXISTS reviewed_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS first_approved_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_approved_at    timestamptz,
  ADD COLUMN IF NOT EXISTS alerts               jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fuel_station_id      uuid REFERENCES public.fuel_stations(id);

-- Un gasto puede ser de la unidad sin viaje (cargas en base, traslado a taller)
ALTER TABLE public.dispatch_expenses ALTER COLUMN dispatch_id DROP NOT NULL;

-- Datos existentes: el comprobante de Caja web venía dentro de la descripción
--   "Comprobante: FACTURA F001-123 | Prov: 20100070970 Razón | Refacturar: Sí | Sustento: ..."
UPDATE public.dispatch_expenses SET
  document_type   = NULLIF(substring(description FROM 'Comprobante: ([A-Z_]+) '), ''),
  document_series = NULLIF(upper(substring(description FROM 'Comprobante: [A-Z_]+ ([^ |-]*)-')), ''),
  document_number = NULLIF(substring(description FROM 'Comprobante: [A-Z_]+ [^ |-]*-([^ |]*)'), ''),
  provider_ruc    = NULLIF(substring(description FROM 'Prov: ([0-9]{8,11})'), ''),
  provider_name   = NULLIF(trim(substring(description FROM 'Prov: [0-9]* ?([^|]*)')), ''),
  is_billable     = description LIKE '%Refacturar: Sí%',
  source          = 'WEB',
  description     = COALESCE(NULLIF(trim(substring(description FROM 'Sustento: (.*)$')), ''), description)
WHERE description LIKE 'Comprobante: %| Prov:%';

UPDATE public.dispatch_expenses de SET vehicle_plate = d.vehicle_plate, site_id = d.site_id
FROM public.dispatches d WHERE d.id = de.dispatch_id AND de.vehicle_plate IS NULL;
UPDATE public.dispatch_expenses SET expense_date = (created_at AT TIME ZONE 'America/Lima')::date WHERE expense_date IS NULL;
UPDATE public.dispatch_expenses SET original_amount = amount WHERE original_amount IS NULL;
UPDATE public.dispatch_expenses SET approved_amount = amount WHERE status = 'APROBADO' AND approved_amount IS NULL;
UPDATE public.dispatch_expenses SET expense_type = upper(trim(expense_type)) WHERE expense_type <> upper(trim(expense_type));
-- Estados intermedios del flujo anterior: vuelven a la bandeja
UPDATE public.dispatch_expenses SET status = 'PENDIENTE' WHERE status IN ('BORRADOR', 'EN_REVISION');

ALTER TABLE public.dispatch_expenses ALTER COLUMN expense_date SET DEFAULT ((now() AT TIME ZONE 'America/Lima')::date);
ALTER TABLE public.dispatch_expenses ALTER COLUMN expense_date SET NOT NULL;
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_status_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_status_check
  CHECK (status IN ('PENDIENTE', 'OBSERVADO', 'APROBADO', 'RECHAZADO'));
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_source_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_source_check CHECK (source IN ('APP', 'WEB', 'SISTEMA'));
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_amount_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_amount_check CHECK (amount > 0) NOT VALID;
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_approved_amount_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_approved_amount_check
  CHECK (approved_amount IS NULL OR approved_amount >= 0);
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_asset_check;
ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_asset_check
  CHECK (dispatch_id IS NOT NULL OR vehicle_plate IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS dispatch_expenses_status_idx ON public.dispatch_expenses (status, expense_date DESC);
CREATE INDEX IF NOT EXISTS dispatch_expenses_dispatch_idx ON public.dispatch_expenses (dispatch_id);
CREATE INDEX IF NOT EXISTS dispatch_expenses_plate_idx ON public.dispatch_expenses (vehicle_plate, expense_date DESC);
-- Un comprobante (RUC + tipo + serie + número) se registra una sola vez, salvo que se haya rechazado
-- (si ya hubiera duplicados históricos, el trigger igual bloquea los nuevos y se informa)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.dispatch_expenses
             WHERE status <> 'RECHAZADO' AND provider_ruc IS NOT NULL AND document_type IS NOT NULL
               AND document_series IS NOT NULL AND document_number IS NOT NULL
             GROUP BY provider_ruc, document_type, upper(document_series), ltrim(document_number, '0') HAVING count(*) > 1) THEN
    RAISE NOTICE 'Hay comprobantes duplicados históricos: revise la bandeja de aprobación (índice único no creado)';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_expenses_receipt_unique
      ON public.dispatch_expenses (provider_ruc, document_type, upper(document_series), ltrim(document_number, '0'))
      WHERE status <> 'RECHAZADO' AND provider_ruc IS NOT NULL AND document_type IS NOT NULL
        AND document_series IS NOT NULL AND document_number IS NOT NULL;
  END IF;
END $$;

-- Historial de estados (inmutable)
CREATE TABLE IF NOT EXISTS public.dispatch_expense_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id  uuid NOT NULL REFERENCES public.dispatch_expenses(id) ON DELETE CASCADE,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  amount      numeric(12,2),
  comment     text,
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dispatch_expense_events_expense_idx ON public.dispatch_expense_events (expense_id, created_at);

-- ------------------------------------------------------------
-- 4. Validaciones y alertas automáticas
-- ------------------------------------------------------------
-- RUC peruano: 11 dígitos, prefijo válido y dígito verificador módulo 11
CREATE OR REPLACE FUNCTION public.is_valid_ruc(p_ruc text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  w int[] := ARRAY[5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  s int := 0;
  d int;
BEGIN
  IF p_ruc IS NULL OR p_ruc !~ '^(10|15|16|17|20)[0-9]{9}$' THEN RETURN false; END IF;
  FOR i IN 1..10 LOOP s := s + substr(p_ruc, i, 1)::int * w[i]; END LOOP;
  d := 11 - (s % 11);
  IF d = 10 THEN d := 0; ELSIF d = 11 THEN d := 1; END IF;
  RETURN d = substr(p_ruc, 11, 1)::int;
END $$;

-- El viaje tiene la liquidación cerrada (C2 la reemplaza cuando existen las liquidaciones)
CREATE OR REPLACE FUNCTION public.caja_trip_is_settled(p_dispatch_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT false;
$$;

-- Ventana del viaje: salida (o programación) − 1 día hasta el retorno + 1 día.
-- Se lee vía to_jsonb para tolerar los nombres de columna históricos de dispatches.
CREATE OR REPLACE FUNCTION public.caja_dispatch_window(p_dispatch_id uuid)
RETURNS TABLE (window_start date, window_end date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (COALESCE(NULLIF(j->>'departure_time', ''), NULLIF(j->>'scheduled_departure', ''), NULLIF(j->>'scheduled_date', ''), j->>'created_at')::timestamptz
            AT TIME ZONE 'America/Lima')::date - 1,
         CASE WHEN COALESCE(NULLIF(j->>'returned_at', ''), NULLIF(j->>'arrival_time', '')) IS NOT NULL
              THEN (COALESCE(NULLIF(j->>'returned_at', ''), j->>'arrival_time')::timestamptz AT TIME ZONE 'America/Lima')::date + 1 END
  FROM (SELECT to_jsonb(d) AS j FROM public.dispatches d WHERE d.id = p_dispatch_id) x;
$$;

-- Reglas adicionales (C3 las reemplaza con presupuesto y tarifario)
CREATE OR REPLACE FUNCTION public.caja_extra_expense_alerts(e public.dispatch_expenses)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT '[]'::jsonb $$;

CREATE OR REPLACE FUNCTION public.caja_compute_expense_alerts(e public.dispatch_expenses)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a        jsonb := '[]'::jsonb;
  cat      public.expense_categories%ROWTYPE;
  cfg      public.caja_settings%ROWTYPE;
  veh      public.vehicles%ROWTYPE;
  w_start  date;
  w_end    date;
  prev_odo numeric;
  kmpg     numeric;
  expected numeric;
BEGIN
  SELECT * INTO cfg FROM public.caja_settings WHERE id;
  SELECT * INTO cat FROM public.expense_categories WHERE code = e.expense_type;
  IF e.vehicle_plate IS NOT NULL THEN SELECT * INTO veh FROM public.vehicles WHERE plate = e.vehicle_plate; END IF;

  IF e.receipt_url IS NULL AND COALESCE(cat.requires_receipt, true) THEN
    a := a || jsonb_build_object('code', 'SIN_COMPROBANTE', 'level', 'ALTA', 'message', 'Gasto sin foto del comprobante');
  END IF;
  IF e.provider_ruc IS NOT NULL AND NOT public.is_valid_ruc(e.provider_ruc) THEN
    a := a || jsonb_build_object('code', 'RUC_INVALIDO', 'level', 'ALTA', 'message', 'El RUC ' || e.provider_ruc || ' no es válido');
  END IF;
  IF cat.max_amount IS NOT NULL AND e.amount > cat.max_amount THEN
    a := a || jsonb_build_object('code', 'MONTO_SOBRE_TOPE', 'level', 'MEDIA',
      'message', 'Supera el tope de ' || cat.label || ' (S/ ' || cat.max_amount || ')');
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_expenses o
             WHERE o.id <> e.id AND o.status <> 'RECHAZADO' AND o.expense_type = e.expense_type AND o.amount = e.amount
               AND o.expense_date = e.expense_date
               AND (o.dispatch_id = e.dispatch_id OR (e.dispatch_id IS NULL AND o.vehicle_plate = e.vehicle_plate))) THEN
    a := a || jsonb_build_object('code', 'POSIBLE_DUPLICADO', 'level', 'MEDIA',
      'message', 'Hay otro gasto del mismo tipo, monto y fecha en este viaje');
  END IF;
  IF e.dispatch_id IS NOT NULL THEN
    SELECT window_start, window_end INTO w_start, w_end FROM public.caja_dispatch_window(e.dispatch_id);
    IF (w_start IS NOT NULL AND e.expense_date < w_start) OR (w_end IS NOT NULL AND e.expense_date > w_end) THEN
      a := a || jsonb_build_object('code', 'FUERA_DE_VIAJE', 'level', 'ALTA', 'message', 'La fecha del gasto está fuera del periodo del viaje');
    END IF;
  END IF;

  IF e.expense_type = 'COMBUSTIBLE' THEN
    IF e.fuel_gallons IS NULL OR e.fuel_odometer IS NULL THEN
      a := a || jsonb_build_object('code', 'COMBUSTIBLE_INCOMPLETO', 'level', 'MEDIA', 'message', 'Carga sin galones u odómetro: no entra al rendimiento');
    ELSE
      IF veh.fuel_tank_capacity_gal IS NOT NULL AND e.fuel_gallons > veh.fuel_tank_capacity_gal THEN
        a := a || jsonb_build_object('code', 'GALONES_SOBRE_TANQUE', 'level', 'ALTA',
          'message', 'Galones (' || e.fuel_gallons || ') mayores a la capacidad del tanque (' || veh.fuel_tank_capacity_gal || ')');
      END IF;
      SELECT o.fuel_odometer INTO prev_odo FROM public.dispatch_expenses o
      WHERE o.id <> e.id AND o.vehicle_plate = e.vehicle_plate AND o.expense_type = 'COMBUSTIBLE'
        AND o.status <> 'RECHAZADO' AND o.fuel_odometer IS NOT NULL
        AND (o.expense_date, o.created_at) < (e.expense_date, COALESCE(e.created_at, now()))
      ORDER BY o.expense_date DESC, o.created_at DESC LIMIT 1;
      IF prev_odo IS NOT NULL AND e.fuel_odometer < prev_odo THEN
        a := a || jsonb_build_object('code', 'ODOMETRO_RETROCEDE', 'level', 'ALTA',
          'message', 'Odómetro ' || e.fuel_odometer || ' menor a la carga anterior (' || prev_odo || ')');
      ELSIF prev_odo IS NOT NULL AND e.fuel_gallons > 0 THEN
        -- Rendimiento del tramo anterior: km recorridos desde la carga previa / galones repuestos
        kmpg := round((e.fuel_odometer - prev_odo) / e.fuel_gallons, 2);
        expected := COALESCE(veh.expected_km_per_gallon, cfg.default_km_per_gallon);
        IF kmpg < expected * (1 - cfg.fuel_efficiency_tolerance_pct / 100) OR kmpg > expected * (1 + cfg.fuel_efficiency_tolerance_pct / 100) THEN
          a := a || jsonb_build_object('code', 'RENDIMIENTO_ANORMAL', 'level', 'ALTA',
            'message', 'Rendimiento ' || kmpg || ' km/gal fuera de lo esperado (' || expected || ' ± ' || cfg.fuel_efficiency_tolerance_pct || '%)');
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN a || public.caja_extra_expense_alerts(e);
END $$;

-- ------------------------------------------------------------
-- 5. Reglas del registro (triggers)
-- ------------------------------------------------------------
-- Las RPC de revisión marcan la transacción; fuera de ellas nadie cambia estado ni revisión.
CREATE OR REPLACE FUNCTION public.caja_in_review()
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('caja.review', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION public.caja_expense_normalize()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d   record;
  dup record;
BEGIN
  NEW.expense_type    := upper(trim(NEW.expense_type));
  NEW.document_type   := NULLIF(upper(trim(NEW.document_type)), '');
  NEW.document_series := NULLIF(upper(trim(NEW.document_series)), '');
  NEW.document_number := NULLIF(trim(NEW.document_number), '');
  NEW.provider_ruc    := NULLIF(regexp_replace(COALESCE(NEW.provider_ruc, ''), '[^0-9]', '', 'g'), '');
  NEW.provider_name   := NULLIF(trim(NEW.provider_name), '');
  NEW.vehicle_plate   := NULLIF(upper(trim(NEW.vehicle_plate)), '');
  NEW.expense_date    := COALESCE(NEW.expense_date, (now() AT TIME ZONE 'America/Lima')::date);
  NEW.updated_at      := now();

  IF NEW.fuel_station_id IS NOT NULL AND NEW.provider_ruc IS NULL THEN
    SELECT ruc, COALESCE(NEW.provider_name, name) INTO NEW.provider_ruc, NEW.provider_name FROM public.fuel_stations WHERE id = NEW.fuel_station_id;
  END IF;

  IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RAISE EXCEPTION 'El importe del gasto debe ser mayor a 0';
  END IF;
  IF NEW.expense_type = 'COMBUSTIBLE' AND (NEW.fuel_gallons IS NOT NULL AND NEW.fuel_gallons <= 0) THEN
    RAISE EXCEPTION 'La cantidad de galones debe ser mayor a 0';
  END IF;
  IF NEW.expense_date > (now() AT TIME ZONE 'America/Lima')::date + 1 THEN
    RAISE EXCEPTION 'La fecha del gasto no puede ser futura';
  END IF;

  IF NEW.dispatch_id IS NOT NULL THEN
    SELECT id, vehicle_plate, site_id, driver_id INTO d FROM public.dispatches WHERE id = NEW.dispatch_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Despacho no encontrado'; END IF;
    NEW.vehicle_plate := COALESCE(NEW.vehicle_plate, upper(d.vehicle_plate));
    NEW.site_id := d.site_id;
    IF TG_OP = 'INSERT' THEN NEW.driver_id := COALESCE(NEW.driver_id, d.driver_id); END IF;
    IF public.caja_trip_is_settled(NEW.dispatch_id) AND NOT public.caja_in_review() THEN
      RAISE EXCEPTION 'El viaje ya fue liquidado: no admite gastos nuevos ni cambios';
    END IF;
  ELSIF NEW.vehicle_plate IS NOT NULL THEN
    SELECT site_id INTO NEW.site_id FROM public.vehicles WHERE plate = NEW.vehicle_plate;
    IF NOT FOUND THEN RAISE EXCEPTION 'Placa no registrada: %', NEW.vehicle_plate; END IF;
  ELSE
    RAISE EXCEPTION 'Indique el despacho o la placa de la unidad';
  END IF;

  IF NEW.provider_ruc IS NOT NULL AND NEW.document_type IS NOT NULL AND NEW.document_series IS NOT NULL AND NEW.document_number IS NOT NULL THEN
    SELECT o.expense_date, o.status INTO dup FROM public.dispatch_expenses o
    WHERE o.id <> NEW.id AND o.status <> 'RECHAZADO' AND o.provider_ruc = NEW.provider_ruc AND o.document_type = NEW.document_type
      AND upper(o.document_series) = NEW.document_series AND ltrim(o.document_number, '0') = ltrim(NEW.document_number, '0')
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Comprobante duplicado: % %-% del RUC % ya fue registrado el % (%)',
        NEW.document_type, NEW.document_series, NEW.document_number, NEW.provider_ruc, to_char(dup.expense_date, 'DD/MM/YYYY'), dup.status;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, auth.uid());
    IF NOT public.caja_in_review() THEN
      NEW.status := 'PENDIENTE';
      NEW.approved_amount := NULL; NEW.review_comment := NULL; NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
      NEW.first_approved_by := NULL; NEW.first_approved_at := NULL;
    END IF;
    NEW.original_amount := NEW.amount;
  ELSIF NOT public.caja_in_review() THEN
    -- Corrección directa (conductor o registrador): solo mientras esté pendiente u observado
    IF OLD.status NOT IN ('PENDIENTE', 'OBSERVADO') THEN
      RAISE EXCEPTION 'El gasto ya fue revisado (%): no se puede modificar', OLD.status;
    END IF;
    NEW.status := CASE WHEN OLD.status = 'OBSERVADO' THEN 'PENDIENTE' ELSE OLD.status END;
    NEW.created_by := OLD.created_by; NEW.created_at := OLD.created_at; NEW.driver_id := OLD.driver_id;
    NEW.dispatch_id := OLD.dispatch_id; NEW.source := OLD.source;
    NEW.approved_amount := OLD.approved_amount; NEW.reviewed_by := OLD.reviewed_by; NEW.reviewed_at := OLD.reviewed_at;
    NEW.review_comment := OLD.review_comment;
    -- Un cambio de importe invalida la pre-aprobación
    IF NEW.amount <> OLD.amount OR OLD.status = 'OBSERVADO' THEN
      NEW.first_approved_by := NULL; NEW.first_approved_at := NULL;
    ELSE
      NEW.first_approved_by := OLD.first_approved_by; NEW.first_approved_at := OLD.first_approved_at;
    END IF;
    NEW.original_amount := NEW.amount;
  END IF;

  NEW.alerts := public.caja_compute_expense_alerts(NEW);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_caja_expense_normalize ON public.dispatch_expenses;
CREATE TRIGGER trg_caja_expense_normalize BEFORE INSERT OR UPDATE ON public.dispatch_expenses
FOR EACH ROW EXECUTE FUNCTION public.caja_expense_normalize();

CREATE OR REPLACE FUNCTION public.caja_expense_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.dispatch_expense_events (expense_id, action, to_status, amount, comment, actor_id)
    VALUES (NEW.id, 'REGISTRADO', NEW.status, NEW.amount, NULL, COALESCE(auth.uid(), NEW.created_by));
  ELSIF NOT public.caja_in_review() AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.receipt_url IS DISTINCT FROM OLD.receipt_url OR NEW.description IS DISTINCT FROM OLD.description) THEN
    INSERT INTO public.dispatch_expense_events (expense_id, action, from_status, to_status, amount, actor_id)
    VALUES (NEW.id, CASE WHEN OLD.status = 'OBSERVADO' THEN 'CORREGIDO' ELSE 'EDITADO' END, OLD.status, NEW.status, NEW.amount, auth.uid());
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_caja_expense_log ON public.dispatch_expenses;
CREATE TRIGGER trg_caja_expense_log AFTER INSERT OR UPDATE ON public.dispatch_expenses
FOR EACH ROW EXECUTE FUNCTION public.caja_expense_log();

-- Los gastos no se borran: se rechazan (queda el rastro)
CREATE OR REPLACE FUNCTION public.caja_expense_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'PENDIENTE' AND current_setting('caja.allow_delete', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Un gasto revisado no se elimina: recházelo o reviértalo';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS trg_caja_expense_no_delete ON public.dispatch_expenses;
CREATE TRIGGER trg_caja_expense_no_delete BEFORE DELETE ON public.dispatch_expenses
FOR EACH ROW EXECUTE FUNCTION public.caja_expense_no_delete();

-- Recalcula las alertas de los gastos existentes (sin pasar por las reglas de edición)
DO $$ BEGIN
  PERFORM set_config('caja.review', 'on', true);
  UPDATE public.dispatch_expenses SET alerts = public.caja_compute_expense_alerts(dispatch_expenses) WHERE status IN ('PENDIENTE', 'OBSERVADO');
  PERFORM set_config('caja.review', '', true);
END $$;

-- ------------------------------------------------------------
-- 6. Revisión: aprobar, observar, rechazar, revertir
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_dispatch_expense(
  p_expense_id      uuid,
  p_action          text,
  p_comment         text DEFAULT NULL,
  p_approved_amount numeric DEFAULT NULL,
  p_ack_alerts      boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e          public.dispatch_expenses%ROWTYPE;
  cfg        public.caja_settings%ROWTYPE;
  v_action   text := upper(trim(p_action));
  v_comment  text := NULLIF(trim(p_comment), '');
  v_amount   numeric;
  v_admin    boolean := public.is_tms_admin();
  v_to       text;
  v_event    text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('caja-aprobacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador o el Jefe de Distribución aprueban gastos');
  END IF;
  SELECT * INTO e FROM public.dispatch_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Gasto no encontrado'); END IF;
  IF NOT v_admin AND e.site_id IS NOT NULL AND NOT public.can_access_site(e.site_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El gasto pertenece a otra sede');
  END IF;
  IF e.created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = e.driver_id AND dr.profile_id = auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No puede revisar un gasto registrado por usted: lo revisa otro aprobador o el Administrador');
  END IF;
  IF e.dispatch_id IS NOT NULL AND public.caja_trip_is_settled(e.dispatch_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El viaje ya fue liquidado: reabra la liquidación para revisar el gasto');
  END IF;
  SELECT * INTO cfg FROM public.caja_settings WHERE id;

  IF v_action IN ('APROBAR', 'AJUSTAR') THEN
    IF e.status <> 'PENDIENTE' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se aprueban gastos pendientes (estado actual: ' || e.status || ')');
    END IF;
    v_amount := round(COALESCE(p_approved_amount, e.approved_amount, e.amount), 2);
    IF v_amount <= 0 OR v_amount > e.amount THEN
      RETURN jsonb_build_object('success', false, 'error', 'El monto aprobado debe ser mayor a 0 y no superar el importe del comprobante (S/ ' || e.amount || ')');
    END IF;
    IF v_amount < e.amount AND v_comment IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del ajuste de monto');
    END IF;
    IF jsonb_array_length(e.alerts) > 0 AND NOT p_ack_alerts THEN
      RETURN jsonb_build_object('success', false, 'error', 'El gasto tiene alertas: confirme que las revisó', 'alerts', e.alerts);
    END IF;
    -- Doble aprobación: sobre el umbral aprueba el Jefe y confirma el Administrador
    IF cfg.double_approval_threshold IS NOT NULL AND v_amount >= cfg.double_approval_threshold AND NOT v_admin THEN
      IF e.first_approved_by IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Ya tiene la primera aprobación: falta la confirmación del Administrador');
      END IF;
      PERFORM set_config('caja.review', 'on', true);
      UPDATE public.dispatch_expenses SET first_approved_by = auth.uid(), first_approved_at = now(), approved_amount = v_amount,
        review_comment = COALESCE(v_comment, review_comment)
      WHERE id = e.id;
      INSERT INTO public.dispatch_expense_events (expense_id, action, from_status, to_status, amount, comment)
      VALUES (e.id, 'PRE_APROBADO', e.status, 'PENDIENTE', v_amount, v_comment);
      PERFORM set_config('caja.review', '', true);
      RETURN jsonb_build_object('success', true, 'status', 'PENDIENTE', 'requires_admin', true,
        'message', 'Primera aprobación registrada: el Administrador debe confirmarla (monto ≥ S/ ' || cfg.double_approval_threshold || ')');
    END IF;
    IF e.first_approved_by = auth.uid() THEN
      RETURN jsonb_build_object('success', false, 'error', 'La confirmación debe hacerla un usuario distinto al primer aprobador');
    END IF;
    v_to := 'APROBADO';
    v_event := CASE WHEN v_amount < e.amount THEN 'AJUSTADO' ELSE 'APROBADO' END;
  ELSIF v_action = 'OBSERVAR' THEN
    IF e.status <> 'PENDIENTE' THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se observan gastos pendientes');
    END IF;
    IF v_comment IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la observación'); END IF;
    v_to := 'OBSERVADO'; v_event := 'OBSERVADO';
  ELSIF v_action = 'RECHAZAR' THEN
    IF e.status NOT IN ('PENDIENTE', 'OBSERVADO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se rechazan gastos pendientes u observados');
    END IF;
    IF v_comment IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo del rechazo'); END IF;
    v_to := 'RECHAZADO'; v_event := 'RECHAZADO'; v_amount := 0;
  ELSIF v_action = 'REVERTIR' THEN
    IF NOT v_admin THEN RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador revierte una revisión'); END IF;
    IF e.status NOT IN ('APROBADO', 'RECHAZADO') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo se revierten gastos aprobados o rechazados');
    END IF;
    IF v_comment IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la reversión'); END IF;
    PERFORM set_config('caja.review', 'on', true);
    UPDATE public.dispatch_expenses SET status = 'PENDIENTE', approved_amount = NULL, reviewed_by = NULL, reviewed_at = NULL,
      first_approved_by = NULL, first_approved_at = NULL, review_comment = v_comment
    WHERE id = e.id;
    INSERT INTO public.dispatch_expense_events (expense_id, action, from_status, to_status, amount, comment)
    VALUES (e.id, 'REVERTIDO', e.status, 'PENDIENTE', e.amount, v_comment);
    PERFORM set_config('caja.review', '', true);
    RETURN jsonb_build_object('success', true, 'status', 'PENDIENTE');
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Acción no válida: ' || COALESCE(p_action, ''));
  END IF;

  PERFORM set_config('caja.review', 'on', true);
  UPDATE public.dispatch_expenses SET status = v_to,
    approved_amount = CASE WHEN v_to = 'APROBADO' THEN v_amount WHEN v_to = 'RECHAZADO' THEN 0 ELSE NULL END,
    review_comment = v_comment, reviewed_by = auth.uid(), reviewed_at = now(),
    first_approved_by = CASE WHEN v_to = 'APROBADO' THEN first_approved_by END,
    first_approved_at = CASE WHEN v_to = 'APROBADO' THEN first_approved_at END
  WHERE id = e.id;
  INSERT INTO public.dispatch_expense_events (expense_id, action, from_status, to_status, amount, comment)
  VALUES (e.id, v_event, e.status, v_to, COALESCE(v_amount, e.amount), v_comment);
  PERFORM set_config('caja.review', '', true);
  RETURN jsonb_build_object('success', true, 'status', v_to, 'approved_amount', CASE WHEN v_to = 'APROBADO' THEN v_amount END);
END $$;

-- Aprobación en lote: solo gastos sin alertas; devuelve los omitidos con su motivo
CREATE OR REPLACE FUNCTION public.approve_dispatch_expenses(p_expense_ids uuid[], p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id      uuid;
  r         jsonb;
  v_ok      int := 0;
  v_pending int := 0;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.has_tms_permission('caja-aprobacion') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador o el Jefe de Distribución aprueban gastos');
  END IF;
  FOREACH v_id IN ARRAY COALESCE(p_expense_ids, '{}') LOOP
    IF EXISTS (SELECT 1 FROM public.dispatch_expenses WHERE id = v_id AND jsonb_array_length(alerts) > 0) THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'error', 'Tiene alertas: revíselo individualmente');
      CONTINUE;
    END IF;
    r := public.review_dispatch_expense(v_id, 'APROBAR', p_comment, NULL, false);
    IF (r->>'success')::boolean AND r->>'status' = 'APROBADO' THEN v_ok := v_ok + 1;
    ELSIF (r->>'success')::boolean THEN v_pending := v_pending + 1;
    ELSE v_skipped := v_skipped || jsonb_build_object('id', v_id, 'error', r->>'error');
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'approved', v_ok, 'pre_approved', v_pending, 'skipped', v_skipped);
END $$;

CREATE OR REPLACE FUNCTION public.update_caja_settings(
  p_double_approval_threshold numeric, p_settlement_due_hours int,
  p_default_km_per_gallon numeric, p_fuel_efficiency_tolerance_pct numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_tms_admin() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Administrador cambia los parámetros de caja');
  END IF;
  UPDATE public.caja_settings SET
    double_approval_threshold = NULLIF(p_double_approval_threshold, 0),
    settlement_due_hours = COALESCE(p_settlement_due_hours, settlement_due_hours),
    default_km_per_gallon = COALESCE(p_default_km_per_gallon, default_km_per_gallon),
    fuel_efficiency_tolerance_pct = COALESCE(p_fuel_efficiency_tolerance_pct, fuel_efficiency_tolerance_pct),
    updated_at = now(), updated_by = auth.uid()
  WHERE id;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 7. Combustible: una sola regla para la app y la web
-- ------------------------------------------------------------
-- La versión anterior escribía vehicle_odometer_logs.vehicle_id (la tabla usa vehicle_plate)
-- y no validaba quién registraba.
CREATE OR REPLACE FUNCTION public.register_fuel_load(
  p_amount              numeric,
  p_gallons             numeric,
  p_odometer            numeric,
  p_dispatch_id         uuid DEFAULT NULL,
  p_vehicle_plate       text DEFAULT NULL,
  p_driver_id           uuid DEFAULT NULL,
  p_receipt_url         text DEFAULT NULL,
  p_description         text DEFAULT NULL,
  p_client_operation_id uuid DEFAULT NULL,
  p_expense_date        date DEFAULT NULL,
  p_document            jsonb DEFAULT '{}'::jsonb,
  p_source              text DEFAULT 'APP'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_plate   text;
  v_driver  uuid := p_driver_id;
  v_id      uuid;
  v_current numeric;
  v_is_drv  boolean;
BEGIN
  IF p_gallons IS NULL OR p_gallons <= 0 THEN RAISE EXCEPTION 'La cantidad de galones debe ser mayor a 0'; END IF;
  IF p_odometer IS NULL OR p_odometer < 0 THEN RAISE EXCEPTION 'Ingrese un odómetro válido'; END IF;
  IF p_client_operation_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.dispatch_expenses WHERE client_operation_id = p_client_operation_id;
    IF FOUND THEN RETURN v_id; END IF;  -- reintento de sincronización offline
  END IF;

  IF p_dispatch_id IS NOT NULL THEN
    SELECT upper(vehicle_plate), COALESCE(v_driver, driver_id) INTO v_plate, v_driver FROM public.dispatches WHERE id = p_dispatch_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Despacho no encontrado'; END IF;
  ELSE
    v_plate := upper(trim(p_vehicle_plate));
  END IF;
  IF v_plate IS NULL OR NOT EXISTS (SELECT 1 FROM public.vehicles WHERE plate = v_plate) THEN
    RAISE EXCEPTION 'Unidad no registrada';
  END IF;

  -- Registra el conductor del viaje (a su nombre) o el personal de caja
  v_is_drv := EXISTS (SELECT 1 FROM public.drivers WHERE id = v_driver AND profile_id = auth.uid())
              AND EXISTS (SELECT 1 FROM public.dispatches WHERE id = p_dispatch_id AND driver_id = v_driver);
  IF auth.uid() IS NOT NULL AND NOT v_is_drv AND NOT public.has_tms_permission('caja-gastos') THEN
    RAISE EXCEPTION 'No autorizado para registrar combustible de esta unidad';
  END IF;

  INSERT INTO public.dispatch_expenses (
    dispatch_id, vehicle_plate, driver_id, expense_type, amount, description, receipt_url, fuel_gallons, fuel_odometer,
    client_operation_id, expense_date, source, created_by,
    document_type, document_series, document_number, provider_ruc, provider_name, is_billable, fuel_station_id
  ) VALUES (
    p_dispatch_id, v_plate, v_driver, 'COMBUSTIBLE', p_amount, COALESCE(NULLIF(trim(p_description), ''), 'Carga de combustible'), p_receipt_url,
    p_gallons, p_odometer, p_client_operation_id, p_expense_date,
    CASE WHEN upper(p_source) IN ('APP', 'WEB') THEN upper(p_source) ELSE 'APP' END, auth.uid(),
    p_document->>'document_type', p_document->>'document_series', p_document->>'document_number',
    p_document->>'provider_ruc', p_document->>'provider_name', COALESCE((p_document->>'is_billable')::boolean, false),
    NULLIF(p_document->>'fuel_station_id', '')::uuid
  ) RETURNING id INTO v_id;

  SELECT COALESCE(current_odometer, 0) INTO v_current FROM public.vehicles WHERE plate = v_plate FOR UPDATE;
  INSERT INTO public.vehicle_odometer_logs (vehicle_plate, driver_id, dispatch_id, odometer_value, photo_url, source_event, status, notes, created_by)
  VALUES (v_plate, v_driver, p_dispatch_id, p_odometer, p_receipt_url, 'COMBUSTIBLE',
          CASE WHEN p_odometer < v_current THEN 'REQUIERE_AUDITORIA' ELSE 'VALIDADO' END,
          CASE WHEN p_odometer < v_current THEN 'Carga de combustible con odómetro menor al actual (' || v_current || ')' END, auth.uid());
  IF p_odometer >= v_current THEN
    UPDATE public.vehicles SET current_odometer = p_odometer, updated_at = now() WHERE plate = v_plate;
  END IF;
  RETURN v_id;
END $$;

-- Firma usada por la app del conductor y la sincronización offline (APK instalados)
CREATE OR REPLACE FUNCTION public.register_fuel_expense(
  p_dispatch_id uuid, p_driver_id uuid, p_amount numeric, p_gallons numeric, p_odometer numeric,
  p_receipt_url text, p_description text, p_client_operation_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.register_fuel_load(p_amount, p_gallons, p_odometer, p_dispatch_id, NULL, p_driver_id,
                                   p_receipt_url, p_description, p_client_operation_id, NULL, '{}'::jsonb, 'APP');
$$;

-- ------------------------------------------------------------
-- 8. Libro de costos: categoría del catálogo y monto aprobado; gastos sin viaje por placa
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_vehicle_cost_ledger
WITH (security_invoker = true) AS
SELECT wo.vehicle_id, c.created_at AS cost_date, 'MANTENIMIENTO'::text AS category,
       CASE c.cost_type WHEN 'MANO_OBRA' THEN 'Mano de obra' WHEN 'REPUESTOS' THEN 'Repuestos' WHEN 'SERVICIOS' THEN 'Servicios externos' ELSE 'Otros' END AS subcategory,
       c.amount, 'OT ' || wo.ot_code AS reference, wo.id AS ref_id
FROM public.work_order_costs c JOIN public.maintenance_work_orders wo ON wo.id = c.work_order_id
WHERE wo.status <> 'CANCELADA'
UNION ALL
SELECT v.id, COALESCE(de.expense_date::timestamp AT TIME ZONE 'America/Lima', de.created_at),
       COALESCE(ec.ledger_category,
                CASE WHEN upper(de.expense_type) IN ('COMBUSTIBLE', 'FUEL', 'DIESEL', 'GASOLINA') THEN 'COMBUSTIBLE' ELSE 'OPERACION' END),
       de.expense_type, COALESCE(de.approved_amount, de.amount),
       COALESCE('Despacho ' || d.dispatch_number, 'Gasto directo ' || v.plate), de.id
FROM public.dispatch_expenses de
LEFT JOIN public.dispatches d ON d.id = de.dispatch_id
JOIN public.vehicles v ON v.plate = COALESCE(de.vehicle_plate, d.vehicle_plate)
LEFT JOIN public.expense_categories ec ON ec.code = upper(de.expense_type)
WHERE de.status = 'APROBADO' AND COALESCE(de.approved_amount, de.amount) > 0
UNION ALL
-- Neumáticos: km recorridos en la unidad × costo por km del neumático (compra + reencauches)
SELECT m.vehicle_id, m.created_at, 'NEUMATICOS', t.codigo_interno, round(m.km_accumulated * tr.cost_per_km, 2), 'Neumático ' || t.codigo_interno, m.id
FROM public.tire_movements m JOIN public.tires t ON t.id = m.tire_id JOIN public.vw_tires tr ON tr.id = t.id
WHERE m.km_accumulated > 0 AND m.vehicle_id IS NOT NULL AND tr.cost_per_km IS NOT NULL
UNION ALL
SELECT f.vehicle_id, COALESCE(f.paid_at::timestamptz, f.updated_at), 'MULTAS', f.entity, COALESCE(f.paid_amount, f.amount), f.entity || ' ' || f.ticket_number, f.id
FROM public.traffic_fines f WHERE f.status = 'PAGADA' AND f.responsibility = 'EMPRESA'
UNION ALL
SELECT i.vehicle_id, i.occurred_at, 'SINIESTROS', i.incident_type, GREATEST(COALESCE(i.final_cost, i.estimated_cost, 0) - i.insurance_coverage, 0),
       'Siniestro ' || to_char(i.occurred_at, 'DD/MM/YYYY'), i.id
FROM public.vehicle_incidents i WHERE i.responsibility IN ('EMPRESA', 'CONDUCTOR', 'POR_DETERMINAR')
UNION ALL
SELECT s.vehicle_id, s.period_end::timestamptz, 'ALQUILER', 'Liquidación ' || c.contract_code, s.subtotal,
       c.contract_code || ' ' || to_char(s.period_start, 'DD/MM') || '–' || to_char(s.period_end, 'DD/MM/YYYY'), s.id
FROM public.lease_settlements s JOIN public.vehicle_lease_contracts c ON c.id = s.contract_id
WHERE s.status = 'APROBADA';

-- ------------------------------------------------------------
-- 9. RLS: registrar ≠ aprobar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_caja_read_access()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.has_tms_read_permission('caja') OR public.has_tms_read_permission('caja-gastos')
      OR public.has_tms_read_permission('caja-aprobacion') OR public.has_tms_read_permission('caja-liquidaciones')
      OR public.has_tms_read_permission('caja-fondos');
$$;

DROP POLICY IF EXISTS dispatch_expenses_own_read ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_own_insert ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_staff_update ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_read ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_insert ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_correct ON public.dispatch_expenses;
DROP POLICY IF EXISTS dispatch_expenses_delete ON public.dispatch_expenses;
ALTER TABLE public.dispatch_expenses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_expenses FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dispatch_expenses TO authenticated;

CREATE POLICY dispatch_expenses_read ON public.dispatch_expenses FOR SELECT TO authenticated
  USING (created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid())
    OR ((site_id IS NULL OR public.can_access_site(site_id)) AND (public.has_caja_read_access() OR public.has_tms_read_permission('despacho')))
    -- El TCO de mantenimiento lee los gastos aprobados de la unidad
    OR (status = 'APROBADO' AND (site_id IS NULL OR public.can_access_site(site_id)) AND public.has_cmms_read_permission('dashboard')));
-- Registra el conductor del viaje (a su nombre) o el personal de caja
CREATE POLICY dispatch_expenses_insert ON public.dispatch_expenses FOR INSERT TO authenticated
  WITH CHECK ((created_by = auth.uid() AND EXISTS (SELECT 1 FROM public.drivers d JOIN public.dispatches s ON s.driver_id = d.id
                WHERE d.id = driver_id AND d.profile_id = auth.uid() AND s.id = dispatch_id))
    OR public.has_tms_permission('caja-gastos'));
-- Corrección de un gasto pendiente u observado por quien lo registró (el trigger protege estado y revisión)
CREATE POLICY dispatch_expenses_correct ON public.dispatch_expenses FOR UPDATE TO authenticated
  USING (status IN ('PENDIENTE', 'OBSERVADO') AND (created_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid())))
  WITH CHECK (created_by = auth.uid() OR EXISTS (SELECT 1 FROM public.drivers d WHERE d.id = driver_id AND d.profile_id = auth.uid()));
-- Anular un registro propio aún no revisado
CREATE POLICY dispatch_expenses_delete ON public.dispatch_expenses FOR DELETE TO authenticated
  USING (status = 'PENDIENTE' AND created_by = auth.uid() AND first_approved_by IS NULL);

-- Nombres de conductores y usuarios para Caja (drivers guarda el PIN y profiles solo es legible por su dueño)
CREATE OR REPLACE VIEW public.vw_caja_people WITH (security_barrier = true) AS
SELECT 'CONDUCTOR'::text AS kind, d.id, d.profile_id, trim(COALESCE(d.first_name, '') || ' ' || COALESCE(d.last_name, '')) AS full_name
FROM public.drivers d WHERE public.has_caja_read_access()
UNION ALL
SELECT 'USUARIO', p.id, p.id, trim(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, ''))
FROM public.profiles p WHERE public.has_caja_read_access();
REVOKE ALL ON public.vw_caja_people FROM anon, authenticated;
GRANT SELECT ON public.vw_caja_people TO authenticated;

-- Viajes y unidades para registrar/asignar gastos (Caja no lee el maestro de flota ni las OT de despacho)
CREATE OR REPLACE VIEW public.vw_caja_trips WITH (security_barrier = true) AS
SELECT d.id, d.dispatch_number, upper(d.vehicle_plate) AS vehicle_plate, d.status, d.driver_id, d.site_id, d.created_at,
       COALESCE(NULLIF(to_jsonb(d)->>'departure_time', ''), NULLIF(to_jsonb(d)->>'scheduled_departure', ''), to_jsonb(d)->>'scheduled_date')::timestamptz AS departure_at,
       COALESCE(NULLIF(to_jsonb(d)->>'returned_at', ''), NULLIF(to_jsonb(d)->>'arrival_time', ''))::timestamptz AS returned_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', tr.id, 'label', COALESCE(tr.requester_name, 'OT ' || left(tr.id::text, 8))))
                 FROM public.dispatch_requests dr JOIN public.transport_requests tr ON tr.id = dr.transport_request_id
                 WHERE dr.dispatch_id = d.id), '[]'::jsonb) AS requests,
       NULLIF(to_jsonb(d)->>'freight_cost', '')::numeric AS freight,
       COALESCE(NULLIF(to_jsonb(d)->>'actual_distance_km', ''), NULLIF(to_jsonb(d)->>'estimated_km', ''), NULLIF(to_jsonb(d)->>'estimated_distance_km', ''))::numeric AS km,
       NULLIF(to_jsonb(d)->>'contract_id', '')::uuid AS contract_id
FROM public.dispatches d
WHERE public.has_caja_read_access() AND public.can_access_site(d.site_id);
REVOKE ALL ON public.vw_caja_trips FROM anon, authenticated;
GRANT SELECT ON public.vw_caja_trips TO authenticated;

CREATE OR REPLACE VIEW public.vw_caja_units WITH (security_barrier = true) AS
SELECT v.id, v.plate, v.internal_code, v.type, v.site_id, v.current_odometer, v.fuel_tank_capacity_gal, v.expected_km_per_gallon
FROM public.vehicles v
WHERE public.has_caja_read_access() AND public.can_access_site(v.site_id);
REVOKE ALL ON public.vw_caja_units FROM anon, authenticated;
GRANT SELECT ON public.vw_caja_units TO authenticated;

ALTER TABLE public.dispatch_expense_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dispatch_expense_events FROM anon, authenticated;
GRANT SELECT ON public.dispatch_expense_events TO authenticated;
DROP POLICY IF EXISTS dispatch_expense_events_read ON public.dispatch_expense_events;
CREATE POLICY dispatch_expense_events_read ON public.dispatch_expense_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.dispatch_expenses e WHERE e.id = expense_id));

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.expense_categories FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.expense_categories TO authenticated;
DROP POLICY IF EXISTS expense_categories_read ON public.expense_categories;
DROP POLICY IF EXISTS expense_categories_admin ON public.expense_categories;
CREATE POLICY expense_categories_read ON public.expense_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY expense_categories_admin ON public.expense_categories FOR ALL TO authenticated
  USING (public.is_tms_admin()) WITH CHECK (public.is_tms_admin());

ALTER TABLE public.fuel_stations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fuel_stations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.fuel_stations TO authenticated;
DROP POLICY IF EXISTS fuel_stations_read ON public.fuel_stations;
DROP POLICY IF EXISTS fuel_stations_write ON public.fuel_stations;
CREATE POLICY fuel_stations_read ON public.fuel_stations FOR SELECT TO authenticated USING (true);
CREATE POLICY fuel_stations_write ON public.fuel_stations FOR ALL TO authenticated
  USING (public.is_tms_admin() OR public.has_tms_permission('caja-combustible'))
  WITH CHECK (public.is_tms_admin() OR public.has_tms_permission('caja-combustible'));

ALTER TABLE public.caja_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.caja_settings FROM anon, authenticated;
GRANT SELECT ON public.caja_settings TO authenticated;
DROP POLICY IF EXISTS caja_settings_read ON public.caja_settings;
CREATE POLICY caja_settings_read ON public.caja_settings FOR SELECT TO authenticated USING (true);

-- ------------------------------------------------------------
-- 10. Comprobantes: bucket privado para Caja web; los aprobadores leen las fotos del conductor
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('caja_receipts', 'caja_receipts', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE SET public = false;
DROP POLICY IF EXISTS caja_receipts_upload ON storage.objects;
DROP POLICY IF EXISTS caja_receipts_read ON storage.objects;
DROP POLICY IF EXISTS caja_receipts_delete ON storage.objects;
DROP POLICY IF EXISTS driver_evidence_caja_read ON storage.objects;
CREATE POLICY caja_receipts_upload ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'caja_receipts' AND (storage.foldername(name))[1] = auth.uid()::text AND public.has_tms_permission('caja-gastos'));
CREATE POLICY caja_receipts_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'caja_receipts' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.has_caja_read_access()));
CREATE POLICY caja_receipts_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'caja_receipts' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY driver_evidence_caja_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'driver_evidence' AND public.has_caja_read_access());

-- ------------------------------------------------------------
-- 11. Permisos de ejecución
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.review_dispatch_expense(uuid, text, text, numeric, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_dispatch_expenses(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_caja_settings(numeric, int, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_fuel_load(numeric, numeric, numeric, uuid, text, uuid, text, text, uuid, date, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.caja_compute_expense_alerts(public.dispatch_expenses) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_extra_expense_alerts(public.dispatch_expenses) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_dispatch_window(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.caja_trip_is_settled(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_caja_read_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_dispatch_expense(uuid, text, text, numeric, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_dispatch_expenses(uuid[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_caja_settings(numeric, int, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_fuel_load(numeric, numeric, numeric, uuid, text, uuid, text, text, uuid, date, jsonb, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.caja_trip_is_settled(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_caja_read_access() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_ruc(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
