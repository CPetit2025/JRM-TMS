-- ============================================================
-- Eficiencia de Flota v2: medición corregida, decisión económica e integración con Mantenimiento
-- ============================================================
-- Revisión del análisis (docs/eficiencia-flota.md):
--   * Precio constante: el galón pasó de S/ 13 a S/ 22 en 2026; los costos se comparan al precio actual de referencia.
--   * Mantenimiento reclasificado (líneas "preventivas" que describen reparaciones) y llantas e intervenciones mayores
--     amortizadas en 24 meses (una factura grande no decide sola).
--   * Comparación por grupo (tracto, camión, liviano, grúa, montacarga, elevación), no contra la mediana de toda la flota.
--   * Vehículo vs asignación: capacidad práctica (ficha, Flota o percentil 95 del peso por viaje) y llenado.
--   * Costo total: + conductor y ayudantes (sueldos en parámetros), multas y siniestros del libro de costos.
--   * Decisión económica: costo de seguir un año más (operación + pérdida de valor + costo de capital) frente al costo
--     anual equivalente de una unidad nueva; curva de reventa del mercado de Lima y sensibilidad a la tasa (6 % y 15 %)
--     porque la tasa de la empresa es confidencial.
--   * Montacargas y elevación: costo propio por hora frente al alquiler (S/ 60 + IGV por hora).
--   * Integración con Mantenimiento: vínculo por vehículo (vehicle_id) con Flota; fallas, OT, libro de costos y horómetro
--     del activo vinculado; capacidad y año desde Flota; ficha 360 consulta fe_activo.
--   * Excel: odómetro y próximo mantenimiento (cumplimiento del preventivo), horas por viaje, espera, programado,
--     distrito, conductor y ayudantes.
-- Producción no coincide con las migraciones: las tablas del TMS se verifican antes de usarse y se leen columnas
-- opcionales con to_jsonb. Toda sentencia UPDATE/DELETE lleva WHERE (pg-safeupdate).
BEGIN;

-- ------------------------------------------------------------
-- Columnas nuevas
-- ------------------------------------------------------------
ALTER TABLE public.fe_assets ADD COLUMN IF NOT EXISTS vehicle_id uuid;
ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS prox_mantto numeric;
ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS fecha_ingreso date;
ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS fecha_salida date;
ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS tipo_real text;
ALTER TABLE public.fe_maint ADD COLUMN IF NOT EXISTS amortizable boolean NOT NULL DEFAULT false;
ALTER TABLE public.fe_trips ADD COLUMN IF NOT EXISTS programado boolean;
ALTER TABLE public.fe_trips ADD COLUMN IF NOT EXISTS distrito text;
ALTER TABLE public.fe_trips ADD COLUMN IF NOT EXISTS conductor text;
ALTER TABLE public.fe_trips ADD COLUMN IF NOT EXISTS horas numeric;
ALTER TABLE public.fe_trips ADD COLUMN IF NOT EXISTS ayudantes numeric;

-- Parámetros nuevos (los ya guardados por el usuario se conservan)
UPDATE public.fe_settings SET params = jsonb_build_object(
    'tasa_capital', 0.10, 'tasa_baja', 0.06, 'tasa_alta', 0.15,
    -- Reventa (fracción del valor nuevo): 1.er año pierde d1, luego d por año, con un piso. Calibrado con avisos de Lima
    -- (Hino 300 2021 ≈ 70 %, International 7600 2016 ≈ 50 %, 2011 ≈ 32 %; montacargas 2012 ≈ 18 %).
    'reventa', jsonb_build_object(
      'PESADO', jsonb_build_object('d1', 0.15, 'd', 0.06, 'piso', 0.25),
      'LIVIANO', jsonb_build_object('d1', 0.15, 'd', 0.08, 'piso', 0.15),
      'MONTACARGA', jsonb_build_object('d1', 0.20, 'd', 0.10, 'piso', 0.10),
      'ELEVACION', jsonb_build_object('d1', 0.20, 'd', 0.10, 'piso', 0.10)),
    -- Valor de una unidad nueva equivalente (S/ sin IGV) cuando la ficha no lo tiene: referencial, reemplazar con cotización
    'valor_ref', jsonb_build_object('TRACTO', 480000, 'CAMION', 190000, 'GRUA', 350000, 'LIVIANO', 130000, 'MONTACARGA', 110000, 'ELEVACION', 65000),
    'conductor_mes', 2700, 'ayudante_mes', 1600, 'factor_cargas', 1.0, 'horas_mes', 208,
    'alquiler_hora', 60, 'precio_ref', NULL, 'precio_ref_glp', NULL,
    'amortizar_meses', 24, 'mejora_nuevo', 0.10, 'mant_nuevo_pct', 0.03,
    'rendimiento_min', 0.85, 'factor_mant', 1.5) || params
WHERE id = 1;

-- ------------------------------------------------------------
-- Utilidades
-- ------------------------------------------------------------
-- Grupo de comparación
CREATE OR REPLACE FUNCTION public.fe_grupo(p_clase text, p_tipo text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_clase = 'MONTACARGA' THEN 'MONTACARGA' WHEN p_clase = 'ELEVACION' THEN 'ELEVACION'
              WHEN upper(COALESCE(p_tipo, '')) ~ 'TRACTO|TRAIL|SEMIRREM' THEN 'TRACTO'
              WHEN upper(COALESCE(p_tipo, '')) ~ 'GR[UÚ]A' THEN 'GRUA'
              WHEN upper(COALESCE(p_tipo, '')) ~ 'CAMIONETA|MINIVAN|COMBI|VAN|AUTO|PICK|FURG[OÓ]N' THEN 'LIVIANO'
              ELSE 'CAMION' END
$$;

-- Fracción del valor nuevo que conserva un activo a una edad dada
CREATE OR REPLACE FUNCTION public.fe_residual(p_grupo text, p_edad numeric, pr jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb := pr -> 'reventa' -> (CASE WHEN p_grupo IN ('TRACTO', 'CAMION', 'GRUA') THEN 'PESADO' ELSE p_grupo END);
  d1 numeric := COALESCE((c ->> 'd1')::numeric, 0.15); d numeric := COALESCE((c ->> 'd')::numeric, 0.07); piso numeric := COALESCE((c ->> 'piso')::numeric, 0.15);
BEGIN
  IF p_edad IS NULL THEN RETURN NULL; END IF;
  IF p_edad <= 0 THEN RETURN 1; END IF;
  RETURN GREATEST(piso, (1 - d1) * power(1 - d, p_edad - 1));
END $$;

-- Costo de seguir un año más frente al costo anual equivalente de una unidad nueva, a una tasa dada.
--   seguir(k) = mantenimiento(k) + combustible + pérdida de valor del año + tasa × valor de reventa
--   nuevo     = (valor − reventa al final de su vida descontada) × factor de recuperación + operación de una unidad nueva
-- El mantenimiento de la unidad nueva es el que tuvieron las unidades del grupo hasta los 4 años (p_mant_nuevo) o, sin ese
-- dato, un porcentaje del valor. Las llantas no entran: se gastan por km igual en una unidad nueva o usada.
-- Devuelve el ahorro anual de reemplazar hoy y en cuántos años conviene hacerlo (0 = ya).
CREATE OR REPLACE FUNCTION public.fe_econ(p_valor numeric, p_grupo text, p_edad numeric, p_vida integer, p_mant numeric, p_mant_alza numeric,
  p_comb numeric, p_tasa numeric, pr jsonb, p_mant_nuevo numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i numeric := COALESCE(p_tasa, 0); n integer := GREATEST(COALESCE(p_vida, 10), 3); crf numeric; eac numeric; o_new numeric; keep0 numeric; k integer; ck numeric; anios integer;
  mejora numeric := COALESCE((pr ->> 'mejora_nuevo')::numeric, 0.10); pct numeric := COALESCE((pr ->> 'mant_nuevo_pct')::numeric, 0.03);
  m numeric := COALESCE(p_mant, 0); c numeric := COALESCE(p_comb, 0); alza numeric := GREATEST(COALESCE(p_mant_alza, 0), 0);
BEGIN
  IF p_valor IS NULL OR p_valor <= 0 OR p_edad IS NULL THEN RETURN NULL; END IF;
  crf := CASE WHEN i = 0 THEN 1.0 / n ELSE i / (1 - power(1 + i, -n)) END;
  o_new := c * (1 - mejora) + LEAST(m, COALESCE(p_mant_nuevo, p_valor * pct));
  eac := (p_valor - p_valor * public.fe_residual(p_grupo, n, pr) * power(1 + i, -n)) * crf + o_new;
  FOR k IN 0..15 LOOP
    ck := m + alza * k + c + p_valor * (public.fe_residual(p_grupo, p_edad + k, pr) - public.fe_residual(p_grupo, p_edad + k + 1, pr))
          + i * p_valor * public.fe_residual(p_grupo, p_edad + k, pr);
    IF k = 0 THEN keep0 := ck; END IF;
    IF anios IS NULL AND ck > eac THEN anios := k; END IF;
  END LOOP;
  RETURN jsonb_build_object('seguir', round(keep0), 'nuevo', round(eac), 'ahorro', round(keep0 - eac), 'anios', anios,
    'capital_nuevo', round(eac - o_new), 'operacion_nueva', round(o_new));
END $$;

-- Reclasificación del mantenimiento del Excel: tipo real y si se amortiza
CREATE OR REPLACE FUNCTION public.fe_tipo_real(p_tipo text, p_categoria text, p_detalle text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN upper(COALESCE(p_categoria, '')) ~ 'LLANTA|NEUM' THEN 'NEUMATICOS'
              WHEN upper(COALESCE(p_tipo, '')) = 'MEJORA' THEN 'MEJORA'
              WHEN upper(COALESCE(p_tipo, '')) = 'CORRECTIVO' THEN 'CORRECTIVO'
              WHEN upper(COALESCE(p_detalle, '')) ~ 'REPARA|FALLA|AVER[IÍ]A|OVERHAUL|RECTIFIC|SINIESTRO|CHOQUE|ROTUR|FUGA|SOLDAD|(CAMBIO|REEMPLAZO) DE (CAJA|MOTOR|BOMBA|EMBRAGUE|TURBO|ALTERNADOR|ARRANCADOR|RADIADOR)' THEN 'CORRECTIVO'
              ELSE 'PREVENTIVO' END
$$;

UPDATE public.fe_fuel_month SET glp = true WHERE NOT glp AND precio > 0 AND precio < 9;
UPDATE public.fe_maint SET tipo_real = public.fe_tipo_real(tipo, categoria, detalle),
  amortizable = (upper(COALESCE(categoria, '')) ~ 'LLANTA|NEUM' OR mayor)
WHERE tipo_real IS NULL;

-- Clave de cliente: sin tildes, puntuación ni forma societaria; los envíos a JRM son traslados internos
CREATE OR REPLACE FUNCTION public.fe_cli_key(p text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN v IS NULL OR v = '' THEN NULL
              WHEN v ~ '(^| )J ?R ?M( |$)' THEN 'JRM (TRASLADO INTERNO)'
              ELSE btrim(regexp_replace(regexp_replace(' ' || v || ' ', ' (S ?A ?C ?S|S ?A ?C|S ?A ?A|S ?A|E ?I ?R ?L|S ?R ?L)(?= )', ' ', 'g'), '\s+', ' ', 'g')) END
  FROM (SELECT btrim(regexp_replace(upper(translate(COALESCE(p, ''), 'áéíóúñÁÉÍÓÚÑ', 'aeiounAEIOUN')), '[^A-Z0-9]+', ' ', 'g')) AS v) z
$$;

REVOKE ALL ON FUNCTION public.fe_econ(numeric, text, numeric, integer, numeric, numeric, numeric, numeric, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fe_econ(numeric, text, numeric, integer, numeric, numeric, numeric, numeric, jsonb, numeric) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Carga: columnas nuevas del Excel y reclasificación
-- ------------------------------------------------------------
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
    upper(btrim(d ->> 'area')) AS area, d ->> 'detalle' AS detalle, public.fe_num(d -> 'anio_fab')::int AS anio_fab,
    public.fe_num(d -> 'prox_mantto') AS prox_mantto,
    CASE WHEN (d ->> 'fecha_ingreso') ~ '^\d{4}-\d{2}-\d{2}' THEN left(d ->> 'fecha_ingreso', 10)::date END AS fecha_ingreso,
    CASE WHEN (d ->> 'fecha_salida') ~ '^\d{4}-\d{2}-\d{2}' THEN left(d ->> 'fecha_salida', 10)::date END AS fecha_salida
  FROM public.fe_raw r, LATERAL (SELECT r.data AS d) z WHERE r.upload_id = p_upload_id AND r.kind = 'MANT';
  DELETE FROM x_m WHERE code IS NULL;
  SELECT count(*) FILTER (WHERE fecha IS NULL), COALESCE(sum(monto) FILTER (WHERE fecha IS NULL), 0) INTO n, s FROM x_m;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Mantenimiento', 'problema', 'Registros sin fecha válida', 'casos', n, 'monto', s, 'tratamiento', 'Cuentan en el total, no en los meses')); END IF;
  SELECT count(*), COALESCE(sum(monto), 0) INTO n, s FROM x_m WHERE tipo = 'PREVENTIVO' AND public.fe_tipo_real(tipo, categoria, detalle) = 'CORRECTIVO';
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Mantenimiento', 'problema', 'Registros "preventivos" cuyo detalle describe una reparación', 'casos', n, 'monto', s, 'tratamiento', 'Se cuentan como correctivos')); END IF;
  SELECT count(*), COALESCE(sum(monto), 0) INTO n, s FROM x_m WHERE categoria ~ 'LLANTA|NEUM' OR mayor;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Mantenimiento', 'problema', 'Llantas e intervenciones mayores', 'casos', n, 'monto', s, 'tratamiento', 'Se reparten en los meses siguientes para comparar costos')); END IF;

  -- Combustible mensual (km del mes = fila validada)
  DROP TABLE IF EXISTS pg_temp.x_c;
  CREATE TEMP TABLE x_c ON COMMIT DROP AS
  -- GLP: lo dice la placa o el precio del galón (el GLP cuesta menos de S/ 9; el diésel y la gasolina, más)
  SELECT public.fe_code(d ->> 'placa') AS code, COALESCE(upper(d ->> 'placa') ~ 'GLP' OR public.fe_num(d -> 'precio') < 9, false) AS glp, upper(btrim(d ->> 'vehiculo')) AS vehiculo,
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
    upper(btrim(d ->> 'actividad')) AS actividad, upper(btrim(d ->> 'area')) AS area, btrim(d ->> 'cliente') AS cliente,
    initcap(btrim(d ->> 'provincia')) AS provincia, initcap(btrim(d ->> 'distrito')) AS distrito, initcap(btrim(d ->> 'conductor')) AS conductor,
    d ->> 'guia' AS guia, upper(btrim(d ->> 'descarga')) AS descarga,
    CASE WHEN upper(btrim(d ->> 'programado')) IN ('SI', 'SÍ', 'S', 'X', '1', 'TRUE') THEN true
         WHEN upper(btrim(d ->> 'programado')) IN ('NO', 'N', '0', 'FALSE') THEN false END AS programado,
    public.fe_num(d -> 'km') AS km, public.fe_num(d -> 'kg') AS kg, public.fe_num(d -> 'm3') AS m3, public.fe_num(d -> 'espera_h') AS espera_h,
    public.fe_num(d -> 'horas') AS horas, public.fe_num(d -> 'ayudantes') AS ayudantes
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

  -- Rutas: anular peso mayor a la capacidad (o 45 t si no está definida) y km u horas imposibles
  WITH b AS (SELECT r.ctid FROM x_r r LEFT JOIN public.fe_assets a ON a.code = r.code WHERE r.kg > COALESCE(a.capacidad_kg * 1.1, 45000))
  UPDATE x_r SET kg = NULL WHERE ctid IN (SELECT ctid FROM b);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Peso por viaje mayor a la capacidad del vehículo', 'casos', n, 'tratamiento', 'Peso anulado en esos viajes')); END IF;
  UPDATE x_r SET km = NULL WHERE km <= 0 OR km > 1200;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Km por viaje negativo, cero o mayor a 1 200', 'casos', n, 'tratamiento', 'Km anulado en esos viajes')); END IF;
  UPDATE x_r SET m3 = NULL WHERE m3 < 0 OR m3 > 1.5;
  UPDATE x_r SET espera_h = NULL WHERE espera_h < 0 OR espera_h > 12;
  UPDATE x_r SET horas = NULL WHERE horas <= 0 OR horas > 20;
  UPDATE x_r SET ayudantes = NULL WHERE ayudantes < 0 OR ayudantes > 6;
  SELECT count(*) INTO n FROM x_r WHERE kg IS NULL;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Viajes sin peso', 'casos', n, 'tratamiento', 'No suman toneladas')); END IF;
  SELECT count(*) INTO n FROM x_r WHERE horas IS NULL;
  IF n > 0 THEN v_dq := v_dq || jsonb_build_array(jsonb_build_object('fuente', 'Rutas', 'problema', 'Viajes sin tiempo total válido', 'casos', n, 'tratamiento', 'No entran en la productividad por hora')); END IF;

  -- Reemplazo de la historia
  DELETE FROM public.fe_maint WHERE true; DELETE FROM public.fe_fuel_month WHERE true; DELETE FROM public.fe_trips WHERE true;
  INSERT INTO public.fe_maint (upload_id, asset_code, fecha, monto, proveedor, factura, km_hrs, tipo, categoria, mayor, dias_fuera, area, detalle,
    prox_mantto, fecha_ingreso, fecha_salida, tipo_real, amortizable)
  SELECT p_upload_id, code, fecha, monto, proveedor, factura, km_hrs, tipo, categoria, mayor, dias_fuera, area, detalle,
    prox_mantto, fecha_ingreso, fecha_salida, public.fe_tipo_real(tipo, categoria, detalle), (COALESCE(categoria, '') ~ 'LLANTA|NEUM' OR mayor) FROM x_m;
  GET DIAGNOSTICS n_m = ROW_COUNT;
  INSERT INTO public.fe_fuel_month (asset_code, mes, upload_id, galones, soles, km, precio, glp)
  SELECT code, mes, p_upload_id, sum(galones), sum(soles), sum(km), percentile_cont(0.5) WITHIN GROUP (ORDER BY precio), bool_or(glp)
  FROM x_c GROUP BY code, mes;
  GET DIAGNOSTICS n_c = ROW_COUNT;
  INSERT INTO public.fe_trips (upload_id, asset_code, fecha, actividad, area, cliente, provincia, guia, descarga, km, kg, m3, espera_h,
    programado, distrito, conductor, horas, ayudantes)
  SELECT p_upload_id, code, fecha, actividad, area, cliente, provincia, guia, descarga, km, kg, m3, espera_h,
    programado, distrito, conductor, horas, ayudantes FROM x_r;
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

-- Ficha del activo: ahora acepta el vínculo con Flota (vehicle_id)
CREATE OR REPLACE FUNCTION public.fe_save_asset(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text := public.fe_code(p ->> 'code'); v_vid uuid;
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso'); END IF;
  IF v_code IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el código del activo'); END IF;
  IF COALESCE(p ->> 'clase', 'TRANSPORTE') NOT IN ('TRANSPORTE', 'MONTACARGA', 'ELEVACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Clase no válida');
  END IF;
  IF NULLIF(p ->> 'vehicle_id', '') IS NOT NULL THEN
    v_vid := (p ->> 'vehicle_id')::uuid;
    IF to_regclass('public.vehicles') IS NULL OR NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = v_vid) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La unidad de Flota no existe');
    END IF;
  END IF;
  INSERT INTO public.fe_assets (code, nombre, clase, tipo, marca, anio_fab, capacidad_kg, valor_reposicion, vida_util, vehicle_plate, vehicle_id, activo, editado)
  VALUES (v_code, COALESCE(NULLIF(p ->> 'nombre', ''), v_code), COALESCE(p ->> 'clase', 'TRANSPORTE'), NULLIF(p ->> 'tipo', ''), NULLIF(p ->> 'marca', ''),
    public.fe_num(p -> 'anio_fab')::int, public.fe_num(p -> 'capacidad_kg'), public.fe_num(p -> 'valor_reposicion'), public.fe_num(p -> 'vida_util')::int,
    NULLIF(upper(btrim(p ->> 'vehicle_plate')), ''), v_vid, COALESCE((p ->> 'activo')::boolean, true), true)
  ON CONFLICT (code) DO UPDATE SET nombre = EXCLUDED.nombre, clase = EXCLUDED.clase, tipo = EXCLUDED.tipo, marca = EXCLUDED.marca,
    anio_fab = EXCLUDED.anio_fab, capacidad_kg = EXCLUDED.capacidad_kg, valor_reposicion = EXCLUDED.valor_reposicion,
    vida_util = EXCLUDED.vida_util, vehicle_plate = EXCLUDED.vehicle_plate, vehicle_id = EXCLUDED.vehicle_id, activo = EXCLUDED.activo,
    editado = true, updated_at = now();
  RETURN jsonb_build_object('success', true, 'code', v_code);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN jsonb_build_object('success', false, 'error', 'Unidad de Flota no válida');
END $$;

-- ------------------------------------------------------------
-- Panel mensual
-- ------------------------------------------------------------
-- Deja en pg_temp: fe_a (activos con grupo y vínculo a Flota), fe_pm (activo × mes) y fe_hr (lecturas de horas).
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

  -- TMS: fallas reportadas (backlog de Mantenimiento)
  IF to_regclass('public.vehicle_failures') IS NOT NULL THEN
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
REVOKE ALL ON FUNCTION public.fe_build(date, date) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Resumen v2
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_resumen(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_desde date; v_hasta date; v_cut jsonb; v_cm date; pr jsonb; v_tr jsonb; v_eq jsonb; v_kpi jsonb; v_years jsonb; v_cov jsonb;
  med_ch numeric; v_meses int; v_pref numeric; v_pglp numeric; i_base numeric; i_low numeric; i_high numeric;
  v_cond numeric; v_ayu_h numeric; v_grp jsonb; v_alq numeric; v_rmin numeric; v_fmant numeric;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  pr := st.params;
  v_desde := date_trunc('month', COALESCE(NULLIF(p ->> 'desde', '')::date, st.desde))::date;
  v_hasta := date_trunc('month', COALESCE(NULLIF(p ->> 'hasta', '')::date, CURRENT_DATE))::date;
  v_cut := public.fe_build(v_desde, v_hasta);
  v_cm := (v_cut ->> 'mantenimiento')::date;
  v_hasta := LEAST(v_hasta, COALESCE((SELECT max(mes) FROM fe_pm WHERE mes >= v_desde AND (km > 0 OR gal > 0 OR viajes > 0 OR mant > 0)), v_hasta));
  v_meses := ((date_part('year', age(v_hasta, v_desde)) * 12 + date_part('month', age(v_hasta, v_desde))) + 1)::int;
  i_base := COALESCE((pr ->> 'tasa_capital')::numeric, 0.10); i_low := COALESCE((pr ->> 'tasa_baja')::numeric, 0.06); i_high := COALESCE((pr ->> 'tasa_alta')::numeric, 0.15);
  v_cond := COALESCE((pr ->> 'conductor_mes')::numeric, 2700) * COALESCE((pr ->> 'factor_cargas')::numeric, 1);
  v_ayu_h := COALESCE((pr ->> 'ayudante_mes')::numeric, 1600) * COALESCE((pr ->> 'factor_cargas')::numeric, 1) / NULLIF(COALESCE((pr ->> 'horas_mes')::numeric, 208), 0);
  v_alq := COALESCE((pr ->> 'alquiler_hora')::numeric, 60);
  v_rmin := COALESCE((pr ->> 'rendimiento_min')::numeric, 0.85); v_fmant := COALESCE((pr ->> 'factor_mant')::numeric, 1.5);

  -- Precio de referencia (precio constante): el fijado en parámetros o la mediana de los últimos 6 meses con datos
  v_pref := NULLIF(pr ->> 'precio_ref', '')::numeric;
  IF v_pref IS NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY comb / gal) INTO v_pref FROM fe_pm
    WHERE gal > 0 AND comb > 0 AND NOT COALESCE(glp, false) AND mes > (SELECT max(mes) FROM fe_pm WHERE gal > 0 AND NOT COALESCE(glp, false)) - interval '6 months';
  END IF;
  v_pglp := NULLIF(pr ->> 'precio_ref_glp', '')::numeric;
  IF v_pglp IS NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY comb / gal) INTO v_pglp FROM fe_pm
    WHERE gal > 0 AND comb > 0 AND glp AND mes > (SELECT max(mes) FROM fe_pm WHERE gal > 0 AND glp) - interval '6 months';
  END IF;

  -- Ventana con costos a precio constante, mantenimiento devengado y mano de obra
  DROP TABLE IF EXISTS pg_temp.fe_w;
  CREATE TEMP TABLE fe_w ON COMMIT DROP AS
  SELECT m.*, m.gal * CASE WHEN COALESCE(m.glp, false) THEN COALESCE(v_pglp, m.comb / NULLIF(m.gal, 0)) ELSE COALESCE(v_pref, m.comb / NULLIF(m.gal, 0)) END AS comb_c,
    CASE WHEN COALESCE(m.viajes, 0) > 0 OR COALESCE(m.km, 0) > 0 THEN v_cond ELSE 0 END
      + COALESCE(m.ayud_h, 0) * v_ayu_h AS mo
  FROM fe_pm m WHERE m.mes BETWEEN v_desde AND v_hasta;

  -- Capacidad práctica por unidad: percentil 95 del peso por viaje (toda la historia, con al menos 30 viajes con peso)
  DROP TABLE IF EXISTS pg_temp.fe_cap;
  CREATE TEMP TABLE fe_cap ON COMMIT DROP AS
  SELECT asset_code AS code, percentile_cont(0.95) WITHIN GROUP (ORDER BY kg) AS p95, avg(horas) AS horas_viaje, avg(espera_h) AS espera_viaje,
    avg(COALESCE(ayudantes, 1) * horas) AS ayud_h_viaje
  FROM public.fe_trips WHERE kg > 0 GROUP BY 1 HAVING count(*) >= 30;

  -- Cumplimiento del preventivo (Excel): servicio a tiempo si no supera en más de 10 % el km/hora programado
  DROP TABLE IF EXISTS pg_temp.fe_prev;
  CREATE TEMP TABLE fe_prev ON COMMIT DROP AS
  SELECT code, count(*) AS evaluados, avg(CASE WHEN exceso <= 0.10 THEN 1 ELSE 0 END) AS a_tiempo FROM (
    SELECT asset_code AS code, fecha, (km - prox_prev) / NULLIF(prox_prev - km_prev, 0) AS exceso FROM (
      SELECT asset_code, fecha, km, lag(prox) OVER w AS prox_prev, lag(km) OVER w AS km_prev FROM (
        SELECT asset_code, fecha, max(km_hrs) AS km, max(prox_mantto) AS prox FROM public.fe_maint
        WHERE COALESCE(tipo_real, tipo) = 'PREVENTIVO' AND km_hrs > 0 AND fecha IS NOT NULL GROUP BY 1, 2) s
      WINDOW w AS (PARTITION BY asset_code ORDER BY fecha)) z
    WHERE prox_prev > km_prev AND fecha BETWEEN v_desde AND (v_hasta + interval '1 month - 1 day')::date) y
  WHERE exceso BETWEEN -1 AND 5 GROUP BY code;

  -- Transporte
  DROP TABLE IF EXISTS pg_temp.fe_t;
  CREATE TEMP TABLE fe_t ON COMMIT DROP AS
  WITH k AS (  -- meses completos para costo por km: km, combustible y mantenimiento cubierto
    SELECT code, count(*) AS meses_km, sum(km) AS km, sum(gal) AS gal, sum(comb) AS comb, sum(comb_c) AS comb_c,
      sum(COALESCE(mant_amort, 0)) AS mant_a, sum(COALESCE(neum_amort, 0)) AS neum_a, sum(COALESCE(mant, 0)) AS mant, sum(COALESCE(otros, 0)) AS otros, sum(mo) AS mo
    FROM fe_w WHERE km > 0 AND gal > 0 AND mant_cubierto GROUP BY code),
  t AS (  -- meses completos para costo por tonelada: además con viajes y peso
    SELECT code, count(*) AS meses_t, sum(km) AS km, sum(comb_c) AS comb_c, sum(comb) AS comb, sum(COALESCE(mant_amort, 0)) AS mant_a,
      sum(COALESCE(otros, 0)) AS otros, sum(mo) AS mo, sum(viajes) AS viajes, sum(viajes - COALESCE(sin_peso, 0)) AS viajes_peso,
      sum(kg) / 1000.0 AS ton, sum(tkm) AS tkm, avg(m3) AS m3, sum(km_viajes) AS km_viajes
    FROM fe_w WHERE km > 0 AND gal > 0 AND mant_cubierto AND viajes > 0 AND kg > 0 GROUP BY code),
  g AS (SELECT code, sum(km) AS km_tot, sum(gal) AS gal_tot, sum(comb) AS comb_tot, sum(mant) AS mant_tot, sum(viajes) AS viajes_tot,
          sum(kg) / 1000.0 AS ton_tot, sum(mayores) AS mayores, sum(dias_fuera) AS dias_fuera, sum(fallas) AS fallas,
          sum(mant_corr) / NULLIF(sum(mant), 0) AS corr_pct, sum(neum) AS neum,
          max(mes) FILTER (WHERE km > 0 OR gal > 0 OR viajes > 0) AS ult_uso,
          count(*) FILTER (WHERE km > 0) AS meses_con_km, count(*) FILTER (WHERE gal > 0) AS meses_con_comb, count(*) FILTER (WHERE viajes > 0) AS meses_con_rutas,
          bool_or(glp) AS glp, sum(horas) / NULLIF(sum(viajes_h), 0) AS horas_viaje, sum(espera) / NULLIF(sum(viajes_h), 0) AS espera_viaje,
          sum(programados)::numeric / NULLIF(sum(viajes) FILTER (WHERE fuente LIKE '%EXCEL%'), 0) AS programados_pct
        FROM fe_w GROUP BY code)
  SELECT a.code, a.nombre, a.tipo, a.marca, a.anio_fab, a.capacidad_kg, a.activo, a.solo_tms, a.grupo, a.vehicle_id,
    COALESCE(a.vida_util, (pr -> 'vida_util' ->> 'TRANSPORTE')::int, 12) AS vida_util,
    COALESCE(a.valor_reposicion, (pr -> 'valor_ref' ->> a.grupo)::numeric) AS valor, a.valor_reposicion IS NULL AS valor_ref,
    COALESCE(a.capacidad_kg, a.cap_flota, c.p95) AS capacidad,
    CASE WHEN a.capacidad_kg IS NOT NULL THEN 'ficha' WHEN a.cap_flota IS NOT NULL THEN 'flota' WHEN c.p95 IS NOT NULL THEN 'p95' END AS capacidad_fuente,
    k.meses_km, k.km, k.gal, k.comb, k.comb_c, k.mant_a, k.mant, k.otros, k.mo, k.km / NULLIF(k.gal, 0) AS kmgal,
    k.comb_c / NULLIF(k.km, 0) AS comb_km, k.mant_a / NULLIF(k.km, 0) AS mant_km,
    (k.comb_c + k.mant_a) / NULLIF(k.km, 0) AS costo_km, (k.comb + k.mant) / NULLIF(k.km, 0) AS costo_km_real,
    (k.comb_c + k.mant_a + k.otros + k.mo) / NULLIF(k.km, 0) AS costo_km_total,
    t.meses_t, t.ton, t.tkm, t.viajes, (t.comb_c + t.mant_a) / NULLIF(t.ton, 0) AS costo_t, (t.comb_c + t.mant_a) / NULLIF(t.tkm, 0) AS costo_tkm,
    (t.comb_c + t.mant_a + t.otros + t.mo) / NULLIF(t.tkm, 0) AS costo_tkm_total, (t.comb + t.mant_a) / NULLIF(t.tkm, 0) AS costo_tkm_real,
    t.comb_c / NULLIF(t.tkm, 0) AS comb_tkm, t.mant_a / NULLIF(t.tkm, 0) AS mant_tkm, t.mo / NULLIF(t.tkm, 0) AS mo_tkm,
    t.ton * 1000 / NULLIF(t.viajes_peso, 0) AS kg_viaje, t.m3, t.viajes::numeric / NULLIF(t.meses_t, 0) AS viajes_mes, t.ton / NULLIF(t.meses_t, 0) AS ton_mes,
    g.km_tot, g.gal_tot, g.comb_tot, g.mant_tot, g.viajes_tot, g.ton_tot, g.mayores, g.dias_fuera, g.fallas, g.corr_pct, g.neum, g.ult_uso,
    g.meses_con_km, g.meses_con_comb, g.meses_con_rutas, g.glp,
    COALESCE(g.horas_viaje, c.horas_viaje) AS horas_viaje, COALESCE(g.espera_viaje, c.espera_viaje) AS espera_viaje, g.programados_pct,
    pv.a_tiempo AS prev_a_tiempo, pv.evaluados AS prev_evaluados,
    CASE WHEN k.meses_km > 0 THEN k.km / k.meses_km * 12 END AS km_anio,
    CASE WHEN k.meses_km > 0 THEN k.mant_a / k.meses_km * 12 END AS mant_anual,
    CASE WHEN k.meses_km > 0 THEN (k.mant_a - k.neum_a) / k.meses_km * 12 END AS mant_anual_sl,
    CASE WHEN k.meses_km > 0 THEN k.comb_c / k.meses_km * 12 END AS comb_anual,
    CASE WHEN a.anio_fab IS NOT NULL THEN extract(year FROM v_hasta)::int - a.anio_fab END AS edad,
    CASE WHEN COALESCE(k.meses_km, 0) >= 12 THEN 'Alta' WHEN COALESCE(k.meses_km, 0) >= 6 THEN 'Media' ELSE 'Baja' END AS confianza
  FROM fe_a a LEFT JOIN k USING (code) LEFT JOIN t USING (code) LEFT JOIN g USING (code) LEFT JOIN fe_cap c USING (code) LEFT JOIN fe_prev pv USING (code)
  WHERE a.clase = 'TRANSPORTE' AND (g.code IS NOT NULL);
  ALTER TABLE fe_t ADD COLUMN llenado numeric, ADD COLUMN tend_mant_km numeric, ADD COLUMN kmgal_grupo numeric, ADD COLUMN mant_km_grupo numeric, ADD COLUMN costo_km_grupo numeric,
    ADD COLUMN n_grupo int, ADD COLUMN rend_rel numeric, ADD COLUMN mant_rel numeric, ADD COLUMN econ jsonb, ADD COLUMN econ_bajo jsonb, ADD COLUMN econ_alto jsonb,
    ADD COLUMN residual numeric, ADD COLUMN mant_km_joven numeric, ADD COLUMN ociosa boolean, ADD COLUMN score int, ADD COLUMN rec text, ADD COLUMN motivos text[];
  UPDATE fe_t SET llenado = kg_viaje / NULLIF(capacidad, 0) WHERE kg_viaje IS NOT NULL;
  -- Capacidad ociosa: llenado bajo frente a la capacidad real (ficha o Flota) o % de volumen bajo en las rutas.
  -- Con la capacidad práctica (percentil 95) el llenado típico ronda 50 % por construcción: solo es informativo.
  UPDATE fe_t SET ociosa = (capacidad_fuente IN ('ficha', 'flota') AND llenado < COALESCE((pr ->> 'volumen_min')::numeric, 0.55))
                        OR (m3 < COALESCE((pr ->> 'volumen_min')::numeric, 0.55) AND kg_viaje > 0)
  WHERE true;

  -- Por año (toda la historia disponible, precio constante y mantenimiento devengado)
  DROP TABLE IF EXISTS pg_temp.fe_y;
  CREATE TEMP TABLE fe_y ON COMMIT DROP AS
  SELECT code, extract(year FROM mes)::int AS anio, count(*) FILTER (WHERE km > 0) AS meses_km,
    sum(km) AS km, sum(gal) AS gal, sum(comb) AS comb, sum(mant) AS mant, sum(mant_amort) AS mant_amort, sum(viajes) AS viajes, sum(kg) / 1000.0 AS ton,
    sum(mant_amort) FILTER (WHERE km > 0 AND mant_cubierto) / NULLIF(sum(km) FILTER (WHERE km > 0 AND mant_cubierto), 0) AS mant_km,
    sum(COALESCE(mant_amort, 0) - COALESCE(neum_amort, 0)) FILTER (WHERE km > 0 AND mant_cubierto) / NULLIF(sum(km) FILTER (WHERE km > 0 AND mant_cubierto), 0) AS mant_km_sl,
    sum(COALESCE(mant_amort, 0) - COALESCE(neum_amort, 0)) FILTER (WHERE mant_cubierto) / NULLIF(count(*) FILTER (WHERE mant_cubierto), 0) * 12 AS mant_anual_sl,
    count(*) FILTER (WHERE mant_cubierto) AS meses_cub,
    sum(km) FILTER (WHERE gal > 0 AND km > 0) / NULLIF(sum(gal) FILTER (WHERE gal > 0 AND km > 0), 0) AS kmgal,
    (sum(gal * COALESCE(CASE WHEN glp THEN v_pglp ELSE v_pref END, comb / NULLIF(gal, 0))) FILTER (WHERE km > 0)
      + COALESCE(sum(mant_amort) FILTER (WHERE km > 0 AND mant_cubierto), 0)) / NULLIF(sum(km) FILTER (WHERE km > 0), 0) AS costo_km,
    sum(comb) / NULLIF(sum(gal), 0) AS precio
  FROM fe_pm WHERE mes <= v_hasta GROUP BY 1, 2;
  UPDATE fe_t t SET tend_mant_km = z.slope FROM (
    SELECT code, regr_slope(mant_km, anio) AS slope FROM fe_y WHERE meses_km >= 6 AND mant_km IS NOT NULL AND anio >= 2021 GROUP BY code HAVING count(*) >= 3) z
  WHERE z.code = t.code;

  -- Referencia por grupo (solo grupos con al menos 2 unidades medidas; la grúa no se compara en km por galón)
  UPDATE fe_t t SET kmgal_grupo = g.kmgal, mant_km_grupo = g.mant_km, costo_km_grupo = g.costo_km, n_grupo = g.n
  FROM (SELECT grupo, count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY kmgal) AS kmgal,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY mant_km) AS mant_km, percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_km) AS costo_km
        FROM fe_t WHERE meses_km >= 3 AND kmgal IS NOT NULL GROUP BY grupo) g
  WHERE g.grupo = t.grupo;
  UPDATE fe_t SET rend_rel = CASE WHEN grupo <> 'GRUA' AND n_grupo >= 2 AND NOT COALESCE(glp, false) THEN kmgal / NULLIF(kmgal_grupo, 0) END,
    mant_rel = CASE WHEN n_grupo >= 2 THEN mant_km / NULLIF(mant_km_grupo, 0) END
  WHERE true;

  -- Mantenimiento por km (sin llantas) de las unidades del grupo cuando tenían hasta 4 años: lo que costaría una nueva
  UPDATE fe_t t SET mant_km_joven = j.v FROM (
    SELECT a.grupo, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.mant_km_sl) AS v FROM fe_y y JOIN fe_a a ON a.code = y.code
    WHERE a.clase = 'TRANSPORTE' AND a.anio_fab IS NOT NULL AND y.anio - a.anio_fab BETWEEN 0 AND 4 AND y.meses_km >= 6 AND y.mant_km_sl > 0 GROUP BY a.grupo) j
  WHERE j.grupo = t.grupo;

  -- Economía del reemplazo: tasa base y sensibilidad (mantenimiento sin llantas)
  UPDATE fe_t SET residual = public.fe_residual(grupo, edad, pr),
    econ = public.fe_econ(valor, grupo, edad, vida_util, mant_anual_sl, tend_mant_km * km_anio, comb_anual, i_base, pr, mant_km_joven * km_anio),
    econ_bajo = public.fe_econ(valor, grupo, edad, vida_util, mant_anual_sl, tend_mant_km * km_anio, comb_anual, i_low, pr, mant_km_joven * km_anio),
    econ_alto = public.fe_econ(valor, grupo, edad, vida_util, mant_anual_sl, tend_mant_km * km_anio, comb_anual, i_high, pr, mant_km_joven * km_anio)
  WHERE mant_anual_sl IS NOT NULL AND edad IS NOT NULL;

  -- Decisión: puntaje y motivos
  UPDATE fe_t SET motivos = '{}', score = 0 WHERE true;
  UPDATE fe_t SET score = score + CASE WHEN edad >= vida_util THEN 40 WHEN edad >= vida_util * 0.8 THEN 20 ELSE 0 END,
    motivos = motivos || CASE WHEN edad >= vida_util THEN ARRAY[format('%s años: supera la vida útil de %s', edad, vida_util)]
                              WHEN edad >= vida_util * 0.8 THEN ARRAY[format('%s años: cerca de la vida útil de %s', edad, vida_util)] ELSE '{}' END
  WHERE edad IS NOT NULL;
  UPDATE fe_t SET score = score + 40, motivos = motivos || format('Reemplazarla ahorraría S/ %s al año (con tasa de 6 %% a 15 %%)',
      to_char(LEAST((econ_bajo ->> 'ahorro')::numeric, (econ ->> 'ahorro')::numeric, (econ_alto ->> 'ahorro')::numeric), 'FM999G999G990'))
  WHERE (econ_bajo ->> 'ahorro')::numeric > 0 AND (econ ->> 'ahorro')::numeric > 0 AND (econ_alto ->> 'ahorro')::numeric > 0;
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('Mantenimiento S/ %s por km: %s veces el de su grupo', round(mant_km, 2), round(mant_rel, 1))
  WHERE mant_rel > v_fmant;
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('Rinde %s km por galón: %s %% menos que su grupo', round(kmgal, 1), round((1 - rend_rel) * 100))
  WHERE rend_rel < v_rmin;
  UPDATE fe_t SET score = score + 20, motivos = motivos || format('El mantenimiento sube S/ %s por km cada año', round(tend_mant_km, 2))
  WHERE tend_mant_km > COALESCE((pr ->> 'tendencia_mant_km')::numeric, 0.15);
  UPDATE fe_t SET motivos = motivos || CASE WHEN capacidad_fuente IN ('ficha', 'flota') AND llenado < COALESCE((pr ->> 'volumen_min')::numeric, 0.55)
      THEN format('Lleva %s kg por viaje: %s %% de su capacidad de %s kg', round(kg_viaje), round(llenado * 100), round(capacidad))
      ELSE format('Viaja con %s %% del volumen y %s kg por viaje', round(m3 * 100), round(kg_viaje)) END
  WHERE ociosa;
  UPDATE fe_t SET motivos = motivos || format('%s intervenciones mayores en el periodo', mayores) WHERE mayores >= 5;
  UPDATE fe_t SET rec = CASE
      WHEN ult_uso IS NULL OR ult_uso < v_hasta - interval '3 months' THEN 'Verificar estado'
      WHEN (econ_bajo ->> 'ahorro')::numeric > 0 AND (econ ->> 'ahorro')::numeric > 0 AND (econ_alto ->> 'ahorro')::numeric > 0 THEN 'Reemplazar'
      WHEN econ IS NULL AND score >= 60 THEN 'Reemplazar'
      WHEN (econ_bajo ->> 'ahorro')::numeric > 0 OR (econ ->> 'anios')::int <= 2 OR edad >= vida_util THEN 'Planificar reemplazo'
      WHEN ociosa AND COALESCE(mant_rel, 1) <= v_fmant AND COALESCE(rend_rel, 1) >= v_rmin THEN 'Reasignar carga'
      WHEN score >= 20 THEN 'Vigilar'
      WHEN meses_con_comb <= 12 AND (anio_fab IS NULL OR edad <= 1) AND solo_tms IS NOT TRUE AND (SELECT min(mes) FROM fe_pm x WHERE x.code = fe_t.code) >= v_hasta - interval '12 months' THEN 'Alta reciente'
      ELSE 'Mantener' END
  WHERE true;
  UPDATE fe_t SET motivos = motivos || 'El vehículo rinde como su grupo: el costo por tonelada alto viene de cargas chicas'::text WHERE rec = 'Reasignar carga';
  UPDATE fe_t SET motivos = motivos || format('Sin km ni combustible desde %s', to_char(ult_uso, 'MM/YYYY')) WHERE rec = 'Verificar estado' AND ult_uso IS NOT NULL;
  UPDATE fe_t SET motivos = motivos || format('Conviene reemplazarla en %s años (tasa %s %%)', econ ->> 'anios', round(i_base * 100))
  WHERE rec IN ('Planificar reemplazo', 'Vigilar', 'Mantener') AND (econ ->> 'anios')::int BETWEEN 1 AND 5;
  UPDATE fe_t SET motivos = motivos || format('Reemplazarla ahorraría hasta S/ %s al año con tasa baja, pero no con todas las tasas: la decisión depende del costo de capital',
      to_char((econ_bajo ->> 'ahorro')::numeric, 'FM999G999G990'))
  WHERE rec = 'Planificar reemplazo' AND (econ_bajo ->> 'ahorro')::numeric > 0 AND NOT ((econ_alto ->> 'ahorro')::numeric > 0);
  UPDATE fe_t SET motivos = motivos || format('Seguir con ella cuesta S/ %s menos al año que una nueva', to_char(-(econ ->> 'ahorro')::numeric, 'FM999G999G990'))
  WHERE (econ_alto ->> 'ahorro')::numeric < 0 AND (econ ->> 'ahorro')::numeric < 0 AND (econ_bajo ->> 'ahorro')::numeric < 0 AND rec <> 'Verificar estado';
  UPDATE fe_t SET motivos = motivos || 'Datos de pocos meses: confirme antes de decidir'::text WHERE confianza = 'Baja' AND rec IN ('Reemplazar', 'Planificar reemplazo', 'Reasignar carga');

  -- Equipos: costo anual devengado, costo propio por hora y comparación con el alquiler
  DROP TABLE IF EXISTS pg_temp.fe_e;
  CREATE TEMP TABLE fe_e ON COMMIT DROP AS
  SELECT a.code, a.nombre, a.clase, a.tipo, a.anio_fab, a.activo, a.grupo, a.vehicle_id,
    COALESCE(a.valor_reposicion, (pr -> 'valor_ref' ->> a.grupo)::numeric) AS valor, a.valor_reposicion IS NULL AS valor_ref,
    COALESCE(a.vida_util, (pr -> 'vida_util' ->> a.clase)::int, 10) AS vida_util,
    CASE WHEN a.anio_fab IS NOT NULL THEN extract(year FROM v_hasta)::int - a.anio_fab END AS edad,
    COALESCE(sum(w.mant_amort), 0) AS mant, COALESCE(sum(w.mant), 0) AS mant_caja, count(*) FILTER (WHERE w.mant_cubierto) AS meses_cub,
    NULL::numeric AS costo_anual,
    COALESCE(sum(w.mant_corr), 0) / NULLIF(sum(w.mant), 0) AS corr_pct, COALESCE(sum(w.mayores), 0)::int AS mayores,
    COALESCE(sum(w.dias_fuera), 0) AS dias_fuera, COALESCE(sum(w.fallas), 0)::int AS fallas, max(w.mes) FILTER (WHERE w.mant > 0) AS ult_registro
  FROM fe_a a
  LEFT JOIN fe_w w ON w.code = a.code
  WHERE a.clase <> 'TRANSPORTE'
  GROUP BY a.code, a.nombre, a.clase, a.tipo, a.anio_fab, a.activo, a.grupo, a.vehicle_id, a.valor_reposicion, a.vida_util;
  UPDATE fe_e SET costo_anual = mant / NULLIF((SELECT count(*) FROM generate_series(v_desde, v_hasta, interval '1 month') g(m)
      WHERE g.m::date >= v_cm OR EXISTS (SELECT 1 FROM public.fe_maint mm WHERE mm.fecha IS NOT NULL HAVING g.m::date BETWEEN date_trunc('month', min(mm.fecha)) AND date_trunc('month', max(mm.fecha)))), 0) * 12
  WHERE true;
  ALTER TABLE fe_e ADD COLUMN horas_anio numeric, ADD COLUMN lecturas int, ADD COLUMN horometro numeric, ADD COLUMN horometro_fecha date,
    ADD COLUMN costo_hora numeric, ADD COLUMN propiedad_anual numeric, ADD COLUMN costo_propio_anual numeric, ADD COLUMN costo_propio_hora numeric,
    ADD COLUMN propiedad_bajo numeric, ADD COLUMN alquiler_anual numeric, ADD COLUMN horas_equilibrio numeric, ADD COLUMN econ jsonb,
    ADD COLUMN econ_bajo jsonb, ADD COLUMN econ_alto jsonb, ADD COLUMN mant_joven numeric, ADD COLUMN score int, ADD COLUMN rec text, ADD COLUMN motivos text[];
  UPDATE fe_e e SET mant_joven = j.v FROM (
    SELECT a.grupo, percentile_cont(0.5) WITHIN GROUP (ORDER BY y.mant_anual_sl) AS v FROM fe_y y JOIN fe_a a ON a.code = y.code
    WHERE a.clase <> 'TRANSPORTE' AND a.anio_fab IS NOT NULL AND y.anio - a.anio_fab BETWEEN 0 AND 4 AND y.meses_cub >= 6 AND y.mant_anual_sl > 0 GROUP BY a.grupo) j
  WHERE j.grupo = e.grupo;
  UPDATE fe_e e SET horas_anio = h.horas_anio, lecturas = h.lecturas, horometro = h.ultima, horometro_fecha = h.ultima_fecha
  FROM (SELECT code, (public.fe_hours_rate(code, v_desde, (v_hasta + interval '1 month - 1 day')::date)).* FROM fe_e) h WHERE h.code = e.code;
  UPDATE fe_e SET costo_hora = costo_anual / NULLIF(horas_anio, 0),
    propiedad_anual = valor * (public.fe_residual(grupo, edad, pr) - public.fe_residual(grupo, edad + 1, pr)) + i_base * valor * public.fe_residual(grupo, edad, pr),
    propiedad_bajo = valor * (public.fe_residual(grupo, edad, pr) - public.fe_residual(grupo, edad + 1, pr)) + i_low * valor * public.fe_residual(grupo, edad, pr),
    alquiler_anual = v_alq * horas_anio,
    econ = public.fe_econ(valor, grupo, edad, vida_util, costo_anual, NULL, 0, i_base, pr, mant_joven),
    econ_bajo = public.fe_econ(valor, grupo, edad, vida_util, costo_anual, NULL, 0, i_low, pr, mant_joven),
    econ_alto = public.fe_econ(valor, grupo, edad, vida_util, costo_anual, NULL, 0, i_high, pr, mant_joven)
  WHERE true;
  UPDATE fe_e SET costo_propio_anual = COALESCE(costo_anual, 0) + propiedad_anual,
    costo_propio_hora = (COALESCE(costo_anual, 0) + propiedad_anual) / NULLIF(horas_anio, 0),
    -- horas por año desde las que conviene tener el equipo propio (el mantenimiento crece con el uso)
    horas_equilibrio = CASE WHEN v_alq > COALESCE(costo_anual / NULLIF(horas_anio, 0), 0) THEN propiedad_anual / (v_alq - COALESCE(costo_anual / NULLIF(horas_anio, 0), 0)) END
  WHERE true;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_hora) INTO med_ch FROM fe_e WHERE costo_hora IS NOT NULL;
  UPDATE fe_e SET motivos = '{}', score = 0 WHERE true;
  UPDATE fe_e SET score = score + CASE WHEN edad >= vida_util THEN 40 WHEN edad >= vida_util * 0.8 THEN 20 ELSE 0 END,
    motivos = motivos || CASE WHEN edad >= vida_util THEN ARRAY[format('%s años: supera la vida útil de %s', edad, vida_util)]
                              WHEN edad >= vida_util * 0.8 THEN ARRAY[format('%s años: cerca de la vida útil de %s', edad, vida_util)] ELSE '{}' END
  WHERE edad IS NOT NULL;
  UPDATE fe_e SET score = score + 25, motivos = motivos || format('Tenerlo cuesta S/ %s por hora y alquilarlo S/ %s', round(costo_propio_hora, 1), round(v_alq))
  WHERE costo_propio_hora > v_alq;
  UPDATE fe_e SET score = score + 25, motivos = motivos || format('Solo %s h de uso al año: tenerlo propio conviene desde %s h', horas_anio, round(horas_equilibrio))
  WHERE horas_anio < horas_equilibrio;
  UPDATE fe_e SET score = score + 25, motivos = motivos || format('Solo %s h de uso al año', horas_anio)
  WHERE horas_equilibrio IS NULL AND horas_anio < COALESCE((pr ->> 'horas_min_anio')::numeric, 300);
  UPDATE fe_e SET motivos = motivos || format('%s días fuera de servicio', dias_fuera) WHERE dias_fuera >= 15;
  UPDATE fe_e SET motivos = motivos || format('%s intervenciones mayores', mayores) WHERE mayores >= 5;
  UPDATE fe_e SET motivos = motivos || format('%s fallas reportadas en Mantenimiento', fallas) WHERE fallas >= 3;
  UPDATE fe_e SET motivos = motivos || format('Solo %s lecturas de horómetro: registre una lectura al mes', COALESCE(lecturas, 0)) WHERE COALESCE(lecturas, 0) < 3;
  UPDATE fe_e SET rec = CASE
      -- alquilar sale más barato incluso con la tasa baja
      WHEN horas_anio IS NOT NULL AND (COALESCE(costo_anual, 0) + propiedad_bajo) / NULLIF(horas_anio, 0) > v_alq THEN 'Dar de baja o alquilar'
      WHEN ult_registro IS NULL OR ult_registro < v_hasta - interval '6 months' THEN 'Verificar estado'
      WHEN (econ_bajo ->> 'ahorro')::numeric > 0 AND (econ ->> 'ahorro')::numeric > 0 AND (econ_alto ->> 'ahorro')::numeric > 0 THEN 'Reemplazar'
      WHEN econ IS NULL AND score >= 60 THEN 'Reemplazar'
      WHEN edad >= vida_util OR (econ ->> 'anios')::int <= 2 THEN 'Planificar reemplazo'
      WHEN horas_anio IS NULL THEN 'Registrar horómetro'
      WHEN score >= 25 THEN 'Vigilar'
      ELSE 'Mantener' END
  WHERE true;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) - 'motivos' || jsonb_build_object('motivos', to_jsonb(t.motivos),
           'anios', (SELECT COALESCE(jsonb_agg(to_jsonb(y) - 'code' ORDER BY y.anio), '[]') FROM fe_y y WHERE y.code = t.code))
         ORDER BY t.score DESC, t.code), '[]') INTO v_tr FROM fe_t t;
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.score DESC, e.code), '[]') INTO v_eq FROM fe_e e;
  SELECT COALESCE(jsonb_object_agg(grupo, jsonb_build_object('n', n, 'kmgal', round(kmgal::numeric, 1), 'mant_km', round(mant_km::numeric, 3), 'costo_km', round(costo_km::numeric, 3))), '{}')
  INTO v_grp FROM (SELECT DISTINCT grupo, n_grupo AS n, kmgal_grupo AS kmgal, mant_km_grupo AS mant_km, costo_km_grupo AS costo_km FROM fe_t WHERE n_grupo IS NOT NULL) z;

  SELECT jsonb_build_object(
      'mant', (SELECT sum(mant) FROM fe_w), 'mant_amort', (SELECT sum(mant_amort) FROM fe_w),
      'mant_transporte', (SELECT sum(w.mant) FROM fe_w w JOIN fe_a a ON a.code = w.code AND a.clase = 'TRANSPORTE'),
      'mant_equipos', (SELECT sum(w.mant) FROM fe_w w JOIN fe_a a ON a.code = w.code AND a.clase <> 'TRANSPORTE'),
      'mant_correctivo', (SELECT sum(mant_corr) FROM fe_w), 'neumaticos', (SELECT sum(neum) FROM fe_w), 'otros', (SELECT sum(otros) FROM fe_w),
      'comb', (SELECT sum(comb) FROM fe_w), 'comb_c', (SELECT sum(comb_c) FROM fe_w),
      'gal', (SELECT sum(gal) FROM fe_w), 'km', (SELECT sum(km) FROM fe_w), 'ton', (SELECT sum(kg) / 1000.0 FROM fe_w),
      'viajes', (SELECT sum(viajes) FROM fe_w), 'tkm', (SELECT sum(tkm) FROM fe_w), 'mo', (SELECT round(sum(w.mo)) FROM fe_w w JOIN fe_a a ON a.code = w.code AND a.clase = 'TRANSPORTE'),
      'activos', (SELECT count(*) FROM fe_a), 'transporte', (SELECT count(*) FROM fe_t), 'equipos', (SELECT count(*) FROM fe_e),
      'ahorro_reemplazo', (SELECT sum((econ ->> 'ahorro')::numeric) FROM fe_t WHERE rec = 'Reemplazar'),
      'ahorro_alquiler', (SELECT sum(costo_propio_anual - alquiler_anual) FROM fe_e WHERE rec = 'Dar de baja o alquilar' AND alquiler_anual IS NOT NULL))
  INTO v_kpi;

  SELECT COALESCE(jsonb_object_agg(anio, precio), '{}') INTO v_years FROM (
    SELECT extract(year FROM mes)::int AS anio, round(sum(comb) / NULLIF(sum(gal), 0), 2) AS precio FROM fe_pm WHERE NOT COALESCE(glp, false) AND gal > 0 GROUP BY 1) z;

  SELECT jsonb_build_object(
    'excel', (SELECT summary FROM public.fe_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1),
    'ultima_carga', (SELECT jsonb_build_object('archivo', file_name, 'fecha', applied_at) FROM public.fe_uploads WHERE status = 'APLICADA' ORDER BY applied_at DESC LIMIT 1),
    'meses', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'fuente', fuente, 'km', km, 'comb', comb, 'mant', mant, 'viajes', viajes, 'ton', ton) ORDER BY mes), '[]') FROM (
      SELECT mes, string_agg(DISTINCT fuente, '+') AS fuente, sum(km) AS km, sum(comb) AS comb, sum(mant) AS mant, sum(viajes) AS viajes, round(sum(kg) / 1000.0, 1) AS ton
      FROM fe_w GROUP BY mes) z),
    'vinculados', (SELECT count(*) FROM fe_a WHERE vehicle_id IS NOT NULL AND NOT solo_tms))
  INTO v_cov;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'corte', v_cut, 'meses', v_meses, 'params', pr,
    'precio_ref', round(v_pref, 2), 'precio_ref_glp', round(v_pglp, 2), 'tasas', jsonb_build_array(i_low, i_base, i_high),
    'mano_obra', jsonb_build_object('conductor_mes', v_cond, 'ayudante_hora', round(v_ayu_h, 2)), 'alquiler_hora', v_alq,
    'medianas', jsonb_build_object('costo_hora', med_ch), 'grupos', v_grp,
    'kpis', v_kpi, 'precio_anio', v_years, 'transporte', v_tr, 'equipos', v_eq, 'cobertura', v_cov);
END $$;

-- Un activo (ficha Flota 360 de Mantenimiento): decisión e indicadores clave
CREATE OR REPLACE FUNCTION public.fe_activo(p_plate text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; v_key text := public.fe_code(p_plate); x jsonb; v_vid text;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso'); END IF;
  IF to_regclass('public.vehicles') IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM public.vehicles WHERE public.fe_code(plate) = $1 OR upper(to_jsonb(vehicles) ->> ''internal_code'') = upper($2) LIMIT 1'
      INTO v_vid USING v_key, p_plate;
  END IF;
  r := public.fe_resumen('{}'::jsonb);
  SELECT e INTO x FROM jsonb_array_elements(COALESCE(r -> 'transporte', '[]') || COALESCE(r -> 'equipos', '[]')) e
  WHERE e ->> 'code' = v_key OR (v_vid IS NOT NULL AND e ->> 'vehicle_id' = v_vid) LIMIT 1;
  IF x IS NULL THEN RETURN jsonb_build_object('success', true, 'activo', NULL); END IF;
  RETURN jsonb_build_object('success', true, 'desde', r -> 'desde', 'hasta', r -> 'hasta', 'activo', x - 'anios');
END $$;

-- ------------------------------------------------------------
-- Rutas v2: productividad, clientes y distritos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_rutas(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; pr jsonb; v_desde date; v_hasta date; v_cut jsonb; v_corte date; v_mes jsonb; v_act jsonb; v_un jsonb; v_desc jsonb; v_prov jsonb;
  v_cli jsonb; v_dist jsonb; v_prod jsonb; v_pref numeric; v_cond_h numeric; v_ayu_h numeric; v_fin date;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  pr := st.params;
  v_desde := date_trunc('month', COALESCE(NULLIF(p ->> 'desde', '')::date, st.desde))::date;
  v_hasta := date_trunc('month', COALESCE(NULLIF(p ->> 'hasta', '')::date, CURRENT_DATE))::date;
  v_cut := public.fe_build(v_desde, v_hasta);
  v_corte := (v_cut ->> 'rutas')::date;
  v_fin := LEAST(v_corte, (v_hasta + interval '1 month')::date);
  v_cond_h := COALESCE((pr ->> 'conductor_mes')::numeric, 2700) * COALESCE((pr ->> 'factor_cargas')::numeric, 1) / NULLIF(COALESCE((pr ->> 'horas_mes')::numeric, 208), 0);
  v_ayu_h := COALESCE((pr ->> 'ayudante_mes')::numeric, 1600) * COALESCE((pr ->> 'factor_cargas')::numeric, 1) / NULLIF(COALESCE((pr ->> 'horas_mes')::numeric, 208), 0);
  v_pref := NULLIF(pr ->> 'precio_ref', '')::numeric;
  IF v_pref IS NULL THEN
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY comb / gal) INTO v_pref FROM fe_pm
    WHERE gal > 0 AND comb > 0 AND NOT COALESCE(glp, false) AND mes > (SELECT max(mes) FROM fe_pm WHERE gal > 0 AND NOT COALESCE(glp, false)) - interval '6 months';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', mes, 'viajes', viajes, 'ton', ton, 'fuente', fuente) ORDER BY mes), '[]') INTO v_mes
  FROM (SELECT mes, sum(viajes) AS viajes, round(sum(kg) / 1000.0, 1) AS ton, string_agg(DISTINCT fuente, '+') AS fuente
        FROM fe_pm WHERE viajes > 0 AND mes BETWEEN v_desde AND v_hasta GROUP BY mes) z;

  -- Costo variable por km de cada unidad (precio constante, mantenimiento devengado; meses completos de la ventana)
  DROP TABLE IF EXISTS pg_temp.fe_ckm;
  CREATE TEMP TABLE fe_ckm ON COMMIT DROP AS
  SELECT code, (sum(gal * COALESCE(CASE WHEN glp THEN NULL ELSE v_pref END, comb / NULLIF(gal, 0))) + sum(COALESCE(mant_amort, 0))) / NULLIF(sum(km), 0) AS ckm
  FROM fe_pm WHERE mes BETWEEN v_desde AND v_hasta AND km > 0 AND gal > 0 AND mant_cubierto GROUP BY code;

  -- Viajes de la historia con su costo estimado: km × costo por km + horas × (conductor + ayudantes)
  DROP TABLE IF EXISTS pg_temp.fe_tv;
  CREATE TEMP TABLE fe_tv ON COMMIT DROP AS
  SELECT t.*, COALESCE(t.km, 0) * COALESCE(c.ckm, 0) + COALESCE(t.horas, 0) * (v_cond_h + COALESCE(t.ayudantes, 1) * v_ayu_h) AS costo,
    (t.km IS NOT NULL AND c.ckm IS NOT NULL AND t.horas IS NOT NULL) AS costo_completo
  FROM public.fe_trips t LEFT JOIN fe_ckm c ON c.code = t.asset_code
  WHERE t.fecha >= v_desde AND t.fecha < v_fin;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'tipo', tipo, 'viajes', viajes, 'ton', ton, 'kg_viaje', kg_viaje, 'm3', m3, 'km_viaje', km_viaje, 'sin_peso', sin_peso,
           'horas_viaje', horas_viaje, 'espera_viaje', espera_viaje, 'viajes_dia', viajes_dia, 'horas_dia', horas_dia, 'programados', programados) ORDER BY ton DESC NULLS LAST), '[]') INTO v_un
  FROM (SELECT m.code, max(a.tipo) AS tipo, sum(m.viajes) AS viajes, round(sum(m.kg) / 1000.0, 1) AS ton,
          round(sum(m.kg) / NULLIF(sum(m.viajes) - sum(m.sin_peso), 0)) AS kg_viaje, round(avg(m.m3), 3) AS m3,
          round(sum(m.km_viajes) / NULLIF(sum(m.viajes), 0), 1) AS km_viaje, sum(m.sin_peso) AS sin_peso,
          round(sum(m.horas) / NULLIF(sum(m.viajes_h), 0), 2) AS horas_viaje, round(sum(m.espera) / NULLIF(sum(m.viajes_h), 0), 2) AS espera_viaje,
          (SELECT round(count(*)::numeric / NULLIF(count(DISTINCT fecha), 0), 2) FROM fe_tv x WHERE x.asset_code = m.code) AS viajes_dia,
          (SELECT round(sum(horas) / NULLIF(count(DISTINCT fecha), 0), 1) FROM fe_tv x WHERE x.asset_code = m.code) AS horas_dia,
          round(sum(m.programados)::numeric / NULLIF(sum(m.viajes) FILTER (WHERE m.fuente LIKE '%EXCEL%'), 0), 3) AS programados
        FROM fe_pm m JOIN fe_a a ON a.code = m.code WHERE m.viajes > 0 AND m.mes BETWEEN v_desde AND v_hasta GROUP BY m.code) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('t', t, 'viajes', n, 'ton', ton) ORDER BY n DESC), '[]') INTO v_act FROM (
    SELECT COALESCE(NULLIF(actividad, ''), 'SIN DATO') AS t, count(*) AS n, round(sum(kg) / 1000.0, 1) AS ton FROM fe_tv GROUP BY 1
    UNION ALL SELECT 'DESPACHO TMS', sum(viajes), round(sum(kg) / 1000.0, 1) FROM fe_pm WHERE fuente LIKE '%TMS%' AND mes >= v_corte AND mes BETWEEN v_desde AND v_hasta AND viajes > 0 HAVING sum(viajes) > 0) z;
  SELECT COALESCE(jsonb_object_agg(d, n), '{}') INTO v_desc FROM (
    SELECT CASE WHEN descarga LIKE 'MONTACARG%' THEN 'Montacargas' WHEN descarga LIKE 'MANUAL%' THEN 'Manual' WHEN descarga LIKE 'GR%' THEN 'Grúa' ELSE 'Sin dato' END AS d, count(*) AS n
    FROM fe_tv GROUP BY 1) z;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('provincia', pv, 'viajes', n) ORDER BY n DESC), '[]') INTO v_prov FROM (
    SELECT COALESCE(NULLIF(provincia, ''), 'Sin dato') AS pv, count(*) AS n FROM fe_tv GROUP BY 1 ORDER BY 2 DESC LIMIT 8) z;

  -- Costo por cliente y por distrito (historia con horas y km): costo estimado, toneladas, espera y viajes no programados
  SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.costo DESC), '[]') INTO v_cli FROM (
    SELECT COALESCE(CASE WHEN public.fe_cli_key(cliente) = 'JRM (TRASLADO INTERNO)' THEN 'JRM (traslado interno)' END,
             mode() WITHIN GROUP (ORDER BY NULLIF(btrim(cliente), '')), 'Sin dato') AS nombre, count(*) AS viajes, round(sum(kg) / 1000.0, 1) AS ton, round(sum(costo)) AS costo,
      round(sum(costo) FILTER (WHERE kg > 0) / NULLIF(sum(kg) / 1000.0, 0), 1) AS costo_t, round(sum(costo) / count(*), 1) AS costo_viaje,
      round(sum(espera_h), 1) AS espera_h, round(avg(espera_h), 2) AS espera_viaje, count(*) FILTER (WHERE programado = false) AS no_programados,
      round(avg(km), 1) AS km_viaje, count(*) FILTER (WHERE costo_completo) AS viajes_costeados
    FROM fe_tv GROUP BY public.fe_cli_key(cliente) ORDER BY sum(costo) DESC LIMIT 25) z;
  SELECT COALESCE(jsonb_agg(to_jsonb(z) ORDER BY z.costo DESC), '[]') INTO v_dist FROM (
    SELECT COALESCE(NULLIF(distrito, ''), 'Sin dato') AS nombre, count(*) AS viajes, round(sum(kg) / 1000.0, 1) AS ton, round(sum(costo)) AS costo,
      round(sum(costo) FILTER (WHERE kg > 0) / NULLIF(sum(kg) / 1000.0, 0), 1) AS costo_t, round(avg(km), 1) AS km_viaje, round(avg(horas), 2) AS horas_viaje
    FROM fe_tv GROUP BY 1 ORDER BY sum(costo) DESC LIMIT 20) z;
  SELECT jsonb_build_object('viajes', count(*), 'con_horas', count(*) FILTER (WHERE horas > 0), 'horas_viaje', round(avg(horas), 2),
      'espera_viaje', round(avg(espera_h), 2), 'espera_pct', round(sum(espera_h) FILTER (WHERE horas > 0) / NULLIF(sum(horas) FILTER (WHERE espera_h IS NOT NULL), 0), 3),
      'espera_costo', round(sum(espera_h * (v_cond_h + COALESCE(ayudantes, 1) * v_ayu_h))),
      'no_programados', count(*) FILTER (WHERE programado = false), 'programado_dato', count(*) FILTER (WHERE programado IS NOT NULL),
      'costo_total', round(sum(costo)), 'clientes', count(DISTINCT public.fe_cli_key(cliente)), 'distritos', count(DISTINCT distrito),
      'conductor_hora', round(v_cond_h, 2), 'ayudante_hora', round(v_ayu_h, 2))
  INTO v_prod FROM fe_tv;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'corte', v_cut, 'mensual', v_mes, 'unidades', v_un,
    'actividad', v_act, 'descarga', v_desc, 'provincias', v_prov, 'clientes', v_cli, 'distritos', v_dist, 'productividad', v_prod,
    'espera_mediana', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY espera_h) FROM fe_tv WHERE espera_h IS NOT NULL));
END $$;

-- ------------------------------------------------------------
-- Datos: unidades de Flota para vincular y calidad del vínculo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fe_datos()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_cut jsonb; v_cc date; v_cr date; v_gaps jsonb := '[]'::jsonb; n int; v_veh jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  SELECT * INTO st FROM public.fe_settings WHERE id = 1;
  v_cut := public.fe_build(st.desde, CURRENT_DATE);
  v_cc := (v_cut ->> 'combustible')::date; v_cr := (v_cut ->> 'rutas')::date;
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
    'efecto', 'No se puede medir el costo por hora: registre una lectura al mes (o en la inspección de Mantenimiento)')); END IF;
  SELECT count(*) INTO n FROM fe_a WHERE NOT solo_tms AND activo AND vehicle_id IS NULL;
  IF n > 0 THEN v_gaps := v_gaps || jsonb_build_array(jsonb_build_object('fuente', 'Flota · Mantenimiento', 'problema', 'Activos sin vincular a una unidad de Flota', 'casos', n,
    'efecto', 'No reciben costos de OT, neumáticos, fallas ni horómetro del TMS: vincúlelos en la tabla de activos')); END IF;
  SELECT count(*) INTO n FROM public.fe_assets WHERE activo AND valor_reposicion IS NULL;
  IF n > 0 THEN v_gaps := v_gaps || jsonb_build_array(jsonb_build_object('fuente', 'Ficha del activo', 'problema', 'Activos sin valor de reposición', 'casos', n,
    'efecto', 'La decisión económica usa el valor referencial del grupo: ingrese la cotización real')); END IF;
  IF to_regclass('public.vehicles') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'plate', plate, 'type', type, 'internal_code', to_jsonb(v) ->> 'internal_code',
          'year', to_jsonb(v) ->> 'year', 'weight_capacity', to_jsonb(v) ->> 'weight_capacity') ORDER BY COALESCE(plate, to_jsonb(v) ->> 'internal_code')), '[]')
        FROM public.vehicles v WHERE COALESCE(plate, to_jsonb(v) ->> 'internal_code') IS NOT NULL$q$ INTO v_veh;
    EXCEPTION WHEN OTHERS THEN v_veh := '[]'::jsonb; END;
  END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.fe_can_load(), 'corte', v_cut,
    'settings', jsonb_build_object('desde', st.desde, 'corte', st.corte, 'params', st.params, 'updated_at', st.updated_at),
    'activos', (SELECT COALESCE(jsonb_agg(to_jsonb(x) || jsonb_build_object('vinculo', (SELECT a.vehicle_id FROM fe_a a WHERE a.code = x.code), 'grupo', public.fe_grupo(x.clase, x.tipo))
               ORDER BY x.clase DESC, x.code), '[]') FROM public.fe_assets x),
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
  FOREACH f IN ARRAY ARRAY['fe_upload_apply(uuid)', 'fe_save_asset(jsonb)', 'fe_resumen(jsonb)', 'fe_rutas(jsonb)', 'fe_datos()', 'fe_activo(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
