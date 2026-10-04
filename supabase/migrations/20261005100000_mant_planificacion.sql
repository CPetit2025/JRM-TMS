-- 20261005100000_mant_planificacion.sql
-- Planificación de mantenimiento clara y con los datos:
-- * Base común (mant_tmp_base / mant_tmp_proyectar): unidades, historial único (Excel + OT + Caja), uso real y servicios
--   proyectados entre dos fechas, con lectura objetivo (km/h) y si el plan está activo. La usan el plan anual y la
--   planificación, así ambas pantallas dicen lo mismo.
-- * mant_planificacion(): resumen de 12 meses con el historial, próximos 90 días del preventivo, plan correctivo
--   (riesgo por unidad y sistema según la frecuencia real de fallas, con la acción sugerida) y calidad de datos.
-- * mant_activar_planes(): activa en un paso los planes por validar con la línea base del historial.
-- * mant_agregar_inspeccion(): agrega al plan preventivo la inspección que propone el plan correctivo.
-- Defensivo frente a producción: columnas por to_jsonb, tablas por to_regclass.

BEGIN;

-- ------------------------------------------------------------
-- 1. Base común
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_tmp_base()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pa_u (vehicle_id uuid, plate text, familia text, fam text, lectura text, uso_anual numeric, odo numeric, hrs numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pa_h (vehicle_id uuid, fecha date, fuente text, tipo text, sistema text, monto numeric, detalle text, lectura numeric) ON COMMIT DROP;
  TRUNCATE pa_u; TRUNCATE pa_h;

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
END $$;
REVOKE ALL ON FUNCTION public.mant_tmp_base() FROM PUBLIC, anon, authenticated;

-- Servicios proyectados entre dos fechas (requiere mant_tmp_base). Intervalo = lo que ocurra primero entre el uso
-- real y los días. Lo vencido a hoy se programa hoy y la cadena sigue desde hoy. Un servicio mayor reemplaza a los
-- que incluye en el mismo mes.
CREATE OR REPLACE FUNCTION public.mant_tmp_proyectar(p_desde date, p_hasta date)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; r record; tp record; v_last date; v_lec numeric; v_d date; v_int numeric;
  v_uso numeric; v_cost numeric; v_freq numeric; v_obj numeric; v_activo boolean; v_pid uuid; pl record; i int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pa_s (vehicle_id uuid, tid bigint, servicio text, mes int, periodo date, fecha date, costo numeric, vencido boolean,
    lectura_obj numeric, plan_id uuid, plan_activo boolean, sistema text, tareas jsonb) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS pa_inc (mayor bigint, incluido text) ON COMMIT DROP;
  TRUNCATE pa_s; TRUNCATE pa_inc;

  FOR r IN SELECT * FROM pa_u LOOP
    FOR tp IN SELECT * FROM public.mant_plan_templates WHERE familia = r.familia AND activo LOOP
      v_uso := CASE WHEN r.uso_anual > 0 THEN r.uso_anual / 365.0 END;
      v_int := LEAST(COALESCE(tp.frecuencia_dias, 100000),
                     CASE WHEN tp.frecuencia_km IS NOT NULL AND r.lectura = 'KM' AND v_uso > 0 THEN tp.frecuencia_km / v_uso ELSE 100000 END,
                     CASE WHEN tp.frecuencia_horas IS NOT NULL AND r.lectura = 'HORAS' AND v_uso > 0 THEN tp.frecuencia_horas / v_uso ELSE 100000 END);
      IF v_int >= 100000 THEN CONTINUE; END IF;
      v_int := GREATEST(v_int, 7);
      v_freq := CASE r.lectura WHEN 'KM' THEN tp.frecuencia_km WHEN 'HORAS' THEN tp.frecuencia_horas END;

      -- Última ejecución: la del plan (activo o por validar); si no hay plan, el historial
      v_last := NULL; v_lec := NULL; v_activo := NULL; v_pid := NULL;
      IF to_regclass('public.maintenance_plans') IS NOT NULL THEN
        EXECUTE $q$SELECT p.id, p.is_active, p.last_performed_date,
                          CASE $3 WHEN 'KM' THEN NULLIF(to_jsonb(p) ->> 'last_performed_km', '')::numeric WHEN 'HORAS' THEN NULLIF(to_jsonb(p) ->> 'last_performed_hours', '')::numeric END AS lec
                   FROM public.maintenance_plans p WHERE p.vehicle_plate = $1 AND p.mant_template_id = $2 ORDER BY p.is_active DESC LIMIT 1$q$
          INTO pl USING r.plate, tp.id, r.lectura;
        v_pid := pl.id; v_activo := pl.is_active; v_last := pl.last_performed_date; v_lec := NULLIF(pl.lec, 0);
      END IF;
      IF v_last IS NULL THEN
        SELECT s.fecha, s.lectura INTO v_last, v_lec FROM public.mant_ultimo_servicio(r.vehicle_id, tp.patron) s;
      END IF;

      -- Costo de referencia: mediana de los días con ese servicio (3 años), como mucho 2 veces el de la plantilla
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.m) INTO v_cost FROM (
        SELECT h.fecha, sum(h.monto) AS m FROM pa_h h WHERE h.vehicle_id = r.vehicle_id AND h.tipo <> 'CORRECTIVO'
          AND public.mant_es_servicio(h.detalle, tp.patron) AND h.fecha > v_hoy - 1095 GROUP BY 1) d;
      v_cost := CASE WHEN v_cost IS NULL THEN COALESCE(tp.costo_ref, 0) ELSE LEAST(round(v_cost), COALESCE(tp.costo_ref * 2, round(v_cost))) END;

      v_d := COALESCE(v_last, v_hoy) + ceil(v_int)::int;
      v_obj := CASE WHEN v_freq IS NOT NULL AND v_lec IS NOT NULL THEN v_lec + v_freq END;
      IF v_d < v_hoy THEN
        IF v_hoy BETWEEN p_desde AND p_hasta THEN
          INSERT INTO pa_s VALUES (r.vehicle_id, tp.id, tp.servicio, extract(month FROM v_hoy)::int, date_trunc('month', v_hoy)::date, v_hoy, v_cost, true,
            v_obj, v_pid, v_activo, tp.sistema, tp.tareas);
        END IF;
        v_d := v_hoy + ceil(v_int)::int;
        v_obj := CASE WHEN v_freq IS NOT NULL THEN COALESCE(CASE r.lectura WHEN 'KM' THEN r.odo ELSE r.hrs END, v_lec) + v_freq END;
      END IF;
      i := 0;
      WHILE v_d <= p_hasta AND i < 400 LOOP
        IF v_d >= p_desde THEN
          INSERT INTO pa_s VALUES (r.vehicle_id, tp.id, tp.servicio, extract(month FROM v_d)::int, date_trunc('month', v_d)::date, v_d, v_cost, false,
            v_obj, v_pid, v_activo, tp.sistema, tp.tareas);
        END IF;
        v_d := v_d + ceil(v_int)::int; v_obj := v_obj + v_freq; i := i + 1;
      END LOOP;
    END LOOP;
  END LOOP;

  INSERT INTO pa_inc
  WITH RECURSIVE ch(mayor, familia, serv) AS (
    SELECT t.id, t.familia, t.incluye FROM public.mant_plan_templates t WHERE t.incluye IS NOT NULL
    UNION
    SELECT ch.mayor, ch.familia, tt.incluye FROM ch JOIN public.mant_plan_templates tt ON tt.familia = ch.familia AND tt.servicio = ch.serv WHERE tt.incluye IS NOT NULL)
  SELECT mayor, serv FROM ch;
  DELETE FROM pa_s s USING pa_s s2, pa_inc x
  WHERE s2.vehicle_id = s.vehicle_id AND s2.periodo = s.periodo AND x.mayor = s2.tid AND x.incluido = s.servicio;
END $$;
REVOKE ALL ON FUNCTION public.mant_tmp_proyectar(date, date) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Plan anual sobre la base común (misma respuesta que antes)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_plan_anual(p_anio integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_anio int := COALESCE(p_anio, extract(year FROM now() AT TIME ZONE 'America/Lima')::int);
  v_ini date; v_fin date; v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; st record; v_res jsonb; v_kpi jsonb; v_caja jsonb := '[]'; v_ot jsonb := '[]';
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-planes') OR public.menu_has_permission('mantenimiento-dashboard')
          OR public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-finanzas')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  v_ini := make_date(v_anio, 1, 1); v_fin := make_date(v_anio, 12, 31);
  SELECT * INTO st FROM public.mant_settings WHERE id = 1;
  PERFORM public.mant_tmp_base();
  PERFORM public.mant_tmp_proyectar(v_ini, v_fin);

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

-- ------------------------------------------------------------
-- 3. Planificación: resumen, próximos 90 días, correctivo y calidad de datos
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_planificacion()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; st record; v_res jsonb; v_prox jsonb; v_corr jsonb; v_cal jsonb := '[]';
  v_corte date; n int; v_items jsonb; v_has_plans boolean := to_regclass('public.maintenance_plans') IS NOT NULL;
BEGIN
  IF NOT (public.menu_has_permission('mantenimiento-planes') OR public.menu_has_permission('mantenimiento-dashboard')
          OR public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('mantenimiento-finanzas')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso');
  END IF;
  SELECT * INTO st FROM public.mant_settings WHERE id = 1;
  PERFORM public.mant_tmp_base();
  PERFORM public.mant_tmp_proyectar(v_hoy, v_hoy + 90);
  SELECT max(fecha) INTO v_corte FROM pa_h WHERE fuente = 'Historial (Excel)';

  -- Resumen de 12 meses con el historial único (Excel + OT + Caja)
  SELECT jsonb_build_object(
      'desde', v_hoy - 365, 'hasta', v_hoy, 'historial_hasta', v_corte,
      'total', COALESCE(sum(monto), 0),
      'preventivo', COALESCE(sum(monto) FILTER (WHERE tipo <> 'CORRECTIVO'), 0),
      'correctivo', COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0),
      'pct_correctivo', round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)),
      'eventos_correctivos', count(DISTINCT (vehicle_id, fecha)) FILTER (WHERE tipo = 'CORRECTIVO'),
      'fuentes', jsonb_build_object('excel', count(*) FILTER (WHERE fuente = 'Historial (Excel)'), 'ot', count(*) FILTER (WHERE fuente = 'OT del sistema'),
                                    'caja', count(*) FILTER (WHERE fuente = 'Caja')))
  INTO v_res FROM pa_h WHERE fecha > v_hoy - 365;
  v_res := v_res || jsonb_build_object(
    'meta_correctivo', st.meta_correctivo, 'umbral', st.umbral_cotizacion, 'unidades', (SELECT count(*) FROM pa_u),
    'por_sistema', (SELECT COALESCE(jsonb_agg(jsonb_build_object('sistema', z.sistema, 'nombre', s.nombre, 'correctivo', z.c, 'total', z.t) ORDER BY z.c DESC), '[]') FROM (
        SELECT sistema, round(COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0)) AS c, round(sum(monto)) AS t FROM pa_h WHERE fecha > v_hoy - 365 GROUP BY 1) z
        LEFT JOIN public.mant_sistemas s ON s.code = z.sistema),
    'por_unidad', (SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', u.plate, 'familia', u.fam, 'correctivo', z.c, 'total', z.t,
                    'pct', round(100 * z.c / NULLIF(z.t, 0))) ORDER BY z.t DESC), '[]') FROM (
        SELECT vehicle_id, round(COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0)) AS c, round(sum(monto)) AS t FROM pa_h WHERE fecha > v_hoy - 365 GROUP BY 1) z
        JOIN pa_u u ON u.vehicle_id = z.vehicle_id),
    'por_mes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
                  'preventivo', (SELECT COALESCE(sum(monto), 0) FROM pa_h WHERE tipo <> 'CORRECTIVO' AND date_trunc('month', fecha) = m),
                  'correctivo', (SELECT COALESCE(sum(monto), 0) FROM pa_h WHERE tipo = 'CORRECTIVO' AND date_trunc('month', fecha) = m)) ORDER BY m), '[]')
                FROM generate_series(date_trunc('month', v_hoy - 330), date_trunc('month', v_hoy), interval '1 month') m),
    'planes', CASE WHEN v_has_plans THEN (SELECT jsonb_build_object('activos', count(*) FILTER (WHERE p.is_active), 'por_validar', count(*) FILTER (WHERE NOT p.is_active AND p.mant_template_id IS NOT NULL))
                FROM public.maintenance_plans p) END,
    'vencidos', (SELECT count(*) FROM pa_s WHERE vencido),
    'proximos_30', (SELECT count(*) FROM pa_s WHERE fecha <= v_hoy + 30),
    'presupuesto_90', (SELECT COALESCE(sum(costo), 0) FROM pa_s));

  -- Preventivo: próximos 90 días
  SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', u.plate, 'familia', u.fam, 'lectura', u.lectura, 'servicio', s.servicio, 'fecha', s.fecha,
      'dias', s.fecha - v_hoy, 'vencido', s.vencido, 'lectura_obj', round(s.lectura_obj),
      'lectura_actual', CASE u.lectura WHEN 'KM' THEN u.odo WHEN 'HORAS' THEN u.hrs END, 'costo', s.costo, 'tareas', s.tareas,
      'sistema', s.sistema, 'plan_id', s.plan_id, 'plan_activo', s.plan_activo) ORDER BY s.vencido DESC, s.fecha, u.plate), '[]')
  INTO v_prox FROM pa_s s JOIN pa_u u ON u.vehicle_id = s.vehicle_id;

  -- Correctivo: frecuencia real de fallas por unidad y sistema (24 meses)
  CREATE TEMP TABLE IF NOT EXISTS pc_s (vehicle_id uuid, sistema text, eventos int, costo numeric, primera date, ultima date, mtbf numeric) ON COMMIT DROP;
  TRUNCATE pc_s;
  -- Un episodio = gastos correctivos del mismo sistema separados por menos de 30 días (varias facturas de una reparación)
  INSERT INTO pc_s
  SELECT vehicle_id, sistema, count(*)::int, sum(m), min(f), max(f),
         CASE WHEN count(*) > 1 THEN (max(f) - min(f))::numeric / (count(*) - 1) END
  FROM (SELECT vehicle_id, sistema, min(f) AS f, sum(m) AS m FROM (
          SELECT e.*, sum(nuevo) OVER (PARTITION BY vehicle_id, sistema ORDER BY f) AS ep FROM (
            SELECT vehicle_id, sistema, fecha AS f, sum(monto) AS m,
                   CASE WHEN fecha - lag(fecha) OVER (PARTITION BY vehicle_id, sistema ORDER BY fecha) < 30 THEN 0 ELSE 1 END AS nuevo
            FROM pa_h WHERE tipo = 'CORRECTIVO' AND fecha > v_hoy - 730 GROUP BY 1, 2, 3) e) x
        GROUP BY vehicle_id, sistema, ep) g
  GROUP BY 1, 2;

  SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'riesgo')::numeric DESC), '[]') INTO v_corr FROM (
    SELECT jsonb_build_object(
      'plate', u.plate, 'familia', u.fam,
      'correctivo_24m', (SELECT round(COALESCE(sum(costo), 0)) FROM pc_s WHERE vehicle_id = u.vehicle_id),
      'eventos_24m', (SELECT COALESCE(sum(eventos), 0) FROM pc_s WHERE vehicle_id = u.vehicle_id),
      'pct_correctivo_12m', (SELECT round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)) FROM pa_h WHERE vehicle_id = u.vehicle_id AND fecha > v_hoy - 365),
      'mtbf_dias', (SELECT round(avg(dif)) FROM (SELECT d - lag(d) OVER (ORDER BY d) AS dif FROM (SELECT DISTINCT fecha AS d FROM pa_h WHERE vehicle_id = u.vehicle_id AND tipo = 'CORRECTIVO' AND fecha > v_hoy - 730) a) b WHERE dif >= 15),
      'fallas_abiertas', CASE WHEN to_regclass('public.maintenance_requests') IS NOT NULL THEN public.mant_fallas_abiertas(u.plate) END,
      'riesgo', round((SELECT COALESCE(sum(costo), 0) FROM pc_s WHERE vehicle_id = u.vehicle_id) / 1000
                + 10 * (SELECT count(*) FROM pc_s WHERE vehicle_id = u.vehicle_id AND eventos >= 3 AND ultima + round(mtbf)::int <= v_hoy + 60)),
      'nivel', CASE WHEN (SELECT round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)) FROM pa_h WHERE vehicle_id = u.vehicle_id AND fecha > v_hoy - 365) >= 50
                      OR EXISTS (SELECT 1 FROM pc_s WHERE vehicle_id = u.vehicle_id AND eventos >= 4)
                      OR (SELECT COALESCE(sum(costo), 0) FROM pc_s WHERE vehicle_id = u.vehicle_id) >= 25000 THEN 'ALTO'
                    WHEN (SELECT round(100 * COALESCE(sum(monto) FILTER (WHERE tipo = 'CORRECTIVO'), 0) / NULLIF(sum(monto), 0)) FROM pa_h WHERE vehicle_id = u.vehicle_id AND fecha > v_hoy - 365) >= st.meta_correctivo
                      OR EXISTS (SELECT 1 FROM pc_s WHERE vehicle_id = u.vehicle_id AND eventos >= 3)
                      OR (SELECT COALESCE(sum(costo), 0) FROM pc_s WHERE vehicle_id = u.vehicle_id) >= 10000 THEN 'MEDIO'
                    ELSE 'BAJO' END,
      'reserva', (SELECT round(COALESCE(sum(monto), 0) / 2) FROM pa_h WHERE vehicle_id = u.vehicle_id AND tipo = 'CORRECTIVO' AND fecha > v_hoy - 730),
      'sistemas', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'sistema', c.sistema, 'nombre', COALESCE(s.nombre, c.sistema), 'eventos', c.eventos, 'costo', round(c.costo), 'ultima', c.ultima,
          'mtbf_dias', round(c.mtbf), 'proxima', CASE WHEN c.mtbf IS NOT NULL THEN c.ultima + round(c.mtbf)::int END,
          'estado', CASE WHEN c.mtbf IS NULL THEN 'AISLADA' WHEN c.ultima + round(c.mtbf)::int <= v_hoy THEN 'ESPERADA'
                         WHEN c.ultima + round(c.mtbf)::int <= v_hoy + 60 THEN 'PROXIMA' ELSE 'VIGILAR' END,
          'inspeccion_dias', CASE WHEN c.eventos >= 3 THEN LEAST(180, GREATEST(30, (round(c.mtbf / 2 / 15) * 15)::int)) END,
          'tiene_inspeccion', v_has_plans AND public.mant_tiene_inspeccion(u.plate, COALESCE(s.nombre, c.sistema)),
          'recomendacion', CASE WHEN c.eventos >= 3 THEN 'Inspección de ' || lower(COALESCE(s.nombre, c.sistema)) || ' cada '
                                     || LEAST(180, GREATEST(30, (round(c.mtbf / 2 / 15) * 15)::int)) || ' días'
                                WHEN c.eventos = 2 THEN 'Revisar en el próximo preventivo'
                                ELSE 'Sin patrón (una sola falla)' END) ORDER BY c.eventos DESC, c.costo DESC), '[]')
        FROM pc_s c LEFT JOIN public.mant_sistemas s ON s.code = c.sistema WHERE c.vehicle_id = u.vehicle_id)) AS x
    FROM pa_u u) z;

  -- Calidad de datos
  SELECT count(*) INTO n FROM pa_u;
  IF v_corte IS NOT NULL AND v_corte < v_hoy - 30 THEN
    v_cal := v_cal || jsonb_build_object('codigo', 'historial', 'nivel', 'crit', 'titulo', 'El historial termina el ' || to_char(v_corte, 'DD/MM/YYYY'),
      'detalle', 'Lo hecho desde entonces no está registrado. Registre las OT y gastos de taller en el sistema (o una nueva carga del Excel) para que el plan y los indicadores sean reales.',
      'cantidad', v_hoy - v_corte);
  END IF;
  IF v_has_plans THEN
    SELECT COALESCE(jsonb_agg(DISTINCT p.vehicle_plate), '[]') INTO v_items FROM public.maintenance_plans p WHERE NOT p.is_active AND p.mant_template_id IS NOT NULL;
    IF jsonb_array_length(v_items) > 0 THEN
      v_cal := v_cal || jsonb_build_object('codigo', 'planes', 'nivel', 'crit', 'titulo', 'Planes preventivos sin activar',
        'detalle', 'Mientras no se activen, el programador no genera las OT preventivas.', 'cantidad', jsonb_array_length(v_items), 'items', v_items);
    END IF;
  END IF;
  -- Lecturas: unidades por km u horas sin lectura propia en 30 días (el historial no cuenta)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', u.plate, 'ultima', l.ultima) ORDER BY l.ultima NULLS FIRST), '[]') INTO v_items
  FROM pa_u u LEFT JOIN LATERAL (SELECT public.mant_ultima_lectura(u.vehicle_id, u.plate) AS ultima) l ON true
  WHERE u.lectura IN ('KM', 'HORAS') AND (l.ultima IS NULL OR l.ultima < v_hoy - 30);
  IF jsonb_array_length(v_items) > 0 THEN
    v_cal := v_cal || jsonb_build_object('codigo', 'lecturas', 'nivel', 'warn', 'titulo', 'Unidades sin lectura de km u horas en 30 días',
      'detalle', 'Sin lecturas el plan usa el uso promedio del historial. Montacargas: horómetro en la app (Equipos); transporte: odómetro en checklist, despacho o Preventivos › Lecturas.',
      'cantidad', jsonb_array_length(v_items), 'items', v_items);
  END IF;
  SELECT COALESCE(jsonb_agg(plate), '[]') INTO v_items FROM pa_u WHERE lectura IN ('KM', 'HORAS') AND uso_anual IS NULL;
  IF jsonb_array_length(v_items) > 0 THEN
    v_cal := v_cal || jsonb_build_object('codigo', 'uso', 'nivel', 'warn', 'titulo', 'Uso anual desconocido',
      'detalle', 'Estas unidades se planifican solo por calendario hasta tener lecturas.', 'cantidad', jsonb_array_length(v_items), 'items', v_items);
  END IF;
  BEGIN
    EXECUTE $q$SELECT COALESCE(jsonb_agg(v.plate ORDER BY v.plate), '[]') FROM public.vehicles v
      WHERE NOT EXISTS (SELECT 1 FROM public.mant_asset_familia af WHERE af.vehicle_id = v.id)
        AND upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'$q$ INTO v_items;
    IF jsonb_array_length(v_items) > 0 THEN
      v_cal := v_cal || jsonb_build_object('codigo', 'familia', 'nivel', 'warn', 'titulo', 'Unidades sin plan (sin familia)',
        'detalle', 'No tienen plan preventivo ni entran al presupuesto.', 'cantidad', jsonb_array_length(v_items), 'items', v_items);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  IF to_regclass('public.maintenance_requests') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('plate', vehicle_plate, 'descripcion', left(description, 80), 'dias', (now()::date - reported_at::date)) ORDER BY reported_at), '[]')
        FROM public.maintenance_requests WHERE upper(COALESCE(status, '')) IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PENDIENTE')
          AND work_order_id IS NULL AND reported_at < now() - interval '7 days'$q$ INTO v_items;
      IF jsonb_array_length(v_items) > 0 THEN
        v_cal := v_cal || jsonb_build_object('codigo', 'fallas', 'nivel', 'warn', 'titulo', 'Fallas de más de 7 días sin OT',
          'detalle', 'Convierta la falla en OT o descártela en Fallas y Backlog.', 'cantidad', jsonb_array_length(v_items), 'items', v_items);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  IF to_regclass('public.maintenance_work_orders') IS NOT NULL AND to_regclass('public.work_order_costs') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT COALESCE(jsonb_agg(COALESCE(to_jsonb(o) ->> 'ot_code', left(o.id::text, 8))), '[]') FROM public.maintenance_work_orders o
        WHERE upper(COALESCE(to_jsonb(o) ->> 'status', '')) = 'CERRADA'
          AND NOT EXISTS (SELECT 1 FROM public.work_order_costs c WHERE c.work_order_id = o.id)
          AND COALESCE(NULLIF(to_jsonb(o) ->> 'total_cost', '')::numeric, 0) = 0$q$ INTO v_items;
      IF jsonb_array_length(v_items) > 0 THEN
        v_cal := v_cal || jsonb_build_object('codigo', 'ot_costo', 'nivel', 'warn', 'titulo', 'OT cerradas sin costo',
          'detalle', 'Sin costo, el gasto de la unidad queda incompleto.', 'cantidad', jsonb_array_length(v_items), 'items', v_items);
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('success', true, 'hoy', v_hoy, 'resumen', v_res, 'proximos', v_prox, 'correctivo', v_corr, 'calidad', v_cal);
END $$;

-- Ayudantes de la planificación
CREATE OR REPLACE FUNCTION public.mant_fallas_abiertas(p_plate text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  EXECUTE $q$SELECT count(*) FROM public.maintenance_requests WHERE vehicle_plate = $1
    AND upper(COALESCE(status, '')) NOT IN ('CERRADA', 'DESCARTADA', 'CONVERTIDA_OT')$q$ INTO n USING p_plate;
  RETURN n;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.mant_tiene_inspeccion(p_plate text, p_sistema text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.maintenance_plans WHERE vehicle_plate = p_plate AND is_active AND name = 'Inspección: ' || p_sistema);
$$;

-- Última lectura propia de la unidad (odómetro u horómetro registrado en el sistema, no el historial)
CREATE OR REPLACE FUNCTION public.mant_ultima_lectura(p_vehicle_id uuid, p_plate text)
RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d1 date; d2 date;
BEGIN
  IF to_regclass('public.vehicle_odometer_logs') IS NOT NULL THEN
    EXECUTE $q$SELECT max(created_at)::date FROM public.vehicle_odometer_logs WHERE vehicle_plate = $1 AND COALESCE(source_event, '') <> 'HISTORIAL_EXCEL'$q$ INTO d1 USING p_plate;
  END IF;
  SELECT max(created_at)::date INTO d2 FROM public.mant_turnos WHERE vehicle_id = p_vehicle_id AND horas IS NOT NULL;
  RETURN GREATEST(d1, d2);
EXCEPTION WHEN OTHERS THEN RETURN d2;
END $$;
REVOKE ALL ON FUNCTION public.mant_fallas_abiertas(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_tiene_inspeccion(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mant_ultima_lectura(uuid, text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Activar planes en un paso e inspecciones del plan correctivo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mant_activar_planes(p_plate text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0; v_err jsonb := '[]'::jsonb; v_who text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.menu_has_permission('mantenimiento-planes') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para activar planes (Mantenimiento › Preventivos)');
  END IF;
  BEGIN
    EXECUTE 'SELECT COALESCE(NULLIF(btrim(concat_ws('' '', to_jsonb(p) ->> ''first_name'', to_jsonb(p) ->> ''last_name'')), ''''), to_jsonb(p) ->> ''full_name'', to_jsonb(p) ->> ''email'') FROM public.profiles p WHERE p.id = $1'
      INTO v_who USING auth.uid();
  EXCEPTION WHEN OTHERS THEN v_who := NULL; END;
  FOR r IN SELECT id FROM public.maintenance_plans WHERE NOT is_active AND mant_template_id IS NOT NULL
             AND (p_plate IS NULL OR upper(vehicle_plate) = upper(btrim(p_plate))) LOOP
    BEGIN
      UPDATE public.maintenance_plans SET is_active = true,
        mant_base_origen = COALESCE(mant_base_origen, '') || ' · Activado con el historial por ' || COALESCE(v_who, 'Mantenimiento') || ' el ' || to_char(now() AT TIME ZONE 'America/Lima', 'DD/MM/YYYY')
      WHERE id = r.id;
      n := n + 1;
    EXCEPTION WHEN OTHERS THEN v_err := v_err || jsonb_build_object('id', r.id, 'error', SQLERRM);
    END;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'activados', n, 'errores', v_err);
END $$;

CREATE OR REPLACE FUNCTION public.mant_agregar_inspeccion(p_plate text, p_sistema text, p_dias integer, p_motivo text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plate text; v_nombre text; v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.menu_has_permission('mantenimiento-planes') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para editar planes (Mantenimiento › Preventivos)');
  END IF;
  IF p_dias IS NULL OR p_dias < 7 OR p_dias > 730 THEN RETURN jsonb_build_object('success', false, 'error', 'Frecuencia inválida'); END IF;
  EXECUTE 'SELECT plate FROM public.vehicles WHERE upper(plate) = upper($1)' INTO v_plate USING btrim(p_plate);
  IF v_plate IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Unidad no registrada'); END IF;
  SELECT COALESCE((SELECT nombre FROM public.mant_sistemas WHERE code = upper(p_sistema) OR nombre = p_sistema LIMIT 1), p_sistema) INTO v_nombre;
  IF public.mant_tiene_inspeccion(v_plate, v_nombre) THEN RETURN jsonb_build_object('success', false, 'error', 'La unidad ya tiene esa inspección'); END IF;
  INSERT INTO public.maintenance_plans (vehicle_plate, name, activity_description, frequency_days, last_performed_date, standard_tasks, expected_parts, is_active, mant_base_origen)
  VALUES (v_plate, 'Inspección: ' || v_nombre, 'Inspección de ' || lower(v_nombre) || ' por fallas repetidas',
    p_dias, (now() AT TIME ZONE 'America/Lima')::date,
    jsonb_build_array(jsonb_build_object('description', 'Inspeccionar ' || lower(v_nombre) || ' y registrar hallazgos'),
                      jsonb_build_object('description', 'Corregir lo encontrado antes de que falle (OT preventiva)')),
    '[]'::jsonb, true, COALESCE(p_motivo, 'Plan correctivo'))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'plan_id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.mant_planificacion() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_activar_planes(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mant_agregar_inspeccion(text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mant_planificacion() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_activar_planes(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mant_agregar_inspeccion(text, text, integer, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
