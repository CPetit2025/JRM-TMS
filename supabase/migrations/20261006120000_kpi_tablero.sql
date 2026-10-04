-- Tablero de KPI: un solo módulo para el Jefe de Distribución y el Administrador, y «Mi avance» para cada usuario medido.
--   1. Quien revisa el desempeño (permiso «desempeno» o Administrador) también ve los KPI de Soporte Mecánico y revisa sus
--      informes (antes solo el supervisor de mantenimiento). Se parchea el texto de las funciones existentes.
--   2. Soporte Mecánico se presenta con la misma ficha que los demás roles (kpis, índice, cobertura, informe).
--   3. kpi_historial: foto mensual del índice por persona y rol, para la evolución mes a mes (cierre diario hasta el día 10).
--   4. kpi_tablero(mes): los 5 roles en una sola respuesta: promedios, distribución, evolución, alertas e informes por revisar.
--   5. kpi_mi_avance(mes): el tablero personal de cada usuario medido (su índice, el mes anterior, la evolución y lo pendiente).
-- No toca columnas de tablas operativas: todo se lee con las funciones de cálculo ya desplegadas.
BEGIN;

-- ------------------------------------------------------------
-- 1. El revisor de desempeño ve y revisa a Soporte Mecánico
-- ------------------------------------------------------------
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.soporte_kpis(uuid,date)'::regprocedure);
  IF position('desempeno_es_revisor' IN d) = 0 THEN
    d := replace(d, 'v_user <> auth.uid() AND NOT public.soporte_es_supervisor()',
                    'v_user <> auth.uid() AND NOT (public.soporte_es_supervisor() OR public.desempeno_es_revisor())');
    EXECUTE d;
  END IF;
  d := pg_get_functiondef('public.soporte_revisar_informe(uuid,text,text)'::regprocedure);
  IF position('desempeno_es_revisor' IN d) = 0 THEN
    d := replace(d, 'auth.uid() IS NULL OR NOT public.soporte_es_supervisor()',
                    'auth.uid() IS NULL OR NOT (public.soporte_es_supervisor() OR public.desempeno_es_revisor())');
    EXECUTE d;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Catálogo de roles medidos (los 4 de desempeño + Soporte Mecánico) y ficha común
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_roles_todos()
RETURNS TABLE (rol text, nombre text, informe boolean, orden int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.rol, k.nombre, k.informe, k.orden FROM public.kpi_roles k
  UNION ALL SELECT 'SOPORTE', 'Soporte Mecánico', true, 5;
$$;
REVOKE ALL ON FUNCTION public.kpi_roles_todos() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.kpi_miembros(p_rol text)
RETURNS TABLE (sujeto uuid, nombre text, user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF upper(p_rol) = 'SOPORTE' THEN
    RETURN QUERY SELECT t.user_id, t.nombre, t.user_id FROM public.soporte_tecnicos() t;
  ELSE
    RETURN QUERY SELECT m.sujeto, m.nombre, m.user_id FROM public.desempeno_miembros(p_rol) m;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.kpi_miembros(text) FROM PUBLIC, anon, authenticated;

-- Soporte Mecánico con la forma de desempeno_calcular (mismo índice y pesos de soporte_kpis)
CREATE OR REPLACE FUNCTION public.kpi_soporte_ficha(k jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb := COALESCE(k -> 'componentes', '{}'::jsonb); f jsonb := COALESCE(k -> 'fallas', '{}'::jsonb); b jsonb := COALESCE(k -> 'backlog', '{}'::jsonb);
  v_kpis jsonb; v_cob numeric;
BEGIN
  IF NOT COALESCE((k ->> 'success')::boolean, false) THEN RETURN k; END IF;
  v_kpis := jsonb_build_array(
    jsonb_build_object('codigo', 'respuesta', 'nombre', 'Fallas atendidas dentro del plazo de respuesta', 'grupo', 'Respuesta', 'unidad', '%', 'meta', 100, 'sentido', 'MAYOR', 'peso', 30,
      'descripcion', 'Primera atención dentro del plazo según la criticidad', 'valor', f -> 'respuesta_en_sla_pct', 'puntaje', c -> 'respuesta',
      'contexto', CASE WHEN f ->> 'respuesta_prom_h' IS NOT NULL THEN 'promedio ' || (f ->> 'respuesta_prom_h') || ' h' END),
    jsonb_build_object('codigo', 'solucion', 'nombre', 'Fallas resueltas dentro del plazo', 'grupo', 'Solución', 'unidad', '%', 'meta', 100, 'sentido', 'MAYOR', 'peso', 30,
      'descripcion', 'Cierre dentro del plazo de solución según la criticidad', 'valor', f -> 'solucion_en_sla_pct', 'puntaje', c -> 'solucion',
      'contexto', CASE WHEN (f ->> 'cerradas') IS NOT NULL THEN (f ->> 'cerradas') || ' cerradas' END),
    jsonb_build_object('codigo', 'reincidencia', 'nombre', 'Reincidencias', 'grupo', 'Calidad', 'unidad', '%', 'meta', 0, 'sentido', 'MENOR', 'peso', 15,
      'descripcion', 'La misma unidad vuelve a fallar poco después del cierre', 'valor', f -> 'reincidencia_pct', 'puntaje', c -> 'reincidencia'),
    jsonb_build_object('codigo', 'backlog', 'nombre', 'Fallas abiertas envejecidas', 'grupo', 'Backlog', 'unidad', '%', 'meta', 0, 'sentido', 'MENOR', 'peso', 10,
      'descripcion', 'Fallas abiertas con más de ' || COALESCE(b ->> 'envejecida_dias', '7') || ' días', 'valor', CASE WHEN c ->> 'backlog' IS NOT NULL THEN 100 - (c ->> 'backlog')::numeric END,
      'puntaje', c -> 'backlog', 'contexto', COALESCE(b ->> 'abiertas', '0') || ' abiertas'),
    jsonb_build_object('codigo', 'informe', 'nombre', 'Puntualidad del informe mensual', 'grupo', 'Informe', 'unidad', '%', 'meta', 100, 'sentido', 'MAYOR', 'peso', 15,
      'descripcion', '−15 puntos por día de atraso (vence el día 3)', 'valor', c -> 'informe', 'puntaje', c -> 'informe'),
    jsonb_build_object('codigo', 'atendidas', 'nombre', 'Fallas atendidas en el mes', 'grupo', 'Volumen', 'unidad', 'n', 'meta', 0, 'sentido', 'MAYOR', 'peso', 0,
      'descripcion', 'Informativo', 'valor', f -> 'atendidas'),
    jsonb_build_object('codigo', 'ot_cerradas', 'nombre', 'Órdenes de trabajo cerradas', 'grupo', 'Volumen', 'unidad', 'n', 'meta', 0, 'sentido', 'MAYOR', 'peso', 0,
      'descripcion', 'Informativo', 'valor', k -> 'ot' -> 'cerradas'));
  v_cob := COALESCE(CASE WHEN c ->> 'respuesta' IS NOT NULL THEN 30 END, 0) + COALESCE(CASE WHEN c ->> 'solucion' IS NOT NULL THEN 30 END, 0)
         + COALESCE(CASE WHEN c ->> 'reincidencia' IS NOT NULL THEN 15 END, 0) + COALESCE(CASE WHEN c ->> 'backlog' IS NOT NULL THEN 10 END, 0)
         + COALESCE(CASE WHEN c ->> 'informe' IS NOT NULL THEN 15 END, 0);
  -- Mismo criterio que los demás roles: con menos del 40 % del peso medido el índice no es representativo
  RETURN jsonb_build_object('success', true, 'rol', 'SOPORTE', 'sujeto', k -> 'usuario', 'periodo', k -> 'periodo', 'periodo_fin', k -> 'periodo_fin',
    'kpis', v_kpis, 'indice', CASE WHEN v_cob >= 40 THEN k -> 'indice' END, 'cobertura', v_cob,
    'calificacion', CASE WHEN v_cob >= 40 THEN k -> 'calificacion' ELSE '"SIN_DATOS"'::jsonb END, 'siniestro_grave', false,
    'informe', k -> 'informe', 'notas', '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.kpi_ficha(p_rol text, p_sujeto uuid, p_mes date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF upper(p_rol) = 'SOPORTE' THEN RETURN public.kpi_soporte_ficha(public.soporte_kpis(p_sujeto, p_mes)); END IF;
  RETURN public.desempeno_calcular(p_rol, p_sujeto, p_mes);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'rol', upper(p_rol), 'sujeto', p_sujeto, 'kpis', '[]'::jsonb,
                            'calificacion', 'SIN_DATOS', 'notas', jsonb_build_array(SQLERRM));
END $$;
REVOKE ALL ON FUNCTION public.kpi_ficha(text, uuid, date) FROM PUBLIC, anon, authenticated;

-- Lo que más baja el índice (puntaje < 80), para listas y alertas
CREATE OR REPLACE FUNCTION public.kpi_por_mejorar(f jsonb, p_max int DEFAULT 3)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'puntaje')::numeric, (x ->> 'peso')::numeric DESC), '[]'::jsonb)
  FROM (SELECT jsonb_build_object('codigo', x ->> 'codigo', 'nombre', x ->> 'nombre', 'valor', x -> 'valor', 'unidad', x ->> 'unidad',
               'meta', x -> 'meta', 'sentido', x ->> 'sentido', 'puntaje', x -> 'puntaje', 'peso', x -> 'peso') AS x
        FROM jsonb_array_elements(COALESCE(f -> 'kpis', '[]'::jsonb)) x
        WHERE COALESCE((x ->> 'peso')::numeric, 0) > 0 AND x ->> 'puntaje' IS NOT NULL AND (x ->> 'puntaje')::numeric < 80
        ORDER BY (x ->> 'puntaje')::numeric, (x ->> 'peso')::numeric DESC LIMIT p_max) s;
$$;

-- ------------------------------------------------------------
-- 3. Historial mensual
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_historial (
  rol text NOT NULL,
  sujeto uuid NOT NULL,
  periodo date NOT NULL CHECK (extract(day FROM periodo) = 1),
  nombre text,
  user_id uuid,
  indice numeric,
  calificacion text,
  cobertura numeric,
  ficha jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculado_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rol, sujeto, periodo)
);
ALTER TABLE public.kpi_historial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_historial_read ON public.kpi_historial;
CREATE POLICY kpi_historial_read ON public.kpi_historial FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.desempeno_es_revisor());
GRANT SELECT ON public.kpi_historial TO authenticated;

CREATE OR REPLACE FUNCTION public.kpi_cerrar_mes(p_mes date)
RETURNS int LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_mes date := date_trunc('month', p_mes)::date; r record; m record; f jsonb; n int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.desempeno_es_revisor() THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM public.kpi_roles_todos() LOOP
    FOR m IN SELECT * FROM public.kpi_miembros(r.rol) LOOP
      f := public.kpi_ficha(r.rol, m.sujeto, v_mes);
      CONTINUE WHEN NOT COALESCE((f ->> 'success')::boolean, false);
      INSERT INTO public.kpi_historial AS h (rol, sujeto, periodo, nombre, user_id, indice, calificacion, cobertura, ficha, calculado_at)
      VALUES (r.rol, m.sujeto, v_mes, m.nombre, m.user_id, (f ->> 'indice')::numeric, f ->> 'calificacion', (f ->> 'cobertura')::numeric, f, now())
      ON CONFLICT (rol, sujeto, periodo) DO UPDATE SET nombre = EXCLUDED.nombre, user_id = EXCLUDED.user_id, indice = EXCLUDED.indice,
        calificacion = EXCLUDED.calificacion, cobertura = EXCLUDED.cobertura, ficha = EXCLUDED.ficha, calculado_at = now();
      n := n + 1;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.kpi_cerrar_mes(date) FROM PUBLIC, anon, authenticated;

-- Evolución de un rol (promedio del equipo) o de una persona, de los meses anteriores a p_mes
CREATE OR REPLACE FUNCTION public.kpi_tendencia(p_rol text, p_sujeto uuid, p_mes date, p_meses int DEFAULT 5)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('periodo', g.periodo, 'indice', h.prom, 'con_indice', h.n) ORDER BY g.periodo), '[]'::jsonb)
  FROM (SELECT (date_trunc('month', p_mes) - make_interval(months => i))::date AS periodo FROM generate_series(1, p_meses) i) g
  LEFT JOIN LATERAL (SELECT round(avg(x.indice), 0) AS prom, count(x.indice) AS n FROM public.kpi_historial x
                     WHERE x.rol = upper(p_rol) AND x.periodo = g.periodo AND (p_sujeto IS NULL OR x.sujeto = p_sujeto)) h ON true;
$$;
REVOKE ALL ON FUNCTION public.kpi_tendencia(text, uuid, date, int) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Tablero (Jefe de Distribución y Administrador)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_tablero(p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_mes date := date_trunc('month', COALESCE(p_mes, v_hoy))::date;
  r record; m record; f jsonb; a record; v_miem jsonb; v_roles jsonb := '[]'::jsonb; v_alertas jsonb := '[]'::jsonb; v_inf jsonb; v_gen record;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.desempeno_es_revisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'El tablero de KPI es para el Jefe de Distribución y el Administrador');
  END IF;
  FOR r IN SELECT * FROM public.kpi_roles_todos() ORDER BY orden LOOP
    v_miem := '[]'::jsonb;
    FOR m IN SELECT * FROM public.kpi_miembros(r.rol) ORDER BY nombre LOOP
      f := public.kpi_ficha(r.rol, m.sujeto, v_mes) || jsonb_build_object('nombre', m.nombre, 'user_id', m.user_id, 'rol', r.rol, 'rol_nombre', r.nombre);
      f := f || jsonb_build_object('por_mejorar', public.kpi_por_mejorar(f));
      v_miem := v_miem || jsonb_build_array(f);
      IF COALESCE((f ->> 'siniestro_grave')::boolean, false) THEN
        v_alertas := v_alertas || jsonb_build_array(jsonb_build_object('tipo', 'SINIESTRO', 'nivel', 'crit', 'rol', r.rol, 'rol_nombre', r.nombre, 'nombre', m.nombre,
          'texto', 'Siniestro grave con responsabilidad: índice del mes en 0'));
      ELSIF f ->> 'calificacion' = 'BAJO' THEN
        v_alertas := v_alertas || jsonb_build_array(jsonb_build_object('tipo', 'BAJO', 'nivel', 'crit', 'rol', r.rol, 'rol_nombre', r.nombre, 'nombre', m.nombre,
          'texto', 'Índice ' || (f ->> 'indice') || ' (bajo)' || COALESCE(' · ' || (SELECT string_agg(x ->> 'nombre', ', ') FROM jsonb_array_elements(f -> 'por_mejorar') x), '')));
      END IF;
      IF f -> 'informe' ->> 'estado' = 'ATRASADO' THEN
        v_alertas := v_alertas || jsonb_build_array(jsonb_build_object('tipo', 'INFORME', 'nivel', 'warn', 'rol', r.rol, 'rol_nombre', r.nombre, 'nombre', m.nombre,
          'texto', 'Informe mensual atrasado ' || COALESCE(f -> 'informe' ->> 'dias_atraso', '?') || ' día(s)'));
      END IF;
      IF NOT COALESCE((f ->> 'success')::boolean, false) THEN
        v_alertas := v_alertas || jsonb_build_array(jsonb_build_object('tipo', 'ERROR', 'nivel', 'info', 'rol', r.rol, 'rol_nombre', r.nombre, 'nombre', m.nombre,
          'texto', 'No se pudo calcular: ' || left(COALESCE(f ->> 'error', ''), 120)));
      END IF;
    END LOOP;
    SELECT count(*) AS miembros, count(x ->> 'indice') AS con_indice, round(avg((x ->> 'indice')::numeric), 0) AS promedio,
           min((x ->> 'indice')::numeric) AS minimo, max((x ->> 'indice')::numeric) AS maximo,
           count(*) FILTER (WHERE x ->> 'calificacion' = 'EXCELENTE') AS exc, count(*) FILTER (WHERE x ->> 'calificacion' = 'BUENO') AS bue,
           count(*) FILTER (WHERE x ->> 'calificacion' = 'REGULAR') AS reg, count(*) FILTER (WHERE x ->> 'calificacion' = 'BAJO') AS baj,
           count(*) FILTER (WHERE COALESCE(x ->> 'calificacion', 'SIN_DATOS') = 'SIN_DATOS') AS sd,
           count(*) FILTER (WHERE x -> 'informe' ->> 'estado' = 'ATRASADO') AS inf_atr,
           count(*) FILTER (WHERE x -> 'informe' ->> 'estado' = 'ENVIADO') AS inf_rev,
           count(*) FILTER (WHERE x -> 'informe' ->> 'estado' = 'REVISADO') AS inf_ok
    INTO a FROM jsonb_array_elements(v_miem) x;
    v_roles := v_roles || jsonb_build_array(jsonb_build_object('rol', r.rol, 'nombre', r.nombre, 'informe', r.informe,
      'miembros', v_miem, 'n', a.miembros, 'con_indice', a.con_indice, 'promedio', a.promedio, 'minimo', a.minimo, 'maximo', a.maximo,
      'dist', jsonb_build_object('EXCELENTE', a.exc, 'BUENO', a.bue, 'REGULAR', a.reg, 'BAJO', a.baj, 'SIN_DATOS', a.sd),
      'informes', jsonb_build_object('atrasados', a.inf_atr, 'por_revisar', a.inf_rev, 'revisados', a.inf_ok),
      'tendencia', public.kpi_tendencia(r.rol, NULL, v_mes) || jsonb_build_array(jsonb_build_object('periodo', v_mes, 'indice', a.promedio, 'con_indice', a.con_indice))));
  END LOOP;

  -- Informes de todos los roles: los enviados sin revisar y los de los últimos 3 meses
  SELECT COALESCE(jsonb_agg(z ORDER BY z ->> 'estado' <> 'ENVIADO', z ->> 'enviado_at' DESC), '[]'::jsonb) INTO v_inf FROM (
    SELECT jsonb_build_object('origen', 'DESEMPENO', 'id', i.id, 'rol', i.rol, 'rol_nombre', COALESCE(k.nombre, i.rol), 'user_id', i.user_id,
             'nombre', public.lease_person_name(i.user_id), 'periodo', i.periodo, 'estado', i.estado, 'enviado_at', i.enviado_at, 'dias_atraso', i.dias_atraso,
             'indice', i.kpis -> 'indice', 'logros', i.logros, 'problemas', i.problemas, 'acciones', i.acciones, 'comentario', i.comentario) AS z
    FROM public.desempeno_informes i LEFT JOIN public.kpi_roles k ON k.rol = i.rol
    WHERE i.estado = 'ENVIADO' OR i.periodo >= (v_mes - interval '2 months')::date
    UNION ALL
    SELECT jsonb_build_object('origen', 'SOPORTE', 'id', i.id, 'rol', 'SOPORTE', 'rol_nombre', 'Soporte Mecánico', 'user_id', i.user_id,
             'nombre', public.lease_person_name(i.user_id), 'periodo', i.periodo, 'estado', i.estado, 'enviado_at', i.enviado_at, 'dias_atraso', i.dias_atraso,
             'indice', i.kpis -> 'indice', 'logros', i.logros, 'problemas', i.problemas, 'acciones', i.acciones, 'comentario', i.comentario)
    FROM public.soporte_informes i WHERE i.estado = 'ENVIADO' OR i.periodo >= (v_mes - interval '2 months')::date) s;

  SELECT round(avg((x ->> 'promedio')::numeric), 0) AS indice, sum((x ->> 'n')::int) AS miembros, sum((x ->> 'con_indice')::int) AS con_indice,
         sum((x -> 'dist' ->> 'BAJO')::int) AS bajos, sum((x -> 'informes' ->> 'atrasados')::int) AS atrasados
  INTO v_gen FROM jsonb_array_elements(v_roles) x;

  RETURN jsonb_build_object('success', true, 'periodo', v_mes, 'mes_en_curso', v_mes = date_trunc('month', v_hoy)::date,
    'general', jsonb_build_object('indice', v_gen.indice, 'miembros', v_gen.miembros, 'con_indice', v_gen.con_indice, 'bajos', v_gen.bajos,
      'informes_atrasados', v_gen.atrasados, 'informes_por_revisar', (SELECT count(*) FROM jsonb_array_elements(v_inf) x WHERE x ->> 'estado' = 'ENVIADO'),
      'calificacion', CASE WHEN v_gen.indice IS NULL THEN 'SIN_DATOS' WHEN v_gen.indice >= 90 THEN 'EXCELENTE' WHEN v_gen.indice >= 75 THEN 'BUENO'
                           WHEN v_gen.indice >= 60 THEN 'REGULAR' ELSE 'BAJO' END),
    'roles', v_roles, 'alertas', v_alertas, 'informes', v_inf);
END $$;
REVOKE ALL ON FUNCTION public.kpi_tablero(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kpi_tablero(date) TO authenticated;

-- ------------------------------------------------------------
-- 5. Mi avance (cada usuario medido)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kpi_mi_avance(p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_mes date := date_trunc('month', COALESCE(p_mes, v_hoy))::date;
  v_prev date; r record; f jsonb; p jsonb; v_items jsonb := '[]'::jsonb; v_dias int; v_trans int;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  v_prev := (v_mes - interval '1 month')::date;
  v_dias := extract(day FROM (v_mes + interval '1 month - 1 day'))::int;
  v_trans := CASE WHEN v_mes = date_trunc('month', v_hoy)::date THEN extract(day FROM v_hoy)::int WHEN v_mes > v_hoy THEN 0 ELSE v_dias END;
  FOR r IN SELECT kr.rol, kr.nombre, kr.informe, kr.orden, m.sujeto FROM public.kpi_roles_todos() kr CROSS JOIN LATERAL public.kpi_miembros(kr.rol) m
           WHERE m.user_id = auth.uid() ORDER BY kr.orden LOOP
    f := public.kpi_ficha(r.rol, r.sujeto, v_mes);
    p := public.kpi_ficha(r.rol, r.sujeto, v_prev);   -- en vivo: el informe del mes anterior puede haberse enviado hoy
    v_items := v_items || jsonb_build_array(f || jsonb_build_object('rol', r.rol, 'rol_nombre', r.nombre, 'tiene_informe', r.informe,
      'por_mejorar', public.kpi_por_mejorar(f, 5),
      'anterior', jsonb_build_object('periodo', v_prev, 'indice', p -> 'indice', 'calificacion', p -> 'calificacion', 'informe', p -> 'informe'),
      'tendencia', public.kpi_tendencia(r.rol, r.sujeto, v_prev, 4)
                   || jsonb_build_array(jsonb_build_object('periodo', v_prev, 'indice', p -> 'indice'), jsonb_build_object('periodo', v_mes, 'indice', f -> 'indice')),
      'kpis_en_meta', (SELECT count(*) FROM jsonb_array_elements(COALESCE(f -> 'kpis', '[]'::jsonb)) x WHERE COALESCE((x ->> 'peso')::numeric, 0) > 0 AND (x ->> 'puntaje')::numeric >= 100),
      'kpis_medidos', (SELECT count(*) FROM jsonb_array_elements(COALESCE(f -> 'kpis', '[]'::jsonb)) x WHERE COALESCE((x ->> 'peso')::numeric, 0) > 0 AND x ->> 'puntaje' IS NOT NULL),
      'kpis_total', (SELECT count(*) FROM jsonb_array_elements(COALESCE(f -> 'kpis', '[]'::jsonb)) x WHERE COALESCE((x ->> 'peso')::numeric, 0) > 0)));
  END LOOP;
  RETURN jsonb_build_object('success', true, 'periodo', v_mes, 'dias_mes', v_dias, 'dias_transcurridos', v_trans,
    'roles', v_items, 'revisor', public.desempeno_es_revisor());
END $$;
REVOKE ALL ON FUNCTION public.kpi_mi_avance(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kpi_mi_avance(date) TO authenticated;

-- ------------------------------------------------------------
-- 6. Cierre diario (hasta el día 10 se recalcula el mes anterior) y aviso al revisor el día 5
-- ------------------------------------------------------------
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('KPI_TABLERO_MES', 'CUMPLIMIENTO', 'Tablero de KPI del mes anterior listo para revisar', 'info', ARRAY['desempeno'], false)
ON CONFLICT (evento) DO NOTHING;

CREATE OR REPLACE FUNCTION public.kpi_historial_job(p_ahora timestamptz DEFAULT NULL)
RETURNS int LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hoy date := (COALESCE(p_ahora, now()) AT TIME ZONE 'America/Lima')::date;
  v_prev date := (date_trunc('month', v_hoy) - interval '1 month')::date;
  meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
  n int := 0; g record;
BEGIN
  IF extract(day FROM v_hoy) <= 10 OR NOT EXISTS (SELECT 1 FROM public.kpi_historial WHERE periodo = v_prev) THEN
    n := public.kpi_cerrar_mes(v_prev);
  END IF;
  IF extract(day FROM v_hoy) = 5 THEN
    SELECT round(avg(indice), 0) AS prom, count(*) FILTER (WHERE calificacion = 'BAJO') AS bajos INTO g FROM public.kpi_historial WHERE periodo = v_prev;
    PERFORM public.notif_emit('KPI_TABLERO_MES', 'kpi-tab-' || to_char(v_prev, 'YYYYMM'),
      'Indicadores de ' || meses[extract(month FROM v_prev)::int] || ' listos',
      'Índice promedio ' || COALESCE(g.prom::text, 'sin datos') || CASE WHEN g.bajos > 0 THEN ' · ' || g.bajos || ' persona(s) con índice bajo' ELSE '' END
      || '. Revise el tablero y los informes.', '/desempeno?tab=tablero', NULL);
  END IF;
  RETURN n;
EXCEPTION WHEN OTHERS THEN RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.kpi_historial_job(timestamptz) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('kpi-historial'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('kpi-historial', '25 11 * * *', $cron$SELECT public.kpi_historial_job()$cron$);   -- 06:25 Lima
  END IF;
END $$;

-- Historial inicial: los 6 meses anteriores (si algo falla, el cierre diario lo completa)
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..6 LOOP
    BEGIN
      PERFORM public.kpi_cerrar_mes((date_trunc('month', (now() AT TIME ZONE 'America/Lima')::date) - make_interval(months => i))::date);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'kpi_historial %: %', i, SQLERRM;
    END;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
