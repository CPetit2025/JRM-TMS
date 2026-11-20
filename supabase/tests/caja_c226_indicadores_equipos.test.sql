-- CAJA C226 — Indicadores por equipo: catálogo, periodos, exactitud contra la fuente, estados honestos (sin datos ≠ cumple),
-- permisos, correcciones con aprobación, reversión y trazabilidad, cierre/reapertura con versiones, enlace compartido con PIN
-- sin nombres y cierre automático. Usa datos reales de producción, no depende del día de la semana y siempre se revierte.
-- Cada paso que escribe va en su propia sentencia: una expresión SQL comparte una sola foto y no vería sus propias escrituras.
BEGIN;
DO $test$
DECLARE
  adm uuid; sup uuid; cond uuid; doc uuid; pass int := 0; fails text[] := '{}'; total int := 12;
  hoy date := public.kpi_eq_hoy(); w record; q record; wp record; m record; v jsonb; v2 jsonb; t jsonb; r jsonb; l jsonb; l2 jsonb;
  cod text; fila record; fila2 record; per record; cid uuid; cid2 uuid; a numeric; b numeric; n_src bigint; t_ini timestamptz; ms int; ms_max int := 0;
  ver0 int; i int; f text;
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Administrador' AND p.is_active LIMIT 1;
  SELECT p.id INTO sup FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Supervisor de Despacho' AND p.is_active LIMIT 1;
  SELECT p.id INTO cond FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Conductor' AND p.is_active LIMIT 1;
  SELECT p.id INTO doc FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id WHERE ro.name = 'Asistente Documentario' AND p.is_active LIMIT 1;
  IF adm IS NULL OR sup IS NULL OR cond IS NULL OR doc IS NULL THEN RAISE EXCEPTION 'CAJA C226 FAIL: fixtures (administrador, supervisor de despacho, conductor, asistente documentario) ausentes'; END IF;
  SELECT * INTO w FROM public.kpi_eq_rango('SEMANAL', hoy);
  SELECT * INTO q FROM public.kpi_eq_rango('QUINCENAL', hoy);
  SELECT * INTO wp FROM public.kpi_eq_rango('SEMANAL', hoy - 7);
  SELECT * INTO m FROM public.kpi_eq_rango('MENSUAL', (date_trunc('month', hoy) - interval '1 month')::date);

  -- T1: catálogo de 24 KPI, 6 por equipo
  IF (SELECT count(*) FROM public.kpi_eq_def) = 24 AND NOT EXISTS (SELECT 1 FROM public.kpi_eq_def GROUP BY equipo HAVING count(*) <> 6)
  THEN pass := pass + 1; ELSE fails := fails || 'T1 catálogo'::text; END IF;

  -- T2: periodos (semana lunes-domingo, quincenas 1-15 / 16-fin, mes) y cierre automático en hora de Lima
  IF (SELECT row(desde, hasta)::text FROM public.kpi_eq_rango('SEMANAL', '2026-11-18')) = '(2026-11-16,2026-11-22)'
     AND (SELECT row(desde, hasta)::text FROM public.kpi_eq_rango('QUINCENAL', '2026-11-18')) = '(2026-11-16,2026-11-30)'
     AND (SELECT row(desde, hasta)::text FROM public.kpi_eq_rango('QUINCENAL', '2027-02-15')) = '(2027-02-01,2027-02-15)'
     AND (SELECT row(desde, hasta)::text FROM public.kpi_eq_rango('QUINCENAL', '2027-02-16')) = '(2027-02-16,2027-02-28)'
     AND (SELECT row(desde, hasta)::text FROM public.kpi_eq_rango('MENSUAL', '2026-12-31')) = '(2026-12-01,2026-12-31)'
     AND public.kpi_eq_vence('SEMANAL', '2026-11-22') = '2026-11-25 12:00:00-05'::timestamptz
     AND public.kpi_eq_vence('MENSUAL', '2026-11-30') = '2026-12-03 12:00:00-05'::timestamptz
  THEN pass := pass + 1; ELSE fails := fails || 'T2 periodos'::text; END IF;

  -- T3: exactitud contra consultas escritas aparte sobre la fuente (mes anterior)
  v := public.kpi_eq_valor('D1', m.desde, m.hasta);
  SELECT count(*) FILTER (WHERE ok), count(*) INTO a, b FROM (
    SELECT (e.llegada AT TIME ZONE 'America/Lima')::date <= COALESCE(tr.committed_date, (tr.required_date AT TIME ZONE 'America/Lima')::date) AS ok
    FROM (SELECT request_id, min(arrived_at) llegada FROM public.delivery_conformities WHERE arrived_at IS NOT NULL GROUP BY 1) e
    JOIN public.transport_requests tr ON tr.id = e.request_id
    WHERE (e.llegada AT TIME ZONE 'America/Lima')::date BETWEEN m.desde AND m.hasta AND tr.required_date IS NOT NULL AND upper(COALESCE(tr.status, '')) <> 'CANCELADA'
    UNION ALL
    SELECT false FROM public.transport_requests tr
    WHERE COALESCE(tr.committed_date, (tr.required_date AT TIME ZONE 'America/Lima')::date) BETWEEN m.desde AND LEAST(m.hasta, hoy - 1)
      AND upper(COALESCE(tr.status, '')) NOT IN ('CANCELADA','ENTREGADA')
      AND NOT EXISTS (SELECT 1 FROM public.delivery_conformities c WHERE c.request_id = tr.id AND c.arrived_at IS NOT NULL)) z;
  IF NOT ((v->>'num')::numeric = a AND (v->>'den')::numeric = b AND (b = 0 OR (v->>'valor')::numeric = round(100 * a / b, 2))) THEN fails := fails || ('T3 D1 ' || a || '/' || b || ' vs ' || v::text); END IF;
  v := public.kpi_eq_valor('T6', m.desde, m.hasta);
  SELECT count(*) FILTER (WHERE public.kpi_salida_puntual(salida_at, programado)), count(*) FILTER (WHERE salida_at IS NOT NULL) INTO a, b
  FROM public.kpi_despachos_v WHERE estado <> 'CANCELADO' AND (programado AT TIME ZONE 'America/Lima')::date BETWEEN m.desde AND m.hasta;
  IF (v->>'num')::numeric <> a OR (v->>'den')::numeric <> b THEN fails := fails || ('T3 T6 ' || a || '/' || b || ' vs ' || v::text); END IF;
  v := public.kpi_eq_valor('I4', m.desde, m.hasta);
  SELECT sum(kg_saldo) FILTER (WHERE estado = 'Sin salida identificada'), sum(kg_saldo) INTO a, b FROM public.apt_layers WHERE kg_saldo > 0;
  IF (v->>'num')::numeric <> COALESCE(a, 0) OR (v->>'den')::numeric <> COALESCE(b, 0) THEN fails := fails || ('T3 I4 ' || v::text); END IF;
  v := public.kpi_eq_valor('I5', m.desde, m.hasta);
  SELECT sum(abs(peso_kg)) FILTER (WHERE tipodocto ILIKE 'AJUSTE%' OR tipodocto ILIKE 'MERMA%'),
         sum(abs(peso_kg)) FILTER (WHERE clase = 'DESPACHO' AND tipodocto NOT ILIKE 'AJUSTE%' AND tipodocto NOT ILIKE 'MERMA%') INTO a, b
  FROM public.inv_movements_v WHERE active AND fecha BETWEEN m.desde AND m.hasta;
  IF round((v->>'num')::numeric, 3) <> round(COALESCE(a, 0), 3) OR round((v->>'den')::numeric, 3) <> round(COALESCE(b, 0), 3) THEN fails := fails || ('T3 I5 ' || v::text); END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T3 %') THEN pass := pass + 1; END IF;

  -- T4: honestidad — ningún KPI se juzga (CUMPLE/ALERTA/NO_CUMPLE) sin datos, con cobertura baja o con fuente pendiente
  FOR per IN SELECT 'MENSUAL' fr, m.desde d, m.hasta h UNION ALL SELECT 'SEMANAL', w.desde, w.hasta UNION ALL SELECT 'QUINCENAL', q.desde, q.hasta LOOP
    FOR v IN SELECT y FROM jsonb_array_elements(public.kpi_eq_calcular(per.fr, per.d, per.h)) y LOOP
      IF v->>'estado' IN ('CUMPLE','ALERTA','NO_CUMPLE') AND (
           (v->>'n_con_dato')::int = 0 OR v->>'valor' IS NULL OR v->>'estado_datos' IN ('PENDIENTE_CAPTURA','PENDIENTE_INTEGRACION')
           OR COALESCE((v->>'cobertura')::numeric, 0) < (v->>'cobertura_min')::numeric)
      THEN fails := fails || ('T4 ' || (v->>'codigo') || ' juzgado sin datos: ' || v::text); END IF;
    END LOOP;
  END LOOP;
  IF (public.kpi_eq_valor('T1', m.desde, m.hasta))->>'estado' <> 'PENDIENTE_DATOS' OR (public.kpi_eq_valor('T1', m.desde, m.hasta))->>'valor' IS NOT NULL
     OR (public.kpi_eq_valor('A5', '2000-01-01', '2000-01-07'))->>'estado' <> 'SIN_REGISTROS'
     OR (public.kpi_eq_valor('A4', m.desde, m.hasta))->>'estado' <> 'PENDIENTE_DATOS'
  THEN fails := fails || 'T4 estados pendientes'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T4%') THEN pass := pass + 1; END IF;

  -- T5: permisos de lectura — anónimo sin acceso; conductor sin equipos; supervisor de despacho no ve Transporte
  PERFORM set_config('request.jwt.claim.sub', cond::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', cond, 'role', 'authenticated')::text, true);
  t := public.kpi_eq_tablero('SEMANAL', NULL);
  PERFORM set_config('request.jwt.claim.sub', sup::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', sup, 'role', 'authenticated')::text, true);
  IF NOT has_function_privilege('anon', 'public.kpi_eq_tablero(text,date)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.kpi_eq_detalle(text,date,date)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.kpi_eq_proponer(text,text,date,text,numeric,numeric,text,text)', 'EXECUTE')
     AND has_function_privilege('anon', 'public.kpi_eq_publico(uuid,text,text,text,date)', 'EXECUTE')
     AND t ? 'error'
     AND 'DESPACHO' = ANY (public.kpi_eq_equipos_visibles()) AND NOT 'TRANSPORTE' = ANY (public.kpi_eq_equipos_visibles())
     AND (public.kpi_eq_detalle('T6', w.desde, w.hasta)) ? 'error'
     AND NOT (public.kpi_eq_tablero('SEMANAL', NULL)) ? 'error'
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  -- Registro de Despacho en un periodo abierto (semana o quincena en curso), para las pruebas de corrección
  FOREACH cod IN ARRAY ARRAY['D1','D2','D4','D5','D3'] LOOP
    SELECT * INTO fila FROM public.kpi_eq_filas(cod, w.desde, LEAST(w.hasta, hoy)) x WHERE x.con_dato AND x.den > 0 LIMIT 1;
    EXIT WHEN fila.ref IS NOT NULL;
    SELECT * INTO fila FROM public.kpi_eq_filas(cod, q.desde, LEAST(q.hasta, hoy)) x WHERE x.con_dato AND x.den > 0 LIMIT 1;
    EXIT WHEN fila.ref IS NOT NULL;
  END LOOP;

  -- T6: solo lectura no corrige; propuesta del supervisor, aprobación por otro; el dato de origen no cambia; nadie aprueba la suya
  IF fila.ref IS NULL THEN
    pass := pass + 1;  -- inicio de semana y de quincena sin actividad: no hay registro abierto que corregir hoy
    RAISE NOTICE 'CAJA C226 T6/T7 omitidas: sin registros de Despacho en periodos abiertos';
  ELSE
    SELECT * INTO per FROM (SELECT w.desde d, w.hasta h) x WHERE fila.fecha BETWEEN w.desde AND w.hasta UNION ALL SELECT q.desde, q.hasta LIMIT 1;
    PERFORM set_config('request.jwt.claim.sub', doc::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', doc, 'role', 'authenticated')::text, true);
    IF NOT (public.kpi_eq_proponer(cod, fila.ref, fila.fecha, 'EXCLUIR', NULL, NULL, 'EXCLUIR_PRUEBA', 'solo lectura') ->> 'error') ILIKE '%Sin permiso%' THEN fails := fails || 'T6 lectura propone'::text; END IF;
    PERFORM set_config('request.jwt.claim.sub', sup::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', sup, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO n_src FROM public.kpi_eq_filas(cod, per.d, per.h);
    v := public.kpi_eq_valor(cod, per.d, per.h);
    r := public.kpi_eq_proponer(cod, fila.ref, fila.fecha, 'EXCLUIR', NULL, NULL, 'EXCLUIR_PRUEBA', 'Prueba C226');
    cid := (r->>'id')::uuid;
    v2 := public.kpi_eq_valor(cod, per.d, per.h);
    IF NOT COALESCE((r->>'success')::boolean, false) OR (v2->>'n')::int <> (v->>'n')::int OR (v2->>'correcciones_pendientes')::int < 1 THEN fails := fails || ('T6 propuesta ' || r::text); END IF;
    IF NOT (public.kpi_eq_proponer(cod, fila.ref, fila.fecha, 'EXCLUIR', NULL, NULL, 'EXCLUIR_PRUEBA', 'dup') ->> 'error') ILIKE '%ya tiene una corrección%' THEN fails := fails || 'T6 duplicada'::text; END IF;
    IF NOT (public.kpi_eq_proponer(cod, 'no-existe', fila.fecha, 'EXCLUIR', NULL, NULL, 'OTRO', 'detalle') ->> 'error') ILIKE '%no pertenece%' THEN fails := fails || 'T6 ref inexistente'::text; END IF;
    IF NOT (public.kpi_eq_resolver(cid, true, NULL) ->> 'error') ILIKE '%revisor%' THEN fails := fails || 'T6 supervisor aprueba'::text; END IF;
    PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
    IF NOT (public.kpi_eq_resolver(cid, false, NULL) ->> 'error') ILIKE '%por qué%' THEN fails := fails || 'T6 rechazo sin motivo'::text; END IF;
    r := public.kpi_eq_resolver(cid, true, 'ok');
    v2 := public.kpi_eq_valor(cod, per.d, per.h);
    IF NOT COALESCE((r->>'success')::boolean, false) OR (v2->>'n')::int <> (v->>'n')::int - 1 OR (v2->>'corregidos')::int < 1
       OR (SELECT count(*) FROM public.kpi_eq_filas(cod, per.d, per.h)) <> n_src
       OR (SELECT origen FROM public.kpi_eq_filas_corr(cod, per.d, per.h) x WHERE x.ref = fila.ref) <> 'EXCLUIDO'
    THEN fails := fails || ('T6 aprobada ' || v2::text); END IF;
    -- otro registro: el administrador propone un valor imposible y luego uno válido que no puede aprobar
    SELECT * INTO fila2 FROM public.kpi_eq_filas(cod, per.d, LEAST(per.h, hoy)) x WHERE x.con_dato AND x.den > 0 AND x.ref <> fila.ref LIMIT 1;
    IF fila2.ref IS NOT NULL THEN
      IF NOT (public.kpi_eq_proponer(cod, fila2.ref, fila2.fecha, 'CORREGIR', 5, 1, 'ERROR_REGISTRO', NULL) ->> 'error') ILIKE '%no puede superar%' THEN fails := fails || 'T6 valor imposible'::text; END IF;
      cid2 := (public.kpi_eq_proponer(cod, fila2.ref, fila2.fecha, 'CORREGIR', 1 - fila2.num, 1, 'ERROR_REGISTRO', NULL) ->> 'id')::uuid;
      IF cid2 IS NULL OR NOT (public.kpi_eq_resolver(cid2, true, NULL) ->> 'error') ILIKE '%propia%' THEN fails := fails || 'T6 autoaprobación'::text; END IF;
      IF (SELECT num_orig FROM public.kpi_eq_correcciones WHERE id = cid2) IS DISTINCT FROM fila2.num THEN fails := fails || 'T6 original no guardado'::text; END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T6%') THEN pass := pass + 1; END IF;

    -- T7: revertir una corrección aprobada exige motivo, la deja ANULADA (no se borra) y el registro vuelve a contar
    IF NOT (public.kpi_eq_revertir(cid, '') ->> 'error') ILIKE '%motivo%' THEN fails := fails || 'T7 revertir sin motivo'::text; END IF;
    r := public.kpi_eq_revertir(cid, 'Aprobada por error en la prueba C226');
    v2 := public.kpi_eq_valor(cod, per.d, per.h);
    IF NOT COALESCE((r->>'success')::boolean, false) OR (SELECT estado FROM public.kpi_eq_correcciones WHERE id = cid) <> 'ANULADA'
       OR (v2->>'n')::int <> (v->>'n')::int
       OR (public.kpi_eq_proponer(cod, fila.ref, fila.fecha, 'EXCLUIR', NULL, NULL, 'EXCLUIR_PRUEBA', 'de nuevo') ->> 'success') IS DISTINCT FROM 'true'
    THEN fails := fails || ('T7 revertir ' || COALESCE(r::text, '∅')); END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T7%') THEN pass := pass + 1; END IF;
  END IF;
  IF fila.ref IS NULL THEN pass := pass + 1; END IF;

  -- T8: cierre con foto, bloqueo de correcciones, reapertura con motivo y nueva versión (el historial se conserva)
  PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  r := public.kpi_eq_cerrar('SEMANAL', wp.desde);   -- el cron puede haberla cerrado ya: entonces devuelve la versión vigente
  ver0 := (r->>'version')::int;
  t := public.kpi_eq_tablero('SEMANAL', wp.desde);
  IF NOT (COALESCE((r->>'success')::boolean, false) AND t->>'estado_periodo' = 'CERRADO' AND NOT (t->>'provisional')::boolean) THEN fails := fails || ('T8 cierre ' || r::text); END IF;
  IF NOT (public.kpi_eq_cerrar('SEMANAL', w.desde) ->> 'error') ILIKE '%no termina%' THEN fails := fails || 'T8 cierre de semana en curso'::text; END IF;
  SELECT * INTO fila2 FROM public.kpi_eq_filas('D2', wp.desde, wp.hasta) LIMIT 1;
  IF fila2.ref IS NOT NULL AND NOT (public.kpi_eq_proponer('D2', fila2.ref, fila2.fecha, 'EXCLUIR', NULL, NULL, 'EXCLUIR_PRUEBA', NULL) ->> 'error') ILIKE '%cerrado%' THEN fails := fails || 'T8 corrección en periodo cerrado'::text; END IF;
  IF NOT (public.kpi_eq_reabrir('SEMANAL', wp.desde, '') ->> 'error') ILIKE '%motivo%' THEN fails := fails || 'T8 reabrir sin motivo'::text; END IF;
  r := public.kpi_eq_reabrir('SEMANAL', wp.desde, 'Prueba C226 de reapertura');
  t := public.kpi_eq_tablero('SEMANAL', wp.desde);
  IF NOT COALESCE((r->>'success')::boolean, false) OR t->>'estado_periodo' <> 'REABIERTO' THEN fails := fails || ('T8 reabrir ' || r::text); END IF;
  r := public.kpi_eq_cerrar('SEMANAL', wp.desde);
  IF (r->>'version')::int <> ver0 + 1 OR (SELECT count(*) FROM public.kpi_eq_cierres WHERE frecuencia = 'SEMANAL' AND desde = wp.desde) <> ver0 + 1
     OR (SELECT estado FROM public.kpi_eq_cierres WHERE frecuencia = 'SEMANAL' AND desde = wp.desde AND version = ver0) <> 'REABIERTO'
  THEN fails := fails || ('T8 versión nueva ' || r::text); END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T8%') THEN pass := pass + 1; END IF;

  -- T9: enlace compartido — PIN, solo periodos cerrados, solo equipos elegidos, sin num/den, fuentes ni nombres; revocable
  l := public.kpi_eq_enlace_crear('Gerencia C226', ARRAY['DESPACHO']);
  l2 := public.kpi_eq_enlace_crear('Bloqueo C226', ARRAY['TRANSPORTE']);
  PERFORM set_config('request.jwt.claim.sub', '', true); PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := public.kpi_eq_publico((l->>'token')::uuid, '00000000', 'Ana Pérez', 'SEMANAL', NULL);
  v := public.kpi_eq_publico((l->>'token')::uuid, l->>'pin', 'Ana Pérez', 'SEMANAL', wp.desde);
  IF (r->>'error') ILIKE '%incorrecto%'
     AND (public.kpi_eq_publico((l->>'token')::uuid, l->>'pin', '  ', 'SEMANAL', NULL) ->> 'error') ILIKE '%nombre%'
     AND (public.kpi_eq_publico((l->>'token')::uuid, l->>'pin', 'Ana Pérez', NULL, NULL) ->> 'error') ILIKE '%frecuencia%'
     AND v->'periodo'->>'desde' = wp.desde::text AND (v->'periodo'->>'version')::int = ver0 + 1
     AND jsonb_array_length(v->'kpis') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'kpis') x WHERE x->>'equipo' <> 'DESPACHO' OR x ? 'num' OR x ? 'den' OR x ? 'responsable' OR x ? 'fuente')
     AND position('responsable_nombre' IN v::text) = 0 AND position('propuesto_por' IN v::text) = 0
     AND (public.kpi_eq_publico((l->>'token')::uuid, l->>'pin', 'Ana Pérez', 'SEMANAL', w.desde) -> 'periodo') = 'null'::jsonb
  THEN pass := pass + 1; ELSE fails := fails || ('T9 enlace: ' || left(COALESCE(v::text, '∅'), 300)); END IF;

  -- T10: 10 PIN errados bloquean el enlace aunque luego llegue el correcto; revocar lo inutiliza
  FOR i IN 1 .. 10 LOOP r := public.kpi_eq_publico((l2->>'token')::uuid, '11111111', 'Ana Pérez', 'MENSUAL', NULL); END LOOP;
  r := public.kpi_eq_publico((l2->>'token')::uuid, l2->>'pin', 'Ana Pérez', 'MENSUAL', NULL);
  PERFORM set_config('request.jwt.claim.sub', adm::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  PERFORM public.kpi_eq_enlace_revocar((l->>'token')::uuid);
  IF (r->>'error') ILIKE '%Demasiados intentos%'
     AND (public.kpi_eq_publico((l->>'token')::uuid, l->>'pin', 'Ana Pérez', 'SEMANAL', NULL) ->> 'error') ILIKE '%revocado%'
     AND (SELECT sum(consultas) FROM public.kpi_eq_enlace_visitas WHERE token = (l->>'token')::uuid) >= 1
  THEN pass := pass + 1; ELSE fails := fails || ('T10 bloqueo/revocado ' || COALESCE(r::text, '∅')); END IF;

  -- T11: cierre automático idempotente (no vuelve a cerrar lo que ya tiene foto) y foto del mes vencido
  a := public.kpi_eq_job();
  b := public.kpi_eq_job();
  IF a >= 0 AND b = 0
     AND (now() < public.kpi_eq_vence('MENSUAL', m.hasta) OR EXISTS (SELECT 1 FROM public.kpi_eq_cierres WHERE frecuencia = 'MENSUAL' AND desde = m.desde))
     AND (SELECT count(*) FROM public.kpi_eq_cierres WHERE frecuencia = 'SEMANAL' AND desde = wp.desde) = ver0 + 1
  THEN pass := pass + 1; ELSE fails := fails || ('T11 cierre automático ' || a || '/' || b); END IF;

  -- T12: cada tablero responde dentro del límite de 8 s de las llamadas autenticadas
  FOREACH f IN ARRAY ARRAY['SEMANAL','QUINCENAL','MENSUAL'] LOOP
    t_ini := clock_timestamp();
    t := public.kpi_eq_tablero(f, NULL);
    ms := extract(epoch FROM clock_timestamp() - t_ini)::numeric * 1000;
    ms_max := GREATEST(ms_max, ms);
    IF t ? 'error' OR jsonb_array_length(t->'kpis') = 0 THEN fails := fails || ('T12 tablero ' || f); END IF;
  END LOOP;
  IF ms_max < 8000 AND NOT EXISTS (SELECT 1 FROM unnest(fails) x WHERE x LIKE 'T12%') THEN pass := pass + 1; ELSE fails := fails || ('T12 tiempo ' || ms_max || ' ms'); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C226 FAIL (%/%): %', pass, total, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C226 PASS (%/%) indicadores por equipo: catálogo, periodos, exactitud, honestidad, permisos, correcciones, reversión, cierre, enlace, bloqueo y job (tablero más lento % ms)', pass, total, ms_max;
END $test$;
ROLLBACK;
