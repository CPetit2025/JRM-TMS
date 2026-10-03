-- ============================================================
-- Eficiencia de Flota: fecha y odómetros del despacho sin depender de columnas que producción no tiene
-- ============================================================
-- En producción dispatches no tiene scheduled_date (C27: ERR 42703), por lo que los viajes del TMS y los km por
-- odómetro de despacho quedaban vacíos sin aviso. Ahora la fecha del despacho es la primera columna presente entre
-- las de programación/salida y created_at, y los odómetros y el estado se leen con to_jsonb (columnas opcionales).

-- Primera fecha presente en j según el orden de keys (texto con hora → fecha en Lima)
CREATE OR REPLACE FUNCTION public.fe_jdate(j jsonb, keys text[])
RETURNS date LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN length(v) > 10 THEN (v::timestamptz AT TIME ZONE 'America/Lima')::date ELSE v::date END
  FROM (SELECT NULLIF(j ->> k, '') AS v, o FROM unnest(keys) WITH ORDINALITY u(k, o)) x
  WHERE v IS NOT NULL ORDER BY o LIMIT 1
$$;

-- Columnas candidatas a fecha del despacho, de la más específica a created_at
CREATE OR REPLACE FUNCTION public.fe_desp_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['scheduled_date', 'dispatch_date', 'departure_date', 'programmed_date', 'planned_date', 'service_date',
               'start_date', 'started_at', 'departed_at', 'created_at']
$$;

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
      EXECUTE $q$INSERT INTO fe_odo SELECT a.code, public.fe_jdate(to_jsonb(d), ARRAY['returned_at','completed_at','closed_at','finished_at'] || public.fe_desp_keys()), NULLIF(NULLIF(to_jsonb(d) ->> 'end_odometer', '')::numeric, 0), NULL
        FROM public.dispatches d JOIN fe_a a ON a.plate_key = public.fe_code(d.vehicle_plate) WHERE NULLIF(to_jsonb(d) ->> 'end_odometer', '') IS NOT NULL$q$;
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

GRANT EXECUTE ON FUNCTION public.fe_jdate(jsonb, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fe_desp_keys() TO authenticated;

NOTIFY pgrst, 'reload schema';
