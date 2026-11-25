-- C234: indicadores de Transporte (sección F): sin metas inventadas, el total concilia con el detalle, OTIF exige a
-- tiempo Y completa, y se distingue «sin registros» de «no calculable». Usa periodos de 2001 (sin datos reales) con
-- registros preparados dentro de la transacción y siempre se revierte.
BEGIN;
DO $test$
DECLARE c text; v jsonb; s record; r1 record; r2 record; n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.kpi_eq_def WHERE codigo IN ('D7','D8','T7','T8','T9','T10') AND meta IS NOT NULL) THEN
    RAISE EXCEPTION 'CAJA C234 FAIL: un indicador nuevo trae meta sin aprobar'; END IF;
  -- Conciliación: el valor del tablero es la suma de su detalle (últimos 30 días)
  FOREACH c IN ARRAY ARRAY['D6','D7','D8','T7','T8','T9','T10'] LOOP
    v := public.kpi_eq_valor(c, public.kpi_eq_hoy() - 30, public.kpi_eq_hoy());
    SELECT coalesce(sum(num) FILTER (WHERE con_dato), 0) AS sn, coalesce(sum(den) FILTER (WHERE con_dato), 0) AS sd, count(*) AS n
      INTO s FROM public.kpi_eq_filas_corr(c, public.kpi_eq_hoy() - 30, public.kpi_eq_hoy()) WHERE origen <> 'EXCLUIDO';
    IF (v->>'num')::numeric <> s.sn OR (v->>'den')::numeric <> s.sd OR (v->>'n')::int <> s.n THEN
      RAISE EXCEPTION 'CAJA C234 FAIL: % no concilia con su detalle (% vs %/%)', c, v, s.sn, s.sd; END IF;
    IF v->>'estado' IN ('CUMPLE','ALERTA','NO_CUMPLE') AND c <> 'D6' THEN RAISE EXCEPTION 'CAJA C234 FAIL: % muestra semáforo sin meta', c; END IF;
    n := n + (v->>'n')::int;
  END LOOP;
  IF public.kpi_eq_valor('T8', '2001-01-01', '2001-01-31')->>'estado' <> 'SIN_REGISTROS' THEN RAISE EXCEPTION 'CAJA C234 FAIL: periodo vacío no es «sin registros»'; END IF;

  -- OTIF: dos llegadas con guía validada, una el día comprometido original y otra al día siguiente (la fecha comprometida no cambia)
  SELECT c2.dispatch_id, c2.request_id, coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date) AS dia INTO r1
  FROM public.delivery_conformities c2 JOIN public.transport_requests t ON t.id = c2.request_id
  WHERE t.required_date IS NOT NULL AND upper(coalesce(t.status, '')) <> 'CANCELADA' AND NOT EXISTS (SELECT 1 FROM public.delivery_rejections j WHERE j.request_id = c2.request_id)
  ORDER BY c2.updated_at DESC LIMIT 1;
  SELECT c2.dispatch_id, c2.request_id, coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date) AS dia INTO r2
  FROM public.delivery_conformities c2 JOIN public.transport_requests t ON t.id = c2.request_id
  WHERE c2.request_id <> r1.request_id AND t.required_date IS NOT NULL AND upper(coalesce(t.status, '')) <> 'CANCELADA'
    AND NOT EXISTS (SELECT 1 FROM public.delivery_rejections j WHERE j.request_id = c2.request_id)
  ORDER BY c2.updated_at DESC LIMIT 1;
  IF r2.request_id IS NULL THEN RAISE EXCEPTION 'CAJA C234 PASS: conciliación de % filas (sin entregas para probar OTIF)', n; END IF;
  UPDATE public.delivery_conformities SET arrived_at = NULL WHERE request_id IN (r1.request_id, r2.request_id);
  UPDATE public.delivery_conformities SET arrived_at = (r1.dia + time '10:00') AT TIME ZONE 'America/Lima', state = 'VALIDADA' WHERE dispatch_id = r1.dispatch_id AND request_id = r1.request_id;
  UPDATE public.delivery_conformities SET arrived_at = (r2.dia + 1 + time '10:00') AT TIME ZONE 'America/Lima', state = 'VALIDADA' WHERE dispatch_id = r2.dispatch_id AND request_id = r2.request_id;
  IF (SELECT f.num FROM public.kpi_eq_filas('D7', r1.dia, r1.dia) f WHERE f.ref = r1.request_id::text) IS DISTINCT FROM 1
     OR (SELECT f.num FROM public.kpi_eq_filas('D7', r2.dia + 1, r2.dia + 1) f WHERE f.ref = r2.request_id::text) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'CAJA C234 FAIL: OTIF no separa a tiempo (día comprometido) de tarde'; END IF;
  -- Sin guía validada ni rechazo: todavía no se juzga como completa (sin dato)
  UPDATE public.delivery_conformities SET state = 'RECIBIDA' WHERE dispatch_id = r1.dispatch_id AND request_id = r1.request_id;
  IF (SELECT f.con_dato FROM public.kpi_eq_filas('D7', r1.dia, r1.dia) f WHERE f.ref = r1.request_id::text) THEN
    RAISE EXCEPTION 'CAJA C234 FAIL: una llegada sin guía validada se juzgó como completa'; END IF;

  -- Incidencias sin viajes en el periodo: no calculable (no se divide por cero ni se informa 0)
  INSERT INTO public.route_incidents(id, dispatch_id, category, description, occurred_at) VALUES (gen_random_uuid(), r1.dispatch_id, 'DANO', 'Prueba C234', '2001-03-05 10:00-05');
  v := public.kpi_eq_valor('T7', '2001-03-01', '2001-03-31');
  IF v->>'estado' <> 'NO_CALCULABLE' OR (v->>'n')::int <> 1 THEN RAISE EXCEPTION 'CAJA C234 FAIL: incidencias sin viajes %', v; END IF;
  IF (SELECT f.dims->>'causa_confirmada' FROM public.kpi_eq_filas('T7', '2001-03-01', '2001-03-31') f LIMIT 1) <> 'SIN_CONFIRMAR' THEN
    RAISE EXCEPTION 'CAJA C234 FAIL: la incidencia sin causa confirmada no se marca SIN_CONFIRMAR'; END IF;
  RAISE EXCEPTION 'CAJA C234 PASS: % filas conciliadas; OTIF a tiempo y completa; sin registros y no calculable separados; sin metas nuevas', n;
END $test$;
ROLLBACK;
