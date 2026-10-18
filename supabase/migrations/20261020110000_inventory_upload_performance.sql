-- Inventory import: bounded chunks with idempotent retries; linear catalog aggregation.
-- Preserve the existing FIFO model, normalization semantics, and authorization rules.
BEGIN;

CREATE TABLE public.inv_upload_chunks (
  upload_id uuid NOT NULL REFERENCES public.inv_uploads(id) ON DELETE CASCADE,
  chunk_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(upload_id, chunk_hash)
);
ALTER TABLE public.inv_upload_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY security_active_account ON public.inv_upload_chunks AS RESTRICTIVE FOR ALL TO authenticated
 USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.inv_upload_chunks FROM PUBLIC, anon, authenticated;

-- The SQL CTE implementation expanded and repeated normalization for each invocation.
-- Normalize the same string once; output is identical to the original ERP rules.
CREATE OR REPLACE FUNCTION public.inv_lote(v text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE s text;
BEGIN
  s := upper(btrim(regexp_replace(COALESCE(v, ''), '\s+', '', 'g')));
  IF s ~ '^[0-9]+\.0+$' THEN s := split_part(s, '.', 1); END IF;
  IF s ~ '^0+[0-9]+(-|$)' THEN s := regexp_replace(s, '^0+([0-9])', '\1'); END IF;
  RETURN CASE WHEN s IN ('', '0', '1', '-', '.', 'NULL', 'N/A', 'NA') THEN NULL ELSE s END;
END $$;

CREATE OR REPLACE FUNCTION public.inv_upload_rows(p_upload_id uuid, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
DECLARE v_side text; v_ok integer := 0; v_total integer; v_excl jsonb; v_hash text; v_result jsonb;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario');
  END IF;
  SELECT side INTO v_side FROM public.inv_uploads WHERE id = p_upload_id AND status = 'CARGANDO' FOR UPDATE;
  IF v_side IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe un arreglo de filas');
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Envíe como máximo 5000 filas por bloque');
  END IF;
  -- A network retry of a committed chunk must not duplicate rows or counters.
  -- Serialized by the upload row lock; the digest includes original ERP line numbers.
  v_hash := md5(p_rows::text);
  SELECT result INTO v_result FROM public.inv_upload_chunks WHERE upload_id = p_upload_id AND chunk_hash = v_hash;
  IF FOUND THEN RETURN v_result || jsonb_build_object('replayed', true); END IF;
  v_total := jsonb_array_length(p_rows);

  IF to_regclass('pg_temp.inv_tmp_rows') IS NULL THEN
    CREATE TEMP TABLE inv_tmp_rows (n integer, j jsonb, motivo text) ON COMMIT DROP;
  END IF;
  TRUNCATE inv_tmp_rows;
  INSERT INTO inv_tmp_rows (n, j, motivo)
  SELECT COALESCE((r.j->>'__row')::integer, r.ord::integer), r.j,
    CASE
      WHEN public.inv_code(r.j->>'BODEGA') IS NULL THEN 'Sin bodega'
      WHEN NULLIF(btrim(r.j->>'Producto'), '') IS NULL THEN 'Sin producto'
      WHEN v_side <> 'STOCK' AND (r.j->>'Fecha') !~ '^\d{4}-\d{2}-\d{2}$' THEN 'Sin fecha'
      WHEN v_side <> 'STOCK' AND public.inv_code(r.j->>'TIPODOCTO') IS NULL THEN 'Sin tipo de documento'
      WHEN (r.j->>'Cantidad') !~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN 'Cantidad no numérica'
      WHEN v_side <> 'STOCK' AND (r.j->>'Cantidad')::numeric = 0 THEN 'Cantidad cero'
    END
  FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(j, ord);

  IF v_side = 'STOCK' THEN
    INSERT INTO public.inv_stock_snapshots (upload_id, bodega, producto, lote, glosa, unidad, cantidad, peso_kg)
    SELECT p_upload_id, public.inv_code(j->>'BODEGA'), btrim(j->>'Producto'), public.inv_lote(j->>'Lote'),
      NULLIF(btrim(j->>'GLOSA'), ''), public.inv_code(j->>'UNIDAD'), (j->>'Cantidad')::numeric,
      CASE WHEN (j->>'Peso') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN abs((j->>'Peso')::numeric) END
    FROM inv_tmp_rows WHERE motivo IS NULL AND (j->>'Cantidad')::numeric > 0;
    GET DIAGNOSTICS v_ok = ROW_COUNT;
  ELSE
    INSERT INTO public.inv_movements (upload_id, side, linea, tipodocto, bodega, numero, fecha, cod_legal, razon_social,
      producto, glosa, cantidad, unidad, doc_rel, num_rel, fecha_entrega, contrato, ref_tipo, ref_correlativo, ref_numero,
      ref_fecha, lote_raw, lote, ot, comentario, peso_unit, peso_kg, ccosto)
    SELECT p_upload_id, v_side, n, public.inv_code(j->>'TIPODOCTO'), public.inv_code(j->>'BODEGA'),
      COALESCE(public.apt_id(NULLIF(btrim(j->>'Numero'), '')), 'S/N'), (j->>'Fecha')::date,
      NULLIF(regexp_replace(btrim(COALESCE(j->>'CodLegal', '')), '\.0+$', ''), ''), NULLIF(btrim(j->>'RazonSocial'), ''),
      btrim(j->>'Producto'), NULLIF(btrim(j->>'GLOSA'), ''), q.cant, public.inv_code(j->>'UNIDAD'),
      public.inv_code(j->>'DocRel'), public.inv_lote(j->>'NumRel'),
      CASE WHEN (j->>'FechaEntrega') ~ '^\d{4}-\d{2}-\d{2}$' THEN (j->>'FechaEntrega')::date END,
      public.inv_lote(j->>'Contrato'), public.inv_code(j->>'RefTipoDocto'),
      NULLIF(NULLIF(btrim(j->>'RefCorrelativo'), ''), '0'), NULLIF(NULLIF(btrim(j->>'RefNumero'), ''), '0'),
      -- 22/03/2020 es el valor por defecto del ERP: "sin dato"
      CASE WHEN (j->>'RefFecha') ~ '^\d{4}-\d{2}-\d{2}$' AND (j->>'RefFecha') <> '2020-03-22' THEN (j->>'RefFecha')::date END,
      NULLIF(btrim(j->>'Lote'), ''), l.lote, public.inv_ot(l.lote), NULLIF(btrim(j->>'Comentario'), ''),
      pu.v, CASE WHEN pu.v IS NOT NULL THEN round(abs(q.cant) * pu.v, 6) END, NULLIF(btrim(j->>'CCostoJRM'), '')
    FROM inv_tmp_rows
    CROSS JOIN LATERAL (SELECT (j->>'Cantidad')::numeric AS cant) q
    CROSS JOIN LATERAL (SELECT public.inv_lote(j->>'Lote') AS lote) l
    CROSS JOIN LATERAL (SELECT CASE
        WHEN (j->>'PesoUnitario') ~ '^[0-9]+(\.[0-9]+)?$' AND (j->>'PesoUnitario')::numeric > 0 THEN (j->>'PesoUnitario')::numeric
        WHEN (j->>'PesoTotalProduccido') ~ '^-?[0-9]+(\.[0-9]+)?$' AND (j->>'PesoTotalProduccido')::numeric <> 0
          THEN round(abs((j->>'PesoTotalProduccido')::numeric) / abs(q.cant), 6) END AS v) pu
    WHERE motivo IS NULL;
    GET DIAGNOSTICS v_ok = ROW_COUNT;

    INSERT INTO public.inv_doc_types (tipodocto, clase)
    SELECT DISTINCT public.inv_code(j->>'TIPODOCTO'), public.inv_guess_class(public.inv_code(j->>'TIPODOCTO'))
    FROM inv_tmp_rows WHERE motivo IS NULL
    ON CONFLICT (tipodocto) DO NOTHING;
  END IF;

  INSERT INTO public.inv_warehouses (code, name, kind, stage)
  SELECT DISTINCT ON (c) c, left(btrim(j->>'BODEGA'), 120), public.inv_guess_kind(c), public.inv_kind_stage(public.inv_guess_kind(c))
  FROM inv_tmp_rows CROSS JOIN LATERAL (SELECT public.inv_code(j->>'BODEGA') AS c) b
  WHERE motivo IS NULL
  ON CONFLICT (code) DO NOTHING;

  SELECT COALESCE(jsonb_object_agg(motivo, n), '{}'::jsonb) INTO v_excl
  FROM (SELECT motivo, count(*) AS n FROM inv_tmp_rows WHERE motivo IS NOT NULL GROUP BY motivo) x;

  UPDATE public.inv_uploads u SET rows_total = u.rows_total + v_total, rows_valid = u.rows_valid + v_ok,
    excluded = (SELECT COALESCE(jsonb_object_agg(k, COALESCE((u.excluded->>k)::integer, 0) + COALESCE((v_excl->>k)::integer, 0)), '{}'::jsonb)
                FROM (SELECT jsonb_object_keys(u.excluded) AS k UNION SELECT jsonb_object_keys(v_excl)) ks)
  WHERE u.id = p_upload_id;
  v_result := jsonb_build_object('success', true, 'inserted', v_ok, 'excluded', v_excl);
  INSERT INTO public.inv_upload_chunks(upload_id, chunk_hash, result) VALUES(p_upload_id, v_hash, v_result);
  RETURN v_result;
END $$;

-- One pass for each dimension instead of one full history scan per catalog entry.
CREATE OR REPLACE FUNCTION public.inv_catalogs()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET jit = off AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'bodegas', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', w.code, 'name', w.name, 'kind', w.kind, 'stage', w.stage, 'auto', w.auto,
        'movimientos', COALESCE(c.n, 0)) ORDER BY w.stage, w.code)
      FROM public.inv_warehouses w LEFT JOIN (SELECT bodega, count(*) n FROM public.inv_movements WHERE active GROUP BY bodega) c
      ON c.bodega = w.code), '[]'::jsonb),
    'tipos', COALESCE((SELECT jsonb_agg(jsonb_build_object('tipodocto', d.tipodocto, 'clase', d.clase, 'auto', d.auto,
        'movimientos', COALESCE(c.n, 0)) ORDER BY d.clase, d.tipodocto)
      FROM public.inv_doc_types d LEFT JOIN (SELECT tipodocto, count(*) n FROM public.inv_movements WHERE active GROUP BY tipodocto) c
      ON c.tipodocto = d.tipodocto), '[]'::jsonb));
END $$;
-- A lost apply response can be retried without replacing the same range again.
CREATE OR REPLACE FUNCTION public.inv_upload_apply_core(p_upload_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.inv_uploads; v_from date; v_to date; v_valid integer; v_removed integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_rebuild'));
  SELECT * INTO u FROM public.inv_uploads WHERE id = p_upload_id FOR UPDATE;
  IF u.status = 'APLICADA' THEN
    RETURN jsonb_build_object('success', true, 'replayed', true, 'side', u.side, 'desde', u.desde, 'hasta', u.hasta,
      'rows', u.rows_valid, 'replaced', u.replaced);
  END IF;
  IF u.status = 'DESCARTADA' THEN RETURN jsonb_build_object('success', false, 'error', 'La carga fue descartada'); END IF;
  IF u.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada'); END IF;

  IF u.side = 'STOCK' THEN
    IF NOT EXISTS (SELECT 1 FROM public.inv_stock_snapshots WHERE upload_id = u.id) THEN
      RETURN jsonb_build_object('success', false, 'error', 'La foto de stock no tiene filas con cantidad positiva');
    END IF;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = u.cutoff, hasta = u.cutoff WHERE id = u.id;
  ELSE
    SELECT min(fecha), max(fecha), count(*) INTO v_from, v_to, v_valid FROM public.inv_movements WHERE upload_id = u.id;
    IF v_valid = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'El archivo no tiene movimientos válidos'); END IF;
    SELECT count(*) INTO v_removed FROM public.inv_movements m
    WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    -- Protección: un archivo filtrado (p. ej. una sola bodega) no debe borrar la historia completa de su rango
    IF NOT p_force AND v_removed > 200 AND v_removed > 3 * v_valid THEN
      RETURN jsonb_build_object('success', false, 'partial', true, 'error', format(
        'El archivo trae %s filas del %s al %s, pero ya hay %s cargadas en ese rango. Parece un reporte parcial o filtrado: cargue el reporte completo de esas fechas.',
        v_valid, to_char(v_from, 'DD/MM/YYYY'), to_char(v_to, 'DD/MM/YYYY'), v_removed));
    END IF;
    DELETE FROM public.inv_movements m WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;
    UPDATE public.inv_movements SET active = true WHERE upload_id = u.id;
    UPDATE public.inv_uploads SET status = 'APLICADA', applied_at = now(), desde = v_from, hasta = v_to, replaced = v_removed
    WHERE id = u.id;
  END IF;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'side', u.side, 'desde', COALESCE(v_from, u.cutoff), 'hasta', COALESCE(v_to, u.cutoff),
    'rows', COALESCE(v_valid, u.rows_valid), 'replaced', v_removed);
END $$;
COMMIT;
