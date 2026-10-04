-- 20261004160000_mant_fase2_3.sql
-- Plan de mantenimiento — Fases 2 y 3.
--
-- Fase 2
-- * Flota: CFO 930 (camión grúa), CJS 716 (camioneta) y el semirremolque ARB 976 (antes solo dentro de "BCW838/ARB976")
--   se registran si no existen. Odómetro de las unidades de transporte: se sube a la última lectura del Excel (nunca baja).
-- * Planes preventivos de cada unidad creados desde mant_plan_templates, con la última ejecución tomada del historial
--   (patrón del servicio). Quedan INACTIVOS hasta que Mantenimiento valide la línea base (mant_validar_planes):
--   el Excel termina en junio y activarlos directo haría que el programador diario generara OT falsas por vencimiento.
-- Fase 3
-- * Reparación mayor: una OT correctiva de más de S/ 5.000 (mant_settings) no se aprueba ni se inicia sin cotización
--   aprobada (disparador; no cambia las funciones de OT).
-- * Gasto de mantenimiento pagado por Caja (categorías MANTENIMIENTO y NEUMATICOS) entra al historial de la unidad;
--   los que no tienen unidad se listan y se asignan (mant_asignar_gasto, solo si no tenían placa).
-- * Plan anual (mant_plan_anual): servicios proyectados por mes según el uso real, costo de referencia del historial,
--   reserva de correctivo, real del año e indicadores.
-- * Eficiencia de Flota: las fallas se leen de maintenance_requests (fuente única).
-- Defensivo frente a producción: columnas por to_jsonb / information_schema, tablas por to_regclass.

BEGIN;

-- ------------------------------------------------------------
-- 0. Parámetros y plantillas (patrón de última ejecución, costo y jerarquía)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mant_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  umbral_cotizacion numeric NOT NULL DEFAULT 5000,
  meta_correctivo numeric NOT NULL DEFAULT 25,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.mant_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.mant_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mant_settings_read ON public.mant_settings;
CREATE POLICY mant_settings_read ON public.mant_settings FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.mant_settings TO authenticated;

ALTER TABLE public.mant_plan_templates ADD COLUMN IF NOT EXISTS patron text;      -- regex sobre el detalle del gasto
ALTER TABLE public.mant_plan_templates ADD COLUMN IF NOT EXISTS costo_ref numeric; -- respaldo si el historial no tiene el servicio
ALTER TABLE public.mant_plan_templates ADD COLUMN IF NOT EXISTS incluye text;      -- servicio que este reemplaza (B incluye A)

UPDATE public.mant_plan_templates t SET patron = x.patron, costo_ref = x.costo, incluye = x.incluye
FROM (VALUES
  ('PESADO_DIESEL', 'Servicio A', 'ACEITE (DE |DEL |PARA )?MOTOR|CAMBIO DE ACEITE|FILTROS? DE ACEITE', 950, NULL),
  ('PESADO_DIESEL', 'Servicio B', 'FILTROS? DE AIRE', 1500, 'Servicio A'),
  ('PESADO_DIESEL', 'Servicio C', 'ACEITE DE CAJA|CORONA|DIFERENCIAL|REFRIGERANTE', 3000, 'Servicio B'),
  ('TRACTO', 'Servicio A', 'ACEITE (DE |DEL |PARA )?MOTOR|CAMBIO DE ACEITE|FILTROS? DE ACEITE', 2600, NULL),
  ('TRACTO', 'Servicio B', 'FILTROS? DE AIRE|SECADOR', 3500, 'Servicio A'),
  ('TRACTO', 'Caja y diferencial', 'ACEITE DE CAJA|ACEITE (SINTETICO )?DE TRANSMISI|DIFERENCIAL|HIDROLINA', 4000, NULL),
  ('SEMIRREMOLQUE', 'Servicio trimestral', 'ZAPATA|CARRETA|SEMIRREMOLQUE', 800, NULL),
  ('SEMIRREMOLQUE', 'Servicio anual', 'RODAJE|RODAMIENTO|\mEJES?\M|MUELLE', 2500, NULL),
  ('CAMION_ANTIGUO', 'Servicio A', 'ACEITE (DE |DEL |PARA )?MOTOR|CAMBIO DE ACEITE|FILTROS? DE ACEITE', 400, NULL),
  ('CAMION_ANTIGUO', 'Servicio B', 'FILTROS? DE (AIRE|COMBUSTIBLE|PETR[OÓ]LEO)', 600, 'Servicio A'),
  ('CAMION_ANTIGUO', 'Servicio C', 'ACEITE DE CAJA|CORONA|DIFERENCIAL', 1500, 'Servicio B'),
  ('LIVIANO', 'Servicio A', 'ACEITE (DE |DEL |PARA )?MOTOR|CAMBIO DE ACEITE|FILTROS? DE ACEITE', 450, NULL),
  ('LIVIANO', 'Servicio B', 'FILTROS? DE AIRE|SISTEMA DE GAS|\mGLP\M', 700, 'Servicio A'),
  ('LIVIANO', 'Servicio C', 'BUJ[IÍ]A|PASTILLA|ALINEA', 900, 'Servicio B'),
  ('MONTACARGA_IC', 'Servicio 250 h', 'ACEITE (DE |DEL |PARA )?MOTOR|CAMBIO DE ACEITE|FILTROS? DE ACEITE', 450, NULL),
  ('MONTACARGA_IC', 'Servicio 500 h', 'FILTROS? DE AIRE|BUJ[IÍ]A|CADENA', 700, 'Servicio 250 h'),
  ('MONTACARGA_IC', 'Servicio 1.000 h', 'FILTRO HIDR|TRANSMISI|L[IÍ]QUIDO DE FRENO', 1200, 'Servicio 500 h'),
  ('MONTACARGA_IC', 'Servicio 2.000 h', 'ACEITE HIDR|REFRIGERANTE', 2000, 'Servicio 1.000 h'),
  ('ELEVACION_ELECTRICA', 'Mensual', 'BATER|AGUA (DESTILADA|ACIDULADA)', 150, NULL),
  ('ELEVACION_ELECTRICA', 'Trimestral', 'MANTENIMIENTO PREVENTIVO|HIDR[AÁ]UL|SELLO', 600, NULL),
  ('ELEVACION_ELECTRICA', 'Anual', 'CERTIFIC|HOMOLOG', 1200, NULL)
) AS x(familia, servicio, patron, costo, incluye)
WHERE t.familia = x.familia AND t.servicio = x.servicio;

-- Montacargas: 250 h o 3 meses (no 45 días): con 300–1.400 h al año el límite por calendario daba 8 cambios anuales
UPDATE public.mant_plan_templates t SET frecuencia_dias = x.dias
FROM (VALUES ('Servicio 250 h', 90), ('Servicio 500 h', 180), ('Servicio 1.000 h', 365), ('Servicio 2.000 h', 730)) AS x(servicio, dias)
WHERE t.familia = 'MONTACARGA_IC' AND t.servicio = x.servicio;

-- ------------------------------------------------------------
-- 1. Flota: unidades faltantes y odómetro desde el historial
-- ------------------------------------------------------------
DO $$
DECLARE r record; v_carrier uuid; v_vid uuid;
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  BEGIN
    EXECUTE $q$SELECT id FROM public.carriers ORDER BY (upper(COALESCE(type::text, '')) = 'PROPIO') DESC, created_at NULLS LAST LIMIT 1$q$ INTO v_carrier;
  EXCEPTION WHEN OTHERS THEN v_carrier := NULL; END;
  FOR r IN SELECT * FROM (VALUES
      ('CFO930', 'CFO 930', 'CAMION', 'Camión grúa', 'PESADO_DIESEL'),
      ('CJS716', 'CJS 716', 'CAMIONETA', 'Camioneta', 'LIVIANO'),
      ('ARB976', 'ARB 976', 'SEMIRREMOLQUE', 'Semirremolque / plataforma del tracto BCW 838', 'SEMIRREMOLQUE')) AS x(plate, k, tipo, modelo, familia)
  LOOP
    BEGIN
      EXECUTE 'SELECT id FROM public.vehicles WHERE public.fe_code(plate) = $1 AND upper(plate) !~ ''/'' LIMIT 1' INTO v_vid USING r.k;
      IF v_vid IS NULL AND v_carrier IS NOT NULL THEN
        EXECUTE 'INSERT INTO public.vehicles (plate, carrier_id, type, model) VALUES ($1, $2, $3, $4) RETURNING id' INTO v_vid USING r.plate, v_carrier, r.tipo, r.modelo;
        INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('fase2', r.k || ': registrada en Flota como ' || r.plate);
      END IF;
      IF v_vid IS NOT NULL THEN
        INSERT INTO public.mant_asset_familia (vehicle_id, familia, nota) VALUES (v_vid, r.familia, 'fase 2') ON CONFLICT (vehicle_id) DO NOTHING;
        UPDATE public.fe_assets SET vehicle_id = v_vid WHERE code = r.k AND vehicle_id IS NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('fase2', r.k || ': error ' || SQLERRM);
    END;
  END LOOP;
END $$;

-- Vínculo persistente ficha de Eficiencia de Flota ↔ unidad de Flota por placa (antes solo se calculaba al vuelo)
DO $$
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  EXECUTE $q$UPDATE public.fe_assets a SET vehicle_id = z.id FROM (
      SELECT public.fe_code(v.plate) AS k, (array_agg(v.id ORDER BY v.plate))[1] AS id, count(*) AS n FROM public.vehicles v GROUP BY 1) z
    WHERE a.vehicle_id IS NULL AND z.k = a.code AND z.n = 1$q$;
END $$;

-- Odómetro: última lectura de km del Excel (por fecha) si supera la de Flota
DO $$
DECLARE r record; v_has_logs boolean := to_regclass('public.vehicle_odometer_logs') IS NOT NULL;
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  FOR r IN EXECUTE $q$
    SELECT v.id, v.plate, COALESCE(NULLIF(to_jsonb(v) ->> 'current_odometer', '')::numeric, 0) AS odo, z.km, z.fecha
    FROM public.vehicles v
    JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
    JOIN public.mant_familias f ON f.code = af.familia AND f.lectura = 'KM'
    JOIN public.fe_assets a ON a.vehicle_id = v.id
    JOIN LATERAL (SELECT m.km_hrs AS km, m.fecha FROM public.fe_maint m WHERE m.asset_code = a.code AND m.km_hrs > 1000 AND m.fecha IS NOT NULL
                  ORDER BY m.fecha DESC, m.id DESC LIMIT 1) z ON true$q$
  LOOP
    BEGIN
      IF r.km > r.odo AND r.km < 2000000 THEN
        EXECUTE 'UPDATE public.vehicles SET current_odometer = $1 WHERE id = $2' USING r.km, r.id;
        IF v_has_logs THEN
          EXECUTE 'INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, source_event, status, notes) VALUES ($1, $2, ''HISTORIAL_EXCEL'', ''VALIDADO'', $3)'
            USING r.plate, r.km, 'Última lectura del historial de mantenimiento (' || to_char(r.fecha, 'DD/MM/YYYY') || ')';
        END IF;
        INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('odometro', r.plate || ': ' || r.odo || ' → ' || r.km || ' km');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('odometro', r.plate || ': error ' || SQLERRM);
    END;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. Planes desde las plantillas (inactivos hasta validar)
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS mant_template_id bigint;
ALTER TABLE public.maintenance_plans ADD COLUMN IF NOT EXISTS mant_base_origen text;

-- ¿El detalle de un gasto corresponde al servicio? (rellenar o completar aceite no es un cambio)
CREATE OR REPLACE FUNCTION public.mant_es_servicio(p_detalle text, p_patron text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_patron IS NOT NULL AND upper(COALESCE(p_detalle, '')) ~ p_patron AND upper(COALESCE(p_detalle, '')) !~ 'RELLEN|COMPLETAD|COMPLETO DE ACEITE';
$$;

-- Última ejecución de un servicio en el historial del Excel de la unidad
CREATE OR REPLACE FUNCTION public.mant_ultimo_servicio(p_vehicle_id uuid, p_patron text)
RETURNS TABLE (fecha date, lectura numeric, detalle text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.fecha, m.km_hrs, m.detalle FROM public.fe_maint m
  WHERE m.fecha IS NOT NULL AND m.fecha > DATE '1990-01-01'
    AND m.asset_code IN (SELECT a.code FROM public.fe_assets a WHERE a.vehicle_id = p_vehicle_id)
    AND public.mant_es_servicio(m.detalle, p_patron)
  ORDER BY m.fecha DESC, m.id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.mant_ultimo_servicio(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mant_crear_planes(p_vehicle_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; u record; n int := 0; v_km numeric; v_h numeric; v_fecha date; v_origen text;
BEGIN
  IF to_regclass('public.maintenance_plans') IS NULL THEN RETURN 0; END IF;
  FOR r IN EXECUTE $q$
    SELECT v.id, v.plate, COALESCE(NULLIF(to_jsonb(v) ->> 'current_odometer', '')::numeric, 0) AS odo,
           COALESCE(NULLIF(to_jsonb(v) ->> 'current_hours', '')::numeric, 0) AS hrs,
           t.id AS tid, t.servicio, t.frecuencia_km, t.frecuencia_horas, t.frecuencia_dias, t.tareas, t.patron, f.nombre AS fam, f.lectura
    FROM public.vehicles v
    JOIN public.mant_asset_familia af ON af.vehicle_id = v.id
    JOIN public.mant_familias f ON f.code = af.familia
    JOIN public.mant_plan_templates t ON t.familia = af.familia AND t.activo
    WHERE ($1 IS NULL OR v.id = $1)
      AND upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'
      AND NOT EXISTS (SELECT 1 FROM public.maintenance_plans p WHERE p.vehicle_plate = v.plate AND p.mant_template_id = t.id)$q$ USING p_vehicle_id
  LOOP
    SELECT s.fecha, s.lectura, s.detalle INTO u FROM public.mant_ultimo_servicio(r.id, r.patron) s;
    v_fecha := u.fecha;
    v_km := CASE WHEN r.frecuencia_km IS NOT NULL AND u.lectura IS NOT NULL AND r.lectura = 'KM' THEN LEAST(u.lectura, r.odo) END;
    v_h := CASE WHEN r.frecuencia_horas IS NOT NULL AND u.lectura IS NOT NULL AND r.lectura = 'HORAS' THEN LEAST(u.lectura, r.hrs) END;
    v_origen := CASE WHEN u.fecha IS NOT NULL THEN 'Historial ' || to_char(u.fecha, 'DD/MM/YYYY') || ': ' || left(COALESCE(u.detalle, ''), 120)
                     ELSE 'Sin registro en el historial: confirmar la última ejecución' END;
    BEGIN
      INSERT INTO public.maintenance_plans (vehicle_plate, name, activity_description, frequency_km, frequency_hours, frequency_days,
        last_performed_km, last_performed_hours, last_performed_date, standard_tasks, expected_parts, is_active, mant_template_id, mant_base_origen)
      VALUES (r.plate, r.servicio, r.fam || ' — ' || (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(r.tareas) x),
        r.frecuencia_km, r.frecuencia_horas, r.frecuencia_dias, v_km, v_h, v_fecha,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('description', x)), '[]') FROM jsonb_array_elements_text(r.tareas) x), '[]'::jsonb,
        false, r.tid, v_origen);
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('plan', r.plate || ' ' || r.servicio || ': error ' || SQLERRM);
    END;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.mant_crear_planes(uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE n int;
BEGIN
  n := public.mant_crear_planes(NULL);
  INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('plan', n || ' planes creados (inactivos hasta validar)');
END $$;

-- Planes de una unidad (para validar) y validación/activación
CREATE OR REPLACE FUNCTION public.mant_planes_unidad(p_plate text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; r jsonb;
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-planes') OR public.menu_has_permission('mantenimiento-flota')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  EXECUTE 'SELECT id, plate, NULLIF(to_jsonb(vehicles) ->> ''current_odometer'', '''')::numeric AS odo, NULLIF(to_jsonb(vehicles) ->> ''current_hours'', '''')::numeric AS hrs FROM public.vehicles WHERE upper(plate) = upper($1)'
    INTO v USING btrim(p_plate);
  IF v.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada'); END IF;
  EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'nombre', p.name, 'km', p.frequency_km, 'horas', p.frequency_hours, 'dias', p.frequency_days,
      'ultima_fecha', p.last_performed_date, 'ultima_km', NULLIF(to_jsonb(p) ->> 'last_performed_km', '')::numeric,
      'ultima_horas', NULLIF(to_jsonb(p) ->> 'last_performed_hours', '')::numeric, 'activo', p.is_active,
      'origen', p.mant_base_origen, 'plantilla', p.mant_template_id IS NOT NULL) ORDER BY p.mant_template_id NULLS LAST, p.name), '[]')
    FROM public.maintenance_plans p WHERE p.vehicle_plate = $1$q$ INTO r USING v.plate;
  RETURN jsonb_build_object('success', true, 'plate', v.plate, 'odometro', v.odo, 'horometro', v.hrs, 'planes', r);
END $$;

CREATE OR REPLACE FUNCTION public.mant_validar_planes(p_plate text, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it jsonb; v_plate text; n int := 0; v_err jsonb := '[]'::jsonb; v_who text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.menu_has_permission('mantenimiento-planes') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para validar planes (Mantenimiento › Preventivos)');
  END IF;
  EXECUTE 'SELECT plate FROM public.vehicles WHERE upper(plate) = upper($1)' INTO v_plate USING btrim(p_plate);
  IF v_plate IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada'); END IF;
  BEGIN
    EXECUTE 'SELECT COALESCE(NULLIF(btrim(concat_ws('' '', to_jsonb(p) ->> ''first_name'', to_jsonb(p) ->> ''last_name'')), ''''), to_jsonb(p) ->> ''full_name'', to_jsonb(p) ->> ''email'') FROM public.profiles p WHERE p.id = $1'
      INTO v_who USING auth.uid();
  EXCEPTION WHEN OTHERS THEN v_who := NULL; END;
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    BEGIN
      UPDATE public.maintenance_plans SET
        last_performed_date  = COALESCE(NULLIF(it ->> 'fecha', '')::date, last_performed_date),
        last_performed_km    = COALESCE(NULLIF(it ->> 'km', '')::numeric, last_performed_km),
        last_performed_hours = COALESCE(NULLIF(it ->> 'horas', '')::numeric, last_performed_hours),
        is_active            = COALESCE((it ->> 'activo')::boolean, true),
        mant_base_origen     = 'Validado por ' || COALESCE(v_who, 'Mantenimiento') || ' el ' || to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM/YYYY')
      WHERE id = (it ->> 'id')::uuid AND vehicle_plate = v_plate;
      IF FOUND THEN n := n + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_err := v_err || jsonb_build_object('id', it ->> 'id', 'error', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('success', jsonb_array_length(v_err) = 0, 'validados', n, 'errores', v_err,
    'error', CASE WHEN jsonb_array_length(v_err) > 0 THEN v_err -> 0 ->> 'error' END);
END $$;

-- ------------------------------------------------------------
-- 3. Reparación mayor: cotización obligatoria sobre el umbral
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_trg_ot_umbral()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); o jsonb := to_jsonb(OLD); v_monto numeric; v_umbral numeric; v_ok boolean := false;
BEGIN
  IF COALESCE(n ->> 'status', '') IS NOT DISTINCT FROM COALESCE(o ->> 'status', '')
     OR upper(COALESCE(n ->> 'status', '')) NOT IN ('APROBADA', 'PROGRAMADA', 'EN_PROCESO')
     OR upper(COALESCE(n ->> 'order_type', n ->> 'type', '')) ~ 'PREVENT' THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT umbral_cotizacion INTO v_umbral FROM public.mant_settings WHERE id = 1;
    v_monto := GREATEST(COALESCE(NULLIF(n ->> 'estimated_cost_pen', '')::numeric, 0), COALESCE(NULLIF(n ->> 'estimated_cost', '')::numeric, 0),
                        COALESCE(NULLIF(n ->> 'total_cost', '')::numeric, 0));
    IF NULLIF(n ->> 'approved_quote_id', '') IS NOT NULL THEN v_ok := true;
    ELSIF to_regclass('public.service_quotes') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.service_quotes WHERE work_order_id = $1 AND status = ''APROBADA'')' INTO v_ok USING (n ->> 'id')::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- ante un dato inesperado no se bloquea la OT
  END;
  IF v_monto > COALESCE(v_umbral, 5000) AND NOT v_ok THEN
    RAISE EXCEPTION 'Reparación mayor: la OT correctiva suma S/ % y supera el umbral de S/ %. Registre y apruebe una cotización del proveedor y revise la decisión de Eficiencia de Flota de la unidad (Flota 360 › Resumen) antes de aprobarla o iniciarla.',
      to_char(v_monto, 'FM999G999G990D00'), to_char(COALESCE(v_umbral, 5000), 'FM999G999G990')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS mant_ot_umbral ON public.maintenance_work_orders;
    CREATE TRIGGER mant_ot_umbral BEFORE UPDATE ON public.maintenance_work_orders FOR EACH ROW EXECUTE FUNCTION public.mant_trg_ot_umbral();
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Historial único: Excel + OT + Caja
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_hist_rows(p_plate text)
RETURNS TABLE (fecha date, fuente text, tipo text, sistema text, monto numeric, detalle text, proveedor text, lectura numeric, ref text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; v_key text := public.fe_code(p_plate); v_codes text[]; v_corte date;
BEGIN
  EXECUTE 'SELECT id, plate FROM public.vehicles WHERE upper(plate) = upper($1) OR public.fe_code(plate) = $2 ORDER BY (upper(plate) = upper($1)) DESC LIMIT 1'
    INTO v USING btrim(p_plate), v_key;
  SELECT array_agg(a.code) INTO v_codes FROM public.fe_assets a
  WHERE (v.id IS NOT NULL AND a.vehicle_id = v.id) OR (v.id IS NULL AND a.code = v_key);
  v_codes := COALESCE(v_codes, '{}');
  SELECT max(m.fecha) INTO v_corte FROM public.fe_maint m WHERE m.asset_code = ANY (v_codes);

  RETURN QUERY SELECT m.fecha, 'Historial (Excel)'::text,
      CASE COALESCE(m.tipo_real, public.fe_tipo_real(m.tipo, m.categoria, m.detalle)) WHEN 'NEUMATICOS' THEN 'PREVENTIVO' ELSE COALESCE(m.tipo_real, public.fe_tipo_real(m.tipo, m.categoria, m.detalle)) END,
      COALESCE(m.sistema, public.mant_sistema(m.detalle, m.categoria)), m.monto, m.detalle, m.proveedor, m.km_hrs, m.factura
    FROM public.fe_maint m WHERE m.asset_code = ANY (v_codes) AND m.fecha IS NOT NULL AND m.fecha > DATE '1990-01-01';

  IF v.id IS NULL THEN RETURN; END IF;

  IF to_regclass('public.maintenance_work_orders') IS NOT NULL AND to_regclass('public.work_order_costs') IS NOT NULL THEN
    BEGIN
      RETURN QUERY EXECUTE $q$
        SELECT z.* FROM (SELECT
          COALESCE(NULLIF(to_jsonb(o) ->> 'closed_at', '')::timestamptz, NULLIF(to_jsonb(o) ->> 'actual_end_date', '')::timestamptz,
                   NULLIF(to_jsonb(o) ->> 'start_date', '')::timestamptz, NULLIF(to_jsonb(o) ->> 'created_at', '')::timestamptz)::date AS fecha,
          'OT del sistema'::text,
          CASE WHEN upper(COALESCE(to_jsonb(o) ->> 'order_type', to_jsonb(o) ->> 'type', '')) ~ 'PREVENT' THEN 'PREVENTIVO'
               WHEN upper(COALESCE(to_jsonb(o) ->> 'order_type', to_jsonb(o) ->> 'type', '')) ~ 'MEJORA' THEN 'MEJORA' ELSE 'CORRECTIVO' END,
          COALESCE(NULLIF(to_jsonb(o) ->> 'sistema', ''), public.mant_sistema(COALESCE(to_jsonb(o) ->> 'description', to_jsonb(o) ->> 'diagnosis'), NULL)),
          GREATEST((SELECT COALESCE(sum(c.amount), 0) FROM public.work_order_costs c WHERE c.work_order_id = o.id),
                   COALESCE(NULLIF(to_jsonb(o) ->> 'total_cost', '')::numeric, 0)),
          COALESCE(to_jsonb(o) ->> 'description', to_jsonb(o) ->> 'diagnosis'), NULL::text,
          NULLIF(to_jsonb(o) ->> 'odometer_at_start', '')::numeric,
          COALESCE(to_jsonb(o) ->> 'ot_code', to_jsonb(o) ->> 'ot_number')
        FROM public.maintenance_work_orders o
        WHERE (to_jsonb(o) ->> 'vehicle_id' = $1::text OR upper(COALESCE(to_jsonb(o) ->> 'vehicle_plate', '')) = upper($2))
          AND upper(COALESCE(to_jsonb(o) ->> 'status', '')) NOT IN ('CANCELADA', 'ANULADA')) z
        WHERE $3::date IS NULL OR z.fecha > $3$q$ USING v.id, v.plate, v_corte;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  -- Caja: gastos aprobados de mantenimiento/neumáticos de la unidad (directos o del despacho)
  IF to_regclass('public.dispatch_expenses') IS NOT NULL THEN
    BEGIN
      RETURN QUERY EXECUTE $q$
        SELECT z.* FROM (SELECT
          COALESCE(NULLIF(to_jsonb(e) ->> 'expense_date', '')::date, (e.created_at AT TIME ZONE 'America/Lima')::date) AS fecha,
          'Caja'::text, 'CORRECTIVO'::text,
          CASE WHEN public.mant_caja_categoria(e.expense_type) = 'NEUMATICOS' THEN 'LLANTAS' ELSE public.mant_sistema(e.description, NULL) END,
          COALESCE(NULLIF(to_jsonb(e) ->> 'approved_amount', '')::numeric, e.amount),
          concat_ws(': ', e.expense_type, NULLIF(e.description, '')), NULL::text, NULL::numeric, left(e.id::text, 8)
        FROM public.dispatch_expenses e
        LEFT JOIN public.dispatches d ON d.id = e.dispatch_id
        WHERE upper(COALESCE(e.status, '')) = 'APROBADO' AND public.mant_caja_categoria(e.expense_type) IS NOT NULL
          AND upper(COALESCE(NULLIF(to_jsonb(e) ->> 'vehicle_plate', ''), d.vehicle_plate, '')) = upper($1)) z
        WHERE $2::date IS NULL OR z.fecha > $2$q$ USING v.plate, v_corte;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.mant_hist_rows(text) FROM PUBLIC, anon, authenticated;

-- Categoría de mantenimiento de un gasto de Caja (MANTENIMIENTO / NEUMATICOS) o NULL
CREATE OR REPLACE FUNCTION public.mant_caja_categoria(p_tipo text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c text;
BEGIN
  IF to_regclass('public.expense_categories') IS NOT NULL THEN
    EXECUTE 'SELECT ledger_category FROM public.expense_categories WHERE code = upper($1)' INTO c USING p_tipo;
    IF c IS NOT NULL THEN RETURN CASE WHEN c IN ('MANTENIMIENTO', 'NEUMATICOS') THEN c END; END IF;
  END IF;
  RETURN CASE WHEN upper(COALESCE(p_tipo, '')) ~ 'LLANTA|NEUM' THEN 'NEUMATICOS'
              WHEN upper(COALESCE(p_tipo, '')) ~ 'REPUEST|MANTEN|REPARA|TALLER' THEN 'MANTENIMIENTO' END;
END $$;
REVOKE ALL ON FUNCTION public.mant_caja_categoria(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mant_caja_categoria(text) TO authenticated, service_role;

-- mant_historial usa ahora el historial único (incluye Caja); mismo formato de respuesta
CREATE OR REPLACE FUNCTION public.mant_historial(p_plate text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v record; v_key text := public.fe_code(p_plate); v_corte date; v_fam record;
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-ot')
          OR public.menu_has_permission('mantenimiento-finanzas') OR public.fe_can_view()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  EXECUTE 'SELECT id, plate FROM public.vehicles WHERE upper(plate) = upper($1) OR public.fe_code(plate) = $2 ORDER BY (upper(plate) = upper($1)) DESC LIMIT 1'
    INTO v USING btrim(p_plate), v_key;
  CREATE TEMP TABLE IF NOT EXISTS mh (fecha date, fuente text, tipo text, sistema text, monto numeric, detalle text, proveedor text, lectura numeric, ref text) ON COMMIT DROP;
  TRUNCATE mh;
  INSERT INTO mh SELECT * FROM public.mant_hist_rows(COALESCE(v.plate, p_plate));
  SELECT max(fecha) INTO v_corte FROM mh WHERE fuente = 'Historial (Excel)';
  SELECT f.code, f.nombre INTO v_fam FROM public.mant_asset_familia af JOIN public.mant_familias f ON f.code = af.familia WHERE af.vehicle_id = v.id;

  RETURN jsonb_build_object('success', true, 'plate', COALESCE(v.plate, p_plate), 'vehicle_id', v.id, 'corte_excel', v_corte,
    'familia', v_fam.code, 'familia_nombre', v_fam.nombre,
    'total', (SELECT COALESCE(sum(monto), 0) FROM mh),
    'ultimos_12m', (SELECT jsonb_build_object('monto', COALESCE(sum(monto), 0),
        'correctivo', COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0),
        'pct_correctivo', round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)))
      FROM mh WHERE fecha > (SELECT max(fecha) FROM mh) - 365),
    'por_anio', (SELECT COALESCE(jsonb_agg(jsonb_build_object('anio', a, 'preventivo', p, 'correctivo', c, 'mejora', m) ORDER BY a), '[]') FROM (
        SELECT extract(year FROM fecha)::int AS a, round(sum(monto) FILTER (WHERE tipo = 'PREVENTIVO')) AS p,
               round(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO')) AS c, round(sum(monto) FILTER (WHERE tipo = 'MEJORA')) AS m
        FROM mh GROUP BY 1) z),
    'por_sistema', (SELECT COALESCE(jsonb_agg(jsonb_build_object('sistema', z.sistema, 'nombre', s.nombre, 'monto', z.monto, 'correctivo', z.corr, 'n', z.n) ORDER BY z.monto DESC), '[]') FROM (
        SELECT sistema, round(sum(monto)) AS monto, round(COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0)) AS corr, count(*) AS n FROM mh GROUP BY 1) z
        LEFT JOIN public.mant_sistemas s ON s.code = z.sistema),
    'items', (SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.fecha DESC), '[]') FROM (SELECT * FROM mh ORDER BY fecha DESC LIMIT 300) z),
    'plan', (SELECT COALESCE(jsonb_agg(jsonb_build_object('servicio', t.servicio, 'km', t.frecuencia_km, 'horas', t.frecuencia_horas, 'dias', t.frecuencia_dias,
               'tareas', t.tareas, 'fuente', t.fuente) ORDER BY COALESCE(t.frecuencia_km, t.frecuencia_horas * 40, t.frecuencia_dias * 100)), '[]')
             FROM public.mant_plan_templates t WHERE t.familia = v_fam.code AND t.activo),
    'turnos', (SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha', t.created_at, 'tipo', t.tipo, 'horas', t.horas, 'estado', t.estado_lectura, 'fallas', t.fallas,
               'observaciones', t.observaciones, 'no_ok', (SELECT jsonb_agg(e ->> 'texto') FROM jsonb_array_elements(t.checklist) e WHERE (e ->> 'ok')::boolean = false)) ORDER BY t.created_at DESC), '[]')
             FROM (SELECT * FROM public.mant_turnos WHERE vehicle_id = v.id ORDER BY created_at DESC LIMIT 15) t));
END $$;

-- Gastos de mantenimiento de Caja sin unidad: asignar la placa (solo si no tenía)
CREATE OR REPLACE FUNCTION public.mant_asignar_gasto(p_expense_id uuid, p_plate text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plate text; n int;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('caja-aprobacion')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso');
  END IF;
  IF to_regclass('public.dispatch_expenses') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'dispatch_expenses' AND column_name = 'vehicle_plate') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Caja no admite placa en el gasto');
  END IF;
  EXECUTE 'SELECT plate FROM public.vehicles WHERE upper(plate) = upper($1)' INTO v_plate USING btrim(p_plate);
  IF v_plate IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada'); END IF;
  EXECUTE 'UPDATE public.dispatch_expenses SET vehicle_plate = $1 WHERE id = $2 AND NULLIF(btrim(COALESCE(vehicle_plate, '''')), '''') IS NULL' USING v_plate, p_expense_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Gasto no encontrado o ya tiene unidad'); END IF;
  RETURN jsonb_build_object('success', true);
END $$;

-- ------------------------------------------------------------
-- 5. Plan anual: calendario, presupuesto e indicadores
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_plan_anual(p_anio integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_anio int := COALESCE(p_anio, extract(year FROM now() AT TIME ZONE 'America/Lima')::int);
  v_ini date; v_fin date; v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; r record; tp record; v_last date; v_d date;
  v_int numeric; v_uso numeric; v_cost numeric; st record; v_res jsonb; v_kpi jsonb; v_caja jsonb := '[]'; v_ot jsonb := '[]'; i int;
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-planes') OR public.menu_has_permission('mantenimiento-dashboard')
          OR public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-finanzas')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  v_ini := make_date(v_anio, 1, 1); v_fin := make_date(v_anio, 12, 31);
  SELECT * INTO st FROM public.mant_settings WHERE id = 1;

  CREATE TEMP TABLE IF NOT EXISTS pa_u (vehicle_id uuid, plate text, familia text, fam text, lectura text, uso_anual numeric, odo numeric, hrs numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pa_h (vehicle_id uuid, fecha date, fuente text, tipo text, sistema text, monto numeric, detalle text, lectura numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pa_s (vehicle_id uuid, tid bigint, servicio text, mes int, fecha date, costo numeric, vencido boolean) ON COMMIT DROP;
  TRUNCATE pa_u; TRUNCATE pa_h; TRUNCATE pa_s;

  EXECUTE $q$INSERT INTO pa_u (vehicle_id, plate, familia, fam, lectura, odo, hrs)
    SELECT v.id, v.plate, f.code, f.nombre, f.lectura, NULLIF(to_jsonb(v) ->> 'current_odometer', '')::numeric, NULLIF(to_jsonb(v) ->> 'current_hours', '')::numeric
    FROM public.vehicles v JOIN public.mant_asset_familia af ON af.vehicle_id = v.id JOIN public.mant_familias f ON f.code = af.familia
    WHERE upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'$q$;

  FOR r IN SELECT * FROM pa_u LOOP
    INSERT INTO pa_h SELECT r.vehicle_id, h.fecha, h.fuente, h.tipo, h.sistema, h.monto, h.detalle, h.lectura FROM public.mant_hist_rows(r.plate) h;
  END LOOP;

  -- Uso anual: km de los últimos 12 meses con datos (combustible mensual) o del incremento de lecturas; horas por incremento
  UPDATE pa_u u SET uso_anual = z.uso FROM (
    SELECT u2.vehicle_id, CASE
      WHEN u2.lectura = 'KM' THEN COALESCE(
        (SELECT sum(fm.km) FROM (SELECT f.km FROM public.fe_fuel_month f JOIN public.fe_assets a ON a.code = f.asset_code
                                 WHERE a.vehicle_id = u2.vehicle_id AND f.km > 0 ORDER BY f.mes DESC LIMIT 12) fm),
        (SELECT (max(h.lectura) - min(h.lectura)) * 365.0 / NULLIF(max(h.fecha) - min(h.fecha), 0)
         FROM pa_h h WHERE h.vehicle_id = u2.vehicle_id AND h.lectura > 0 AND h.fecha > (SELECT max(fecha) FROM pa_h WHERE vehicle_id = u2.vehicle_id) - 365))
      WHEN u2.lectura = 'HORAS' THEN
        (SELECT CASE WHEN max(h.fecha) - min(h.fecha) >= 90 THEN (max(h.lectura) - min(h.lectura)) * 365.0 / (max(h.fecha) - min(h.fecha)) END
         FROM pa_h h WHERE h.vehicle_id = u2.vehicle_id AND h.lectura > 0 AND h.fuente = 'Historial (Excel)'
           AND h.fecha > (SELECT max(fecha) FROM pa_h WHERE vehicle_id = u2.vehicle_id) - 365)
      END AS uso
    FROM pa_u u2) z
  WHERE z.vehicle_id = u.vehicle_id;
  UPDATE pa_u SET uso_anual = NULL WHERE uso_anual <= 0 OR (lectura = 'KM' AND uso_anual > 250000) OR (lectura = 'HORAS' AND uso_anual > 6000);

  -- Servicios proyectados del año
  FOR r IN SELECT * FROM pa_u LOOP
    FOR tp IN SELECT * FROM public.mant_plan_templates WHERE familia = r.familia AND activo LOOP
      -- Intervalo efectivo en días: lo que ocurra primero entre uso y calendario
      v_uso := CASE WHEN r.uso_anual > 0 THEN r.uso_anual / 365.0 END;
      v_int := LEAST(COALESCE(tp.frecuencia_dias, 100000),
                     CASE WHEN tp.frecuencia_km IS NOT NULL AND r.lectura = 'KM' AND v_uso > 0 THEN tp.frecuencia_km / v_uso ELSE 100000 END,
                     CASE WHEN tp.frecuencia_horas IS NOT NULL AND r.lectura = 'HORAS' AND v_uso > 0 THEN tp.frecuencia_horas / v_uso ELSE 100000 END);
      IF v_int >= 100000 THEN CONTINUE; END IF;
      v_int := GREATEST(v_int, 7);
      -- Última ejecución: plan validado; si no, el historial
      v_last := NULL;
      IF to_regclass('public.maintenance_plans') IS NOT NULL THEN
        EXECUTE 'SELECT last_performed_date FROM public.maintenance_plans WHERE vehicle_plate = $1 AND mant_template_id = $2 AND is_active LIMIT 1' INTO v_last USING r.plate, tp.id;
      END IF;
      IF v_last IS NULL THEN SELECT s.fecha INTO v_last FROM public.mant_ultimo_servicio(r.vehicle_id, tp.patron) s; END IF;
      -- Costo de referencia: mediana de los días con ese servicio (3 años); respaldo, la plantilla
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.m) INTO v_cost FROM (
        SELECT h.fecha, sum(h.monto) AS m FROM pa_h h WHERE h.vehicle_id = r.vehicle_id AND h.tipo <> 'CORRECTIVO'
          AND public.mant_es_servicio(h.detalle, tp.patron) AND h.fecha > v_hoy - 1095 GROUP BY 1) d;
      -- El historial mezcla servicios con compras mayores (p. ej. baterías): como mucho 2 veces el costo de referencia
      v_cost := CASE WHEN v_cost IS NULL THEN COALESCE(tp.costo_ref, 0) ELSE LEAST(round(v_cost), COALESCE(tp.costo_ref * 2, round(v_cost))) END;
      v_d := COALESCE(v_last, v_hoy) + ceil(v_int)::int;
      -- Vencido a la fecha (año en curso): un servicio ahora y la cadena se reprograma desde hoy
      IF v_anio = extract(year FROM v_hoy)::int AND v_d < v_hoy THEN
        INSERT INTO pa_s VALUES (r.vehicle_id, tp.id, tp.servicio, extract(month FROM v_hoy)::int, v_hoy, v_cost, true);
        v_d := v_hoy + ceil(v_int)::int;
      END IF;
      i := 0;
      WHILE v_d <= v_fin AND i < 400 LOOP
        IF v_d >= v_ini THEN
          INSERT INTO pa_s VALUES (r.vehicle_id, tp.id, tp.servicio, extract(month FROM v_d)::int, v_d, v_cost, false);
        END IF;
        v_d := v_d + ceil(v_int)::int; i := i + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Un servicio mayor reemplaza a los que incluye en el mismo mes (B incluye A, C incluye B…)
  CREATE TEMP TABLE IF NOT EXISTS pa_inc (mayor bigint, incluido text) ON COMMIT DROP;
  TRUNCATE pa_inc;
  INSERT INTO pa_inc
  WITH RECURSIVE ch(mayor, familia, serv) AS (
    SELECT t.id, t.familia, t.incluye FROM public.mant_plan_templates t WHERE t.incluye IS NOT NULL
    UNION
    SELECT ch.mayor, ch.familia, tt.incluye FROM ch JOIN public.mant_plan_templates tt ON tt.familia = ch.familia AND tt.servicio = ch.serv WHERE tt.incluye IS NOT NULL)
  SELECT mayor, serv FROM ch;
  DELETE FROM pa_s s USING pa_s s2, pa_inc x
  WHERE s2.vehicle_id = s.vehicle_id AND s2.mes = s.mes AND x.mayor = s2.tid AND x.incluido = s.servicio;

  -- Unidades
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'vehicle_id', u.vehicle_id, 'plate', u.plate, 'familia', u.familia, 'familia_nombre', u.fam, 'lectura', u.lectura,
      'uso_anual', round(u.uso_anual), 'odometro', u.odo, 'horometro', u.hrs,
      'meses', (SELECT jsonb_agg(jsonb_build_object('mes', m, 'servicios', (SELECT COALESCE(jsonb_agg(jsonb_build_object('servicio', s.servicio, 'fecha', s.fecha, 'costo', s.costo, 'vencido', s.vencido) ORDER BY s.fecha), '[]')
                    FROM pa_s s WHERE s.vehicle_id = u.vehicle_id AND s.mes = m)) ORDER BY m) FROM generate_series(1, 12) m),
      'preventivo', (SELECT COALESCE(sum(s.costo), 0) FROM pa_s s WHERE s.vehicle_id = u.vehicle_id),
      'vencidos', (SELECT count(*) FROM pa_s s WHERE s.vehicle_id = u.vehicle_id AND s.vencido),
      'reserva_correctivo', (SELECT round(COALESCE(sum(h.monto), 0) / 2) FROM pa_h h WHERE h.vehicle_id = u.vehicle_id AND h.tipo = 'CORRECTIVO'
                              AND h.fecha > (SELECT max(fecha) FROM pa_h WHERE vehicle_id = u.vehicle_id) - 730),
      'real', (SELECT jsonb_build_object('preventivo', COALESCE(sum(h.monto) FILTER (WHERE h.tipo <> 'CORRECTIVO'), 0),
                                         'correctivo', COALESCE(sum(h.monto) FILTER (WHERE h.tipo = 'CORRECTIVO'), 0))
               FROM pa_h h WHERE h.vehicle_id = u.vehicle_id AND h.fecha BETWEEN v_ini AND v_fin),
      'pct_correctivo_12m', (SELECT round(100 * COALESCE(sum(h.monto) FILTER (WHERE h.tipo = 'CORRECTIVO'), 0) / NULLIF(sum(h.monto), 0))
                             FROM pa_h h WHERE h.vehicle_id = u.vehicle_id AND h.fecha > (SELECT max(fecha) FROM pa_h WHERE vehicle_id = u.vehicle_id) - 365),
      'mtbf_dias', (SELECT round(avg(dif)) FROM (SELECT d - lag(d) OVER (ORDER BY d) AS dif FROM (SELECT DISTINCT h.fecha AS d FROM pa_h h
                     WHERE h.vehicle_id = u.vehicle_id AND h.tipo = 'CORRECTIVO' AND h.fecha > (SELECT max(fecha) FROM pa_h WHERE vehicle_id = u.vehicle_id) - 730) x) y WHERE dif IS NOT NULL),
      'planes', CASE WHEN to_regclass('public.maintenance_plans') IS NOT NULL THEN public.mant_plan_estado(u.plate) END
    ) ORDER BY u.familia, u.plate), '[]') INTO v_res FROM pa_u u;

  -- Cumplimiento del preventivo (servicio A de motor): intervalos dentro del 10 % en los últimos 24 meses de datos
  WITH a AS (
    SELECT h.vehicle_id, h.fecha, max(h.lectura) AS lec FROM pa_h h JOIN pa_u u ON u.vehicle_id = h.vehicle_id
    JOIN public.mant_plan_templates t ON t.familia = u.familia AND t.incluye IS NULL AND t.sistema = 'MOTOR' AND (t.frecuencia_km IS NOT NULL OR t.frecuencia_horas IS NOT NULL)
    WHERE public.mant_es_servicio(h.detalle, t.patron) GROUP BY 1, 2),
  b AS (SELECT a.*, lec - lag(lec) OVER (PARTITION BY vehicle_id ORDER BY fecha) AS dl, fecha - lag(fecha) OVER (PARTITION BY vehicle_id ORDER BY fecha) AS dd FROM a),
  c AS (SELECT b.*, (SELECT COALESCE(t.frecuencia_km, t.frecuencia_horas) FROM pa_u u JOIN public.mant_plan_templates t ON t.familia = u.familia AND t.incluye IS NULL AND t.sistema = 'MOTOR'
                     WHERE u.vehicle_id = b.vehicle_id LIMIT 1) AS f FROM b WHERE dl > 0 AND fecha > v_hoy - 730)
  SELECT jsonb_build_object(
    'cumplimiento_preventivo', (SELECT round(100.0 * count(*) FILTER (WHERE dl <= f * 1.1) / NULLIF(count(*), 0)) FROM c),
    'servicios_evaluados', (SELECT count(*) FROM c)) INTO v_kpi;

  -- Caja sin unidad y OT mayores sin cotización
  IF to_regclass('public.dispatch_expenses') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'fecha', COALESCE(NULLIF(to_jsonb(e) ->> 'expense_date', '')::date, e.created_at::date),
          'tipo', e.expense_type, 'descripcion', e.description, 'monto', COALESCE(NULLIF(to_jsonb(e) ->> 'approved_amount', '')::numeric, e.amount)) ORDER BY e.created_at DESC), '[]')
        FROM public.dispatch_expenses e LEFT JOIN public.dispatches d ON d.id = e.dispatch_id
        WHERE upper(COALESCE(e.status, '')) = 'APROBADO' AND public.mant_caja_categoria(e.expense_type) IS NOT NULL
          AND NULLIF(btrim(COALESCE(to_jsonb(e) ->> 'vehicle_plate', d.vehicle_plate, '')), '') IS NULL$q$ INTO v_caja;
    EXCEPTION WHEN OTHERS THEN v_caja := '[]'; END;
  END IF;
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(z ORDER BY z.monto DESC), '[]') FROM (
        SELECT o.id, COALESCE(to_jsonb(o) ->> 'ot_code', to_jsonb(o) ->> 'ot_number') AS ot, COALESCE(v.plate, to_jsonb(o) ->> 'vehicle_plate') AS plate,
               to_jsonb(o) ->> 'status' AS estado, COALESCE(to_jsonb(o) ->> 'description', to_jsonb(o) ->> 'diagnosis') AS descripcion,
               GREATEST(COALESCE(NULLIF(to_jsonb(o) ->> 'estimated_cost_pen', '')::numeric, 0), COALESCE(NULLIF(to_jsonb(o) ->> 'total_cost', '')::numeric, 0)) AS monto,
               (NULLIF(to_jsonb(o) ->> 'approved_quote_id', '') IS NOT NULL) AS cotizada
        FROM public.maintenance_work_orders o LEFT JOIN public.vehicles v ON v.id::text = to_jsonb(o) ->> 'vehicle_id'
        WHERE upper(COALESCE(to_jsonb(o) ->> 'order_type', to_jsonb(o) ->> 'type', '')) !~ 'PREVENT'
          AND upper(COALESCE(to_jsonb(o) ->> 'status', '')) NOT IN ('CERRADA', 'CANCELADA')) z
        WHERE z.monto > $1$q$ INTO v_ot USING COALESCE(st.umbral_cotizacion, 5000);
    EXCEPTION WHEN OTHERS THEN v_ot := '[]'; END;
  END IF;

  RETURN jsonb_build_object('success', true, 'anio', v_anio, 'hoy', v_hoy, 'umbral', st.umbral_cotizacion, 'meta_correctivo', st.meta_correctivo,
    'unidades', v_res,
    'totales', jsonb_build_object(
      'preventivo', (SELECT COALESCE(sum(costo), 0) FROM pa_s),
      'reserva_correctivo', (SELECT COALESCE(sum((x ->> 'reserva_correctivo')::numeric), 0) FROM jsonb_array_elements(v_res) x),
      'real_preventivo', (SELECT COALESCE(sum(monto) FILTER (WHERE tipo <> 'CORRECTIVO'), 0) FROM pa_h WHERE fecha BETWEEN v_ini AND v_fin),
      'real_correctivo', (SELECT COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) FROM pa_h WHERE fecha BETWEEN v_ini AND v_fin),
      'por_mes', (SELECT jsonb_agg(jsonb_build_object('mes', m, 'preventivo', (SELECT COALESCE(sum(costo), 0) FROM pa_s WHERE mes = m),
                   'real', (SELECT COALESCE(sum(monto), 0) FROM pa_h WHERE fecha BETWEEN v_ini AND v_fin AND extract(month FROM fecha) = m)) ORDER BY m)
                  FROM generate_series(1, 12) m),
      'pct_correctivo_12m', (SELECT round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)) FROM pa_h WHERE fecha > (SELECT max(fecha) FROM pa_h) - 365),
      'vencidos', (SELECT count(*) FROM pa_s WHERE vencido)) || COALESCE(v_kpi, '{}'),
    'caja_sin_unidad', v_caja, 'ot_mayores', v_ot);
END $$;

-- Estado de los planes de una unidad (activos, por validar, vencidos)
CREATE OR REPLACE FUNCTION public.mant_plan_estado(p_plate text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; v_venc int := NULL;
BEGIN
  EXECUTE $q$SELECT jsonb_build_object('activos', count(*) FILTER (WHERE is_active), 'por_validar', count(*) FILTER (WHERE NOT is_active AND mant_template_id IS NOT NULL))
    FROM public.maintenance_plans WHERE vehicle_plate = $1$q$ INTO r USING p_plate;
  IF to_regclass('public.vw_maintenance_projections') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT count(*) FROM public.vw_maintenance_projections WHERE vehicle_plate = $1 AND alert_status = ''VENCIDO''' INTO v_venc USING p_plate;
    EXCEPTION WHEN OTHERS THEN v_venc := NULL; END;
  END IF;
  RETURN r || jsonb_build_object('vencidos', v_venc);
END $$;
REVOKE ALL ON FUNCTION public.mant_plan_estado(text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.mant_planes_unidad(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_validar_planes(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_asignar_gasto(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_plan_anual(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mant_planes_unidad(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_validar_planes(text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_asignar_gasto(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_plan_anual(integer) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Eficiencia de Flota: fallas desde maintenance_requests (fe_build v2 con ese único cambio)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_build(p_desde date, p_hasta date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_corte date; v_cc date; v_cm date; v_cr date; v_mh_min date; v_mh_max date; v_desde date := date_trunc('month', p_desde)::date; v_hasta date := date_trunc('month', p_hasta)::date;
  has_ledger boolean := to_regclass('public.vw_vehicle_cost_ledger') IS NOT NULL; has_veh boolean := to_regclass('public.vehicles') IS NOT NULL;
  v_amort integer;
BEGIN
  SELECT corte, GREATEST(COALESCE((params ->> 'amortizar_meses')::int, 24), 1) INTO v_corte, v_amort FROM public.fe_settings WHERE id = 1;
  SELECT date_trunc('month', min(fecha))::date, date_trunc('month', max(fecha))::date INTO v_mh_min, v_mh_max FROM public.fe_maint WHERE fecha IS NOT NULL;
  v_cc := date_trunc('month', COALESCE(v_corte, (SELECT max(mes) + interval '1 month' FROM public.fe_fuel_month)::date, v_desde))::date;
  v_cm := date_trunc('month', COALESCE(v_corte, (v_mh_max + interval '1 month')::date, v_desde))::date;
  v_cr := date_trunc('month', COALESCE(v_corte, (SELECT max(fecha) + interval '1 month' FROM public.fe_trips)::date, v_desde))::date;

  -- Activos: ficha propia + unidades de Flota que no tienen ficha; vínculo con Flota por vehicle_id, placa o código interno
  DROP TABLE IF EXISTS pg_temp.fe_a;
  CREATE TEMP TABLE fe_a ON COMMIT DROP AS
  SELECT code, COALESCE(nombre, code) AS nombre, clase, tipo, marca, anio_fab, capacidad_kg, valor_reposicion, vida_util, activo,
    public.fe_code(COALESCE(vehicle_plate, code)) AS plate_key, false AS solo_tms, vehicle_id, NULL::numeric AS cap_flota,
    public.fe_grupo(clase, tipo) AS grupo
  FROM public.fe_assets;
  IF has_veh THEN
    BEGIN
      -- vínculo automático: misma placa o mismo código interno
      EXECUTE $q$UPDATE fe_a a SET vehicle_id = v.id FROM public.vehicles v
        WHERE a.vehicle_id IS NULL AND (public.fe_code(v.plate) = a.plate_key OR upper(NULLIF(to_jsonb(v) ->> 'internal_code', '')) = upper(a.code))$q$;
      EXECUTE $q$UPDATE fe_a a SET cap_flota = NULLIF(NULLIF(to_jsonb(v) ->> 'weight_capacity', '')::numeric, 0),
          anio_fab = COALESCE(a.anio_fab, NULLIF(to_jsonb(v) ->> 'year', '')::int)
        FROM public.vehicles v WHERE v.id = a.vehicle_id$q$;
      EXECUTE $q$INSERT INTO fe_a
        SELECT public.fe_code(COALESCE(v.plate, to_jsonb(v) ->> 'internal_code')), COALESCE(v.plate, to_jsonb(v) ->> 'internal_code'),
          CASE WHEN upper(COALESCE(v.type, '')) IN ('MONTACARGAS', 'MONTACARGA', 'TRANSPALETA') THEN 'MONTACARGA' WHEN upper(COALESCE(v.type, '')) IN ('APILADOR', 'ELEVADOR', 'PLATAFORMA') THEN 'ELEVACION' ELSE 'TRANSPORTE' END,
          initcap(v.type), to_jsonb(v) ->> 'brand', NULLIF(to_jsonb(v) ->> 'year', '')::int, NULL, NULL, NULL, true,
          public.fe_code(COALESCE(v.plate, to_jsonb(v) ->> 'internal_code')), true, v.id, NULLIF(NULLIF(to_jsonb(v) ->> 'weight_capacity', '')::numeric, 0), NULL
        FROM public.vehicles v
        WHERE COALESCE(v.plate, to_jsonb(v) ->> 'internal_code') IS NOT NULL AND v.id NOT IN (SELECT vehicle_id FROM fe_a WHERE vehicle_id IS NOT NULL)$q$;
      UPDATE fe_a SET grupo = public.fe_grupo(clase, tipo) WHERE grupo IS NULL;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  DROP TABLE IF EXISTS pg_temp.fe_src;
  CREATE TEMP TABLE fe_src (code text, mes date, fuente text, km numeric, gal numeric, comb numeric, glp boolean, mant numeric, mant_amort numeric, neum_amort numeric,
    mant_corr numeric, neum numeric, otros numeric, alquiler numeric, mayores int, dias_fuera numeric, fallas int,
    viajes int, kg numeric, tkm numeric, km_viajes numeric, m3 numeric, sin_peso int, horas numeric, espera numeric, programados int,
    ayud_h numeric, viajes_h int) ON COMMIT DROP;

  -- Historia
  INSERT INTO fe_src (code, mes, fuente, km, gal, comb, glp)
  SELECT asset_code, mes, 'EXCEL', km, galones, soles, glp FROM public.fe_fuel_month WHERE mes < v_cc;
  INSERT INTO fe_src (code, mes, fuente, mant, mant_corr, neum, mayores, dias_fuera)
  SELECT asset_code, date_trunc('month', fecha)::date, 'EXCEL', sum(monto), sum(monto) FILTER (WHERE COALESCE(tipo_real, tipo) = 'CORRECTIVO'),
    sum(monto) FILTER (WHERE tipo_real = 'NEUMATICOS'), count(*) FILTER (WHERE mayor)::int,
    sum(COALESCE(NULLIF(dias_fuera, 0), CASE WHEN fecha_salida > fecha_ingreso THEN fecha_salida - fecha_ingreso END))
  FROM public.fe_maint WHERE fecha IS NOT NULL AND fecha < v_cm GROUP BY 1, 2;
  -- Mantenimiento devengado: lo amortizable se reparte en los meses siguientes
  INSERT INTO fe_src (code, mes, fuente, mant_amort, neum_amort)
  SELECT asset_code, mes, 'EXCEL', sum(v), sum(v) FILTER (WHERE neum) FROM (
    SELECT asset_code, date_trunc('month', fecha)::date AS mes, monto AS v, tipo_real = 'NEUMATICOS' AS neum FROM public.fe_maint WHERE fecha IS NOT NULL AND fecha < v_cm AND NOT amortizable
    UNION ALL
    SELECT asset_code, (date_trunc('month', fecha) + make_interval(months => k))::date, monto / v_amort, tipo_real = 'NEUMATICOS' FROM public.fe_maint, generate_series(0, v_amort - 1) k
    WHERE fecha IS NOT NULL AND fecha < v_cm AND amortizable) z
  GROUP BY 1, 2;
  INSERT INTO fe_src (code, mes, fuente, viajes, kg, tkm, km_viajes, m3, sin_peso, horas, espera, programados, ayud_h, viajes_h)
  SELECT asset_code, date_trunc('month', fecha)::date, 'EXCEL', count(*)::int, sum(kg), sum(kg / 1000.0 * km), sum(km), avg(m3), count(*) FILTER (WHERE kg IS NULL)::int,
    sum(horas), sum(espera_h), count(*) FILTER (WHERE programado)::int, sum(COALESCE(ayudantes, 1) * horas), count(*) FILTER (WHERE horas > 0)::int
  FROM public.fe_trips WHERE fecha < v_cr GROUP BY 1, 2;

  -- TMS: libro de costos del activo (Mantenimiento: OT, neumáticos, multas, siniestros y alquiler)
  IF has_ledger AND has_veh THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, mant, mant_amort, neum, neum_amort, otros, alquiler)
        SELECT a.code, date_trunc('month', (l.cost_date AT TIME ZONE 'America/Lima'))::date, 'TMS',
          sum(l.amount) FILTER (WHERE l.category IN ('MANTENIMIENTO', 'NEUMATICOS')), sum(l.amount) FILTER (WHERE l.category IN ('MANTENIMIENTO', 'NEUMATICOS')),
          sum(l.amount) FILTER (WHERE l.category = 'NEUMATICOS'), sum(l.amount) FILTER (WHERE l.category = 'NEUMATICOS'), sum(l.amount) FILTER (WHERE l.category IN ('MULTAS', 'SINIESTROS')),
          sum(l.amount) FILTER (WHERE l.category = 'ALQUILER')
        FROM public.vw_vehicle_cost_ledger l JOIN fe_a a ON a.vehicle_id = l.vehicle_id
        WHERE l.category IN ('MANTENIMIENTO', 'NEUMATICOS', 'MULTAS', 'SINIESTROS', 'ALQUILER') AND (l.cost_date AT TIME ZONE 'America/Lima')::date >= $1
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

  -- TMS: km del mes por odómetro y horómetro (bitácora de Flota por vehículo o placa, abastecimientos y despachos)
  DROP TABLE IF EXISTS pg_temp.fe_odo;
  CREATE TEMP TABLE fe_odo (code text, fecha date, odo numeric, horas numeric) ON COMMIT DROP;
  IF to_regclass('public.vehicle_odometer_logs') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, (o.created_at AT TIME ZONE 'America/Lima')::date, NULLIF(NULLIF(to_jsonb(o) ->> 'odometer_value', '')::numeric, 0),
          NULLIF(to_jsonb(o) ->> 'hours_value', '')::numeric
        FROM public.vehicle_odometer_logs o
        JOIN fe_a a ON CASE WHEN a.vehicle_id IS NOT NULL AND to_jsonb(o) ->> 'vehicle_id' IS NOT NULL THEN a.vehicle_id::text = to_jsonb(o) ->> 'vehicle_id'
                            ELSE a.plate_key = public.fe_code(to_jsonb(o) ->> 'vehicle_plate') END
        WHERE COALESCE(to_jsonb(o) ->> 'status', '') <> 'REQUIERE_AUDITORIA'$q$;
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
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, public.fe_jdate(to_jsonb(d), ARRAY['returned_at','completed_at','closed_at','finished_at'] || public.fe_desp_keys()), NULLIF(NULLIF(to_jsonb(d) ->> 'end_odometer', '')::numeric, 0), NULL
        FROM public.dispatches d JOIN fe_a a ON a.plate_key = public.fe_code(d.vehicle_plate) WHERE NULLIF(to_jsonb(d) ->> 'end_odometer', '') IS NOT NULL$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
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
          SELECT a.code, date_trunc('month', public.fe_jdate(to_jsonb(d), public.fe_desp_keys()))::date AS mes, d.id,
            COALESCE(NULLIF(%s, 0), (SELECT CASE WHEN o.fin > o.ini AND o.fin - o.ini < 1500 THEN o.fin - o.ini END FROM (SELECT NULLIF(to_jsonb(d) ->> 'start_odometer', '')::numeric AS ini, NULLIF(to_jsonb(d) ->> 'end_odometer', '')::numeric AS fin) o)) AS km,
            %s AS kg
          FROM public.dispatches d JOIN fe_a a ON a.plate_key = public.fe_code(d.vehicle_plate)
          WHERE public.fe_jdate(to_jsonb(d), public.fe_desp_keys()) >= $1 AND upper(COALESCE(to_jsonb(d) ->> 'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO', 'ANULADA', 'BORRADOR'))
        SELECT code, mes, 'TMS', count(*)::int, sum(kg), sum(kg / 1000.0 * km), sum(km), count(*) FILTER (WHERE kg IS NULL)::int FROM t GROUP BY 1, 2$q$,
        CASE WHEN public.menu_col_exists('dispatches', 'actual_distance_km') THEN 'd.actual_distance_km' ELSE 'NULL::numeric' END,
        CASE WHEN to_regclass('public.dispatch_documents') IS NOT NULL AND to_regclass('public.apt_movements') IS NOT NULL
               AND to_regprocedure('public.apt_guia_key(text)') IS NOT NULL
             THEN '(SELECT NULLIF(sum(m.peso_kg), 0) FROM public.dispatch_documents dd JOIN public.apt_movements m ON m.active AND m.valid AND m.kind = ''SALIDA'' AND public.apt_guia_key(m.documento) = public.apt_guia_key(dd.document_number) WHERE dd.dispatch_id = d.id AND dd.voided_at IS NULL AND dd.doc_type = ''GUIA_REMISION'')'
             ELSE 'NULL::numeric' END)
      USING v_cr;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- TMS: días fuera de servicio por órdenes de trabajo (vehículo vinculado)
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, dias_fuera)
        SELECT a.code, date_trunc('month', ini)::date, 'TMS', sum(GREATEST(fin - ini, 0))
        FROM (SELECT (to_jsonb(wo) ->> 'vehicle_id') AS vid, NULLIF(to_jsonb(wo) ->> 'start_date', '')::timestamptz::date AS ini,
                     COALESCE(NULLIF(to_jsonb(wo) ->> 'actual_end_date', ''), NULLIF(to_jsonb(wo) ->> 'end_date', ''))::timestamptz::date AS fin
              FROM public.maintenance_work_orders wo WHERE upper(COALESCE(to_jsonb(wo) ->> 'status', '')) NOT IN ('CANCELADA', 'CANCELADO')) w
        JOIN fe_a a ON a.vehicle_id::text = w.vid
        WHERE w.ini >= $1 AND w.fin IS NOT NULL GROUP BY 1, 2$q$ USING v_cm;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- TMS: fallas reportadas. Fuente única: maintenance_requests (vehicle_failures se eliminó en producción)
  IF to_regclass('public.maintenance_requests') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, fallas)
        SELECT a.code, date_trunc('month', public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'created_at']))::date, 'TMS', count(*)::int
        FROM public.maintenance_requests f JOIN public.vehicles v ON v.plate = f.vehicle_plate JOIN fe_a a ON a.vehicle_id = v.id
        WHERE upper(COALESCE(to_jsonb(f) ->> 'status', '')) <> 'DESCARTADA'
          AND public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'created_at']) >= $1 GROUP BY 1, 2$q$ USING v_desde;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  ELSIF to_regclass('public.vehicle_failures') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_src (code, mes, fuente, fallas)
        SELECT a.code, date_trunc('month', public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'detected_at', 'created_at']))::date, 'TMS', count(*)::int
        FROM public.vehicle_failures f JOIN fe_a a ON a.vehicle_id::text = to_jsonb(f) ->> 'vehicle_id'
        WHERE public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'detected_at', 'created_at']) >= $1 GROUP BY 1, 2$q$ USING v_desde;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Panel activo × mes (todo el periodo disponible; la ventana de análisis se aplica después)
  DROP TABLE IF EXISTS pg_temp.fe_pm;
  CREATE TEMP TABLE fe_pm ON COMMIT DROP AS
  SELECT s.code, s.mes, string_agg(DISTINCT s.fuente, '+') AS fuente,
    sum(s.km) AS km, sum(s.gal) AS gal, sum(s.comb) AS comb, bool_or(s.glp) AS glp,
    sum(s.mant) AS mant, sum(s.mant_amort) AS mant_amort, sum(s.neum_amort) AS neum_amort, sum(s.mant_corr) AS mant_corr, sum(s.neum) AS neum, sum(s.otros) AS otros, sum(s.alquiler) AS alquiler,
    sum(s.mayores)::int AS mayores, sum(s.dias_fuera) AS dias_fuera, sum(s.fallas)::int AS fallas,
    sum(s.viajes)::int AS viajes, sum(s.kg) AS kg, sum(s.tkm) AS tkm, sum(s.km_viajes) AS km_viajes, avg(s.m3) AS m3, sum(s.sin_peso)::int AS sin_peso,
    sum(s.horas) AS horas, sum(s.espera) AS espera, sum(s.programados)::int AS programados, sum(s.ayud_h) AS ayud_h, sum(s.viajes_h)::int AS viajes_h,
    (s.mes >= v_cm OR (s.mes BETWEEN v_mh_min AND v_mh_max)) AS mant_cubierto
  FROM fe_src s WHERE s.code IN (SELECT code FROM fe_a) AND s.mes <= v_hasta
  GROUP BY s.code, s.mes;
  CREATE INDEX ON fe_pm (code, mes);

  -- Lecturas de horas (horómetro): historia de mantenimiento, lecturas mensuales y bitácora de Flota
  DROP TABLE IF EXISTS pg_temp.fe_hr;
  CREATE TEMP TABLE fe_hr ON COMMIT DROP AS
  SELECT m.asset_code AS code, m.fecha, max(m.km_hrs) AS horas FROM public.fe_maint m JOIN fe_a a ON a.code = m.asset_code
  WHERE a.clase <> 'TRANSPORTE' AND m.fecha IS NOT NULL AND m.km_hrs > 0 GROUP BY 1, 2
  UNION ALL SELECT asset_code, fecha, max(horas) FROM public.fe_hour_readings GROUP BY 1, 2
  UNION ALL SELECT o.code, o.fecha, max(o.horas) FROM fe_odo o JOIN fe_a a ON a.code = o.code WHERE a.clase <> 'TRANSPORTE' AND o.horas > 0 GROUP BY 1, 2;
  RETURN jsonb_build_object('manual', v_corte, 'combustible', v_cc, 'mantenimiento', v_cm, 'rutas', v_cr);
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
