-- ============================================================
-- APT — Cobertura de fechas de las cargas y alerta de secuencia rota
-- ============================================================
-- Las cargas se consolidan: cada una reemplaza solo su rango de fechas y conserva el resto. apt_coverage arma, por
-- hoja, los rangos cubiertos por las cargas aplicadas y alerta:
--  * error: hueco entre cargas (fechas que nunca se cargaron) o una carga nueva que deja un hueco antes de su inicio;
--  * aviso: ENTRADA y SALIDA llegan a fechas distintas (el saldo de esos días queda incompleto);
--  * info: 4 o más días seguidos sin movimientos dentro de lo cargado (feriados o exportación incompleta).
-- p_preview (opcional): {"ENTRADA": {"desde": "2026-10-01", "hasta": "2026-10-10"}, "SALIDA": {...}} para evaluar una
-- carga antes de confirmarla.
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_coverage(p_preview jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  k text; v_kinds jsonb := '{}'::jsonb; v_alerts jsonb := '[]'::jsonb;
  v_ranges jsonb; v_gaps jsonb; v_idle jsonb; v_min date; v_max date; v_pd date; v_ph date; v_rep bigint; v_prev jsonb;
  v_max_e date; v_max_s date; g jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;

  FOREACH k IN ARRAY ARRAY['ENTRADA', 'SALIDA'] LOOP
    v_pd := public.apt_date(p_preview -> k -> 'desde');
    v_ph := public.apt_date(p_preview -> k -> 'hasta');

    -- Rangos cubiertos (cargas aplicadas + la carga en vista previa), fusionados cuando se tocan o se superponen
    WITH r AS (
      SELECT (u.summary -> lower(k) ->> 'desde')::date AS desde, (u.summary -> lower(k) ->> 'hasta')::date AS hasta
      FROM public.apt_uploads u
      WHERE u.status = 'APLICADA' AND u.summary -> lower(k) ->> 'desde' IS NOT NULL
      UNION ALL SELECT v_pd, v_ph WHERE v_pd IS NOT NULL AND v_ph IS NOT NULL),
    o AS (SELECT desde, hasta, max(hasta) OVER (ORDER BY desde, hasta ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM r),
    g AS (SELECT desde, hasta, sum(CASE WHEN prev_max IS NULL OR desde > prev_max + 1 THEN 1 ELSE 0 END) OVER (ORDER BY desde, hasta) AS grp FROM o),
    m AS (SELECT min(desde) AS desde, max(hasta) AS hasta FROM g GROUP BY grp),
    h AS (SELECT lag(hasta) OVER (ORDER BY desde) + 1 AS desde, desde - 1 AS hasta FROM m)
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('desde', desde, 'hasta', hasta) ORDER BY desde) FROM m), '[]'),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('desde', desde, 'hasta', hasta, 'dias', hasta - desde + 1) ORDER BY desde)
                     FROM h WHERE desde IS NOT NULL AND hasta >= desde), '[]'),
           (SELECT min(desde) FROM m), (SELECT max(hasta) FROM m)
      INTO v_ranges, v_gaps, v_min, v_max;

    -- Días seguidos sin movimientos dentro de lo cargado (4 o más)
    WITH d AS (SELECT fecha, lead(fecha) OVER (ORDER BY fecha) AS nx
               FROM (SELECT DISTINCT fecha FROM public.apt_movements WHERE active AND valid AND kind = k) z)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('desde', fecha + 1, 'hasta', nx - 1, 'dias', nx - fecha - 1) ORDER BY fecha), '[]')
      INTO v_idle FROM d WHERE nx - fecha - 1 >= 4;

    -- Lo que reemplazaría la carga en vista previa y si deja un hueco antes de su inicio
    v_prev := NULL;
    IF v_pd IS NOT NULL THEN
      SELECT count(*) INTO v_rep FROM public.apt_movements WHERE active AND valid AND kind = k AND fecha BETWEEN v_pd AND v_ph;
      v_prev := jsonb_build_object('desde', v_pd, 'hasta', v_ph, 'filas_a_reemplazar', v_rep,
        'hueco_antes', (SELECT jsonb_build_object('desde', mx + 1, 'hasta', v_pd - 1, 'dias', v_pd - mx - 1)
                        FROM (SELECT max((u.summary -> lower(k) ->> 'hasta')::date) AS mx FROM public.apt_uploads u
                              WHERE u.status = 'APLICADA' AND (u.summary -> lower(k) ->> 'hasta')::date < v_pd) z
                        WHERE mx IS NOT NULL AND v_pd > mx + 1));
    END IF;

    v_kinds := v_kinds || jsonb_build_object(k, jsonb_build_object('rangos', v_ranges, 'huecos', v_gaps, 'desde', v_min, 'hasta', v_max,
      'dias_sin_movimiento', v_idle, 'preview', v_prev));

    FOR g IN SELECT * FROM jsonb_array_elements(v_gaps) LOOP
      -- El hueco que deja la carga en vista previa se informa una sola vez (abajo)
      CONTINUE WHEN v_prev IS NOT NULL AND g ->> 'desde' = v_prev #>> '{hueco_antes,desde}';
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'error', 'hoja', k, 'mensaje', format(
        '%s: faltan cargar %s día(s), del %s al %s. Suba el reporte de esas fechas para no perder movimientos.',
        k, g ->> 'dias', to_char((g ->> 'desde')::date, 'DD/MM/YYYY'), to_char((g ->> 'hasta')::date, 'DD/MM/YYYY'))));
    END LOOP;
    IF v_prev IS NOT NULL AND v_prev -> 'hueco_antes' <> 'null'::jsonb THEN
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'error', 'hoja', k, 'mensaje', format(
        '%s: la carga empieza el %s pero lo cargado termina el %s; quedarían sin cargar %s día(s).',
        k, to_char(v_pd, 'DD/MM/YYYY'), to_char((v_prev #>> '{hueco_antes,desde}')::date - 1, 'DD/MM/YYYY'), v_prev #>> '{hueco_antes,dias}')));
    END IF;
    FOR g IN SELECT * FROM jsonb_array_elements(v_idle) LOOP
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'info', 'hoja', k, 'mensaje', format(
        '%s: %s días seguidos sin movimientos, del %s al %s. Confirme si fueron feriados o si el reporte vino incompleto.',
        k, g ->> 'dias', to_char((g ->> 'desde')::date, 'DD/MM/YYYY'), to_char((g ->> 'hasta')::date, 'DD/MM/YYYY'))));
    END LOOP;
    IF k = 'ENTRADA' THEN v_max_e := v_max; ELSE v_max_s := v_max; END IF;
  END LOOP;

  IF v_max_e IS NOT NULL AND v_max_s IS NOT NULL AND v_max_e <> v_max_s THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object('nivel', 'aviso', 'hoja', NULL, 'mensaje', format(
      'ENTRADA llega al %s y SALIDA al %s: cargue la hoja atrasada para que el saldo de esos días sea correcto.',
      to_char(v_max_e, 'DD/MM/YYYY'), to_char(v_max_s, 'DD/MM/YYYY'))));
  END IF;

  RETURN jsonb_build_object('success', true, 'hojas', v_kinds, 'alertas', v_alerts,
    'secuencia_ok', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_alerts) a WHERE a ->> 'nivel' IN ('error', 'aviso')));
END $$;

REVOKE ALL ON FUNCTION public.apt_coverage(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_coverage(jsonb) TO authenticated, service_role;

COMMIT;
