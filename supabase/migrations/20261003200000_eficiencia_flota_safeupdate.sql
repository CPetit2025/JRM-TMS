-- ============================================================
-- Eficiencia de Flota: UPDATE/DELETE con WHERE (pg-safeupdate)
-- ============================================================
-- Supabase rechaza en las llamadas de la API todo UPDATE o DELETE sin WHERE ("UPDATE requires a WHERE clause"),
-- por lo que fe_resumen (resumen, transporte, equipos) y fe_upload_apply (carga del Excel) fallaban en producción.
-- Se redefinen con WHERE true en las sentencias que afectan a toda la tabla; la lógica no cambia.

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
  DELETE FROM public.fe_maint WHERE true; DELETE FROM public.fe_fuel_month WHERE true; DELETE FROM public.fe_trips WHERE true;
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
  UPDATE fe_t SET motivos = '{}', score = 0 WHERE true;
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
      ELSE 'Mantener' END
  WHERE true;
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
      WHERE g.m::date >= v_cm OR EXISTS (SELECT 1 FROM public.fe_maint mm WHERE mm.fecha IS NOT NULL HAVING g.m::date BETWEEN date_trunc('month', min(mm.fecha)) AND date_trunc('month', max(mm.fecha)))), 0) * 12
  WHERE true;
  ALTER TABLE fe_e ADD COLUMN horas_anio numeric, ADD COLUMN lecturas int, ADD COLUMN horometro numeric, ADD COLUMN horometro_fecha date,
    ADD COLUMN costo_hora numeric, ADD COLUMN score int, ADD COLUMN rec text, ADD COLUMN motivos text[];
  UPDATE fe_e e SET horas_anio = h.horas_anio, lecturas = h.lecturas, horometro = h.ultima, horometro_fecha = h.ultima_fecha
  FROM (SELECT code, (public.fe_hours_rate(code, v_desde, (v_hasta + interval '1 month - 1 day')::date)).* FROM fe_e) h WHERE h.code = e.code;
  UPDATE fe_e SET costo_hora = costo_anual / NULLIF(horas_anio, 0) WHERE true;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_hora) INTO med_ch FROM fe_e WHERE costo_hora IS NOT NULL;
  UPDATE fe_e SET motivos = '{}', score = 0 WHERE true;
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
      ELSE 'Mantener' END
  WHERE true;

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

NOTIFY pgrst, 'reload schema';
