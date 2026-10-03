-- ============================================================
-- Eficiencia de Flota: costo, uso y reemplazo de unidades de transporte, montacargas y equipos de elevación
-- ============================================================
-- Fuentes:
--   * Historia (Excel): mantenimiento (CONSOLIDADO), combustible y km mensual (KM_Combustible) y rutas con peso
--     (consolidado rutas). Se carga desde /eficiencia-flota/datos y reemplaza la historia anterior.
--   * TMS (desde la fecha de corte): costos de órdenes de trabajo y neumáticos (vw_vehicle_cost_ledger), combustible de
--     Caja (dispatch_expenses), odómetro y horómetro (vehicle_odometer_logs, abastecimientos, despachos), despachos con
--     el peso de sus guías (dispatch_documents → apt_movements) y días fuera de servicio (maintenance_work_orders).
--   Un mes se toma de la historia si es anterior al corte y del TMS desde el corte: nunca se cuenta dos veces.
-- Producción no coincide con las migraciones: toda tabla o columna del TMS se verifica antes de usarse y cada fuente
-- falla por separado sin detener el cálculo.
-- Permisos: flota-eficiencia (ver) y flota-eficiencia-carga (cargar historia, parámetros y horómetro). Se usa
-- menu_has_permission (Administrador, permiso exacto o con sufijo :read/:write).
BEGIN;

-- ------------------------------------------------------------
-- Tablas propias
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fe_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  desde date NOT NULL DEFAULT DATE '2025-01-01',
  corte date,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.fe_settings (id, params) VALUES (1, jsonb_build_object(
  'vida_util', jsonb_build_object('TRANSPORTE', 12, 'MONTACARGA', 10, 'ELEVACION', 10),
  'horas_min_anio', 300, 'factor_costo', 2.0, 'tendencia_mant_km', 0.15, 'volumen_min', 0.55, 'factor_tkm', 1.5))
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.fe_assets (
  code text PRIMARY KEY,
  nombre text,
  clase text NOT NULL CHECK (clase IN ('TRANSPORTE', 'MONTACARGA', 'ELEVACION')),
  tipo text,
  marca text,
  anio_fab integer,
  capacidad_kg numeric,
  valor_reposicion numeric,
  vida_util integer,
  vehicle_plate text,
  activo boolean NOT NULL DEFAULT true,
  alias text[] NOT NULL DEFAULT '{}',
  editado boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fe_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text,
  status text NOT NULL DEFAULT 'CARGANDO' CHECK (status IN ('CARGANDO', 'APLICADA', 'REEMPLAZADA', 'DESCARTADA')),
  summary jsonb,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.fe_raw (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES public.fe_uploads(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MANT', 'COMB', 'RUTA')),
  row_no integer NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS fe_raw_upload_idx ON public.fe_raw (upload_id, kind);

CREATE TABLE IF NOT EXISTS public.fe_maint (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id uuid REFERENCES public.fe_uploads(id) ON DELETE SET NULL,
  asset_code text NOT NULL,
  fecha date,
  monto numeric NOT NULL DEFAULT 0,
  proveedor text, factura text, km_hrs numeric, tipo text, categoria text,
  mayor boolean NOT NULL DEFAULT false,
  dias_fuera numeric,
  area text, detalle text
);
CREATE INDEX IF NOT EXISTS fe_maint_asset_idx ON public.fe_maint (asset_code, fecha);

CREATE TABLE IF NOT EXISTS public.fe_fuel_month (
  asset_code text NOT NULL,
  mes date NOT NULL,
  upload_id uuid REFERENCES public.fe_uploads(id) ON DELETE SET NULL,
  galones numeric, soles numeric, km numeric, precio numeric,
  glp boolean NOT NULL DEFAULT false,
  PRIMARY KEY (asset_code, mes)
);

CREATE TABLE IF NOT EXISTS public.fe_trips (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id uuid REFERENCES public.fe_uploads(id) ON DELETE SET NULL,
  asset_code text NOT NULL,
  fecha date NOT NULL,
  actividad text, area text, cliente text, provincia text, guia text, descarga text,
  km numeric, kg numeric, m3 numeric, espera_h numeric
);
CREATE INDEX IF NOT EXISTS fe_trips_asset_idx ON public.fe_trips (asset_code, fecha);

CREATE TABLE IF NOT EXISTS public.fe_hour_readings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_code text NOT NULL REFERENCES public.fe_assets(code) ON UPDATE CASCADE ON DELETE CASCADE,
  fecha date NOT NULL,
  horas numeric NOT NULL CHECK (horas >= 0),
  nota text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fe_hour_readings_asset_idx ON public.fe_hour_readings (asset_code, fecha);

-- ------------------------------------------------------------
-- Permisos y utilidades
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.menu_has_permission('flota-eficiencia') OR public.menu_has_permission('flota-eficiencia-carga');
$$;
CREATE OR REPLACE FUNCTION public.fe_can_load()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.menu_has_permission('flota-eficiencia-carga');
$$;
REVOKE ALL ON FUNCTION public.fe_can_view() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fe_can_load() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fe_can_view() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fe_can_load() TO authenticated, service_role;

-- Código de activo: placa "ABC 123" (BCW 838 / ARB 976 → BCW 838; ROF 360 GLP → ROF 360) o el nombre del equipo
CREATE OR REPLACE FUNCTION public.fe_code(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN v IS NULL OR v = '' THEN NULL
              WHEN v ~ '^[A-Z0-9]{3}[ -]?[0-9]{3}([^0-9]|$)' THEN substring(v, 1, 3) || ' ' || substring(regexp_replace(v, '^[A-Z0-9]{3}[ -]?', ''), 1, 3)
              ELSE v END
  FROM (SELECT upper(regexp_replace(btrim(COALESCE(p, '')), '\s+', ' ', 'g')) AS v) z;
$$;

CREATE OR REPLACE FUNCTION public.fe_num(p jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE s text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) = 'number' THEN RETURN (p #>> '{}')::numeric; END IF;
  s := regexp_replace(p #>> '{}', '[^0-9.,-]', '', 'g');
  IF s = '' THEN RETURN NULL; END IF;
  IF s ~ ',' AND s ~ '\.' THEN s := replace(s, ',', ''); ELSIF s ~ ',\d{3}$' THEN s := replace(s, ',', ''); ELSE s := replace(s, ',', '.'); END IF;
  RETURN s::numeric;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

-- ------------------------------------------------------------
-- RLS: lectura con permiso; escritura solo por funciones
-- ------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['fe_settings', 'fe_assets', 'fe_uploads', 'fe_raw', 'fe_maint', 'fe_fuel_month', 'fe_trips', 'fe_hour_readings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.fe_can_view())', t || '_select', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Carga de historia (Excel): el navegador envía filas normalizadas en bloques
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_upload_begin(p_file_name text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid;
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cargar datos de Eficiencia de Flota'); END IF;
  DELETE FROM public.fe_uploads WHERE status = 'CARGANDO' AND created_at < now() - interval '1 day';
  INSERT INTO public.fe_uploads (file_name) VALUES (left(COALESCE(p_file_name, 'archivo'), 200)) RETURNING id INTO v;
  RETURN jsonb_build_object('success', true, 'id', v);
END $$;

CREATE OR REPLACE FUNCTION public.fe_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  IF p_kind NOT IN ('MANT', 'COMB', 'RUTA') THEN RETURN jsonb_build_object('success', false, 'error', 'Tipo de hoja no válido'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fe_uploads WHERE id = p_upload_id AND status = 'CARGANDO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue aplicada');
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe hasta 5 000 filas por bloque');
  END IF;
  INSERT INTO public.fe_raw (upload_id, kind, row_no, data)
  SELECT p_upload_id, p_kind, COALESCE((r ->> '__row')::int, o::int), r FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS x(r, o);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', n);
END $$;

CREATE OR REPLACE FUNCTION public.fe_upload_discard(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  UPDATE public.fe_uploads SET status = 'DESCARTADA' WHERE id = p_upload_id AND status = 'CARGANDO';
  DELETE FROM public.fe_raw WHERE upload_id = p_upload_id;
  RETURN jsonb_build_object('success', true);
END $$;

-- Aplicar: limpia, valida y reemplaza toda la historia por la de este archivo
CREATE OR REPLACE FUNCTION public.fe_upload_apply(p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_sum jsonb; n_m int; n_c int; n_r int; v_dq jsonb := '[]'::jsonb; n int; s numeric;
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fe_uploads WHERE id = p_upload_id AND status = 'CARGANDO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue aplicada');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fe_upload_apply'));

  -- Mantenimiento
  DROP TABLE IF EXISTS pg_temp.x_m;
  CREATE TEMP TABLE x_m ON COMMIT DROP AS
  SELECT public.fe_code(d ->> 'activo') AS code, d ->> 'activo' AS nombre, upper(btrim(d ->> 'clase')) AS clase_txt,
    CASE WHEN (d ->> 'fecha') ~ '^\d{4}-\d{2}-\d{2}' AND left(d ->> 'fecha', 4)::int >= 2000 THEN left(d ->> 'fecha', 10)::date END AS fecha,
    COALESCE(public.fe_num(d -> 'monto'), 0) AS monto, d ->> 'proveedor' AS proveedor, d ->> 'factura' AS factura,
    public.fe_num(d -> 'km_hrs') AS km_hrs, upper(btrim(d ->> 'tipo')) AS tipo, upper(btrim(d ->> 'categoria')) AS categoria,
    COALESCE(public.fe_num(d -> 'mayor'), 0) > 0 AS mayor, public.fe_num(d -> 'dias_fuera') AS dias_fuera,
    upper(btrim(d ->> 'area')) AS area, d ->> 'detalle' AS detalle, public.fe_num(d -> 'anio_fab')::int AS anio_fab
  FROM public.fe_raw r, LATERAL (SELECT r.data AS d) z WHERE r.upload_id = p_upload_id AND r.kind = 'MANT';
  DELETE FROM x_m WHERE code IS NULL;
  SELECT count(*) FILTER (WHERE fecha IS NULL), COALESCE(sum(monto) FILTER (WHERE fecha IS NULL), 0) INTO n, s FROM x_m;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Mantenimiento', 'problema', 'Registros sin fecha válida', 'casos', n, 'monto', s, 'tratamiento', 'Cuentan en el total, no en los meses')); END IF;

  -- Combustible mensual (km del mes = fila validada)
  DROP TABLE IF EXISTS pg_temp.x_c;
  CREATE TEMP TABLE x_c ON COMMIT DROP AS
  SELECT public.fe_code(d ->> 'placa') AS code, upper(d ->> 'placa') ~ 'GLP' AS glp, upper(btrim(d ->> 'vehiculo')) AS vehiculo,
    make_date(public.fe_num(d -> 'anio')::int, public.fe_num(d -> 'mes')::int, 1) AS mes,
    public.fe_num(d -> 'galones') AS galones, public.fe_num(d -> 'soles') AS soles,
    CASE WHEN COALESCE(public.fe_num(d -> 'valida'), 0) > 0 THEN public.fe_num(d -> 'km_real') END AS km,
    public.fe_num(d -> 'precio') AS precio
  FROM public.fe_raw r, LATERAL (SELECT r.data AS d) z
  WHERE r.upload_id = p_upload_id AND r.kind = 'COMB' AND public.fe_num(d -> 'anio') BETWEEN 2000 AND 2100 AND public.fe_num(d -> 'mes') BETWEEN 1 AND 12;
  DELETE FROM x_c WHERE code IS NULL;

  -- Rutas
  DROP TABLE IF EXISTS pg_temp.x_r;
  CREATE TEMP TABLE x_r ON COMMIT DROP AS
  SELECT public.fe_code(d ->> 'placa') AS code, upper(btrim(d ->> 'marca')) AS marca,
    CASE WHEN (d ->> 'fecha') ~ '^\d{4}-\d{2}-\d{2}' THEN left(d ->> 'fecha', 10)::date END AS fecha,
    upper(btrim(d ->> 'actividad')) AS actividad, upper(btrim(d ->> 'area')) AS area, d ->> 'cliente' AS cliente,
    initcap(btrim(d ->> 'provincia')) AS provincia, d ->> 'guia' AS guia, upper(btrim(d ->> 'descarga')) AS descarga,
    public.fe_num(d -> 'km') AS km, public.fe_num(d -> 'kg') AS kg, public.fe_num(d -> 'm3') AS m3, public.fe_num(d -> 'espera_h') AS espera_h
  FROM public.fe_raw r, LATERAL (SELECT r.data AS d) z WHERE r.upload_id = p_upload_id AND r.kind = 'RUTA';
  DELETE FROM x_r WHERE code IS NULL OR code !~ '^[A-Z0-9]{3} [0-9]{3}$' OR fecha IS NULL;

  -- Activos: alta automática conservando lo editado por el usuario
  INSERT INTO public.fe_assets (code, nombre, clase, tipo, anio_fab, alias)
  SELECT code, max(nombre),
    CASE WHEN bool_or(clase_txt LIKE 'MONTACARGA%') THEN 'MONTACARGA' WHEN bool_or(clase_txt LIKE '%ELEVACI%') THEN 'ELEVACION' ELSE 'TRANSPORTE' END,
    NULL, max(anio_fab), COALESCE(array_agg(DISTINCT nombre) FILTER (WHERE nombre IS NOT NULL AND public.fe_code(nombre) <> nombre), '{}')
  FROM x_m GROUP BY code
  ON CONFLICT (code) DO UPDATE SET
    anio_fab = CASE WHEN fe_assets.editado THEN fe_assets.anio_fab ELSE COALESCE(EXCLUDED.anio_fab, fe_assets.anio_fab) END,
    alias = (SELECT COALESCE(array_agg(DISTINCT a), '{}') FROM unnest(fe_assets.alias || COALESCE(EXCLUDED.alias, '{}')) a),
    updated_at = now();
  INSERT INTO public.fe_assets (code, nombre, clase, tipo)
  SELECT code, code, 'TRANSPORTE', mode() WITHIN GROUP (ORDER BY CASE
      WHEN vehiculo ~ 'GR[UÚ]A' THEN 'CAMIÓN GRÚA' WHEN vehiculo ~ 'TRA[IY]?L|TRAIELR|TRALER' THEN 'TRACTO + SEMIRREMOLQUE'
      WHEN vehiculo ~ 'CAMIONETA' THEN 'CAMIONETA' WHEN vehiculo ~ 'CAM' THEN 'CAMIÓN' WHEN vehiculo ~ 'MIN' THEN 'MINIVAN'
      WHEN vehiculo ~ 'COMBI' THEN 'COMBI' END)
  FROM x_c GROUP BY code
  ON CONFLICT (code) DO UPDATE SET tipo = CASE WHEN fe_assets.editado THEN fe_assets.tipo ELSE COALESCE(fe_assets.tipo, EXCLUDED.tipo) END, updated_at = now();
  INSERT INTO public.fe_assets (code, nombre, clase, marca)
  SELECT code, code, 'TRANSPORTE', max(initcap(marca)) FROM x_r GROUP BY code
  ON CONFLICT (code) DO UPDATE SET marca = COALESCE(fe_assets.marca, EXCLUDED.marca), updated_at = now();

  -- Rutas: anular peso mayor a la capacidad (o 45 t si no está definida) y km imposibles
  WITH b AS (SELECT r.ctid FROM x_r r LEFT JOIN public.fe_assets a ON a.code = r.code WHERE r.kg > COALESCE(a.capacidad_kg * 1.1, 45000))
  UPDATE x_r SET kg = NULL WHERE ctid IN (SELECT ctid FROM b);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Peso por viaje mayor a la capacidad del vehículo', 'casos', n, 'tratamiento', 'Peso anulado en esos viajes')); END IF;
  UPDATE x_r SET km = NULL WHERE km <= 0 OR km > 1200;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Km por viaje negativo, cero o mayor a 1 200', 'casos', n, 'tratamiento', 'Km anulado en esos viajes')); END IF;
  UPDATE x_r SET m3 = NULL WHERE m3 < 0 OR m3 > 1.5;
  UPDATE x_r SET espera_h = NULL WHERE espera_h < 0 OR espera_h > 12;
  SELECT count(*) INTO n FROM x_r WHERE kg IS NULL;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Viajes sin peso', 'casos', n, 'tratamiento', 'No suman toneladas')); END IF;

  -- Reemplazo de la historia
  DELETE FROM public.fe_maint; DELETE FROM public.fe_fuel_month; DELETE FROM public.fe_trips;
  INSERT INTO public.fe_maint (upload_id, asset_code, fecha, monto, proveedor, factura, km_hrs, tipo, categoria, mayor, dias_fuera, area, detalle)
  SELECT p_upload_id, code, fecha, monto, proveedor, factura, km_hrs, tipo, categoria, mayor, dias_fuera, area, detalle FROM x_m;
  GET DIAGNOSTICS n_m = ROW_COUNT;
  INSERT INTO public.fe_fuel_month (asset_code, mes, upload_id, galones, soles, km, precio, glp)
  SELECT code, mes, p_upload_id, sum(galones), sum(soles), sum(km), percentile_cont(0.5) WITHIN GROUP (ORDER BY precio), bool_or(glp)
  FROM x_c GROUP BY code, mes;
  GET DIAGNOSTICS n_c = ROW_COUNT;
  INSERT INTO public.fe_trips (upload_id, asset_code, fecha, actividad, area, cliente, provincia, guia, descarga, km, kg, m3, espera_h)
  SELECT p_upload_id, code, fecha, actividad, area, cliente, provincia, guia, descarga, km, kg, m3, espera_h FROM x_r;
  GET DIAGNOSTICS n_r = ROW_COUNT;

  SELECT count(*) INTO n FROM public.fe_fuel_month WHERE km > 0 AND galones > 0 AND NOT glp AND (km / galones < 2 OR km / galones > 45);
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Combustible', 'problema', 'Meses con km por galón imposible (<2 o >45)', 'casos', n, 'tratamiento', 'Excluidos del rendimiento')); END IF;

  v_sum := jsonb_build_object('mantenimiento', n_m, 'combustible_meses', n_c, 'viajes', n_r,
    'mant_desde', (SELECT min(fecha) FROM public.fe_maint), 'mant_hasta', (SELECT max(fecha) FROM public.fe_maint),
    'comb_desde', (SELECT min(mes) FROM public.fe_fuel_month), 'comb_hasta', (SELECT max(mes) FROM public.fe_fuel_month),
    'rutas_desde', (SELECT min(fecha) FROM public.fe_trips), 'rutas_hasta', (SELECT max(fecha) FROM public.fe_trips),
    'activos', (SELECT count(*) FROM public.fe_assets), 'calidad', v_dq);
  UPDATE public.fe_uploads SET status = 'REEMPLAZADA' WHERE status = 'APLICADA';
  UPDATE public.fe_uploads SET status = 'APLICADA', applied_at = now(), summary = v_sum WHERE id = p_upload_id;
  DELETE FROM public.fe_raw WHERE upload_id = p_upload_id;
  RETURN jsonb_build_object('success', true, 'summary', v_sum);
END $$;

-- ------------------------------------------------------------
-- Parámetros, activos y horómetro
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_save_settings(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  UPDATE public.fe_settings SET
    desde = COALESCE(NULLIF(p ->> 'desde', '')::date, desde),
    corte = CASE WHEN p ? 'corte' THEN NULLIF(p ->> 'corte', '')::date ELSE corte END,
    params = params || COALESCE(p -> 'params', '{}'::jsonb),
    updated_at = now(), updated_by = auth.uid()
  WHERE id = 1;
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN jsonb_build_object('success', false, 'error', 'Fecha no válida');
END $$;

CREATE OR REPLACE FUNCTION public.fe_save_asset(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text := public.fe_code(p ->> 'code');
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  IF v_code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el código del activo'); END IF;
  IF COALESCE(p ->> 'clase', 'TRANSPORTE') NOT IN ('TRANSPORTE', 'MONTACARGA', 'ELEVACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Clase no válida');
  END IF;
  INSERT INTO public.fe_assets (code, nombre, clase, tipo, marca, anio_fab, capacidad_kg, valor_reposicion, vida_util, vehicle_plate, activo, editado)
  VALUES (v_code, COALESCE(NULLIF(p ->> 'nombre', ''), v_code), COALESCE(p ->> 'clase', 'TRANSPORTE'), NULLIF(p ->> 'tipo', ''), NULLIF(p ->> 'marca', ''),
    public.fe_num(p -> 'anio_fab')::int, public.fe_num(p -> 'capacidad_kg'), public.fe_num(p -> 'valor_reposicion'), public.fe_num(p -> 'vida_util')::int,
    NULLIF(upper(btrim(p ->> 'vehicle_plate')), ''), COALESCE((p ->> 'activo')::boolean, true), true)
  ON CONFLICT (code) DO UPDATE SET nombre = EXCLUDED.nombre, clase = EXCLUDED.clase, tipo = EXCLUDED.tipo, marca = EXCLUDED.marca,
    anio_fab = EXCLUDED.anio_fab, capacidad_kg = EXCLUDED.capacidad_kg, valor_reposicion = EXCLUDED.valor_reposicion,
    vida_util = EXCLUDED.vida_util, vehicle_plate = EXCLUDED.vehicle_plate, activo = EXCLUDED.activo, editado = true, updated_at = now();
  RETURN jsonb_build_object('success', true, 'code', v_code);
END $$;

CREATE OR REPLACE FUNCTION public.fe_save_hours(p_code text, p_fecha date, p_horas numeric, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fe_assets WHERE code = p_code) THEN RETURN jsonb_build_object('success', false, 'error', 'Activo no encontrado'); END IF;
  IF p_fecha IS NULL OR p_fecha > CURRENT_DATE OR p_horas IS NULL OR p_horas < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique una fecha no futura y una lectura válida');
  END IF;
  INSERT INTO public.fe_hour_readings (asset_code, fecha, horas, nota) VALUES (p_code, p_fecha, p_horas, NULLIF(btrim(p_nota), ''));
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- Panel mensual: historia (antes del corte) + TMS (desde el corte)
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fe_build(date, date);
-- Deja en pg_temp: fe_a (activos, incluye unidades del TMS sin ficha), fe_pm (activo × mes) y fe_hr (lecturas de horas).
CREATE OR REPLACE FUNCTION public.fe_build(p_desde date, p_hasta date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_corte date; v_cc date; v_cm date; v_cr date; v_mh_min date; v_mh_max date; v_desde date := date_trunc('month', p_desde)::date; v_hasta date := date_trunc('month', p_hasta)::date;
  has_ledger boolean := to_regclass('public.vw_vehicle_cost_ledger') IS NOT NULL; has_veh boolean := to_regclass('public.vehicles') IS NOT NULL;
BEGIN
  SELECT corte INTO v_corte FROM public.fe_settings WHERE id = 1;
  SELECT date_trunc('month', min(fecha))::date, date_trunc('month', max(fecha))::date INTO v_mh_min, v_mh_max FROM public.fe_maint WHERE fecha IS NOT NULL;
  -- Corte por fuente: cada una usa el Excel hasta su último mes y el TMS desde el mes siguiente (o el corte fijado en parámetros)
  v_cc := date_trunc('month', COALESCE(v_corte, (SELECT max(mes) + interval '1 month' FROM public.fe_fuel_month)::date, v_desde))::date;
  v_cm := date_trunc('month', COALESCE(v_corte, (v_mh_max + interval '1 month')::date, v_desde))::date;
  v_cr := date_trunc('month', COALESCE(v_corte, (SELECT max(fecha) + interval '1 month' FROM public.fe_trips)::date, v_desde))::date;

  -- Activos: ficha propia + unidades del TMS que no tienen ficha
  DROP TABLE IF EXISTS pg_temp.fe_a;
  CREATE TEMP TABLE fe_a ON COMMIT DROP AS
  SELECT code, COALESCE(nombre, code) AS nombre, clase, tipo, marca, anio_fab, capacidad_kg, valor_reposicion, vida_util, activo,
    public.fe_code(COALESCE(vehicle_plate, code)) AS plate_key, false AS solo_tms
  FROM public.fe_assets;
  IF has_veh THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_a
        SELECT public.fe_code(v.plate), v.plate,
          CASE WHEN upper(COALESCE(v.type, '')) IN ('MONTACARGAS', 'MONTACARGA', 'TRANSPALETA') THEN 'MONTACARGA' WHEN upper(COALESCE(v.type, '')) IN ('APILADOR', 'ELEVADOR', 'PLATAFORMA') THEN 'ELEVACION' ELSE 'TRANSPORTE' END,
          initcap(v.type), to_jsonb(v) ->> 'brand', NULLIF(to_jsonb(v) ->> 'year', '')::int, NULL, NULL, NULL, true, public.fe_code(v.plate), true
        FROM public.vehicles v
        WHERE v.plate IS NOT NULL AND public.fe_code(v.plate) NOT IN (SELECT plate_key FROM fe_a WHERE plate_key IS NOT NULL)
          AND public.fe_code(v.plate) NOT IN (SELECT code FROM fe_a)$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  DROP TABLE IF EXISTS pg_temp.fe_src;
  CREATE TEMP TABLE fe_src (code text, mes date, fuente text, km numeric, gal numeric, comb numeric, glp boolean, mant numeric, mant_corr numeric,
    mayores int, dias_fuera numeric, viajes int, kg numeric, tkm numeric, km_viajes numeric, m3 numeric, sin_peso int) ON COMMIT DROP;

  -- Historia
  INSERT INTO fe_src (code, mes, fuente, km, gal, comb, glp)
  SELECT asset_code, mes, 'EXCEL', km, galones, soles, glp FROM public.fe_fuel_month WHERE mes < v_cc;
  INSERT INTO fe_src (code, mes, fuente, mant, mant_corr, mayores, dias_fuera)
  SELECT asset_code, date_trunc('month', fecha)::date, 'EXCEL', sum(monto), sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'),
    count(*) FILTER (WHERE mayor)::int, sum(dias_fuera)
  FROM public.fe_maint WHERE fecha IS NOT NULL AND fecha < v_cm GROUP BY 1, 2;
  INSERT INTO fe_src (code, mes, fuente, viajes, kg, tkm, km_viajes, m3, sin_peso)
  SELECT asset_code, date_trunc('month', fecha)::date, 'EXCEL', count(*)::int, sum(kg), sum(kg / 1000.0 * km), sum(km), avg(m3), count(*) FILTER (WHERE kg IS NULL)::int
  FROM public.fe_trips WHERE fecha < v_cr GROUP BY 1, 2;

  -- TMS: mantenimiento y neumáticos (libro de costos de la unidad)
  IF has_ledger AND has_veh THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, mant)
        SELECT a.code, date_trunc('month', (l.cost_date AT TIME ZONE 'America/Lima'))::date, 'TMS', sum(l.amount)
        FROM public.vw_vehicle_cost_ledger l JOIN public.vehicles v ON v.id = l.vehicle_id
        JOIN fe_a a ON a.plate_key = public.fe_code(v.plate)
        WHERE l.category IN ('MANTENIMIENTO', 'NEUMATICOS') AND (l.cost_date AT TIME ZONE 'America/Lima')::date >= $1
        GROUP BY 1, 2$q$ USING v_cm;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- TMS: combustible de Caja
  IF public.menu_col_exists('dispatch_expenses', 'fuel_gallons') THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, gal, comb)
        SELECT a.code, date_trunc('month', COALESCE(de.expense_date, (de.created_at AT TIME ZONE 'America/Lima')::date))::date, 'TMS',
          sum(de.fuel_gallons), sum(COALESCE(de.approved_amount, de.amount))
        FROM public.dispatch_expenses de
        LEFT JOIN public.dispatches d ON d.id = de.dispatch_id
        JOIN fe_a a ON a.plate_key = public.fe_code(COALESCE(de.vehicle_plate, d.vehicle_plate))
        WHERE upper(de.expense_type::text) IN ('COMBUSTIBLE', 'FUEL', 'DIESEL', 'GASOLINA', 'GLP') AND de.status <> 'RECHAZADO'
          AND COALESCE(de.expense_date, (de.created_at AT TIME ZONE 'America/Lima')::date) >= $1
        GROUP BY 1, 2$q$ USING v_cc;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- TMS: km del mes por odómetro (bitácora de odómetro, abastecimientos y despachos); se toma la lectura máxima de cada mes
  DROP TABLE IF EXISTS pg_temp.fe_odo;
  CREATE TEMP TABLE fe_odo (code text, fecha date, odo numeric, horas numeric) ON COMMIT DROP;
  IF to_regclass('public.vehicle_odometer_logs') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, (o.created_at AT TIME ZONE 'America/Lima')::date, NULLIF(o.odometer_value, 0), NULLIF(to_jsonb(o) ->> 'hours_value', '')::numeric
        FROM public.vehicle_odometer_logs o JOIN fe_a a ON a.plate_key = public.fe_code(o.vehicle_plate)
        WHERE COALESCE(o.status, '') <> 'REQUIERE_AUDITORIA'$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  IF public.menu_col_exists('dispatch_expenses', 'fuel_odometer') THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, COALESCE(de.expense_date, (de.created_at AT TIME ZONE 'America/Lima')::date), NULLIF(de.fuel_odometer, 0), NULL
        FROM public.dispatch_expenses de LEFT JOIN public.dispatches d ON d.id = de.dispatch_id
        JOIN fe_a a ON a.plate_key = public.fe_code(COALESCE(de.vehicle_plate, d.vehicle_plate))
        WHERE de.fuel_odometer IS NOT NULL AND de.status <> 'RECHAZADO'$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  IF public.menu_col_exists('dispatches', 'end_odometer') THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, COALESCE((d.returned_at AT TIME ZONE 'America/Lima')::date, d.scheduled_date::date), NULLIF(d.end_odometer, 0), NULL
        FROM public.dispatches d JOIN fe_a a ON a.plate_key = public.fe_code(d.vehicle_plate) WHERE d.end_odometer IS NOT NULL$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  -- km del mes = lectura máxima del mes − lectura máxima del mes anterior; sin mes anterior, la diferencia dentro del mes
  INSERT INTO fe_src (code, mes, fuente, km)
  SELECT code, mes, 'TMS', km FROM (
    SELECT code, mes, CASE WHEN (mes - lag(mes) OVER w) <= 31 THEN mx - lag(mx) OVER w ELSE mx - mn END AS km
    FROM (SELECT code, date_trunc('month', fecha)::date AS mes, max(odo) AS mx, min(odo) AS mn FROM fe_odo
          WHERE odo IS NOT NULL AND fecha >= v_cc - interval '3 months' GROUP BY 1, 2) z
    WINDOW w AS (PARTITION BY code ORDER BY mes)) y
  WHERE mes >= v_cc AND km > 0 AND km < 20000;

  -- TMS: despachos, peso de sus guías (cargas del ERP en APT) y km del viaje
  IF to_regclass('public.dispatches') IS NOT NULL THEN
    BEGIN
      EXECUTE format($q$INSERT INTO fe_src (code, mes, fuente, viajes, kg, tkm, km_viajes, sin_peso)
        WITH t AS (
          SELECT a.code, date_trunc('month', d.scheduled_date::date)::date AS mes, d.id,
            COALESCE(NULLIF(%s, 0), CASE WHEN d.end_odometer > d.start_odometer AND d.end_odometer - d.start_odometer < 1500 THEN d.end_odometer - d.start_odometer END) AS km,
            %s AS kg
          FROM public.dispatches d JOIN fe_a a ON a.plate_key = public.fe_code(d.vehicle_plate)
          WHERE d.scheduled_date::date >= $1 AND upper(COALESCE(d.status::text, '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR'))
        SELECT code, mes, 'TMS', count(*)::int, sum(kg), sum(kg / 1000.0 * km), sum(km), count(*) FILTER (WHERE kg IS NULL)::int FROM t GROUP BY 1, 2$q$,
        CASE WHEN public.menu_col_exists('dispatches', 'actual_distance_km') THEN 'd.actual_distance_km' ELSE 'NULL::numeric' END,
        CASE WHEN to_regclass('public.dispatch_documents') IS NOT NULL AND to_regclass('public.apt_movements') IS NOT NULL
               AND to_regprocedure('public.apt_guia_key(text)') IS NOT NULL
             THEN '(SELECT NULLIF(sum(m.peso_kg), 0) FROM public.dispatch_documents dd JOIN public.apt_movements m ON m.active AND m.valid AND m.kind = ''SALIDA'' AND public.apt_guia_key(m.documento) = public.apt_guia_key(dd.document_number) WHERE dd.dispatch_id = d.id AND dd.voided_at IS NULL AND dd.doc_type = ''GUIA_REMISION'')'
             ELSE 'NULL::numeric' END)
      USING v_cr;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- TMS: días fuera de servicio por órdenes de trabajo cerradas
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL AND has_veh THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, dias_fuera)
        SELECT a.code, date_trunc('month', ini)::date, 'TMS', sum(GREATEST(fin - ini, 0))
        FROM (SELECT wo.vehicle_id, NULLIF(to_jsonb(wo) ->> 'start_date', '')::timestamptz::date AS ini,
                     COALESCE(NULLIF(to_jsonb(wo) ->> 'actual_end_date', ''), NULLIF(to_jsonb(wo) ->> 'end_date', ''))::timestamptz::date AS fin
              FROM public.maintenance_work_orders wo WHERE upper(COALESCE(wo.status::text, '')) NOT IN ('CANCELADA', 'CANCELADO')) w
        JOIN public.vehicles v ON v.id = w.vehicle_id JOIN fe_a a ON a.plate_key = public.fe_code(v.plate)
        WHERE w.ini >= $1 AND w.fin IS NOT NULL GROUP BY 1, 2$q$ USING v_cm;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Panel activo × mes (todo el periodo disponible; la ventana de análisis se aplica después)
  DROP TABLE IF EXISTS pg_temp.fe_pm;
  CREATE TEMP TABLE fe_pm ON COMMIT DROP AS
  SELECT s.code, s.mes, string_agg(DISTINCT s.fuente, '+') AS fuente,
    sum(s.km) AS km, sum(s.gal) AS gal, sum(s.comb) AS comb, bool_or(s.glp) AS glp,
    sum(s.mant) AS mant, sum(s.mant_corr) AS mant_corr, sum(s.mayores)::int AS mayores, sum(s.dias_fuera) AS dias_fuera,
    sum(s.viajes)::int AS viajes, sum(s.kg) AS kg, sum(s.tkm) AS tkm, sum(s.km_viajes) AS km_viajes, avg(s.m3) AS m3, sum(s.sin_peso)::int AS sin_peso,
    -- el mantenimiento del mes está cubierto si cae dentro del periodo de la historia o desde el corte (un mes sin gasto vale 0)
    (s.mes >= v_cm OR (s.mes BETWEEN v_mh_min AND v_mh_max)) AS mant_cubierto
  FROM fe_src s WHERE s.code IN (SELECT code FROM fe_a) AND s.mes <= v_hasta
  GROUP BY s.code, s.mes;
  CREATE INDEX ON fe_pm (code, mes);

  -- Lecturas de horas (horómetro): historia de mantenimiento, lecturas mensuales y bitácora del TMS
  DROP TABLE IF EXISTS pg_temp.fe_hr;
  CREATE TEMP TABLE fe_hr ON COMMIT DROP AS
  SELECT m.asset_code AS code, m.fecha, max(m.km_hrs) AS horas FROM public.fe_maint m JOIN fe_a a ON a.code = m.asset_code
  WHERE a.clase <> 'TRANSPORTE' AND m.fecha IS NOT NULL AND m.km_hrs > 0 GROUP BY 1, 2
  UNION ALL SELECT asset_code, fecha, max(horas) FROM public.fe_hour_readings GROUP BY 1, 2
  UNION ALL SELECT o.code, o.fecha, max(o.horas) FROM fe_odo o JOIN fe_a a ON a.code = o.code WHERE a.clase <> 'TRANSPORTE' AND o.horas > 0 GROUP BY 1, 2;
  RETURN jsonb_build_object('manual', v_corte, 'combustible', v_cc, 'mantenimiento', v_cm, 'rutas', v_cr);
END $$;
REVOKE ALL ON FUNCTION public.fe_build(date, date) FROM PUBLIC, anon, authenticated;

-- Horas de uso por año: suma de avances válidos del horómetro (sin retrocesos ni saltos de más de 12 h por día)
CREATE OR REPLACE FUNCTION public.fe_hours_rate(p_code text, p_desde date, p_hasta date, OUT horas_anio numeric, OUT lecturas integer, OUT ultima numeric, OUT ultima_fecha date)
LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE r record; prev_f date; prev_h numeric; tot numeric := 0; dias numeric := 0; dt int; dh numeric;
BEGIN
  lecturas := 0;
  FOR r IN SELECT fecha, max(horas) AS h FROM fe_hr WHERE code = p_code AND fecha <= p_hasta
           AND fecha >= COALESCE((SELECT max(fecha) FROM fe_hr WHERE code = p_code AND fecha < p_desde), p_desde)
           GROUP BY fecha ORDER BY fecha LOOP
    lecturas := lecturas + 1; ultima := r.h; ultima_fecha := r.fecha;
    IF prev_f IS NOT NULL THEN
      dt := r.fecha - prev_f; dh := r.h - prev_h;
      IF dt > 0 AND dh >= 0 AND dh <= GREATEST(12 * dt, 50) THEN tot := tot + dh; dias := dias + dt; END IF;
    END IF;
    prev_f := r.fecha; prev_h := r.h;
  END LOOP;
  horas_anio := CASE WHEN dias > 180 THEN round(tot / dias * 365.25) END;
END $$;
REVOKE ALL ON FUNCTION public.fe_hours_rate(text, date, date) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Resumen: indicadores por activo y decisión de reemplazo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_resumen(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_desde date; v_hasta date; v_cut jsonb; v_cm date; pr jsonb; v_tr jsonb; v_eq jsonb; v_kpi jsonb; v_years jsonb; v_cov jsonb;
  med_tkm numeric; med_mkm numeric; med_ch numeric; v_meses int;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  pr := st.params;
  v_desde := date_trunc('month', COALESCE(NULLIF(p ->> 'desde', '')::date, st.desde))::date;
  v_hasta := date_trunc('month', COALESCE(NULLIF(p ->> 'hasta', '')::date, CURRENT_DATE))::date;
  v_cut := public.fe_build(v_desde, v_hasta);
  v_cm := (v_cut ->> 'mantenimiento')::date;
  -- hasta efectivo: último mes con datos
  v_hasta := LEAST(v_hasta, COALESCE((SELECT max(mes) FROM fe_pm WHERE mes >= v_desde), v_hasta));
  v_meses := ((date_part('year', age(v_hasta, v_desde)) * 12 + date_part('month', age(v_hasta, v_desde))) + 1)::int;

  -- Transporte: ventana de análisis
  DROP TABLE IF EXISTS pg_temp.fe_t;
  CREATE TEMP TABLE fe_t ON COMMIT DROP AS
  WITH w AS (SELECT * FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
  k AS (  -- meses completos para costo por km: km, combustible y mantenimiento cubierto
    SELECT code, count(*) AS meses_km, sum(km) AS km, sum(gal) AS gal, sum(comb) AS comb, sum(COALESCE(mant, 0)) AS mant
    FROM w WHERE km > 0 AND gal > 0 AND mant_cubierto GROUP BY code),
  t AS (  -- meses completos para costo por tonelada: además con viajes y peso
    SELECT code, count(*) AS meses_t, sum(km) AS km, sum(comb) AS comb, sum(COALESCE(mant, 0)) AS mant, sum(viajes) AS viajes,
      sum(kg) / 1000.0 AS ton, sum(tkm) AS tkm, avg(m3) AS m3, sum(km_viajes) AS km_viajes
    FROM w WHERE km > 0 AND gal > 0 AND mant_cubierto AND viajes > 0 AND kg > 0 GROUP BY code),
  g AS (SELECT code, sum(km) AS km_tot, sum(gal) AS gal_tot, sum(comb) AS comb_tot, sum(mant) AS mant_tot, sum(viajes) AS viajes_tot,
          sum(kg) / 1000.0 AS ton_tot, sum(mayores) AS mayores, sum(dias_fuera) AS dias_fuera, max(mes) FILTER (WHERE km > 0 OR gal > 0 OR viajes > 0) AS ult_uso,
          count(*) FILTER (WHERE km > 0) AS meses_con_km, count(*) FILTER (WHERE gal > 0) AS meses_con_comb, count(*) FILTER (WHERE viajes > 0) AS meses_con_rutas,
          bool_or(glp) AS glp
        FROM w GROUP BY code)
  SELECT a.code, a.nombre, a.tipo, a.marca, a.anio_fab, a.capacidad_kg, a.valor_reposicion, a.activo, a.solo_tms,
    COALESCE(a.vida_util, (pr -> 'vida_util' ->> 'TRANSPORTE')::int, 12) AS vida_util,
    k.meses_km, k.km, k.gal, k.comb, k.mant, k.km / NULLIF(k.gal, 0) AS kmgal,
    k.comb / NULLIF(k.km, 0) AS comb_km, k.mant / NULLIF(k.km, 0) AS mant_km, (k.comb + k.mant) / NULLIF(k.km, 0) AS costo_km,
    t.meses_t, t.ton, t.tkm, t.viajes, (t.comb + t.mant) / NULLIF(t.ton, 0) AS costo_t, (t.comb + t.mant) / NULLIF(t.tkm, 0) AS costo_tkm,
    t.comb / NULLIF(t.tkm, 0) AS comb_tkm, t.mant / NULLIF(t.tkm, 0) AS mant_tkm,
    t.ton * 1000 / NULLIF(t.viajes, 0) AS kg_viaje, t.m3, t.viajes::numeric / NULLIF(t.meses_t, 0) AS viajes_mes, t.ton / NULLIF(t.meses_t, 0) AS ton_mes,
    g.km_tot, g.gal_tot, g.comb_tot, g.mant_tot, g.viajes_tot, g.ton_tot, g.mayores, g.dias_fuera, g.ult_uso, g.meses_con_km, g.meses_con_comb, g.meses_con_rutas, g.glp,
    CASE WHEN k.meses_km > 0 THEN k.km / k.meses_km * 12 END AS km_anio,
    CASE WHEN a.anio_fab IS NOT NULL THEN extract(year FROM v_hasta)::int - a.anio_fab END AS edad
  FROM fe_a a LEFT JOIN k USING (code) LEFT JOIN t USING (code) LEFT JOIN g USING (code)
  WHERE a.clase = 'TRANSPORTE' AND (g.code IS NOT NULL);

  -- Tendencia del mantenimiento por km (años con al menos 6 meses de km y mantenimiento; toda la historia disponible)
  DROP TABLE IF EXISTS pg_temp.fe_y;
  CREATE TEMP TABLE fe_y ON COMMIT DROP AS
  SELECT code, extract(year FROM mes)::int AS anio, count(*) FILTER (WHERE km > 0) AS meses_km,
    sum(km) AS km, sum(gal) AS gal, sum(comb) AS comb, sum(mant) AS mant, sum(viajes) AS viajes, sum(kg) / 1000.0 AS ton,
    sum(mant) FILTER (WHERE km > 0 AND mant_cubierto) / NULLIF(sum(km) FILTER (WHERE km > 0 AND mant_cubierto), 0) AS mant_km,
    sum(km) FILTER (WHERE gal > 0 AND km > 0) / NULLIF(sum(gal) FILTER (WHERE gal > 0 AND km > 0), 0) AS kmgal,
    (sum(comb) FILTER (WHERE km > 0) + COALESCE(sum(mant) FILTER (WHERE km > 0 AND mant_cubierto), 0)) / NULLIF(sum(km) FILTER (WHERE km > 0), 0) AS costo_km,
    sum(comb) / NULLIF(sum(gal), 0) AS precio
  FROM fe_pm WHERE mes <= v_hasta GROUP BY 1, 2;
  ALTER TABLE fe_t ADD COLUMN tend_mant_km numeric;
  UPDATE fe_t t SET tend_mant_km = z.slope FROM (
    SELECT code, regr_slope(mant_km, anio) AS slope FROM fe_y WHERE meses_km >= 6 AND mant_km IS NOT NULL AND anio >= 2021 GROUP BY code HAVING count(*) >= 3) z
  WHERE z.code = t.code;

  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_tkm) INTO med_tkm FROM fe_t WHERE costo_tkm IS NOT NULL AND kg_viaje >= 1000;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mant_km) INTO med_mkm FROM fe_t WHERE mant_km IS NOT NULL;

  -- Decisión: puntaje y motivos
  ALTER TABLE fe_t ADD COLUMN score int, ADD COLUMN rec text, ADD COLUMN motivos text[];
  UPDATE fe_t SET motivos = '{}', score = 0;
  UPDATE fe_t SET score = score + CASE WHEN edad >= vida_util THEN 40 WHEN edad >= vida_util * 0.8 THEN 20 ELSE 0 END,
    motivos = motivos || CASE WHEN edad >= vida_util THEN ARRAY[format('%s años: supera la vida útil de %s', edad, vida_util)]
                              WHEN edad >= vida_util * 0.8 THEN ARRAY[format('%s años: cerca de la vida útil de %s', edad, vida_util)] ELSE '{}' END
  WHERE edad IS NOT NULL;
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('Costo por t·km S/ %s: %s veces la mediana de la flota', round(costo_tkm, 3), round(costo_tkm / med_tkm, 1))
  WHERE med_tkm > 0 AND kg_viaje >= 1000 AND costo_tkm > med_tkm * COALESCE((pr ->> 'factor_tkm')::numeric, 1.5);
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('El mantenimiento sube S/ %s por km cada año', round(tend_mant_km, 2))
  WHERE tend_mant_km > COALESCE((pr ->> 'tendencia_mant_km')::numeric, 0.15);
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('Mantenimiento S/ %s por km: %s veces la mediana', round(mant_km, 2), round(mant_km / med_mkm, 1))
  WHERE med_mkm > 0 AND mant_km > med_mkm * 1.5;
  UPDATE fe_t SET motivos = motivos || format('Viaja con %s %% del volumen y %s kg por viaje', round(m3 * 100), round(kg_viaje))
  WHERE m3 < COALESCE((pr ->> 'volumen_min')::numeric, 0.55) AND kg_viaje >= 1000;
  UPDATE fe_t SET motivos = motivos || format('%s intervenciones mayores en el periodo', mayores) WHERE mayores >= 5;
  UPDATE fe_t SET rec = CASE
      WHEN ult_uso IS NULL OR ult_uso < v_hasta - interval '3 months' THEN 'Verificar estado'
      WHEN score >= 60 THEN 'Reemplazar'
      WHEN edad >= vida_util THEN 'Planificar reemplazo'
      WHEN score >= 20 THEN 'Vigilar'
      WHEN m3 < COALESCE((pr ->> 'volumen_min')::numeric, 0.55) AND kg_viaje >= 1000 THEN 'Consolidar carga'
      WHEN meses_con_comb <= 12 AND (anio_fab IS NULL OR edad <= 1) AND solo_tms IS NOT TRUE AND (SELECT min(mes) FROM fe_pm x WHERE x.code = fe_t.code) >= v_hasta - interval '12 months' THEN 'Alta reciente'
      ELSE 'Mantener' END;
  UPDATE fe_t SET motivos = motivos || format('Sin km ni combustible desde %s', to_char(ult_uso, 'MM/YYYY')) WHERE rec = 'Verificar estado' AND ult_uso IS NOT NULL;

  -- Equipos: costo anual y costo por hora
  DROP TABLE IF EXISTS pg_temp.fe_e;
  CREATE TEMP TABLE fe_e ON COMMIT DROP AS
  SELECT a.code, a.nombre, a.clase, a.tipo, a.anio_fab, a.valor_reposicion, a.activo,
    COALESCE(a.vida_util, (pr -> 'vida_util' ->> a.clase)::int, 10) AS vida_util,
    CASE WHEN a.anio_fab IS NOT NULL THEN extract(year FROM v_hasta)::int - a.anio_fab END AS edad,
    COALESCE(sum(w.mant), 0) AS mant, count(*) FILTER (WHERE w.mant_cubierto) AS meses_cub,
    COALESCE(sum(w.mant), 0) / NULLIF(count(*) FILTER (WHERE w.mant_cubierto), 0) * 12 AS costo_anual,
    COALESCE(sum(w.mant_corr), 0) / NULLIF(sum(w.mant), 0) AS corr_pct, COALESCE(sum(w.mayores), 0)::int AS mayores,
    COALESCE(sum(w.dias_fuera), 0) AS dias_fuera, max(w.mes) FILTER (WHERE w.mant > 0) AS ult_registro
  FROM fe_a a
  LEFT JOIN (SELECT p2.* FROM fe_pm p2 WHERE p2.mes BETWEEN v_desde AND v_hasta) w ON w.code = a.code
  WHERE a.clase <> 'TRANSPORTE'
  GROUP BY a.code, a.nombre, a.clase, a.tipo, a.anio_fab, a.valor_reposicion, a.activo, a.vida_util;
  -- el costo anual se mide sobre los meses de la ventana (un mes sin gasto vale 0 si está cubierto)
  UPDATE fe_e SET costo_anual = mant / NULLIF((SELECT count(*) FROM generate_series(v_desde, v_hasta, interval '1 month') g(m)
      WHERE g.m::date >= v_cm OR EXISTS (SELECT 1 FROM public.fe_maint mm WHERE mm.fecha IS NOT NULL HAVING g.m::date BETWEEN date_trunc('month', min(mm.fecha)) AND date_trunc('month', max(mm.fecha)))), 0) * 12;
  ALTER TABLE fe_e ADD COLUMN horas_anio numeric, ADD COLUMN lecturas int, ADD COLUMN horometro numeric, ADD COLUMN horometro_fecha date,
    ADD COLUMN costo_hora numeric, ADD COLUMN score int, ADD COLUMN rec text, ADD COLUMN motivos text[];
  UPDATE fe_e e SET horas_anio = h.horas_anio, lecturas = h.lecturas, horometro = h.ultima, horometro_fecha = h.ultima_fecha
  FROM (SELECT code, (public.fe_hours_rate(code, v_desde, (v_hasta + interval '1 month - 1 day')::date)).* FROM fe_e) h WHERE h.code = e.code;
  UPDATE fe_e SET costo_hora = costo_anual / NULLIF(horas_anio, 0);
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_hora) INTO med_ch FROM fe_e WHERE costo_hora IS NOT NULL;
  UPDATE fe_e SET motivos = '{}', score = 0;
  UPDATE fe_e SET score = score + CASE WHEN edad >= vida_util THEN 40 WHEN edad >= vida_util * 0.8 THEN 20 ELSE 0 END,
    motivos = motivos || CASE WHEN edad >= vida_util THEN ARRAY[format('%s años: supera la vida útil de %s', edad, vida_util)]
                              WHEN edad >= vida_util * 0.8 THEN ARRAY[format('%s años: cerca de la vida útil de %s', edad, vida_util)] ELSE '{}' END
  WHERE edad IS NOT NULL;
  UPDATE fe_e SET score = score + 25, motivos = motivos || format('S/ %s por hora: %s veces la mediana de los equipos', round(costo_hora, 1), round(costo_hora / med_ch, 1))
  WHERE med_ch > 0 AND costo_hora > med_ch * COALESCE((pr ->> 'factor_costo')::numeric, 2);
  UPDATE fe_e SET score = score + 25, motivos = motivos || format('Solo %s h de uso al año', horas_anio)
  WHERE horas_anio < COALESCE((pr ->> 'horas_min_anio')::numeric, 300);
  UPDATE fe_e SET motivos = motivos || format('%s días fuera de servicio', dias_fuera) WHERE dias_fuera >= 15;
  UPDATE fe_e SET motivos = motivos || format('%s intervenciones mayores', mayores) WHERE mayores >= 5;
  UPDATE fe_e SET motivos = motivos || format('Solo %s lecturas de horómetro: registre una lectura al mes', COALESCE(lecturas, 0)) WHERE COALESCE(lecturas, 0) < 3;
  UPDATE fe_e SET rec = CASE
      WHEN horas_anio < COALESCE((pr ->> 'horas_min_anio')::numeric, 300)
           AND (costo_hora > med_ch * COALESCE((pr ->> 'factor_costo')::numeric, 2) OR edad >= vida_util) THEN 'Dar de baja o alquilar'
      WHEN ult_registro IS NULL OR ult_registro < v_hasta - interval '6 months' THEN 'Verificar estado'
      WHEN score >= 60 THEN 'Reemplazar'
      WHEN edad >= vida_util THEN 'Planificar reemplazo'
      WHEN horas_anio IS NULL THEN 'Registrar horómetro'
      WHEN score >= 25 THEN 'Vigilar'
      ELSE 'Mantener' END;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'motivos' || jsonb_build_object('motivos', to_jsonb(t.motivos),
           'anios', (SELECT COALESCE(jsonb_agg(to_jsonb(y) - 'code' ORDER BY y.anio), '[]') FROM fe_y y WHERE y.code = t.code))
         ORDER BY t.score DESC, t.code), '[]') INTO v_tr FROM fe_t t;
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.score DESC, e.code), '[]') INTO v_eq FROM fe_e e;

  SELECT jsonb_build_object(
      'mant', (SELECT sum(mant) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'mant_transporte', (SELECT sum(p2.mant) FROM fe_pm p2 JOIN fe_a a ON a.code = p2.code AND a.clase = 'TRANSPORTE' WHERE p2.mes BETWEEN v_desde AND v_hasta),
      'mant_equipos', (SELECT sum(p2.mant) FROM fe_pm p2 JOIN fe_a a ON a.code = p2.code AND a.clase <> 'TRANSPORTE' WHERE p2.mes BETWEEN v_desde AND v_hasta),
      'comb', (SELECT sum(comb) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'gal', (SELECT sum(gal) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'km', (SELECT sum(km) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'ton', (SELECT sum(kg) / 1000.0 FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'viajes', (SELECT sum(viajes) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'tkm', (SELECT sum(tkm) FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta),
      'activos', (SELECT count(*) FROM fe_a), 'transporte', (SELECT count(*) FROM fe_t), 'equipos', (SELECT count(*) FROM fe_e))
  INTO v_kpi;

  -- Precio del combustible por año (sin GLP)
  SELECT COALESCE(jsonb_object_agg(anio, precio), '{}') INTO v_years FROM (
    SELECT extract(year FROM mes)::int AS anio, round(sum(comb) / NULLIF(sum(gal), 0), 2) AS precio FROM fe_pm WHERE NOT COALESCE(glp, false) AND gal > 0 GROUP BY 1) z;

  -- Cobertura por fuente
  SELECT jsonb_build_object(
    'excel', (SELECT summary FROM public.fe_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1),
    'ultima_carga', (SELECT jsonb_build_object('archivo', file_name, 'fecha', applied_at) FROM public.fe_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1),
    'meses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'fuente', fuente, 'km', km, 'comb', comb, 'mant', mant, 'viajes', viajes, 'ton', ton) ORDER BY mes), '[]') FROM (
      SELECT mes, string_agg(DISTINCT fuente, '+') AS fuente, sum(km) AS km, sum(comb) AS comb, sum(mant) AS mant, sum(viajes) AS viajes, round(sum(kg) / 1000.0, 1) AS ton
      FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta GROUP BY mes) z))
  INTO v_cov;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'corte', v_cut, 'meses', v_meses, 'params', pr,
    'medianas', jsonb_build_object('costo_tkm', med_tkm, 'mant_km', med_mkm, 'costo_hora', med_ch),
    'kpis', v_kpi, 'precio_anio', v_years, 'transporte', v_tr, 'equipos', v_eq, 'cobertura', v_cov);
END $$;

-- Panel mensual por activo (tabla y exportación)
CREATE OR REPLACE FUNCTION public.fe_mensual(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_desde date; v_hasta date; v_corte jsonb; v_rows jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  v_desde := date_trunc('month', COALESCE(NULLIF(p ->> 'desde', '')::date, st.desde))::date;
  v_hasta := date_trunc('month', COALESCE(NULLIF(p ->> 'hasta', '')::date, CURRENT_DATE))::date;
  v_corte := public.fe_build(v_desde, v_hasta);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', m.code, 'clase', a.clase, 'mes', m.mes, 'fuente', m.fuente, 'km', m.km, 'gal', round(m.gal, 2),
           'comb', round(m.comb, 2), 'mant', round(m.mant, 2), 'mant_cubierto', m.mant_cubierto, 'viajes', m.viajes, 'kg', round(m.kg), 'tkm', round(m.tkm),
           'm3', round(m.m3, 3), 'dias_fuera', m.dias_fuera, 'sin_peso', m.sin_peso, 'kmgal', round(m.km / NULLIF(m.gal, 0), 2),
           'costo_km', round((COALESCE(m.comb, 0) + COALESCE(m.mant, 0)) / NULLIF(m.km, 0), 3)) ORDER BY m.code, m.mes), '[]')
  INTO v_rows FROM fe_pm m JOIN fe_a a ON a.code = m.code WHERE m.mes BETWEEN v_desde AND v_hasta;
  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'corte', v_corte, 'filas', v_rows);
END $$;

-- Rutas y carga
CREATE OR REPLACE FUNCTION public.fe_rutas(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_desde date; v_hasta date; v_cut jsonb; v_corte date; v_mes jsonb; v_act jsonb; v_un jsonb; v_desc jsonb; v_prov jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  v_desde := date_trunc('month', COALESCE(NULLIF(p ->> 'desde', '')::date, st.desde))::date;
  v_hasta := date_trunc('month', COALESCE(NULLIF(p ->> 'hasta', '')::date, CURRENT_DATE))::date;
  v_cut := public.fe_build(v_desde, v_hasta);
  v_corte := (v_cut ->> 'rutas')::date;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'viajes', viajes, 'ton', ton, 'fuente', fuente) ORDER BY mes), '[]') INTO v_mes
  FROM (SELECT mes, sum(viajes) AS viajes, round(sum(kg) / 1000.0, 1) AS ton, string_agg(DISTINCT fuente, '+') AS fuente
        FROM fe_pm WHERE viajes > 0 AND mes BETWEEN v_desde AND v_hasta GROUP BY mes) z;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'tipo', tipo, 'viajes', viajes, 'ton', ton, 'kg_viaje', kg_viaje, 'm3', m3, 'km_viaje', km_viaje, 'sin_peso', sin_peso) ORDER BY ton DESC NULLS LAST), '[]') INTO v_un
  FROM (SELECT m.code, max(a.tipo) AS tipo, sum(m.viajes) AS viajes, round(sum(m.kg) / 1000.0, 1) AS ton,
          round(sum(m.kg) / NULLIF(sum(m.viajes) - sum(m.sin_peso), 0)) AS kg_viaje, round(avg(m.m3), 3) AS m3,
          round(sum(m.km_viajes) / NULLIF(sum(m.viajes), 0), 1) AS km_viaje, sum(m.sin_peso) AS sin_peso
        FROM fe_pm m JOIN fe_a a ON a.code = m.code WHERE m.viajes > 0 AND m.mes BETWEEN v_desde AND v_hasta GROUP BY m.code) z;
  -- Actividad, tipo de descarga y destinos: detalle de la historia; los despachos del TMS cuentan como "Despacho TMS"
  SELECT COALESCE(jsonb_agg(jsonb_build_object('t', t, 'viajes', n, 'ton', ton) ORDER BY n DESC), '[]') INTO v_act FROM (
    SELECT COALESCE(NULLIF(actividad, ''), 'SIN DATO') AS t, count(*) AS n, round(sum(kg) / 1000.0, 1) AS ton FROM public.fe_trips
    WHERE fecha >= v_desde AND fecha < LEAST(v_corte, (v_hasta + interval '1 month')::date) GROUP BY 1
    UNION ALL SELECT 'DESPACHO TMS', sum(viajes), round(sum(kg) / 1000.0, 1) FROM fe_pm WHERE fuente LIKE '%TMS%' AND mes >= v_corte AND mes BETWEEN v_desde AND v_hasta AND viajes > 0 HAVING sum(viajes) > 0) z;
  SELECT COALESCE(jsonb_object_agg(d, n), '{}') INTO v_desc FROM (
    SELECT CASE WHEN descarga LIKE 'MONTACARG%' THEN 'Montacargas' WHEN descarga LIKE 'MANUAL%' THEN 'Manual' WHEN descarga LIKE 'GR%' THEN 'Grúa' ELSE 'Sin dato' END AS d, count(*) AS n
    FROM public.fe_trips WHERE fecha >= v_desde AND fecha < LEAST(v_corte, (v_hasta + interval '1 month')::date) GROUP BY 1) z;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('provincia', pv, 'viajes', n) ORDER BY n DESC), '[]') INTO v_prov FROM (
    SELECT COALESCE(NULLIF(provincia, ''), 'Sin dato') AS pv, count(*) AS n FROM public.fe_trips
    WHERE fecha >= v_desde AND fecha < LEAST(v_corte, (v_hasta + interval '1 month')::date) GROUP BY 1 ORDER BY 2 DESC LIMIT 8) z;
  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'corte', v_cut, 'mensual', v_mes, 'unidades', v_un,
    'actividad', v_act, 'descarga', v_desc, 'provincias', v_prov,
    'espera_mediana', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY espera_h) FROM public.fe_trips WHERE fecha >= v_desde AND espera_h IS NOT NULL));
END $$;

-- Recambios: periodo de actividad de cada activo (toda la historia y el TMS)
CREATE OR REPLACE FUNCTION public.fe_recambios()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_corte jsonb; v jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  v_corte := public.fe_build(DATE '2000-01-01', CURRENT_DATE);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', a.code, 'nombre', a.nombre, 'clase', a.clase, 'tipo', a.tipo, 'anio_fab', a.anio_fab, 'activo', a.activo,
           'desde', z.desde, 'hasta', z.hasta, 'meses', z.meses) ORDER BY a.clase DESC, z.desde, a.code), '[]')
  INTO v FROM fe_a a JOIN (
    SELECT code, min(mes) AS desde, max(mes) AS hasta, count(*) AS meses FROM fe_pm
    WHERE COALESCE(km, 0) > 0 OR COALESCE(gal, 0) > 0 OR COALESCE(viajes, 0) > 0 OR COALESCE(mant, 0) > 0 GROUP BY code) z ON z.code = a.code;
  RETURN jsonb_build_object('success', true, 'corte', v_corte, 'hoy', CURRENT_DATE, 'activos', v);
END $$;

-- Datos: parámetros, activos, cargas y calidad de los registros del TMS
CREATE OR REPLACE FUNCTION public.fe_datos()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_cut jsonb; v_cc date; v_cr date; v_gaps jsonb := '[]'::jsonb; n int; v_veh jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  v_cut := public.fe_build(st.desde, CURRENT_DATE);
  v_cc := (v_cut ->> 'combustible')::date; v_cr := (v_cut ->> 'rutas')::date;
  -- Registros del TMS que impiden calcular (desde el corte)
  IF public.menu_col_exists('dispatch_expenses', 'fuel_odometer') THEN
    BEGIN
      EXECUTE $q$SELECT count(*) FROM public.dispatch_expenses WHERE upper(expense_type::text) IN ('COMBUSTIBLE', 'FUEL', 'DIESEL', 'GASOLINA', 'GLP')
        AND status <> 'RECHAZADO' AND fuel_odometer IS NULL AND COALESCE(expense_date, created_at::date) >= $1$q$ INTO n USING v_cc;
      IF n > 0 THEN v_gaps := v_gaps || jsonb_build_array(jsonb_build_object('fuente', 'Caja · combustible', 'problema', 'Abastecimientos sin odómetro', 'casos', n,
        'efecto', 'No se puede calcular el km del mes ni el km por galón')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  BEGIN
    SELECT COALESCE(sum(sin_peso), 0) INTO n FROM fe_pm WHERE mes >= v_cr AND fuente LIKE '%TMS%';
    IF n > 0 THEN v_gaps := v_gaps || jsonb_build_array(jsonb_build_object('fuente', 'Despacho · documentos', 'problema', 'Despachos sin guías con peso', 'casos', n,
      'efecto', 'No suman toneladas: asocie las guías en el Asistente Documentario')); END IF;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  SELECT count(*) INTO n FROM fe_a a WHERE a.clase <> 'TRANSPORTE' AND a.activo
    AND NOT EXISTS (SELECT 1 FROM fe_hr h WHERE h.code = a.code AND h.fecha >= CURRENT_DATE - 45);
  IF n > 0 THEN v_gaps := v_gaps || jsonb_build_array(jsonb_build_object('fuente', 'Horómetro', 'problema', 'Equipos sin lectura de horómetro en los últimos 45 días', 'casos', n,
    'efecto', 'No se puede medir el costo por hora: registre una lectura al mes')); END IF;
  SELECT count(*) INTO n FROM fe_a WHERE solo_tms;
  IF to_regclass('public.vehicles') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', plate, 'type', type) ORDER BY plate), '[]') FROM public.vehicles WHERE plate IS NOT NULL$q$ INTO v_veh;
    EXCEPTION WHEN OTHERS THEN v_veh := '[]'::jsonb; END;
  END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.fe_can_load(), 'corte', v_cut,
    'settings', jsonb_build_object('desde', st.desde, 'corte', st.corte, 'params', st.params, 'updated_at', st.updated_at),
    'activos', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.clase DESC, x.code), '[]') FROM public.fe_assets x),
    'unidades_tms', v_veh,
    'cargas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'archivo', file_name, 'estado', status, 'fecha', COALESCE(applied_at, created_at), 'resumen', summary) ORDER BY created_at DESC), '[]')
               FROM (SELECT * FROM public.fe_uploads WHERE status <> 'CARGANDO' ORDER BY created_at DESC LIMIT 15) u),
    'calidad_excel', (SELECT summary -> 'calidad' FROM public.fe_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1),
    'calidad_tms', v_gaps,
    'lecturas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', asset_code, 'fecha', fecha, 'horas', horas, 'nota', nota) ORDER BY fecha DESC), '[]')
                 FROM (SELECT * FROM public.fe_hour_readings ORDER BY fecha DESC, id DESC LIMIT 40) r),
    'cobertura', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'mes', mes, 'k', km > 0, 'c', gal > 0, 'm', mant > 0, 'mc', mant_cubierto, 'r', viajes > 0, 'f', fuente) ORDER BY code, mes), '[]')
                  FROM fe_pm WHERE mes >= st.desde));
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fe_upload_begin(text)', 'fe_upload_rows(uuid,text,jsonb)', 'fe_upload_discard(uuid)', 'fe_upload_apply(uuid)', 'fe_save_settings(jsonb)',
    'fe_save_asset(jsonb)', 'fe_save_hours(text,date,numeric,text)', 'fe_resumen(jsonb)', 'fe_mensual(jsonb)', 'fe_rutas(jsonb)', 'fe_recambios()', 'fe_datos()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
