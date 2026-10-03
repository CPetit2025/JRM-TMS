-- ============================================================
-- APT — Carga del reporte total de entradas y salidas del ERP
-- ============================================================
-- 1. Identificadores con ceros a la izquierda: el reporte total exporta los números como texto relleno
--    (NumRel '0000016101', Lote '02859', Numero '0000044266'). Se normalizan quitando los ceros cuando el valor es
--    dígitos (también el primer tramo de un lote con sufijo: '0000016339-S001' → '16339-S001'), así coinciden con los reportes que los exportan como número (16101, 2859, 44266) y la guía del
--    lote 16101 encuentra el traspaso del lote 16101.
-- 2. Bodegas:
-- El reporte total de entradas del ERP trae la producción de todas las plantas y almacenes (P/E PRODUCCION a otras
-- bodegas) y el de salidas incluye bodegas de terceros (RINTI). Hasta ahora una fila ENTRADA sin bodega APT se tomaba
-- como ingreso a 647. Desde aquí, una fila ENTRADA o SALIDA que trae bodega y no es 647, 540 ni ST VENTAS queda excluida
-- con su motivo (la carga ya las descarta antes de subirlas). Las filas sin bodega (reportes clásicos) se aceptan igual.
-- La producción que entra directo a 540 (adelantos con IPT) se mantiene en 540.
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_id(v text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN v ~ '^0+[0-9]+(-|$)' THEN regexp_replace(v, '^0+([0-9])', '\1') ELSE v END;
$$;

CREATE OR REPLACE FUNCTION public.apt_upload_rows(p_upload_id uuid, p_kind text, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.apt_can_load() THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de APT');
  END IF;
  IF p_kind NOT IN ('ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de hoja no válido');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.apt_uploads WHERE id = p_upload_id AND status = 'CARGANDO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'La carga no existe o ya fue cerrada');
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Formato de filas no válido');
  END IF;

  INSERT INTO public.apt_movements (upload_id, kind, row_no, raw, valid, invalid_reason, fecha, documento, tipodocto, bodega,
    numrel, lote_origen, lote, lote_derivado, docrel, cliente, ruc, producto, glosa, familia, ipt, cantidad, unidad,
    peso_unitario, peso_kg, fecha_entrega, almacen, contrato)
  SELECT p_upload_id, p_kind, COALESCE(public.apt_num(x.r -> '__row')::int, 0), x.r - '__row',
    v.ok, v.reason, n.fecha, n.documento, n.tipodocto, n.bodega, n.numrel, n.lote_origen, l.lote,
    (p_kind = 'ENTRADA' AND n.lote_origen IS NULL AND n.numrel IS NOT NULL),
    n.docrel, n.cliente, n.ruc, n.producto, n.glosa, split_part(n.glosa, ' ', 1),
    left(btrim(substring(n.comentario FROM 'IPT:\s*(.*)$')), 40),
    abs(public.apt_num(x.r -> 'Cantidad')), n.unidad, public.apt_num(x.r -> 'PesoUnitario'),
    COALESCE(abs(public.apt_num(x.r -> 'PesoTotalProduccido')), 0), public.apt_date(x.r -> 'FechaEntrega'),
    public.apt_almacen(n.bodega), n.contrato
  FROM jsonb_array_elements(p_rows) AS x(r)
  CROSS JOIN LATERAL (SELECT
      public.apt_date(x.r -> 'Fecha') AS fecha,
      public.apt_id(public.apt_str(x.r -> 'Numero')) AS documento,
      public.apt_str(x.r -> 'TIPODOCTO') AS tipodocto,
      public.apt_str(x.r -> 'BODEGA') AS bodega,
      public.apt_id(public.apt_txt(x.r -> 'NumRel')) AS numrel,
      public.apt_id(public.apt_txt(x.r -> 'Lote')) AS lote_origen,
      upper(public.apt_str(x.r -> 'DocRel')) AS docrel,
      public.apt_str(x.r -> 'RazonSocial') AS cliente,
      public.apt_txt(x.r -> 'CodLegal') AS ruc,
      public.apt_txt(x.r -> 'Producto') AS producto,
      public.apt_str(x.r -> 'GLOSA') AS glosa,
      public.apt_str(x.r -> 'Comentario') AS comentario,
      upper(public.apt_str(x.r -> 'UNIDAD')) AS unidad,
      public.apt_id(public.apt_txt(x.r -> 'Contrato')) AS contrato) n
  CROSS JOIN LATERAL (SELECT CASE
      WHEN p_kind = 'ENTRADA' THEN COALESCE(n.lote_origen,
        regexp_replace(n.numrel, '-[0-9]+$', ''))
      WHEN p_kind = 'SALIDA' AND n.docrel = 'ERROR DE CONTRATO' AND n.lote_origen IS NOT NULL THEN n.lote_origen
      WHEN p_kind = 'SALIDA' THEN n.numrel
      -- Traspasos, consumos y devoluciones: Lote del APT; si falta, el contrato (NumRel en un consumo es la OP que consume)
      ELSE COALESCE(n.lote_origen, n.contrato, regexp_replace(n.numrel, '-[0-9]+$', '')) END AS lote) l
  CROSS JOIN LATERAL (SELECT CASE
      WHEN n.fecha IS NULL AND n.producto IS NULL THEN 'Fila sin fecha ni producto (totalizadora o vacía)'
      WHEN n.fecha IS NULL THEN 'Sin fecha'
      WHEN n.fecha > current_date + 1 THEN 'Fecha futura'
      WHEN n.fecha < DATE '2000-01-01' THEN 'Fecha fuera de rango'
      WHEN n.producto IS NULL THEN 'Sin producto'
      WHEN p_kind = 'ENTRADA' AND l.lote IS NULL THEN 'Sin NumRel ni Lote'
      WHEN (p_kind NOT IN ('ENTRADA', 'SALIDA') OR n.bodega IS NOT NULL) AND public.apt_almacen(n.bodega) IS NULL
        THEN 'Fuera de los almacenes APT (647, 540, ST VENTAS)'
      WHEN p_kind NOT IN ('ENTRADA', 'SALIDA') AND l.lote IS NULL THEN 'Sin Lote ni Contrato'
      WHEN x.r ? 'PesoTotalProduccido' AND jsonb_typeof(x.r -> 'PesoTotalProduccido') <> 'null'
           AND public.apt_num(x.r -> 'PesoTotalProduccido') IS NULL THEN 'Peso no numérico' END AS reason) v0
  CROSS JOIN LATERAL (SELECT v0.reason IS NULL AS ok, v0.reason) v
  ON CONFLICT (upload_id, kind, row_no) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'rows', v_n);
END $$;

-- Filas ya cargadas: mismas reglas
UPDATE public.apt_movements SET documento = public.apt_id(documento), numrel = public.apt_id(numrel),
  lote_origen = public.apt_id(lote_origen), contrato = public.apt_id(contrato), lote = public.apt_id(lote)
WHERE documento ~ '^0+[0-9]+(-|$)' OR numrel ~ '^0+[0-9]+(-|$)' OR lote_origen ~ '^0+[0-9]+(-|$)' OR contrato ~ '^0+[0-9]+(-|$)'
   OR lote ~ '^0+[0-9]+(-|$)';
UPDATE public.apt_movements SET valid = false, invalid_reason = 'Fuera de los almacenes APT (647, 540, ST VENTAS)'
WHERE kind IN ('ENTRADA', 'SALIDA') AND valid AND bodega IS NOT NULL AND public.apt_almacen(bodega) IS NULL;

-- Recalcular con las filas corregidas
SELECT public.apt_rebuild();
SELECT public.apt_flow_rebuild_core();

COMMIT;
