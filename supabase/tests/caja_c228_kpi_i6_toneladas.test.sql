-- C228: el indicador I6 informa las toneladas devueltas del período (sin porcentaje ni meta). Comprueba la definición,
-- que el valor coincide con una consulta escrita aparte sobre la fuente, el estado INFORMATIVO y que I5 no cambió.
-- Usa datos reales y siempre se revierte.
BEGIN;
DO $test$
DECLARE d record; v jsonb; v5 jsonb; kg numeric; n int; hoy date := (now() AT TIME ZONE 'America/Lima')::date; desde date;
BEGIN
  SELECT * INTO d FROM public.kpi_eq_def WHERE codigo = 'I6';
  IF d.unidad <> 't' OR d.meta IS NOT NULL OR d.factor <> 0.001 THEN RAISE EXCEPTION 'CAJA C228 FAIL: definición de I6 (unidad %, meta %, factor %)', d.unidad, d.meta, d.factor; END IF;
  -- Período con devoluciones (el más reciente de los últimos 12 meses)
  SELECT date_trunc('month', max(x.fecha))::date INTO desde FROM public.inv_movements_v x
   WHERE x.active AND x.clase = 'DEVOLUCION' AND x.tipodocto <> 'DEV. HERRAMIENTAS' AND x.fecha > hoy - 365;
  IF desde IS NOT NULL THEN
    v := public.kpi_eq_valor('I6', desde, (desde + interval '1 month - 1 day')::date);
    SELECT coalesce(sum(abs(x.peso_kg)) FILTER (WHERE x.peso_kg IS NOT NULL), 0), count(*) INTO kg, n FROM public.inv_movements_v x
     WHERE x.active AND x.clase = 'DEVOLUCION' AND x.tipodocto <> 'DEV. HERRAMIENTAS' AND x.fecha BETWEEN desde AND (desde + interval '1 month - 1 day')::date;
    IF abs((v->>'valor')::numeric - round(kg / 1000, 2)) > 0.01 THEN RAISE EXCEPTION 'CAJA C228 FAIL: valor % t frente a % t de la fuente', v->>'valor', round(kg / 1000, 2); END IF;
    IF v->>'estado' <> 'INFORMATIVO' THEN RAISE EXCEPTION 'CAJA C228 FAIL: estado % (se esperaba INFORMATIVO)', v->>'estado'; END IF;
    IF (v->>'n')::int <> n + 1 THEN RAISE EXCEPTION 'CAJA C228 FAIL: % filas frente a % documentos + 1 base', v->>'n', n; END IF;
    -- La fila base es técnica: ni se propone su corrección ni la ficha la ofrece
    IF (public.kpi_eq_proponer('I6', 'base-' || desde, desde, 'EXCLUIR', NULL, NULL, 'OTRO', 'prueba de caja'))->>'error' NOT LIKE 'La fila base es técnica%' THEN RAISE EXCEPTION 'CAJA C228 FAIL: la fila base admite corrección'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements((public.kpi_eq_detalle('I6', desde, (desde + interval '1 month - 1 day')::date))->'filas') x WHERE x->>'ref' LIKE 'base-%' AND (x->>'puede_proponer')::boolean) THEN
      RAISE EXCEPTION 'CAJA C228 FAIL: la ficha ofrece corregir la fila base'; END IF;
  END IF;
  -- Tendencia: solo cierres con la misma unidad
  IF position('IS NOT DISTINCT FROM x->>''unidad''' IN pg_get_functiondef('public.kpi_eq_tablero(text, date)'::regprocedure)) = 0 THEN RAISE EXCEPTION 'CAJA C228 FAIL: la tendencia mezcla unidades'; END IF;
  -- Sin devoluciones en el período: sin registros (nunca 0 t inventadas)
  IF (public.kpi_eq_valor('I6', '2000-01-01', '2000-01-31'))->>'estado' <> 'SIN_REGISTROS' THEN RAISE EXCEPTION 'CAJA C228 FAIL: período vacío no es SIN_REGISTROS'; END IF;
  -- I5 conserva su porcentaje
  v5 := public.kpi_eq_valor('I5', hoy - 90, hoy);
  IF (SELECT unidad FROM public.kpi_eq_def WHERE codigo = 'I5') <> '%' THEN RAISE EXCEPTION 'CAJA C228 FAIL: I5 cambió de unidad'; END IF;
  RAISE EXCEPTION 'CAJA C228 PASS: I6 informa toneladas devueltas (sin meta, estado INFORMATIVO), coincide con la fuente; I5 sin cambios';
END $test$;
ROLLBACK;
