-- CAJA C101 — Reporte de ingresos APT: OT, lote, cliente, glosa y cantidad. Cuadra con apt_movements (ENTRADA),
-- respeta el acceso al módulo APT y reporta cuánto queda sin cliente identificado. Solo lectura; siempre se revierte.
BEGIN;
DO $test$
DECLARE actor uuid; r jsonb; d jsonb; tot_kg numeric; tot_cant numeric; sum_cant numeric; v_desde date; v_hasta date;
BEGIN
  SELECT p.id INTO actor FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
    WHERE p.is_active AND ro.name = 'Administrador' ORDER BY p.id LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C101 FAIL: sin Administrador activo'; END IF;
  -- T1: sin sesión no hay acceso; anónimos no ejecutan
  r := public.apt_ingresos('{}'::jsonb, 'resumen', 5, 0);
  IF (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C101 FAIL: acceso sin sesión (T1)'; END IF;
  IF has_function_privilege('anon', 'public.apt_ingresos(jsonb,text,integer,integer)', 'EXECUTE') THEN RAISE EXCEPTION 'CAJA C101 FAIL: anon (T1)'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  -- T2: el resumen cuadra con los movimientos ENTRADA del período (kg y cantidad)
  r := public.apt_ingresos('{}'::jsonb, 'resumen', 20000, 0);
  IF NOT (r->>'success')::boolean THEN RAISE EXCEPTION 'CAJA C101 FAIL: consulta (T2) %', r->>'error'; END IF;
  v_desde := (r->>'desde')::date; v_hasta := (r->>'hasta')::date;
  SELECT COALESCE(sum(peso_kg), 0), COALESCE(sum(cantidad), 0) INTO tot_kg, tot_cant FROM public.apt_movements
    WHERE kind = 'ENTRADA' AND active AND valid AND fecha BETWEEN v_desde AND v_hasta;
  SELECT COALESCE(sum((x->>'cantidad')::numeric), 0) INTO sum_cant FROM jsonb_array_elements(r->'rows') x;
  IF abs((r->'totales'->>'tn')::numeric - round(tot_kg / 1000, 3)) > 0.001 OR (r->'totales'->>'cantidad')::numeric <> tot_cant
     OR ((r->'totales'->>'filas')::int <= 20000 AND sum_cant <> tot_cant) THEN
    RAISE EXCEPTION 'CAJA C101 FAIL: no cuadra (T2) tn % vs %, cantidad % / % vs %', r->'totales'->>'tn', round(tot_kg / 1000, 3), r->'totales'->>'cantidad', sum_cant, tot_cant; END IF;
  -- T3: cada fila trae OT, lote, cliente, glosa y cantidad; el detalle tiene el mismo total
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(r->'rows') x WHERE x->>'ot' IS NULL OR x->>'lote' IS NULL OR x->>'cliente' IS NULL OR NOT x ? 'glosa' OR NOT x ? 'cantidad') THEN
    RAISE EXCEPTION 'CAJA C101 FAIL: columnas (T3)'; END IF;
  d := public.apt_ingresos(jsonb_build_object('desde', v_desde, 'hasta', v_hasta), 'detalle', 1, 0);
  IF d->'totales'->>'ingresos' <> r->'totales'->>'ingresos' THEN RAISE EXCEPTION 'CAJA C101 FAIL: detalle (T3)'; END IF;
  -- T3b: los filtros de las tablas cuadran: «solo sin cliente» suma lo que el total marca sin cliente
  d := public.apt_ingresos(jsonb_build_object('desde', v_desde, 'hasta', v_hasta, 'sin_cliente', true), 'resumen', 1, 0);
  IF (d->'totales'->>'tn')::numeric <> (r->'totales'->>'sin_cliente_tn')::numeric THEN
    RAISE EXCEPTION 'CAJA C101 FAIL: filtro sin cliente (T3) % vs %', d->'totales'->>'tn', r->'totales'->>'sin_cliente_tn'; END IF;
  -- T4: vista no válida y fechas invertidas se rechazan
  IF (public.apt_ingresos('{}'::jsonb, 'otra', 1, 0)->>'success')::boolean
     OR (public.apt_ingresos('{"desde":"2026-02-01","hasta":"2026-01-01"}'::jsonb, 'resumen', 1, 0)->>'success')::boolean THEN
    RAISE EXCEPTION 'CAJA C101 FAIL: validaciones (T4)'; END IF;
  RAISE EXCEPTION 'CAJA C101 PASS (4/4) ingresos APT % a %: % ingresos, % TN, % OT, % lotes, % clientes, sin cliente % TN',
    v_desde, v_hasta, r->'totales'->>'ingresos', r->'totales'->>'tn', r->'totales'->>'ots', r->'totales'->>'lotes',
    r->'totales'->>'clientes', r->'totales'->>'sin_cliente_tn';
END $test$;
ROLLBACK;
