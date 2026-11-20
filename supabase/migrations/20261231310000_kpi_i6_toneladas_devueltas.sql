-- Decisión 9 (20-11-2026): el indicador I6 deja de ser «kg devueltos ÷ kg despachados» (dos flujos sin vínculo entre sí)
-- y pasa a informar las toneladas devueltas del período, sin porcentaje ni meta, hasta que cada devolución se vincule con
-- su despacho de origen. Estado nuevo INFORMATIVO: hay datos y se muestran, pero no se evalúan contra una meta.
UPDATE public.kpi_eq_def SET
  nombre = 'Toneladas devueltas (logística inversa)',
  descripcion = 'Material que regresa al almacén en el período (guías de recojo y otros documentos de devolución). No incluye la devolución de herramientas prestadas. Sin porcentaje hasta vincular cada devolución con su despacho.',
  formula = 'Σ kg de documentos de clase DEVOLUCION (sin DEV. HERRAMIENTAS) ÷ 1000',
  fuente = 'inv_movements_v clase DEVOLUCION (sin DEV. HERRAMIENTAS)',
  unidad = 't', factor = 0.001, sentido = 'MENOR', meta = NULL, tolerancia = 0, cobertura_min = 0, estado_datos = 'PARCIAL',
  nota_datos = 'Informativo, sin meta ni semáforo. Las líneas sin peso no suman (bajan la cobertura). El motivo y el estado del material se gestionan en Devoluciones del WMS.',
  updated_at = now()
WHERE codigo = 'I6';

DO $m$
DECLARE def text; a text := 'ELSIF p_codigo IN (''I5'',''I6'') THEN';
BEGIN
  def := pg_get_functiondef('public.kpi_eq_filas(text, date, date)'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'kpi_eq_filas cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, 'ELSIF p_codigo = ''I6'' THEN
    -- Cada documento de devolución aporta sus kg al total; una fila base (no es un registro) da el denominador 1
    RETURN QUERY
    WITH m AS (
      SELECT x.id, x.fecha, x.tipodocto, x.numero, x.bodega, x.razon_social, x.peso_kg
      FROM public.inv_movements_v x WHERE x.active AND x.fecha BETWEEN p_desde AND p_hasta AND x.clase = ''DEVOLUCION'' AND x.tipodocto <> ''DEV. HERRAMIENTAS'')
    SELECT m.id::text, m.fecha, m.tipodocto || '' '' || COALESCE(m.numero, '''') || '' · '' || COALESCE(m.bodega, ''''),
           abs(COALESCE(m.peso_kg, 0)), 0::numeric, m.peso_kg IS NOT NULL, NULL::uuid,
           jsonb_build_object(''tipo'', m.tipodocto, ''bodega'', m.bodega, ''razon_social'', m.razon_social, ''kg'', m.peso_kg)
    FROM m
    UNION ALL
    SELECT ''base-'' || p_desde::text, p_desde, ''Base del total (fila técnica, no es un documento)'', 0::numeric, 1::numeric, true, NULL::uuid, jsonb_build_object(''tecnica'', true)
    WHERE EXISTS (SELECT 1 FROM m);

  ELSIF p_codigo = ''I5'' THEN');
END $m$;

DO $m$
DECLARE def text; a text := '    WHEN d.meta IS NULL THEN ''SIN_REGISTROS''';
BEGIN
  def := pg_get_functiondef('public.kpi_eq_valor(text, date, date)'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'kpi_eq_valor cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, '    WHEN d.meta IS NULL THEN ''INFORMATIVO''');
END $m$;
