-- ============================================================
-- Inventario multi-almacén: verificación cuantificable del modelo
-- ============================================================
-- inv_verify() responde «¿se puede confiar en estas cifras?» con controles medibles:
--  1. Cuadre por bodega: lo que el modelo registró como entradas y salidas coincide con los movimientos del archivo, y
--     saldo = saldo inicial (foto + inferido) + entradas − salidas. Diferencia esperada: 0.
--  2. Traspasos emparejados: % de líneas de traspaso con su contraparte (origen ↔ destino).
--  3. Origen conocido: % de salidas cubiertas por ingresos cargados o por la foto de stock (no por saldo inferido).
--  4. Peso conocido: % de líneas con peso (las cifras en kg solo cubren esas líneas).
--  5. Cobertura: Entradas y Salidas cubren las mismas fechas, sin huecos de más de 4 días.
--  6. Al día: no hay cargas ni cambios de catálogo pendientes de recalcular.
BEGIN;

CREATE OR REPLACE FUNCTION public.inv_verify()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_state; v_cuadre jsonb; v_bad integer; v_total integer; v_tr numeric; v_tr_ok numeric; v_alloc numeric;
  v_alloc_inf numeric; v_lines numeric; v_peso numeric; v_e record; v_s record; v_gaps integer; v_checks jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  SELECT * INTO s FROM public.inv_state WHERE id = 1;

  WITH mov AS (
    SELECT bodega, COALESCE(sum(cantidad) FILTER (WHERE cantidad > 0), 0) AS ent, COALESCE(-sum(cantidad) FILTER (WHERE cantidad < 0), 0) AS sal,
      count(*) AS lineas
    FROM public.inv_movements WHERE active AND (s.model_from IS NULL OR fecha >= s.model_from) GROUP BY bodega
  ), lay AS (
    SELECT bodega, COALESCE(sum(qty) FILTER (WHERE source = 'FOTO'), 0) AS foto, COALESCE(sum(qty) FILTER (WHERE source = 'INFERIDA'), 0) AS inferida,
      COALESCE(sum(qty) FILTER (WHERE source = 'MOV'), 0) AS ent_modelo, COALESCE(sum(qty - consumed), 0) AS saldo
    FROM public.inv_layers GROUP BY bodega
  ), alo AS (
    SELECT l.bodega, sum(a.qty) AS sal_modelo FROM public.inv_allocations a JOIN public.inv_layers l ON l.id = a.layer_id GROUP BY l.bodega
  ), c AS (
    SELECT bodega, COALESCE(w.kind, 'OTRO') AS kind, COALESCE(w.stage, 70) AS stage, COALESCE(m.lineas, 0) AS lineas,
      COALESCE(m.ent, 0) AS ent, COALESCE(m.sal, 0) AS sal, COALESCE(l.foto, 0) AS foto, COALESCE(l.inferida, 0) AS inferida,
      COALESCE(l.ent_modelo, 0) AS ent_modelo, COALESCE(a.sal_modelo, 0) AS sal_modelo, COALESCE(l.saldo, 0) AS saldo
    FROM mov m FULL JOIN lay l USING (bodega) LEFT JOIN alo a USING (bodega) LEFT JOIN public.inv_warehouses w ON w.code = bodega
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bodega', bodega, 'kind', kind, 'lineas', lineas,
      'saldo_inicial_foto', round(foto, 3), 'saldo_inicial_inferido', round(inferida, 3),
      'entradas_archivo', round(ent, 3), 'entradas_modelo', round(ent_modelo, 3),
      'salidas_archivo', round(sal, 3), 'salidas_modelo', round(sal_modelo, 3),
      'saldo_calculado', round(foto + inferida + ent - sal, 3), 'saldo_modelo', round(saldo, 3),
      'diferencia', round((foto + inferida + ent - sal) - saldo, 3),
      'ok', abs(ent - ent_modelo) < 0.001 AND abs(sal - sal_modelo) < 0.001 AND abs((foto + inferida + ent - sal) - saldo) < 0.001)
      ORDER BY stage, bodega), '[]'::jsonb),
    count(*) FILTER (WHERE NOT (abs(ent - ent_modelo) < 0.001 AND abs(sal - sal_modelo) < 0.001 AND abs((foto + inferida + ent - sal) - saldo) < 0.001)),
    count(*)
  INTO v_cuadre, v_bad, v_total FROM c;

  v_checks := v_checks || jsonb_build_object('id', 'cuadre', 'titulo', 'Cuadre de cantidades por bodega',
    'valor', v_total - v_bad, 'meta', v_total, 'unidad', 'bodegas',
    'estado', CASE WHEN v_total = 0 THEN 'SIN_DATOS' WHEN v_bad = 0 THEN 'OK' ELSE 'FALLA' END,
    'detalle', 'Saldo = saldo inicial + entradas − salidas, y el modelo registró exactamente las entradas y salidas del archivo.');

  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.inv_transfer_links t WHERE t.out_id = m.id OR t.in_id = m.id))
  INTO v_tr, v_tr_ok
  FROM public.inv_movements m WHERE m.active AND m.clase = 'TRASPASO' AND (s.model_from IS NULL OR m.fecha >= s.model_from);
  v_checks := v_checks || jsonb_build_object('id', 'traspasos', 'titulo', 'Traspasos con origen y destino',
    'valor', CASE WHEN v_tr > 0 THEN round(100 * v_tr_ok / v_tr, 1) END, 'meta', 99, 'unidad', '%',
    'estado', CASE WHEN v_tr = 0 THEN 'SIN_DATOS' WHEN v_tr_ok / v_tr >= 0.99 THEN 'OK' WHEN v_tr_ok / v_tr >= 0.95 THEN 'AVISO' ELSE 'FALLA' END,
    'detalle', format('%s de %s líneas de traspaso emparejadas. Sin pareja: falta cargar el otro lado (Entradas o Salidas) de esas fechas.', v_tr_ok, v_tr));

  SELECT count(*), count(*) FILTER (WHERE l.source = 'INFERIDA') INTO v_alloc, v_alloc_inf
  FROM public.inv_allocations a JOIN public.inv_layers l ON l.id = a.layer_id;
  v_checks := v_checks || jsonb_build_object('id', 'origen', 'titulo', 'Salidas con origen conocido',
    'valor', CASE WHEN v_alloc > 0 THEN round(100 * (v_alloc - v_alloc_inf) / v_alloc, 1) END, 'meta', 95, 'unidad', '%',
    'estado', CASE WHEN v_alloc = 0 THEN 'SIN_DATOS' WHEN (v_alloc - v_alloc_inf) / v_alloc >= 0.95 THEN 'OK'
                   WHEN (v_alloc - v_alloc_inf) / v_alloc >= 0.80 THEN 'AVISO' ELSE 'FALLA' END,
    'detalle', format('%s de %s consumos salen de ingresos cargados o de la foto de stock; el resto, de saldo anterior inferido. Para subirlo: cargue una foto de stock del ERP o más meses de historia.',
      v_alloc - v_alloc_inf, v_alloc));

  SELECT count(*), count(*) FILTER (WHERE peso_kg IS NOT NULL) INTO v_lines, v_peso
  FROM public.inv_movements WHERE active AND (s.model_from IS NULL OR fecha >= s.model_from);
  v_checks := v_checks || jsonb_build_object('id', 'peso', 'titulo', 'Líneas con peso',
    'valor', CASE WHEN v_lines > 0 THEN round(100 * v_peso / v_lines, 1) END, 'meta', 90, 'unidad', '%',
    'estado', CASE WHEN v_lines = 0 THEN 'SIN_DATOS' WHEN v_peso / v_lines >= 0.90 THEN 'OK' ELSE 'AVISO' END,
    'detalle', format('%s de %s líneas traen peso. Las cifras en kg solo suman esas líneas; las cantidades se cuentan siempre.', v_peso, v_lines));

  SELECT min(fecha) AS d, max(fecha) AS h INTO v_e FROM public.inv_movements WHERE active AND side = 'E';
  SELECT min(fecha) AS d, max(fecha) AS h INTO v_s FROM public.inv_movements WHERE active AND side = 'S';
  SELECT count(*) INTO v_gaps FROM (
    SELECT side, fecha, lead(fecha) OVER (PARTITION BY side ORDER BY fecha) AS nxt FROM (SELECT DISTINCT side, fecha FROM public.inv_movements WHERE active) f
  ) x WHERE nxt - fecha > 4;
  v_checks := v_checks || jsonb_build_object('id', 'cobertura', 'titulo', 'Cobertura de fechas',
    'valor', v_gaps, 'meta', 0, 'unidad', 'huecos',
    'estado', CASE WHEN v_e.d IS NULL AND v_s.d IS NULL THEN 'SIN_DATOS' WHEN v_e.d IS NULL OR v_s.d IS NULL THEN 'FALLA'
                   WHEN v_gaps = 0 AND v_e.d = v_s.d AND v_e.h = v_s.h THEN 'OK' ELSE 'AVISO' END,
    'detalle', format('Entradas: %s a %s · Salidas: %s a %s · %s hueco(s) de más de 4 días sin movimientos.',
      COALESCE(to_char(v_e.d, 'DD/MM/YYYY'), '—'), COALESCE(to_char(v_e.h, 'DD/MM/YYYY'), '—'),
      COALESCE(to_char(v_s.d, 'DD/MM/YYYY'), '—'), COALESCE(to_char(v_s.h, 'DD/MM/YYYY'), '—'), v_gaps));

  v_checks := v_checks || jsonb_build_object('id', 'al_dia', 'titulo', 'Modelo recalculado',
    'valor', NULL, 'meta', NULL, 'unidad', NULL,
    'estado', CASE WHEN s.rebuilt_at IS NULL THEN 'SIN_DATOS' WHEN s.dirty THEN 'AVISO' ELSE 'OK' END,
    'detalle', CASE WHEN s.dirty THEN 'Hay cargas o cambios de catálogo pendientes: el recálculo termina solo en unos minutos.'
                    ELSE 'Última actualización: ' || COALESCE(to_char(s.rebuilt_at AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI'), '—') END);

  RETURN jsonb_build_object('success', true, 'checks', v_checks, 'cuadre', v_cuadre,
    'ok', (SELECT count(*) FROM jsonb_array_elements(v_checks) x WHERE x->>'estado' = 'OK'),
    'total', jsonb_array_length(v_checks),
    'corte', s.data_max, 'desde', s.data_min, 'model_from', s.model_from, 'snapshot_cutoff', s.snapshot_cutoff);
END $$;
REVOKE ALL ON FUNCTION public.inv_verify() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_verify() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
