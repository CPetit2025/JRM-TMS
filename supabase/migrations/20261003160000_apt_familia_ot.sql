-- ============================================================
-- APT — Familia de una OT: madre, subcontratos, errores, garantías, retornos y posibles errores de digitación
-- ============================================================
-- Al buscar una OT (16339) se agrupan todas sus vertientes:
--   MADRE 16339 · SUBCONTRATO 16339-S001… · ERROR 16339-E001… · GARANTIA 16339-G01 · DEVOLUCION 16339 D / 16339-S004D · OTRO.
-- Además se señalan:
--   SOSPECHOSO: lotes con sufijo (-S, -E, -G) cuya raíz difiere en un dígito de la OT (sobra, falta, cambia o se invierten
--     dos), sin producción ni guías
--     propias (solo traspasos o consumos) y con el mismo sufijo que un lote de la familia (p. ej. 126339-S007 ↔ 16339-S007).
--   Vinculados: lotes de otra raíz que el ERP relaciona con la OT (contrato o NumRel de la OT: insumos consumidos,
--     lotes reasignados) y lotes de adelanto que pasaron a la familia por traspaso.
-- apt_flow_match (filtro OT de las pantallas del flujo) y apt_kardex usan la raíz, así "16339 D" también entra.
BEGIN;

-- Raíz numérica de la OT en un lote, contrato o NumRel (16339-S001 → 16339; 16339 D → 16339; 2-2026-… → NULL)
CREATE OR REPLACE FUNCTION public.apt_ot_raiz(p_lote text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT substring(upper(btrim(p_lote)) FROM '^([0-9]{3,})(?:$|[^0-9])');
$$;

CREATE OR REPLACE FUNCTION public.apt_lote_variante(p_lote text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_lote IS NULL THEN NULL
              WHEN upper(btrim(p_lote)) ~ '[0-9]\s*D$' THEN 'DEVOLUCION'
              WHEN upper(p_lote) ~ '-S[0-9]' THEN 'SUBCONTRATO'
              WHEN upper(p_lote) ~ '-E[0-9]' THEN 'ERROR'
              WHEN upper(p_lote) ~ '-G[0-9]' THEN 'GARANTIA'
              WHEN btrim(p_lote) ~ '^[0-9]+$' THEN 'MADRE'
              ELSE 'OTRO' END;
$$;

-- Dos raíces a un solo error de digitación: sobra o falta un dígito, cambia uno o se invierten dos contiguos
CREATE OR REPLACE FUNCTION public.apt_raiz_parecida(a text, b text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT a IS NOT NULL AND b IS NOT NULL AND a <> b AND (
    (length(a) = length(b) + 1 AND EXISTS (SELECT 1 FROM generate_series(1, length(a)) i WHERE overlay(a PLACING '' FROM i FOR 1) = b))
    OR (length(b) = length(a) + 1 AND EXISTS (SELECT 1 FROM generate_series(1, length(b)) i WHERE overlay(b PLACING '' FROM i FOR 1) = a))
    OR (length(a) = length(b) AND (
          (SELECT count(*) FROM generate_series(1, length(a)) i WHERE substr(a, i, 1) <> substr(b, i, 1)) = 1
          OR EXISTS (SELECT 1 FROM generate_series(1, length(a) - 1) i
                     WHERE overlay(a PLACING substr(a, i + 1, 1) || substr(a, i, 1) FROM i FOR 2) = b))));
$$;

-- Lotes con posible error de digitación de la OT (ver cabecera)
CREATE OR REPLACE FUNCTION public.apt_ot_sospechosos(p_ot text)
RETURNS TABLE (lote text, parecido_a text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH mv AS (SELECT DISTINCT m.lote, public.apt_ot_raiz(m.lote) AS raiz FROM public.apt_movements m WHERE m.active AND m.valid AND m.lote IS NOT NULL),
  fam AS (SELECT lote, substr(lote, length(raiz) + 1) AS suf FROM mv WHERE raiz = p_ot),
  cand AS (SELECT mv.lote, mv.raiz, substr(mv.lote, length(mv.raiz) + 1) AS suf FROM mv
           WHERE mv.raiz IS NOT NULL AND mv.raiz <> p_ot AND abs(length(mv.raiz) - length(p_ot)) <= 1 AND public.apt_raiz_parecida(mv.raiz, p_ot))
  SELECT c.lote, f.lote FROM cand c
  JOIN fam f ON f.suf = c.suf
  WHERE c.suf ~ '^-[SEG][0-9]'   -- solo códigos con sufijo: una OT madre parecida suele ser otra OT real
    -- Una OT real tiene producción o guías propias; el lote mal digitado solo aparece en traspasos o consumos
    AND NOT EXISTS (SELECT 1 FROM public.apt_movements e WHERE e.active AND e.valid AND e.kind IN ('ENTRADA', 'SALIDA')
                    AND public.apt_ot_raiz(e.lote) = c.raiz);
$$;
REVOKE ALL ON FUNCTION public.apt_ot_sospechosos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ot_sospechosos(text) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS apt_movements_ot_raiz_idx ON public.apt_movements (public.apt_ot_raiz(lote)) WHERE active AND valid;
CREATE INDEX IF NOT EXISTS apt_flow_layers_ot_raiz_idx ON public.apt_flow_layers (public.apt_ot_raiz(lote));
CREATE INDEX IF NOT EXISTS apt_flow_exits_ot_raiz_idx ON public.apt_flow_exits (public.apt_ot_raiz(lote));

-- Filtro OT del flujo multi-almacén por raíz (incluye retornos "16339 D")
CREATE OR REPLACE FUNCTION public.apt_flow_match(p jsonb, p_lote text, p_cliente text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR p_lote ILIKE '%' || btrim(p ->> 'lote') || '%')
     AND (NULLIF(btrim(p ->> 'ot'), '') IS NULL
          OR public.apt_ot_raiz(p_lote) = COALESCE(public.apt_ot_raiz(p ->> 'ot'), upper(btrim(p ->> 'ot'))))
     AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
          OR COALESCE(p_cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')));
$$;

-- Ficha de la familia de una OT (p_q: la OT o cualquiera de sus lotes). Cifras del flujo multi-almacén (FIFO encadenado).
CREATE OR REPLACE FUNCTION public.apt_ot_familia(p_q text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ot text := public.apt_ot_raiz(p_q); v_cut date; v_miembros jsonb; v_grupos jsonb; v_res jsonb; v_vinc jsonb; v_sosp jsonb;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF v_ot IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Escriba una OT (p. ej. 16339) o uno de sus lotes'); END IF;
  SELECT cutoff INTO v_cut FROM public.apt_flow_state WHERE id = 1;

  DROP TABLE IF EXISTS pg_temp.f_sosp;
  CREATE TEMP TABLE f_sosp ON COMMIT DROP AS SELECT * FROM public.apt_ot_sospechosos(v_ot);

  -- Lotes de la familia (y sospechosos) con sus cifras por lote
  DROP TABLE IF EXISTS pg_temp.f_lot;
  CREATE TEMP TABLE f_lot ON COMMIT DROP AS
  WITH lotes AS (
    SELECT DISTINCT m.lote FROM public.apt_movements m WHERE m.active AND m.valid AND public.apt_ot_raiz(m.lote) = v_ot
    UNION SELECT lote FROM public.apt_flow_layers WHERE public.apt_ot_raiz(lote) = v_ot
    UNION SELECT lote FROM f_sosp),
  ly AS (SELECT l.lote, sum(l.kg_in) FILTER (WHERE l.tipo = 'PRODUCCION') AS prod,
                sum(l.kg_in) FILTER (WHERE l.tipo IN ('INICIAL', 'DEVOLUCION', 'OTRO_ALMACEN')) AS otros_in,
                sum(l.kg_in) FILTER (WHERE l.tipo = 'TRASPASO' AND public.apt_ot_raiz(l.lote_origen) IS DISTINCT FROM v_ot
                                     AND l.lote_origen IS DISTINCT FROM l.lote) AS asignado,
                sum(l.kg_saldo) AS saldo,
                sum(l.kg_saldo) FILTER (WHERE l.almacen = '647') AS s647, sum(l.kg_saldo) FILTER (WHERE l.almacen = '540') AS s540,
                sum(l.kg_saldo) FILTER (WHERE l.almacen = 'ST') AS sst,
                max(l.cliente) AS cliente, min(l.fecha) FILTER (WHERE l.tipo = 'PRODUCCION') AS primera_prod,
                max(v_cut - l.fecha) FILTER (WHERE l.kg_saldo > 0.0005) AS dias_saldo
         FROM public.apt_flow_layers l JOIN lotes USING (lote) GROUP BY l.lote),
  ex AS (SELECT x.lote, sum(x.kg) FILTER (WHERE x.tipo = 'DESPACHO') AS desp, count(DISTINCT x.documento) FILTER (WHERE x.tipo = 'DESPACHO') AS guias,
                max(x.fecha) FILTER (WHERE x.tipo = 'DESPACHO') AS ultima_guia, sum(x.kg) FILTER (WHERE x.tipo = 'CONSUMO') AS cons,
                sum(x.kg) FILTER (WHERE x.tipo = 'OTRO_ALMACEN') AS otro_out,
                sum(x.kg) FILTER (WHERE x.tipo = 'TRASPASO' AND public.apt_ot_raiz(x.lote_destino) IS DISTINCT FROM v_ot
                                  AND x.lote_destino IS DISTINCT FROM x.lote) AS cedido,
                max(x.cliente) FILTER (WHERE x.tipo = 'DESPACHO') AS cliente
         FROM public.apt_flow_exits x JOIN lotes USING (lote) GROUP BY x.lote),
  mv AS (SELECT m.lote, count(*) AS movs, min(m.fecha) AS f0, max(m.fecha) AS f1
         FROM public.apt_movements m JOIN lotes USING (lote) WHERE m.active AND m.valid GROUP BY m.lote)
  SELECT lt.lote, CASE WHEN s.lote IS NOT NULL THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(lt.lote) END AS variante, s.parecido_a,
    COALESCE(ex.cliente, ly.cliente) AS cliente, COALESCE(ly.prod, 0) AS prod, COALESCE(ly.otros_in, 0) AS otros_in, COALESCE(ly.asignado, 0) AS asignado,
    COALESCE(ex.desp, 0) AS desp, COALESCE(ex.guias, 0) AS guias, COALESCE(ex.cons, 0) AS cons, COALESCE(ex.otro_out, 0) AS otro_out,
    COALESCE(ex.cedido, 0) AS cedido, COALESCE(ly.saldo, 0) AS saldo, COALESCE(ly.s647, 0) AS s647, COALESCE(ly.s540, 0) AS s540,
    COALESCE(ly.sst, 0) AS sst, ly.primera_prod, ex.ultima_guia, ly.dias_saldo, COALESCE(mv.movs, 0) AS movs, mv.f0, mv.f1
  FROM lotes lt LEFT JOIN f_sosp s ON s.lote = lt.lote LEFT JOIN ly ON ly.lote = lt.lote LEFT JOIN ex ON ex.lote = lt.lote LEFT JOIN mv ON mv.lote = lt.lote;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'variante', variante, 'parecido_a', parecido_a, 'cliente', cliente,
           'produccion_tn', public.apt_flow_tn(prod), 'otros_ingresos_tn', public.apt_flow_tn(otros_in), 'asignado_tn', public.apt_flow_tn(asignado),
           'despacho_tn', public.apt_flow_tn(desp), 'guias', guias, 'consumo_tn', public.apt_flow_tn(cons), 'otro_almacen_tn', public.apt_flow_tn(otro_out),
           'cedido_tn', public.apt_flow_tn(cedido), 'saldo_tn', public.apt_flow_tn(saldo),
           'saldo_almacen', jsonb_build_object('647', public.apt_flow_tn(s647), '540', public.apt_flow_tn(s540), 'ST', public.apt_flow_tn(sst)),
           'primera_produccion', primera_prod, 'ultima_guia', ultima_guia, 'dias_saldo', dias_saldo, 'movimientos', movs, 'desde', f0, 'hasta', f1)
           ORDER BY CASE variante WHEN 'MADRE' THEN 1 WHEN 'SUBCONTRATO' THEN 2 WHEN 'ERROR' THEN 3 WHEN 'GARANTIA' THEN 4 WHEN 'DEVOLUCION' THEN 5
                                  WHEN 'OTRO' THEN 6 ELSE 7 END, lote), '[]')
  INTO v_miembros FROM f_lot;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('variante', variante, 'lotes', n, 'produccion_tn', public.apt_flow_tn(prod),
           'despacho_tn', public.apt_flow_tn(desp), 'saldo_tn', public.apt_flow_tn(saldo),
           'guias', (SELECT count(DISTINCT x.documento) FROM public.apt_flow_exits x JOIN f_lot f2 ON f2.lote = x.lote
                     WHERE x.tipo = 'DESPACHO' AND f2.variante = z.variante))
           ORDER BY CASE variante WHEN 'MADRE' THEN 1 WHEN 'SUBCONTRATO' THEN 2 WHEN 'ERROR' THEN 3 WHEN 'GARANTIA' THEN 4 WHEN 'DEVOLUCION' THEN 5
                                  WHEN 'OTRO' THEN 6 ELSE 7 END), '[]')
  INTO v_grupos
  FROM (SELECT variante, count(*) AS n, sum(prod) AS prod, sum(desp) AS desp, sum(saldo) AS saldo FROM f_lot GROUP BY 1) z;

  SELECT jsonb_build_object('lotes', count(*) FILTER (WHERE variante <> 'SOSPECHOSO'), 'sospechosos', count(*) FILTER (WHERE variante = 'SOSPECHOSO'),
      'produccion_tn', public.apt_flow_tn(sum(prod) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'asignado_tn', public.apt_flow_tn(sum(asignado) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'despacho_tn', public.apt_flow_tn(sum(desp) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'consumo_tn', public.apt_flow_tn(sum(cons) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'cedido_tn', public.apt_flow_tn(sum(cedido) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'saldo_tn', public.apt_flow_tn(sum(saldo) FILTER (WHERE variante <> 'SOSPECHOSO')),
      'sospechoso_tn', public.apt_flow_tn(sum(prod + otros_in + asignado) FILTER (WHERE variante = 'SOSPECHOSO')),
      'guias', (SELECT count(DISTINCT x.documento) FROM public.apt_flow_exits x WHERE x.tipo = 'DESPACHO'
                AND x.lote IN (SELECT lote FROM f_lot WHERE variante <> 'SOSPECHOSO')),
      'primera_produccion', min(primera_prod), 'ultima_guia', max(ultima_guia),
      'cliente', (SELECT cliente FROM f_lot WHERE cliente IS NOT NULL GROUP BY cliente ORDER BY sum(prod + desp) DESC LIMIT 1),
      'dias_total', (SELECT round(sum(p.kg * (p.fecha_salida - p.fecha_origen)) / NULLIF(sum(p.kg), 0), 1) FROM public.apt_flow_pieces p
                     WHERE public.apt_ot_raiz(p.lote) = v_ot AND NOT p.es_saldo AND p.salida_tipo = 'DESPACHO' AND p.origen = 'PRODUCCION'))
  INTO v_res FROM f_lot;

  -- Vinculados: lotes de otra raíz relacionados con la OT
  -- (el traspaso de un adelanto también trae el contrato de la OT: la referencia solo suma si no hay otro rol)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'roles', roles, 'tn', public.apt_flow_tn(kg),
           'adelanto_tn', public.apt_flow_tn(ade), 'reasignado_tn', public.apt_flow_tn(rea), 'insumo_tn', public.apt_flow_tn(ins),
           'movimientos', n, 'hacia', hacia, 'glosa', glosa, 'desde', f0, 'hasta', f1) ORDER BY kg DESC NULLS LAST, lote), '[]')
  INTO v_vinc
  FROM (SELECT lote, array_agg(DISTINCT rol ORDER BY rol) AS roles,
               COALESCE(sum(kg) FILTER (WHERE rol = 'ADELANTO'), 0) AS ade, COALESCE(sum(kg) FILTER (WHERE rol = 'REASIGNADO'), 0) AS rea,
               COALESCE(sum(kg) FILTER (WHERE rol = 'INSUMO'), 0) AS ins,
               CASE WHEN bool_or(rol <> 'REFERENCIA') THEN COALESCE(sum(kg) FILTER (WHERE rol <> 'REFERENCIA'), 0) ELSE sum(kg) END AS kg,
               sum(n) AS n,
               (array_agg(hacia ORDER BY kg DESC NULLS LAST))[1] AS hacia, max(glosa) AS glosa, min(f0) AS f0, max(f1) AS f1
        FROM (
          -- Adelanto: material de otro lote que pasó a la familia por traspaso
          SELECT l.lote_origen AS lote, 'ADELANTO' AS rol, sum(l.kg_in) AS kg, count(*) AS n, max(l.lote) AS hacia, max(l.glosa) AS glosa,
                 min(l.fecha) AS f0, max(l.fecha) AS f1
          FROM public.apt_flow_layers l
          WHERE public.apt_ot_raiz(l.lote) = v_ot AND l.tipo = 'TRASPASO' AND l.lote_origen IS NOT NULL
            AND public.apt_ot_raiz(l.lote_origen) IS DISTINCT FROM v_ot AND l.lote_origen NOT IN (SELECT lote FROM f_sosp)
          GROUP BY 1
          UNION ALL
          -- Reasignado: material de la familia que pasó a otro lote
          SELECT x.lote_destino, 'REASIGNADO', sum(x.kg), count(*), max(x.lote), max(x.glosa), min(x.fecha), max(x.fecha)
          FROM public.apt_flow_exits x
          WHERE public.apt_ot_raiz(x.lote) = v_ot AND x.tipo = 'TRASPASO' AND x.lote_destino IS NOT NULL
            AND public.apt_ot_raiz(x.lote_destino) IS DISTINCT FROM v_ot AND x.lote_destino NOT IN (SELECT lote FROM f_sosp)
          GROUP BY 1
          UNION ALL
          -- Referencia del ERP: otro lote cuyo contrato o NumRel es de la OT (insumos consumidos, traspasos al contrato)
          SELECT m.lote, CASE m.kind WHEN 'CONSUMO' THEN 'INSUMO' ELSE 'REFERENCIA' END, sum(m.peso_kg), count(*),
                 max(COALESCE(m.contrato, m.numrel)), max(m.glosa), min(m.fecha), max(m.fecha)
          FROM public.apt_movements m
          WHERE m.active AND m.valid AND m.lote IS NOT NULL AND public.apt_ot_raiz(m.lote) IS DISTINCT FROM v_ot
            AND m.lote NOT IN (SELECT lote FROM f_sosp)
            AND (public.apt_ot_raiz(m.contrato) = v_ot OR public.apt_ot_raiz(m.numrel) = v_ot)
          GROUP BY 1, 2) z
        GROUP BY lote) v;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote', lote, 'parecido_a', parecido_a) ORDER BY lote), '[]') INTO v_sosp FROM f_sosp;

  RETURN jsonb_build_object('success', true, 'ot', v_ot, 'q', upper(btrim(p_q)), 'cutoff', v_cut, 'resumen', v_res, 'grupos', v_grupos,
    'miembros', v_miembros, 'vinculados', v_vinc, 'sospechosos', v_sosp);
END $$;

REVOKE ALL ON FUNCTION public.apt_ot_familia(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_ot_familia(text) TO authenticated, service_role;


-- Kardex: filtro OT por familia (raíz), variantes[] e incluir_sospechosos; cada fila trae su variante
CREATE OR REPLACE FUNCTION public.apt_kardex(p jsonb DEFAULT '{}'::jsonb, p_nivel text DEFAULT 'lote_producto',
  p_por_almacen boolean DEFAULT true, p_limit integer DEFAULT 500, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_desde date; v_hasta date; v_rows jsonb; v_res jsonb; v_alm jsonb; v_tipos jsonb; v_total bigint; v_min date; v_max date;
  v_ot text := COALESCE(public.apt_ot_raiz(p ->> 'ot'), upper(NULLIF(btrim(p ->> 'ot'), ''))); v_sosp text[] := '{}';
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  IF p_nivel NOT IN ('lote_producto', 'producto', 'lote', 'total') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Nivel de saldo no válido');
  END IF;
  p := COALESCE(p, '{}'::jsonb);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 20000);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);
  SELECT min(fecha), max(fecha) INTO v_min, v_max FROM public.apt_movements WHERE active AND valid;
  v_desde := COALESCE(public.apt_date(p -> 'desde'), v_min);
  v_hasta := COALESCE(public.apt_date(p -> 'hasta'), v_max);
  -- Familia de la OT: todos los lotes con la misma raíz (madre, -S, -E, -G, D) y, si se pide, los de posible error de digitación
  IF v_ot IS NOT NULL AND COALESCE((p ->> 'incluir_sospechosos')::boolean, false) THEN
    SELECT COALESCE(array_agg(lote), '{}') INTO v_sosp FROM public.apt_ot_sospechosos(v_ot);
  END IF;

  DROP TABLE IF EXISTS pg_temp.k_mov;
  CREATE TEMP TABLE k_mov ON COMMIT DROP AS
  WITH cli AS (SELECT lote, max(cliente) AS cliente FROM public.apt_flow_layers WHERE cliente IS NOT NULL GROUP BY 1),
  base AS (
    SELECT m.id, m.fecha,
      CASE m.kind WHEN 'ENTRADA' THEN 'PRODUCCION' WHEN 'SALIDA' THEN 'DESPACHO' ELSE m.kind END AS tipo,
      COALESCE(m.almacen, '647') AS almacen, m.documento, m.tipodocto, m.lote, m.producto, m.glosa, m.unidad,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 1 ELSE -1 END AS signo,
      m.cantidad, m.peso_kg AS kg, m.numrel, m.docrel,
      COALESCE(CASE WHEN m.kind = 'SALIDA' THEN m.cliente END, c.cliente) AS cliente,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN COALESCE(x.almacen_destino, 'Otro almacén') WHEN 'TRASPASO_ENT' THEN COALESCE(l.almacen_origen, 'Otro almacén') END AS contraparte,
      CASE m.kind WHEN 'TRASPASO_SAL' THEN NULLIF(x.lote_destino, m.lote) WHEN 'TRASPASO_ENT' THEN NULLIF(l.lote_origen, m.lote) END AS lote_rel,
      CASE WHEN m.kind IN ('ENTRADA', 'TRASPASO_ENT', 'DEVOLUCION') THEN 0 ELSE 1 END AS o
    FROM public.apt_movements m
    LEFT JOIN public.apt_flow_exits x ON m.kind = 'TRASPASO_SAL' AND x.id = m.id
    LEFT JOIN public.apt_flow_layers l ON m.kind = 'TRASPASO_ENT' AND l.id = m.id
    LEFT JOIN cli c ON c.lote = m.lote
    WHERE m.active AND m.valid AND m.lote IS NOT NULL AND (m.almacen IS NOT NULL OR m.kind = 'ENTRADA')
    UNION ALL
    -- Stock previo inferido por el flujo: primera fila de cada lote y producto en su almacén
    SELECT -l.id, NULL::date, 'INICIAL', l.almacen, NULL, 'STOCK PREVIO INFERIDO', l.lote, l.producto, l.glosa, NULL,
      1, NULL::numeric, l.kg_in, NULL, NULL, l.cliente, NULL, NULL, -1
    FROM public.apt_flow_layers l WHERE l.tipo = 'INICIAL')
  SELECT * FROM base b
  WHERE (NULLIF(btrim(p ->> 'lote_exacto'), '') IS NULL OR b.lote = upper(btrim(p ->> 'lote_exacto')))
    AND (NULLIF(btrim(p ->> 'lote'), '') IS NULL OR b.lote ILIKE '%' || btrim(p ->> 'lote') || '%' OR b.lote_rel ILIKE '%' || btrim(p ->> 'lote') || '%')
    AND (v_ot IS NULL OR public.apt_ot_raiz(b.lote) = v_ot OR b.lote = ANY (v_sosp))
    AND (jsonb_typeof(p -> 'variantes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'variantes') = 0
         OR CASE WHEN b.lote = ANY (v_sosp) THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(b.lote) END
            IN (SELECT jsonb_array_elements_text(p -> 'variantes')))
    AND (NULLIF(btrim(p ->> 'producto'), '') IS NULL OR b.producto ILIKE '%' || btrim(p ->> 'producto') || '%')
    AND (NULLIF(btrim(p ->> 'glosa'), '') IS NULL OR b.glosa ILIKE '%' || btrim(p ->> 'glosa') || '%')
    AND (NULLIF(btrim(p ->> 'documento'), '') IS NULL OR b.documento ILIKE '%' || btrim(p ->> 'documento') || '%')
    AND (jsonb_typeof(p -> 'clientes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'clientes') = 0
         OR COALESCE(b.cliente, '(Sin cliente identificado)') IN (SELECT jsonb_array_elements_text(p -> 'clientes')))
    AND (jsonb_typeof(p -> 'almacenes') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'almacenes') = 0
         OR b.almacen IN (SELECT jsonb_array_elements_text(p -> 'almacenes')))
    AND (jsonb_typeof(p -> 'tipos') IS DISTINCT FROM 'array' OR jsonb_array_length(p -> 'tipos') = 0
         OR b.tipo IN (SELECT jsonb_array_elements_text(p -> 'tipos')));

  -- Saldo acumulado por la clave elegida (las filas anteriores al periodo forman el saldo inicial)
  DROP TABLE IF EXISTS pg_temp.k_run;
  CREATE TEMP TABLE k_run ON COMMIT DROP AS
  SELECT k.*, z.clave,
    sum(k.signo * k.kg) OVER w AS saldo_kg,
    CASE WHEN p_nivel IN ('lote_producto', 'producto') THEN sum(k.signo * COALESCE(k.cantidad, 0)) OVER w END AS saldo_cant,
    row_number() OVER (ORDER BY z.clave, k.fecha NULLS FIRST, k.o, k.id) AS rn
  FROM k_mov k
  CROSS JOIN LATERAL (SELECT concat_ws(' · ', CASE WHEN p_por_almacen THEN k.almacen END,
      CASE p_nivel WHEN 'lote_producto' THEN k.lote || ' | ' || k.producto WHEN 'producto' THEN k.producto WHEN 'lote' THEN k.lote ELSE 'Total' END) AS clave) z
  WINDOW w AS (PARTITION BY z.clave ORDER BY k.fecha NULLS FIRST, k.o, k.id ROWS UNBOUNDED PRECEDING);
  CREATE INDEX ON k_run (rn);

  SELECT count(*) INTO v_total FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'clave', r.clave, 'fecha', r.fecha, 'tipo', r.tipo, 'documento', r.documento,
           'tipodocto', r.tipodocto, 'almacen', r.almacen,
           'variante', CASE WHEN r.lote = ANY (v_sosp) THEN 'SOSPECHOSO' ELSE public.apt_lote_variante(r.lote) END, 'contraparte', r.contraparte, 'lote', r.lote, 'lote_rel', r.lote_rel,
           'producto', r.producto, 'glosa', r.glosa, 'cliente', r.cliente, 'numrel', r.numrel, 'docrel', r.docrel, 'unidad', r.unidad,
           'cant_in', CASE WHEN r.signo > 0 THEN r.cantidad END, 'cant_out', CASE WHEN r.signo < 0 THEN r.cantidad END,
           'kg_in', CASE WHEN r.signo > 0 THEN round(r.kg, 3) END, 'kg_out', CASE WHEN r.signo < 0 THEN round(r.kg, 3) END,
           'saldo_kg', round(r.saldo_kg, 3), 'saldo_cant', r.saldo_cant,
           'saldo_kg_antes', round(r.saldo_kg - r.signo * r.kg, 3)) ORDER BY r.rn), '[]')
  INTO v_rows
  FROM (SELECT * FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta ORDER BY rn OFFSET p_offset LIMIT p_limit) r;

  -- Resumen del periodo: saldo inicial (incluye stock previo y movimientos anteriores), entradas, salidas y saldo final
  SELECT jsonb_build_object(
    'claves', (SELECT count(DISTINCT clave) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'movimientos', v_total,
    'guias', (SELECT count(DISTINCT documento) FROM k_run WHERE tipo = 'DESPACHO' AND fecha BETWEEN v_desde AND v_hasta),
    'lotes', (SELECT count(DISTINCT lote) FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta),
    'saldo_inicial_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha < v_desde), 0) / 1000.0, 3),
    'entradas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'salidas_tn', round(COALESCE((SELECT sum(kg) FROM k_run WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) / 1000.0, 3),
    'saldo_final_tn', round(COALESCE((SELECT sum(signo * kg) FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta), 0) / 1000.0, 3),
    'claves_negativas', (SELECT count(*) FROM (SELECT clave FROM k_run WHERE fecha IS NULL OR fecha <= v_hasta GROUP BY clave
                                              HAVING sum(signo * kg) < -0.5) z))
  INTO v_res;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen', almacen, 'inicial_tn', round(ini / 1000.0, 3), 'entradas_tn', round(ent / 1000.0, 3),
           'salidas_tn', round(sal / 1000.0, 3), 'saldo_tn', round((ini + ent - sal) / 1000.0, 3))
           ORDER BY CASE almacen WHEN '647' THEN 1 WHEN '540' THEN 2 ELSE 3 END), '[]')
  INTO v_alm
  FROM (SELECT almacen, COALESCE(sum(signo * kg) FILTER (WHERE fecha IS NULL OR fecha < v_desde), 0) AS ini,
               COALESCE(sum(kg) FILTER (WHERE signo > 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS ent,
               COALESCE(sum(kg) FILTER (WHERE signo < 0 AND fecha BETWEEN v_desde AND v_hasta), 0) AS sal
        FROM k_run GROUP BY almacen) z;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo', tipo, 'filas', n, 'tn', round(kg / 1000.0, 3)) ORDER BY kg DESC), '[]')
  INTO v_tipos
  FROM (SELECT tipo, count(*) AS n, sum(kg) AS kg FROM k_run WHERE fecha BETWEEN v_desde AND v_hasta GROUP BY 1) z;

  RETURN jsonb_build_object('success', true, 'desde', v_desde, 'hasta', v_hasta, 'data_min', v_min, 'data_max', v_max,
    'nivel', p_nivel, 'por_almacen', p_por_almacen, 'total', v_total, 'offset', p_offset, 'limit', p_limit,
    'resumen', v_res, 'almacenes', v_alm, 'tipos', v_tipos, 'filas', v_rows);
END $$;

COMMIT;
