-- APT · Flujo · Stock por almacén: el saldo también agrupado por glosa (descripción del producto) en cada almacén,
-- con las mismas medidas que la lista de lotes (TN, edad y días en almacén ponderados, TN×Días, stock previo, alerta).
-- apt_flow_stock agrega la clave 'glosas' (hasta 2000 grupos, para que sumen el saldo completo); el resto no cambia.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_flow_stock_glosas(p jsonb, p_cut date, p_alert integer, p_almacen text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(z.j ORDER BY z.txd DESC NULLS LAST, z.kg DESC), '[]')
  FROM (SELECT jsonb_build_object('almacen', x.almacen, 'glosa', x.etiqueta, 'tn', public.apt_flow_tn(sum(x.kg)),
          'lotes', count(DISTINCT x.lote), 'productos', count(DISTINCT x.producto), 'clientes', count(DISTINCT x.cliente),
          'fecha_origen_min', min(x.fecha_origen), 'fecha_llegada_min', min(x.fecha_llegada),
          'edad_pond', round(sum(x.kg * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL)
                             / NULLIF(sum(x.kg) FILTER (WHERE x.fecha_origen IS NOT NULL), 0), 1),
          'dias_almacen_pond', round(sum(x.kg * (p_cut - x.fecha_llegada)) FILTER (WHERE x.fecha_llegada IS NOT NULL)
                                     / NULLIF(sum(x.kg) FILTER (WHERE x.fecha_llegada IS NOT NULL), 0), 1),
          'inicial_tn', public.apt_flow_tn(sum(x.kg) FILTER (WHERE x.origen LIKE 'INICIAL%')),
          'tn_dias', round(sum(x.kg / 1000.0 * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL), 1),
          'alerta', COALESCE(bool_or(p_cut - x.fecha_origen > p_alert), false)) AS j,
          sum(x.kg / 1000.0 * (p_cut - x.fecha_origen)) FILTER (WHERE x.fecha_origen IS NOT NULL) AS txd, sum(x.kg) AS kg
        FROM (SELECT s.*, COALESCE(NULLIF(btrim(s.glosa), ''), '(Sin glosa) ' || s.producto) AS etiqueta
              FROM public.apt_flow_pieces s
              WHERE s.es_saldo AND (p_almacen IS NULL OR s.almacen = p_almacen) AND public.apt_flow_match(p, s.lote, s.cliente)) x
        GROUP BY x.almacen, x.etiqueta
        ORDER BY 2 DESC NULLS LAST, 3 DESC LIMIT 2000) z;
$$;
REVOKE ALL ON FUNCTION public.apt_flow_stock_glosas(jsonb, date, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_stock_glosas(jsonb, date, integer, text) TO service_role;

DO $migration$
DECLARE source text; anchor constant text := '''lotes'', v_lotes);';
BEGIN
  source := pg_get_functiondef('public.apt_flow_stock(jsonb)'::regprocedure);
  IF position('''glosas''' IN source) > 0 THEN RETURN; END IF;
  IF position(anchor IN source) = 0 THEN RAISE EXCEPTION 'apt_flow_stock no coincide con la definición esperada: revisar antes de migrar'; END IF;
  EXECUTE replace(source, anchor, '''lotes'', v_lotes, ''glosas'', public.apt_flow_stock_glosas(p, r.v_cut, v_alert, v_alm));');
END $migration$;
COMMIT;
NOTIFY pgrst, 'reload schema';
