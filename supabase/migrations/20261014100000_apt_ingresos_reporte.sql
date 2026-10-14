-- Reporte de ingresos APT (ENTRADA = P/E Producción): OT, lote, cliente, glosa y cantidad.
-- El ERP no trae el cliente en la ENTRADA. Se toma, en orden: el cliente del lote resuelto por el flujo
-- (apt_flow_layers: guías de despacho del lote), el de otro lote de la misma OT madre, y la OT en Contratos del TMS
-- (código = lote u OT madre). Sin ninguno → «(Sin cliente identificado)».
-- Vista «resumen»: una fila por lote y glosa (cantidad y kg sumados). Vista «detalle»: un ingreso por fila.
CREATE OR REPLACE FUNCTION public.apt_ingresos(p jsonb DEFAULT '{}'::jsonb, p_vista text DEFAULT 'resumen',
  p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_min date; v_max date; v_desde date; v_hasta date; v_rows jsonb; v_tot jsonb; v_cli jsonb;
  v_ot text := NULLIF(upper(btrim(COALESCE(p ->> 'ot', ''))), '');
  v_cliente text := NULLIF(btrim(COALESCE(p ->> 'cliente', '')), '');
  v_glosa text := NULLIF(btrim(COALESCE(p ->> 'glosa', '')), '');
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_vista NOT IN ('resumen', 'detalle') THEN RETURN jsonb_build_object('success', false, 'error', 'Vista no válida'); END IF;
  p := COALESCE(p, '{}'::jsonb);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 20000);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE kind = 'ENTRADA' AND active AND valid;
  -- Por defecto, el mes del último ingreso cargado
  v_hasta := COALESCE(public.apt_date(p -> 'hasta'), v_max);
  v_desde := COALESCE(public.apt_date(p -> 'desde'), date_trunc('month', v_hasta)::date);
  IF v_desde > v_hasta THEN RETURN jsonb_build_object('success', false, 'error', 'La fecha inicial es posterior a la final'); END IF;

  DROP TABLE IF EXISTS pg_temp.i_mov;
  CREATE TEMP TABLE i_mov ON COMMIT DROP AS
  WITH e AS (
    SELECT m.id, m.fecha, m.documento, m.lote, m.producto, m.glosa, m.cantidad, m.unidad, m.peso_kg
    FROM public.apt_movements m
    WHERE m.kind = 'ENTRADA' AND m.active AND m.valid AND m.fecha BETWEEN v_desde AND v_hasta),
  lotes AS (SELECT DISTINCT lote, public.apt_ot_raiz(lote) AS raiz FROM e),
  cli AS (SELECT l.lote, max(l.cliente) AS cliente FROM public.apt_flow_layers l
          WHERE l.cliente IS NOT NULL AND l.lote IN (SELECT lote FROM lotes) GROUP BY 1),
  -- Lote nuevo sin guías todavía: el cliente de otro lote de la misma OT madre (el de más kg)
  cli_ot AS (SELECT DISTINCT ON (raiz) raiz, cliente FROM (
               SELECT public.apt_ot_raiz(l.lote) AS raiz, l.cliente, sum(l.kg_in) AS kg FROM public.apt_flow_layers l
               WHERE l.cliente IS NOT NULL AND public.apt_ot_raiz(l.lote) IN (SELECT raiz FROM lotes) GROUP BY 1, 2) z
             ORDER BY raiz, kg DESC NULLS LAST, cliente),
  -- Si tampoco, la OT registrada en Contratos del TMS (código = lote u OT madre)
  tms AS (SELECT DISTINCT ON (upper(c.code)) upper(c.code) AS code, cl.business_name AS cliente
          FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
          WHERE cl.business_name IS NOT NULL
            AND upper(c.code) IN (SELECT lote FROM lotes UNION SELECT raiz FROM lotes) ORDER BY upper(c.code))
  SELECT e.*, COALESCE(lo.raiz, e.lote) AS ot,
    COALESCE(c.cliente, co.cliente, t1.cliente, t2.cliente, '(Sin cliente identificado)') AS cliente
  FROM e JOIN lotes lo ON lo.lote = e.lote
  LEFT JOIN cli c ON c.lote = e.lote LEFT JOIN cli_ot co ON co.raiz = lo.raiz
  LEFT JOIN tms t1 ON t1.code = upper(e.lote) LEFT JOIN tms t2 ON t2.code = lo.raiz
  WHERE (v_ot IS NULL OR e.lote ILIKE '%' || v_ot || '%' OR public.apt_ot_raiz(e.lote) = public.apt_ot_raiz(v_ot))
    AND (v_cliente IS NULL OR COALESCE(c.cliente, co.cliente, t1.cliente, t2.cliente, '(Sin cliente identificado)') ILIKE '%' || v_cliente || '%')
    AND (v_glosa IS NULL OR e.glosa ILIKE '%' || v_glosa || '%' OR e.producto ILIKE '%' || v_glosa || '%');

  SELECT jsonb_build_object('ingresos', count(*), 'cantidad', COALESCE(sum(cantidad), 0),
      'tn', round(COALESCE(sum(peso_kg), 0) / 1000, 3), 'ots', count(DISTINCT ot), 'lotes', count(DISTINCT lote),
      'clientes', count(DISTINCT cliente) FILTER (WHERE cliente <> '(Sin cliente identificado)'),
      'sin_cliente_tn', round(COALESCE(sum(peso_kg) FILTER (WHERE cliente = '(Sin cliente identificado)'), 0) / 1000, 3),
      'filas', CASE p_vista WHEN 'detalle' THEN count(*) ELSE count(DISTINCT (lote, producto, glosa, unidad)) END)
    INTO v_tot FROM i_mov;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.tn DESC), '[]'::jsonb) INTO v_cli FROM (
    SELECT cliente, count(DISTINCT ot) AS ots, count(DISTINCT lote) AS lotes, sum(cantidad) AS cantidad,
      round(sum(peso_kg) / 1000, 3) AS tn
    FROM i_mov GROUP BY cliente ORDER BY sum(peso_kg) DESC LIMIT 15) x;

  IF p_vista = 'detalle' THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.fecha, r.ot, r.lote, r.glosa), '[]'::jsonb) INTO v_rows FROM (
      SELECT fecha, documento, ot, lote, cliente, producto, glosa, cantidad, unidad, round(peso_kg, 3) AS kg
      FROM i_mov ORDER BY fecha, ot, lote, glosa, id LIMIT p_limit OFFSET p_offset) r;
  ELSE
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.ot, r.lote, r.glosa), '[]'::jsonb) INTO v_rows FROM (
      SELECT ot, lote, cliente, producto, glosa, unidad, sum(cantidad) AS cantidad, round(sum(peso_kg), 3) AS kg,
        count(*) AS ingresos, min(fecha) AS primera, max(fecha) AS ultima
      FROM i_mov GROUP BY ot, lote, cliente, producto, glosa, unidad
      ORDER BY ot, lote, glosa, producto LIMIT p_limit OFFSET p_offset) r;
  END IF;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'min', v_min, 'max', v_max,
    'vista', p_vista, 'totales', v_tot, 'clientes', v_cli, 'rows', v_rows);
END $$;
REVOKE ALL ON FUNCTION public.apt_ingresos(jsonb, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ingresos(jsonb, text, integer, integer) TO authenticated, service_role;
