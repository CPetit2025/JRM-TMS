-- Eficiencia de Flota: Índice de Prioridad de Recambio (IPR).
-- La decisión de recambio combina factores técnicos, económicos y operativos (no solo la antigüedad). Cada unidad recibe
-- un puntaje 0–100 por factor (100 = más prioridad de recambio) y el IPR es su promedio ponderado:
--   Costo de mantenimiento 20 · Disponibilidad 15 · Frecuencia de fallas 15 · Antigüedad 10 · Kilometraje 10
--   Consumo de combustible 10 · Costo por km 10 · Productividad (costo por tonelada) 5 · Seguridad/criticidad 5
--   Opcionales (peso 0 por defecto, evaluación manual): Obsolescencia y Adecuación a la operación.
-- Rangos: 0–39 Conservar · 40–59 Monitorear · 60–79 Programar recambio · 80–100 Recambio prioritario.
-- Los costos se comparan contra la mediana del grupo (tracto, camión, grúa, liviano): una unidad que gasta más pero también
-- produce más no se castiga, porque el costo se mide por km y por tonelada transportada.
-- Además: valor residual (venderla hoy), costo de indisponibilidad (días fuera × costo diario de reemplazo) y la
-- comparación económica de fe_resumen (seguir un año más vs costo anual equivalente de una nueva).
-- Fallas críticas de seguridad (frenos, dirección/suspensión, transmisión, eléctrico; hidráulico en equipos) suben la
-- prioridad: 2 en 12 meses llevan el IPR al menos a 60, y 3 o más al menos a 80.
-- Reutiliza las tablas temporales de fe_resumen/fe_build (misma transacción): fe_a, fe_pm, fe_odo, fe_hr, fe_t, fe_e.
BEGIN;

-- Evaluación manual (obsolescencia y adecuación a la operación) por activo
CREATE TABLE IF NOT EXISTS public.fe_ipr_eval (
  code text PRIMARY KEY,
  obsolescencia int CHECK (obsolescencia BETWEEN 0 AND 100),
  adecuacion int CHECK (adecuacion BETWEEN 0 AND 100),
  nota text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fe_ipr_eval ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fe_ipr_eval_read ON public.fe_ipr_eval;
CREATE POLICY fe_ipr_eval_read ON public.fe_ipr_eval FOR SELECT TO authenticated USING (public.fe_can_view());
GRANT SELECT ON public.fe_ipr_eval TO authenticated;

-- Puntaje lineal: 0 en x0 y 100 en x1 (sirve también decreciente, x1 < x0)
CREATE OR REPLACE FUNCTION public.fe_lin(x numeric, x0 numeric, x1 numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN x IS NULL OR x0 = x1 THEN NULL ELSE round(LEAST(100, GREATEST(0, (x - x0) / (x1 - x0) * 100)), 1) END
$$;

-- Falla crítica de seguridad: reportada en Mantenimiento como CRITICA (o ALTA en un sistema de seguridad), o reparación
-- correctiva de S/ 500 o más (o mayor) en frenos, suspensión y dirección, transmisión o sistema eléctrico (hidráulico en equipos)
CREATE OR REPLACE FUNCTION public.fe_ev_critica(p_origen text, p_sev text, p_sistema text, p_monto numeric, p_mayor boolean, p_clase text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_origen = 'TMS' THEN p_sev = 'CRITICA' OR (p_sev = 'ALTA' AND p_sistema = ANY (s))
              ELSE p_sistema = ANY (s) AND (COALESCE(p_monto, 0) >= 500 OR COALESCE(p_mayor, false)) END
  FROM (SELECT ARRAY['FRENOS', 'SUSPENSION', 'TRANSMISION', 'ELECTRICO'] || CASE WHEN p_clase <> 'TRANSPORTE' THEN ARRAY['HIDRAULICO'] ELSE '{}'::text[] END AS s) z
$$;

CREATE OR REPLACE FUNCTION public.fe_ipr_pesos(pr jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('mantenimiento', 20, 'disponibilidad', 15, 'fallas', 15, 'antiguedad', 10, 'kilometraje', 10,
    'consumo', 10, 'costo_km', 10, 'productividad', 5, 'seguridad', 5, 'obsolescencia', 0, 'adecuacion', 0) || COALESCE(pr -> 'ipr_pesos', '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.fe_ipr(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; pr jsonb; w jsonb; v_hasta date; v_desde date; m12 date; m24 date; m36 date;
  kv jsonb; cd jsonb; hv jsonb; v_out jsonb;
BEGIN
  IF NOT public.fe_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo Eficiencia de Flota'); END IF;
  r := public.fe_resumen(p);   -- deja fe_a, fe_pm, fe_odo, fe_hr, fe_t, fe_e en esta transacción
  IF NOT COALESCE((r ->> 'success')::boolean, false) THEN RETURN r; END IF;
  pr := COALESCE(r -> 'params', '{}'::jsonb);
  w := public.fe_ipr_pesos(pr);
  v_hasta := (r ->> 'hasta')::date; v_desde := (r ->> 'desde')::date;
  m12 := (v_hasta - interval '11 months')::date; m24 := (v_hasta - interval '23 months')::date; m36 := (v_hasta - interval '35 months')::date;
  kv := '{"TRACTO": 1200000, "CAMION": 800000, "GRUA": 600000, "LIVIANO": 400000}'::jsonb || COALESCE(pr -> 'ipr_km_vida', '{}'::jsonb);
  hv := '{"MONTACARGA": 20000, "ELEVACION": 15000}'::jsonb || COALESCE(pr -> 'ipr_horas_vida', '{}'::jsonb);
  cd := jsonb_build_object('TRACTO', 1500, 'CAMION', 900, 'GRUA', 1200, 'LIVIANO', 350,
          'MONTACARGA', COALESCE((pr ->> 'alquiler_hora')::numeric, 60) * 8, 'ELEVACION', COALESCE((pr ->> 'alquiler_hora')::numeric, 60) * 6)
        || COALESCE(pr -> 'ipr_costo_dia', '{}'::jsonb);

  -- Averías: correctivos del historial (Excel) y fallas reportadas en Mantenimiento; sistema y criticidad
  DROP TABLE IF EXISTS pg_temp.fe_ev;
  CREATE TEMP TABLE fe_ev (code text, fecha date, sistema text, monto numeric, mayor boolean, sev text, origen text) ON COMMIT DROP;
  -- Correctivos del historial: un evento por día y sistema; los menores de S/ 100 (un foco, un fusible) no cuentan como avería
  BEGIN
    INSERT INTO fe_ev SELECT m.asset_code, m.fecha, COALESCE(m.sistema, public.mant_sistema(m.detalle, m.categoria)), sum(m.monto), bool_or(m.mayor), NULL, 'EXCEL'
    FROM public.fe_maint m WHERE m.fecha IS NOT NULL AND COALESCE(m.tipo_real, m.tipo) = 'CORRECTIVO' AND m.fecha >= m36
    GROUP BY 1, 2, 3 HAVING sum(m.monto) >= 100;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  IF to_regclass('public.maintenance_requests') IS NOT NULL AND to_regclass('public.vehicles') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$INSERT INTO fe_ev
        SELECT a.code, public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'created_at']),
          public.mant_sistema(to_jsonb(f) ->> 'description', NULL), NULL, false,
          translate(upper(COALESCE(to_jsonb(f) ->> 'severity', '')), 'Í', 'I'), 'TMS'
        FROM public.maintenance_requests f JOIN public.vehicles v ON v.plate = f.vehicle_plate JOIN fe_a a ON a.vehicle_id = v.id
        WHERE upper(COALESCE(to_jsonb(f) ->> 'status', '')) <> 'DESCARTADA' AND public.fe_jdate(to_jsonb(f), ARRAY['reported_at', 'created_at']) >= $1$q$ USING m36;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Base por activo (transporte y equipos)
  DROP TABLE IF EXISTS pg_temp.fe_ip;
  CREATE TEMP TABLE fe_ip ON COMMIT DROP AS
  SELECT a.code, a.clase, a.grupo, a.tipo, a.marca, a.anio_fab,
    COALESCE(t.edad, e.edad) AS edad, COALESCE(t.vida_util, e.vida_util) AS vida, COALESCE(t.valor, e.valor) AS valor, COALESCE(t.valor_ref, e.valor_ref) AS valor_ref,
    COALESCE(t.rec, e.rec) AS rec_eco, COALESCE(t.econ, e.econ) AS econ, COALESCE(t.econ_bajo, e.econ_bajo) AS econ_bajo, COALESCE(t.econ_alto, e.econ_alto) AS econ_alto,
    t.confianza, t.km_anio, t.kmgal, t.rend_rel, t.glp, t.ton, t.km AS km_ventana, t.mant_a, t.comb_c, t.otros, t.costo_t,
    e.costo_hora, e.costo_propio_hora, e.horas_anio, e.horometro, e.costo_anual,
    -- ventanas de 12 meses (mantenimiento devengado, km, combustible, días fuera)
    (SELECT sum(mant_amort) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS mant12,
    (SELECT sum(mant_amort) FROM fe_pm x WHERE x.code = a.code AND x.mes >= m24 AND x.mes < m12) AS mant24,
    (SELECT sum(mant_amort) FROM fe_pm x WHERE x.code = a.code AND x.mes >= m36 AND x.mes < m24) AS mant36,
    (SELECT sum(km) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS km12,
    (SELECT sum(km) FROM fe_pm x WHERE x.code = a.code AND x.mes >= m24 AND x.mes < m12) AS km24,
    (SELECT sum(km) FROM fe_pm x WHERE x.code = a.code AND x.mes >= m36 AND x.mes < m24) AS km36,
    (SELECT sum(km) FILTER (WHERE gal > 0 AND km > 0) / NULLIF(sum(gal) FILTER (WHERE gal > 0 AND km > 0), 0) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS kmgal12,
    (SELECT sum(km) FILTER (WHERE gal > 0 AND km > 0) / NULLIF(sum(gal) FILTER (WHERE gal > 0 AND km > 0), 0) FROM fe_pm x WHERE x.code = a.code AND x.mes >= m36 AND x.mes < m12) AS kmgal_prev,
    (SELECT COALESCE(sum(dias_fuera), 0) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS dias_fuera12,
    (SELECT count(*) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta AND (COALESCE(x.mant, 0) > 0 OR COALESCE(x.km, 0) > 0)) AS meses_dato12,
    EXISTS (SELECT 1 FROM fe_pm x WHERE x.code = a.code AND x.mes >= m36 AND x.dias_fuera > 0) AS registra_fuera,
    (SELECT sum(COALESCE(kg, 0)) / 1000.0 FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS ton12,
    (SELECT sum(viajes) FROM fe_pm x WHERE x.code = a.code AND x.mes BETWEEN m12 AND v_hasta) AS viajes12,
    -- km u horas acumuladas: la lectura más reciente que sea plausible (descarta las que duplican la mediana: dígitos de más)
    (WITH l AS (SELECT o.fecha, o.odo AS v FROM fe_odo o WHERE a.clase = 'TRANSPORTE' AND o.code = a.code AND o.odo > 0
                UNION ALL SELECT mm.fecha, mm.km_hrs FROM public.fe_maint mm WHERE a.clase = 'TRANSPORTE' AND mm.asset_code = a.code AND mm.km_hrs > 0 AND mm.fecha IS NOT NULL
                UNION ALL SELECT h.fecha, h.horas FROM fe_hr h WHERE a.clase <> 'TRANSPORTE' AND h.code = a.code AND h.horas > 0),
          md AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS m FROM l)
     SELECT l.v FROM l, md WHERE l.v <= md.m * 2 ORDER BY l.fecha DESC, l.v DESC LIMIT 1) AS acumulado,
    (SELECT count(*) FROM fe_ev v WHERE v.code = a.code AND v.fecha BETWEEN m12 AND v_hasta + interval '1 month - 1 day') AS averias12,
    (SELECT count(*) FROM fe_ev v WHERE v.code = a.code AND v.fecha >= m24 AND v.fecha < m12) AS averias24,
    (SELECT count(*) FROM fe_ev v WHERE v.code = a.code AND v.fecha BETWEEN m12 AND v_hasta + interval '1 month - 1 day'
       AND public.fe_ev_critica(v.origen, v.sev, v.sistema, v.monto, v.mayor, a.clase)) AS criticas12,
    (SELECT string_agg(DISTINCT ms.nombre, ', ') FROM fe_ev v JOIN public.mant_sistemas ms ON ms.code = v.sistema
       WHERE v.code = a.code AND v.fecha BETWEEN m12 AND v_hasta + interval '1 month - 1 day'
         AND public.fe_ev_critica(v.origen, v.sev, v.sistema, v.monto, v.mayor, a.clase)) AS criticas_sistemas,
    (SELECT count(DISTINCT v1.sistema) FROM fe_ev v1 JOIN fe_ev v2 ON v2.code = v1.code AND v2.sistema = v1.sistema AND v2.fecha > v1.fecha AND v2.fecha <= v1.fecha + 90
       WHERE v1.code = a.code AND v1.fecha >= m12 AND v1.sistema NOT IN ('OTROS', 'SERVICIOS', 'LLANTAS')) AS reincidencias,
    ev.obsolescencia, ev.adecuacion, ev.nota AS eval_nota
  FROM fe_a a
  LEFT JOIN fe_t t ON t.code = a.code
  LEFT JOIN fe_e e ON e.code = a.code
  LEFT JOIN public.fe_ipr_eval ev ON ev.code = a.code
  WHERE t.code IS NOT NULL OR e.code IS NOT NULL;

  ALTER TABLE fe_ip ADD COLUMN mant_km12 numeric, ADD COLUMN mant_km_prev numeric, ADD COLUMN mant_tend numeric, ADD COLUMN costo_km numeric,
    ADD COLUMN costo_ton numeric, ADD COLUMN disp numeric, ADD COLUMN mtbf numeric, ADD COLUMN fallas_tasa numeric, ADD COLUMN consumo_tend numeric,
    ADD COLUMN med_mant numeric, ADD COLUMN med_costo_km numeric, ADD COLUMN med_costo_ton numeric, ADD COLUMN med_fallas numeric,
    ADD COLUMN s_mant numeric, ADD COLUMN s_disp numeric, ADD COLUMN s_fallas numeric, ADD COLUMN s_edad numeric, ADD COLUMN s_km numeric,
    ADD COLUMN s_consumo numeric, ADD COLUMN s_costo numeric, ADD COLUMN s_prod numeric, ADD COLUMN s_seg numeric, ADD COLUMN s_obs numeric, ADD COLUMN s_adec numeric,
    ADD COLUMN ipr numeric, ADD COLUMN ipr_tecnico numeric, ADD COLUMN ipr_economico numeric, ADD COLUMN cobertura numeric, ADD COLUMN piso int, ADD COLUMN categoria text,
    ADD COLUMN costo_indisp numeric, ADD COLUMN venta_hoy numeric, ADD COLUMN perdida_valor numeric;

  UPDATE fe_ip SET
    mant_km12 = CASE WHEN clase = 'TRANSPORTE' THEN mant12 / NULLIF(km12, 0) ELSE mant12 END,
    mant_km_prev = CASE WHEN clase = 'TRANSPORTE' THEN (COALESCE(mant24, 0) + COALESCE(mant36, 0)) / NULLIF(COALESCE(km24, 0) + COALESCE(km36, 0), 0)
                        ELSE (COALESCE(mant24, 0) + COALESCE(mant36, 0)) / NULLIF((CASE WHEN mant24 IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN mant36 IS NOT NULL THEN 1 ELSE 0 END), 0) END,
    costo_km = CASE WHEN clase = 'TRANSPORTE' THEN (COALESCE(comb_c, 0) + COALESCE(mant_a, 0) + COALESCE(otros, 0)) / NULLIF(km_ventana, 0) ELSE costo_propio_hora END,
    costo_ton = CASE WHEN clase = 'TRANSPORTE' AND ton > 0 THEN (COALESCE(comb_c, 0) + COALESCE(mant_a, 0) + COALESCE(otros, 0)) / ton END,
    -- sin ningún registro de días fuera de servicio en 36 meses no se asume 100 %: queda sin dato
    disp = CASE WHEN meses_dato12 > 0 AND registra_fuera THEN 1 - LEAST(dias_fuera12, 365) / 365.0 END,
    mtbf = CASE WHEN averias12 > 0 THEN round(365.0 / averias12, 0) END,
    fallas_tasa = CASE WHEN clase = 'TRANSPORTE' AND km12 > 0 THEN averias12 / km12 * 10000 WHEN meses_dato12 > 0 THEN averias12::numeric END,
    consumo_tend = CASE WHEN kmgal_prev > 0 AND kmgal12 > 0 THEN kmgal12 / kmgal_prev - 1 END,
    costo_indisp = dias_fuera12 * COALESCE((cd ->> grupo)::numeric, 0),
    venta_hoy = valor * public.fe_residual(grupo, edad, pr),
    perdida_valor = valor * (public.fe_residual(grupo, edad, pr) - public.fe_residual(grupo, edad + 1, pr))
  WHERE true;
  UPDATE fe_ip SET mant_tend = mant_km12 / NULLIF(mant_km_prev, 0) - 1 WHERE mant_km12 IS NOT NULL AND mant_km_prev > 0;

  -- Medianas del grupo (si el grupo tiene una sola unidad, la de su clase)
  UPDATE fe_ip i SET med_mant = COALESCE(g.mm, c.mm), med_costo_km = COALESCE(g.ck, c.ck), med_costo_ton = COALESCE(g.ct, c.ct), med_fallas = COALESCE(g.mf, c.mf)
  FROM fe_ip i2
  LEFT JOIN LATERAL (SELECT CASE WHEN count(mant_km12) >= 2 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY mant_km12) END AS mm,
                            CASE WHEN count(costo_km) >= 2 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_km) END AS ck,
                            CASE WHEN count(costo_ton) >= 2 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_ton) END AS ct,
                            CASE WHEN count(fallas_tasa) >= 2 THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY fallas_tasa) END AS mf
                     FROM fe_ip x WHERE x.grupo = i2.grupo) g ON true
  LEFT JOIN LATERAL (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mant_km12) AS mm, percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_km) AS ck,
                            percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_ton) AS ct, percentile_cont(0.5) WITHIN GROUP (ORDER BY fallas_tasa) AS mf
                     FROM fe_ip x WHERE (x.clase = 'TRANSPORTE') = (i2.clase = 'TRANSPORTE')) c ON true
  WHERE i.code = i2.code;

  -- Puntajes 0–100 (100 = más prioridad de recambio)
  UPDATE fe_ip SET
    -- 1. Mantenimiento: nivel frente al grupo (60 %) y tendencia de los últimos 12 meses frente a los 24 anteriores (40 %)
    s_mant = CASE WHEN mant_km12 IS NULL THEN NULL
      WHEN mant_tend IS NULL THEN public.fe_lin(mant_km12 / NULLIF(med_mant, 0), 0.8, 2.0)
      ELSE round(0.6 * COALESCE(public.fe_lin(mant_km12 / NULLIF(med_mant, 0), 0.8, 2.0), 50) + 0.4 * public.fe_lin(mant_tend, 0, 0.6), 1) END,
    -- 2. Disponibilidad: 98 % o más = 0; 85 % o menos = 100
    s_disp = public.fe_lin(disp, 0.98, 0.85),
    -- 3. Fallas: tasa frente al grupo (por 10 000 km en transporte; por año en equipos) + 15 por sistema reincidente
    s_fallas = CASE WHEN fallas_tasa IS NULL THEN NULL
      ELSE LEAST(100, COALESCE(CASE WHEN med_fallas > 0 THEN public.fe_lin(fallas_tasa / med_fallas, 0.5, 2.5) ELSE public.fe_lin(averias12, 0, 6) END, 0)
                      + 15 * COALESCE(reincidencias, 0)) END,
    -- 4. Antigüedad frente a la vida útil: hasta la mitad = 0; 130 % = 100
    s_edad = public.fe_lin(edad::numeric / NULLIF(vida, 0), 0.5, 1.3),
    -- 5. Kilometraje (u horas) acumulado frente a la vida esperada del grupo
    s_km = public.fe_lin(acumulado / NULLIF(CASE WHEN clase = 'TRANSPORTE' THEN (kv ->> grupo)::numeric ELSE (hv ->> clase)::numeric END, 0), 0.4, 1.2),
    -- 6. Consumo: rendimiento frente al grupo (70 %) y caída del km/galón (30 %)
    s_consumo = CASE WHEN rend_rel IS NULL THEN NULL
      ELSE round(0.7 * public.fe_lin(rend_rel, 1.0, 0.75) + 0.3 * COALESCE(public.fe_lin(-consumo_tend, 0, 0.15), public.fe_lin(rend_rel, 1.0, 0.75)), 1) END,
    -- 7. Costo por km (combustible + mantenimiento + neumáticos + otros) frente al grupo; en equipos, costo propio por hora frente al alquiler
    s_costo = CASE WHEN clase = 'TRANSPORTE' THEN public.fe_lin(costo_km / NULLIF(med_costo_km, 0), 0.85, 1.5)
                   ELSE public.fe_lin(costo_propio_hora / NULLIF(COALESCE((pr ->> 'alquiler_hora')::numeric, 60), 0), 0.8, 1.3) END,
    -- 8. Productividad: costo por tonelada transportada frente al grupo (no castiga a la que más produce)
    s_prod = public.fe_lin(costo_ton / NULLIF(med_costo_ton, 0), 0.85, 1.6),
    -- 9. Seguridad: fallas críticas en los últimos 12 meses (1 = 50, 2 o más = 100)
    s_seg = CASE WHEN meses_dato12 > 0 OR criticas12 > 0 THEN public.fe_lin(criticas12, 0, 2) END,
    s_obs = obsolescencia, s_adec = adecuacion
  WHERE true;

  UPDATE fe_ip SET
    ipr = round(( COALESCE(s_mant * (w ->> 'mantenimiento')::numeric, 0) + COALESCE(s_disp * (w ->> 'disponibilidad')::numeric, 0)
                + COALESCE(s_fallas * (w ->> 'fallas')::numeric, 0) + COALESCE(s_edad * (w ->> 'antiguedad')::numeric, 0)
                + COALESCE(s_km * (w ->> 'kilometraje')::numeric, 0) + COALESCE(s_consumo * (w ->> 'consumo')::numeric, 0)
                + COALESCE(s_costo * (w ->> 'costo_km')::numeric, 0) + COALESCE(s_prod * (w ->> 'productividad')::numeric, 0)
                + COALESCE(s_seg * (w ->> 'seguridad')::numeric, 0) + COALESCE(s_obs * (w ->> 'obsolescencia')::numeric, 0)
                + COALESCE(s_adec * (w ->> 'adecuacion')::numeric, 0))
              / NULLIF( CASE WHEN s_mant IS NOT NULL THEN (w ->> 'mantenimiento')::numeric ELSE 0 END + CASE WHEN s_disp IS NOT NULL THEN (w ->> 'disponibilidad')::numeric ELSE 0 END
                + CASE WHEN s_fallas IS NOT NULL THEN (w ->> 'fallas')::numeric ELSE 0 END + CASE WHEN s_edad IS NOT NULL THEN (w ->> 'antiguedad')::numeric ELSE 0 END
                + CASE WHEN s_km IS NOT NULL THEN (w ->> 'kilometraje')::numeric ELSE 0 END + CASE WHEN s_consumo IS NOT NULL THEN (w ->> 'consumo')::numeric ELSE 0 END
                + CASE WHEN s_costo IS NOT NULL THEN (w ->> 'costo_km')::numeric ELSE 0 END + CASE WHEN s_prod IS NOT NULL THEN (w ->> 'productividad')::numeric ELSE 0 END
                + CASE WHEN s_seg IS NOT NULL THEN (w ->> 'seguridad')::numeric ELSE 0 END + CASE WHEN s_obs IS NOT NULL THEN (w ->> 'obsolescencia')::numeric ELSE 0 END
                + CASE WHEN s_adec IS NOT NULL THEN (w ->> 'adecuacion')::numeric ELSE 0 END, 0), 0),
    -- Subíndice técnico (deterioro) y económico (costo para producir), con los mismos pesos
    ipr_tecnico = round(( COALESCE(s_disp * (w ->> 'disponibilidad')::numeric, 0) + COALESCE(s_fallas * (w ->> 'fallas')::numeric, 0)
                + COALESCE(s_edad * (w ->> 'antiguedad')::numeric, 0) + COALESCE(s_km * (w ->> 'kilometraje')::numeric, 0)
                + COALESCE(s_seg * (w ->> 'seguridad')::numeric, 0) + COALESCE(public.fe_lin(mant_tend, 0, 0.6) * (w ->> 'mantenimiento')::numeric * 0.4, 0))
              / NULLIF( CASE WHEN s_disp IS NOT NULL THEN (w ->> 'disponibilidad')::numeric ELSE 0 END + CASE WHEN s_fallas IS NOT NULL THEN (w ->> 'fallas')::numeric ELSE 0 END
                + CASE WHEN s_edad IS NOT NULL THEN (w ->> 'antiguedad')::numeric ELSE 0 END + CASE WHEN s_km IS NOT NULL THEN (w ->> 'kilometraje')::numeric ELSE 0 END
                + CASE WHEN s_seg IS NOT NULL THEN (w ->> 'seguridad')::numeric ELSE 0 END + CASE WHEN mant_tend IS NOT NULL THEN (w ->> 'mantenimiento')::numeric * 0.4 ELSE 0 END, 0), 0),
    ipr_economico = round(( COALESCE(public.fe_lin(mant_km12 / NULLIF(med_mant, 0), 0.8, 2.0) * (w ->> 'mantenimiento')::numeric * 0.6, 0)
                + COALESCE(s_consumo * (w ->> 'consumo')::numeric, 0) + COALESCE(s_costo * (w ->> 'costo_km')::numeric, 0) + COALESCE(s_prod * (w ->> 'productividad')::numeric, 0))
              / NULLIF( CASE WHEN mant_km12 IS NOT NULL AND med_mant > 0 THEN (w ->> 'mantenimiento')::numeric * 0.6 ELSE 0 END
                + CASE WHEN s_consumo IS NOT NULL THEN (w ->> 'consumo')::numeric ELSE 0 END + CASE WHEN s_costo IS NOT NULL THEN (w ->> 'costo_km')::numeric ELSE 0 END
                + CASE WHEN s_prod IS NOT NULL THEN (w ->> 'productividad')::numeric ELSE 0 END, 0), 0),
    cobertura = round(100.0 * ( CASE WHEN s_mant IS NOT NULL THEN (w ->> 'mantenimiento')::numeric ELSE 0 END + CASE WHEN s_disp IS NOT NULL THEN (w ->> 'disponibilidad')::numeric ELSE 0 END
                + CASE WHEN s_fallas IS NOT NULL THEN (w ->> 'fallas')::numeric ELSE 0 END + CASE WHEN s_edad IS NOT NULL THEN (w ->> 'antiguedad')::numeric ELSE 0 END
                + CASE WHEN s_km IS NOT NULL THEN (w ->> 'kilometraje')::numeric ELSE 0 END + CASE WHEN s_consumo IS NOT NULL THEN (w ->> 'consumo')::numeric ELSE 0 END
                + CASE WHEN s_costo IS NOT NULL THEN (w ->> 'costo_km')::numeric ELSE 0 END + CASE WHEN s_prod IS NOT NULL THEN (w ->> 'productividad')::numeric ELSE 0 END
                + CASE WHEN s_seg IS NOT NULL THEN (w ->> 'seguridad')::numeric ELSE 0 END)
              / NULLIF((w ->> 'mantenimiento')::numeric + (w ->> 'disponibilidad')::numeric + (w ->> 'fallas')::numeric + (w ->> 'antiguedad')::numeric
                + (w ->> 'kilometraje')::numeric + (w ->> 'consumo')::numeric + (w ->> 'costo_km')::numeric + (w ->> 'productividad')::numeric + (w ->> 'seguridad')::numeric, 0), 0)
  WHERE true;

  -- Seguridad: fallas críticas repetidas elevan la prioridad
  UPDATE fe_ip SET piso = CASE WHEN criticas12 >= 3 THEN 80 WHEN criticas12 >= 2 THEN 60 END WHERE criticas12 >= 2;
  UPDATE fe_ip SET ipr = GREATEST(ipr, piso) WHERE piso IS NOT NULL;
  UPDATE fe_ip SET categoria = CASE
      WHEN ipr IS NULL OR COALESCE(cobertura, 0) < 50 THEN 'Datos insuficientes'
      WHEN ipr >= 80 THEN 'Recambio prioritario' WHEN ipr >= 60 THEN 'Programar recambio' WHEN ipr >= 40 THEN 'Monitorear' ELSE 'Conservar' END
  WHERE true;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'code', i.code, 'clase', i.clase, 'grupo', i.grupo, 'tipo', i.tipo, 'marca', i.marca, 'anio_fab', i.anio_fab, 'edad', i.edad, 'vida', i.vida,
      'ipr', i.ipr, 'ipr_tecnico', i.ipr_tecnico, 'ipr_economico', i.ipr_economico, 'cobertura', i.cobertura, 'categoria', i.categoria, 'piso_seguridad', i.piso,
      'factores', jsonb_build_array(
        jsonb_build_object('codigo', 'mantenimiento', 'nombre', 'Costo de mantenimiento', 'peso', (w ->> 'mantenimiento')::numeric, 'puntaje', i.s_mant,
          'valor', CASE WHEN i.clase = 'TRANSPORTE' THEN round(i.mant_km12, 3) ELSE round(i.mant12) END, 'unidad', CASE WHEN i.clase = 'TRANSPORTE' THEN 'S/ por km' ELSE 'S/ al año' END,
          'referencia', CASE WHEN i.clase = 'TRANSPORTE' THEN round(i.med_mant::numeric, 3) ELSE round(i.med_mant::numeric) END,
          'detalle', jsonb_build_object('m12', round(i.mant12), 'm13_24', round(i.mant24), 'm25_36', round(i.mant36), 'tendencia', round(i.mant_tend * 100))),
        jsonb_build_object('codigo', 'disponibilidad', 'nombre', 'Disponibilidad', 'peso', (w ->> 'disponibilidad')::numeric, 'puntaje', i.s_disp,
          'valor', round(i.disp * 100, 1), 'unidad', '%', 'detalle', jsonb_build_object('dias_fuera', i.dias_fuera12, 'horas_inmovil', round(i.dias_fuera12 * 24))),
        jsonb_build_object('codigo', 'fallas', 'nombre', 'Frecuencia de fallas', 'peso', (w ->> 'fallas')::numeric, 'puntaje', i.s_fallas,
          'valor', i.averias12, 'unidad', 'averías en 12 meses',
          'detalle', jsonb_build_object('mtbf_dias', i.mtbf, 'por_10000_km', round(CASE WHEN i.clase = 'TRANSPORTE' THEN i.fallas_tasa END, 2), 'reincidencias', i.reincidencias, 'averias_12_24', i.averias24)),
        jsonb_build_object('codigo', 'antiguedad', 'nombre', 'Antigüedad', 'peso', (w ->> 'antiguedad')::numeric, 'puntaje', i.s_edad,
          'valor', i.edad, 'unidad', 'años', 'referencia', i.vida),
        jsonb_build_object('codigo', 'kilometraje', 'nombre', CASE WHEN i.clase = 'TRANSPORTE' THEN 'Kilometraje acumulado' ELSE 'Horas acumuladas' END,
          'peso', (w ->> 'kilometraje')::numeric, 'puntaje', i.s_km, 'valor', round(i.acumulado), 'unidad', CASE WHEN i.clase = 'TRANSPORTE' THEN 'km' ELSE 'horas' END,
          'referencia', CASE WHEN i.clase = 'TRANSPORTE' THEN (kv ->> i.grupo)::numeric ELSE (hv ->> i.clase)::numeric END,
          'detalle', jsonb_build_object('km_anio', round(i.km_anio), 'km_12m', round(i.km12), 'horas_anio', i.horas_anio)),
        jsonb_build_object('codigo', 'consumo', 'nombre', 'Consumo de combustible', 'peso', (w ->> 'consumo')::numeric, 'puntaje', i.s_consumo,
          'valor', round(i.kmgal, 1), 'unidad', 'km/galón', 'referencia', round(i.kmgal / NULLIF(i.rend_rel, 0), 1),
          'detalle', jsonb_build_object('kmgal_12m', round(i.kmgal12, 1), 'kmgal_previo', round(i.kmgal_prev, 1), 'variacion', round(i.consumo_tend * 100))),
        jsonb_build_object('codigo', 'costo_km', 'nombre', CASE WHEN i.clase = 'TRANSPORTE' THEN 'Costo por km' ELSE 'Costo propio por hora' END,
          'peso', (w ->> 'costo_km')::numeric, 'puntaje', i.s_costo,
          'valor', round(i.costo_km, 2), 'unidad', CASE WHEN i.clase = 'TRANSPORTE' THEN 'S/ por km' ELSE 'S/ por hora' END,
          'referencia', CASE WHEN i.clase = 'TRANSPORTE' THEN round(i.med_costo_km::numeric, 2) ELSE COALESCE((pr ->> 'alquiler_hora')::numeric, 60) END),
        jsonb_build_object('codigo', 'productividad', 'nombre', 'Productividad (costo por tonelada)', 'peso', (w ->> 'productividad')::numeric, 'puntaje', i.s_prod,
          'valor', round(i.costo_ton, 2), 'unidad', 'S/ por t', 'referencia', round(i.med_costo_ton::numeric, 2),
          'detalle', jsonb_build_object('ton_12m', round(i.ton12, 1), 'viajes_12m', i.viajes12, 'ton_periodo', round(i.ton, 1))),
        jsonb_build_object('codigo', 'seguridad', 'nombre', 'Seguridad y criticidad', 'peso', (w ->> 'seguridad')::numeric, 'puntaje', i.s_seg,
          'valor', i.criticas12, 'unidad', 'fallas críticas en 12 meses', 'detalle', jsonb_build_object('sistemas', i.criticas_sistemas)),
        jsonb_build_object('codigo', 'obsolescencia', 'nombre', 'Obsolescencia (manual)', 'peso', (w ->> 'obsolescencia')::numeric, 'puntaje', i.s_obs, 'valor', i.obsolescencia, 'unidad', 'evaluación'),
        jsonb_build_object('codigo', 'adecuacion', 'nombre', 'Adecuación a la operación (manual)', 'peso', (w ->> 'adecuacion')::numeric, 'puntaje', i.s_adec, 'valor', i.adecuacion, 'unidad', 'evaluación')),
      'economia', jsonb_build_object('econ', i.econ, 'econ_bajo', i.econ_bajo, 'econ_alto', i.econ_alto, 'rec', i.rec_eco,
        'valor_reposicion', i.valor, 'valor_ref', i.valor_ref, 'venta_hoy', round(i.venta_hoy), 'perdida_valor_anio', round(i.perdida_valor),
        'costo_indisponibilidad', round(i.costo_indisp), 'costo_dia_reemplazo', (cd ->> i.grupo)::numeric,
        'seguir_total', CASE WHEN i.econ IS NOT NULL THEN (i.econ ->> 'seguir')::numeric + COALESCE(round(i.costo_indisp), 0) END),
      'produccion', jsonb_build_object('ton_12m', round(i.ton12, 1), 'viajes_12m', i.viajes12, 'km_12m', round(i.km12), 'costo_km', round(i.costo_km, 2), 'costo_ton', round(i.costo_ton, 2)),
      'evaluacion', jsonb_build_object('obsolescencia', i.obsolescencia, 'adecuacion', i.adecuacion, 'nota', i.eval_nota),
      'confianza', i.confianza)
    ORDER BY i.ipr DESC NULLS LAST, i.code), '[]'::jsonb)
  INTO v_out FROM fe_ip i;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'pesos', w, 'tasas', r -> 'tasas', 'puede_editar', public.fe_can_load(),
    'parametros', jsonb_build_object('km_vida', kv, 'horas_vida', hv, 'costo_dia', cd),
    'activos', v_out);
END $$;
REVOKE ALL ON FUNCTION public.fe_ipr(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fe_ipr(jsonb) TO authenticated, service_role;

-- Guardar pesos (y parámetros del IPR) y la evaluación manual de una unidad
CREATE OR REPLACE FUNCTION public.fe_ipr_guardar(p_pesos jsonb DEFAULT NULL, p_eval jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text; v numeric; v_p jsonb := '{}'::jsonb;
BEGIN
  IF NOT public.fe_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cambiar el índice de recambio'); END IF;
  IF p_pesos IS NOT NULL THEN
    FOR k, v IN SELECT key, value::numeric FROM jsonb_each_text(p_pesos) LOOP
      IF k NOT IN ('mantenimiento', 'disponibilidad', 'fallas', 'antiguedad', 'kilometraje', 'consumo', 'costo_km', 'productividad', 'seguridad', 'obsolescencia', 'adecuacion')
         OR v < 0 OR v > 100 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Peso no válido: ' || k);
      END IF;
      v_p := v_p || jsonb_build_object(k, v);
    END LOOP;
    UPDATE public.fe_settings SET params = params || jsonb_build_object('ipr_pesos', COALESCE(params -> 'ipr_pesos', '{}'::jsonb) || v_p),
      updated_at = now(), updated_by = auth.uid() WHERE id = 1;
  END IF;
  IF p_eval IS NOT NULL AND NULLIF(p_eval ->> 'code', '') IS NOT NULL THEN
    INSERT INTO public.fe_ipr_eval (code, obsolescencia, adecuacion, nota, updated_by, updated_at)
    VALUES (p_eval ->> 'code', NULLIF(p_eval ->> 'obsolescencia', '')::int, NULLIF(p_eval ->> 'adecuacion', '')::int, NULLIF(btrim(p_eval ->> 'nota'), ''), auth.uid(), now())
    ON CONFLICT (code) DO UPDATE SET obsolescencia = EXCLUDED.obsolescencia, adecuacion = EXCLUDED.adecuacion, nota = EXCLUDED.nota,
      updated_by = EXCLUDED.updated_by, updated_at = now();
  END IF;
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.fe_ipr_guardar(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fe_ipr_guardar(jsonb, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
