-- Soporte Mecánico: tablero del equipo en /mantenimiento/soporte.
-- La pantalla quedó vacía para quien no es técnico (solo mostraba «Mi avance») y en producción nadie tiene aún el rol
-- Soporte Mecánico, así que no había datos que ver. soporte_tablero mide la atención de fallas a nivel de equipo, con o
-- sin técnico asignado:
--   recibidas, atendidas, sin atender (y fuera de plazo), tiempos de respuesta y solución contra el SLA por criticidad,
--   backlog y envejecidas, evolución de 6 meses, unidades con más fallas, resultado por técnico y la lista de abiertas.
-- Fallas anteriores al módulo (sin first_response_at): la primera atención se estima con la primera OT de la misma unidad
-- creada dentro de los 15 días siguientes al reporte; se marca como «estimada».
-- Diagnóstico: avisa qué falta para medir (técnicos sin rol, fallas sin atención registrada, SLA, etc.).
BEGIN;

CREATE OR REPLACE FUNCTION public.soporte_puede_ver_tablero()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.soporte_es_supervisor() OR public.desempeno_es_revisor()
      OR public.has_tms_read_permission('mantenimiento-soporte') OR public.has_tms_read_permission('mantenimiento-fallas');
$$;
REVOKE ALL ON FUNCTION public.soporte_puede_ver_tablero() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_puede_ver_tablero() TO authenticated;

CREATE OR REPLACE FUNCTION public.soporte_tablero(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_hasta date := COALESCE(p_hasta, v_hoy);
  v_desde date := COALESCE(p_desde, date_trunc('month', v_hoy)::date);
  t0 timestamptz; t1 timestamptz; v_env numeric := public.soporte_param('envejecida_dias', 7);
  k record; v_out jsonb; v_diag jsonb := '[]'::jsonb; n_tec int; n_hist int; n_est int; n_sin int; has_ot boolean := to_regclass('public.maintenance_work_orders') IS NOT NULL;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.soporte_puede_ver_tablero() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a Soporte Mecánico');
  END IF;
  IF v_desde > v_hasta THEN RETURN jsonb_build_object('success', false, 'error', 'El periodo no es válido'); END IF;
  t0 := v_desde::timestamp AT TIME ZONE 'America/Lima';
  t1 := (v_hasta + 1)::timestamp AT TIME ZONE 'America/Lima';

  -- Fallas con primera atención registrada o estimada por la OT
  DROP TABLE IF EXISTS pg_temp.sp_f;
  CREATE TEMP TABLE sp_f ON COMMIT DROP AS
  SELECT f.* FROM public.soporte_fallas_v f
  WHERE f.rep >= LEAST(t0, (date_trunc('month', v_hasta) - interval '5 months')::timestamp AT TIME ZONE 'America/Lima') OR f.status NOT IN ('CERRADA', 'DESCARTADA');
  ALTER TABLE sp_f ADD COLUMN resp_est timestamptz, ADD COLUMN estimada boolean NOT NULL DEFAULT false;
  UPDATE sp_f SET resp_est = resp WHERE resp IS NOT NULL;
  IF has_ot THEN
    BEGIN
      EXECUTE $q$UPDATE sp_f f SET resp_est = o.ot, estimada = true
        FROM (SELECT f2.id, min(NULLIF(to_jsonb(w) ->> 'created_at', '')::timestamptz) AS ot
              FROM sp_f f2 JOIN public.maintenance_work_orders w ON upper(COALESCE(to_jsonb(w) ->> 'vehicle_plate', '')) = f2.plate
              WHERE f2.resp IS NULL AND NULLIF(to_jsonb(w) ->> 'created_at', '')::timestamptz BETWEEN f2.rep AND f2.rep + interval '15 days'
              GROUP BY f2.id) o
        WHERE o.id = f.id$q$;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  ALTER TABLE sp_f ADD COLUMN r_h numeric;
  UPDATE sp_f SET r_h = extract(epoch FROM resp_est - rep) / 3600.0 WHERE resp_est IS NOT NULL;

  SELECT count(*) AS recibidas,
         count(*) FILTER (WHERE sev = 'CRITICA') AS criticas,
         count(*) FILTER (WHERE r_h IS NOT NULL) AS atendidas,
         count(*) FILTER (WHERE estimada) AS estimadas,
         count(*) FILTER (WHERE status = 'DESCARTADA') AS descartadas,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r_h))::numeric, 2) AS resp_med,
         round(100.0 * count(*) FILTER (WHERE r_h <= sla_resp_h) / NULLIF(count(*) FILTER (WHERE r_h IS NOT NULL), 0), 1) AS resp_sla,
         count(*) FILTER (WHERE sol_h IS NOT NULL) AS cerradas,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY sol_h))::numeric, 1) AS sol_med,
         round(100.0 * count(*) FILTER (WHERE sol_h <= sla_sol_h) / NULLIF(count(*) FILTER (WHERE sol_h IS NOT NULL), 0), 1) AS sol_sla
  INTO k FROM sp_f WHERE rep >= t0 AND rep < t1;

  SELECT count(*) INTO n_tec FROM public.soporte_tecnicos();
  SELECT count(*) INTO n_hist FROM public.maintenance_requests;
  SELECT count(*) FILTER (WHERE estimada), count(*) FILTER (WHERE r_h IS NULL AND status NOT IN ('REPORTADA', 'DESCARTADA'))
  INTO n_est, n_sin FROM sp_f WHERE rep >= t0 AND rep < t1;

  IF n_tec = 0 THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'warn',
    'texto', 'Ningún usuario tiene el rol Soporte Mecánico: los avisos de fallas llegan solo a los supervisores y no hay desempeño por técnico. Asígnelo en Usuarios.')); END IF;
  IF n_hist = 0 THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'info',
    'texto', 'Aún no hay fallas reportadas. Se registran desde Mantenimiento › Fallas, Torre de Control, Despacho o el app del conductor.'));
  ELSIF k.recibidas = 0 THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'info',
    'texto', format('No hay fallas reportadas en el periodo (%s en total). Amplíe el periodo para ver la historia.', n_hist))); END IF;
  IF n_est > 0 THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'info',
    'texto', format('%s falla(s) sin primera atención registrada: se estimó con la primera OT de la unidad (anteriores al módulo o atendidas sin «Tomar»).', n_est))); END IF;
  IF n_sin > 0 THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'warn',
    'texto', format('%s falla(s) cambiaron de estado sin registrar quién ni cuándo las atendió: use «Tomar» en Fallas para medir la respuesta.', n_sin))); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.soporte_sla) THEN v_diag := v_diag || jsonb_build_array(jsonb_build_object('nivel', 'warn',
    'texto', 'No hay plazos (SLA) por criticidad: configúrelos en Reportes › Soporte › Plazos.')); END IF;

  SELECT jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'tecnicos_con_rol', n_tec, 'fallas_historicas', n_hist,
    'kpis', jsonb_build_object('recibidas', k.recibidas, 'criticas', k.criticas, 'atendidas', k.atendidas, 'estimadas', k.estimadas, 'descartadas', k.descartadas,
      'respuesta_mediana_h', k.resp_med, 'respuesta_en_sla_pct', k.resp_sla, 'cerradas', k.cerradas, 'solucion_mediana_h', k.sol_med, 'solucion_en_sla_pct', k.sol_sla,
      'abiertas', (SELECT count(*) FROM sp_f WHERE status NOT IN ('CERRADA', 'DESCARTADA')),
      'sin_atender', (SELECT count(*) FROM sp_f WHERE status = 'REPORTADA' AND resp IS NULL),
      'sin_atender_fuera_sla', (SELECT count(*) FROM sp_f WHERE status = 'REPORTADA' AND resp IS NULL AND now() > rep + make_interval(secs => COALESCE(sla_resp_h, 24) * 3600)),
      'envejecidas', (SELECT count(*) FROM sp_f WHERE status NOT IN ('CERRADA', 'DESCARTADA') AND rep < now() - make_interval(days => v_env::int)),
      'sin_tecnico', (SELECT count(*) FROM sp_f WHERE status NOT IN ('CERRADA', 'DESCARTADA') AND tecnico IS NULL),
      'envejecida_dias', v_env),
    'por_criticidad', (SELECT COALESCE(jsonb_agg(jsonb_build_object('criticidad', s.severidad, 'sla_respuesta_h', s.respuesta_horas, 'sla_solucion_h', s.solucion_horas,
        'recibidas', z.n, 'respuesta_mediana_h', z.rm, 'respuesta_en_sla_pct', z.rs, 'abiertas', z.ab) ORDER BY s.respuesta_horas), '[]'::jsonb)
      FROM public.soporte_sla s LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE rep >= t0 AND rep < t1) AS n,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r_h) FILTER (WHERE rep >= t0 AND rep < t1))::numeric, 2) AS rm,
               round(100.0 * count(*) FILTER (WHERE rep >= t0 AND rep < t1 AND r_h <= sla_resp_h) / NULLIF(count(*) FILTER (WHERE rep >= t0 AND rep < t1 AND r_h IS NOT NULL), 0), 1) AS rs,
               count(*) FILTER (WHERE status NOT IN ('CERRADA', 'DESCARTADA')) AS ab
        FROM sp_f WHERE sev = s.severidad) z ON true),
    'por_mes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mes', g.m, 'recibidas', z.n, 'cerradas', z.c, 'respuesta_mediana_h', z.rm) ORDER BY g.m), '[]'::jsonb)
      FROM (SELECT (date_trunc('month', v_hasta) - make_interval(months => i))::date AS m FROM generate_series(0, 5) i) g
      LEFT JOIN LATERAL (SELECT count(*) AS n, count(*) FILTER (WHERE sol_h IS NOT NULL) AS c, round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r_h))::numeric, 2) AS rm
                         FROM sp_f WHERE date_trunc('month', rep AT TIME ZONE 'America/Lima')::date = g.m) z ON true),
    'por_unidad', (SELECT COALESCE(jsonb_agg(jsonb_build_object('placa', plate, 'fallas', n, 'criticas', c, 'abiertas', ab) ORDER BY n DESC, plate), '[]'::jsonb) FROM (
      SELECT plate, count(*) AS n, count(*) FILTER (WHERE sev = 'CRITICA') AS c, count(*) FILTER (WHERE status NOT IN ('CERRADA', 'DESCARTADA')) AS ab
      FROM sp_f WHERE rep >= t0 AND rep < t1 GROUP BY plate ORDER BY n DESC LIMIT 8) u),
    'por_tecnico', (SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', tecnico, 'nombre', COALESCE(public.lease_person_name(tecnico), 'Sin asignar'),
        'fallas', n, 'respuesta_mediana_h', rm, 'respuesta_en_sla_pct', rs, 'cerradas', c, 'abiertas', ab) ORDER BY tecnico IS NULL, n DESC), '[]'::jsonb) FROM (
      SELECT tecnico, count(*) FILTER (WHERE rep >= t0 AND rep < t1) AS n,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY r_h) FILTER (WHERE rep >= t0 AND rep < t1))::numeric, 2) AS rm,
        round(100.0 * count(*) FILTER (WHERE rep >= t0 AND rep < t1 AND r_h <= sla_resp_h) / NULLIF(count(*) FILTER (WHERE rep >= t0 AND rep < t1 AND r_h IS NOT NULL), 0), 1) AS rs,
        count(*) FILTER (WHERE rep >= t0 AND rep < t1 AND sol_h IS NOT NULL) AS c,
        count(*) FILTER (WHERE status NOT IN ('CERRADA', 'DESCARTADA')) AS ab
      FROM sp_f GROUP BY tecnico HAVING count(*) FILTER (WHERE rep >= t0 AND rep < t1) > 0 OR count(*) FILTER (WHERE status NOT IN ('CERRADA', 'DESCARTADA')) > 0) z),
    'abiertas', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'placa', plate, 'criticidad', sev, 'estado', status, 'reportada', rep,
        'horas_abierta', round((extract(epoch FROM now() - rep) / 3600.0)::numeric, 1), 'sla_respuesta_h', sla_resp_h,
        'fuera_sla', resp IS NULL AND now() > rep + make_interval(secs => COALESCE(sla_resp_h, 24) * 3600),
        'descripcion', left(descr, 160), 'reporto', public.soporte_reportante(j), 'tecnico', public.lease_person_name(tecnico), 'atendida_at', resp)
        ORDER BY CASE sev WHEN 'CRITICA' THEN 1 WHEN 'ALTA' THEN 2 WHEN 'MEDIA' THEN 3 ELSE 4 END, rep), '[]'::jsonb)
      FROM (SELECT * FROM sp_f WHERE status NOT IN ('CERRADA', 'DESCARTADA') ORDER BY rep LIMIT 60) a),
    'diagnostico', v_diag)
  INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.soporte_tablero(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soporte_tablero(date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
