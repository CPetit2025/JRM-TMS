-- Inventario: descartar una foto de stock cargada por error. El modelo arranca el día siguiente a la última foto
-- aplicada; una foto posterior a los movimientos (p. ej. el «Stock Bodega Despacho» del ERP, que es la foto de hoy)
-- deja sin usar todo el historial. Además se descarta la que entró así: ese archivo se carga en «ERP: OT, guías y stock».
BEGIN;

CREATE OR REPLACE FUNCTION public.inv_snapshot_discard()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_cut date;
BEGIN
  IF NOT public.apt_can_load() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para cargar movimientos de inventario'); END IF;
  -- La misma foto que usa el recálculo: la última aplicada
  SELECT id, cutoff INTO v_id, v_cut FROM public.inv_uploads
  WHERE side = 'STOCK' AND status = 'APLICADA' ORDER BY cutoff DESC, applied_at DESC LIMIT 1 FOR UPDATE;
  IF v_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'No hay una foto de stock vigente'); END IF;
  UPDATE public.inv_uploads SET status = 'DESCARTADA' WHERE id = v_id;
  DELETE FROM public.inv_stock_snapshots WHERE upload_id = v_id;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'upload_id', v_id, 'cutoff', v_cut);
END $$;
REVOKE ALL ON FUNCTION public.inv_snapshot_discard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_snapshot_discard() TO authenticated;

-- El Stock Bodega Despacho del ERP no es un saldo inicial del inventario: se descarta y el recálculo programado
-- vuelve a usar todos los movimientos
DO $$
DECLARE v_n integer;
BEGIN
  WITH d AS (
    UPDATE public.inv_uploads SET status = 'DESCARTADA'
    WHERE side = 'STOCK' AND status = 'APLICADA' AND file_name ILIKE '%StockBodegaDespacho%'
    RETURNING id)
  SELECT count(*) INTO v_n FROM d;
  IF v_n > 0 THEN
    DELETE FROM public.inv_stock_snapshots s USING public.inv_uploads u
    WHERE s.upload_id = u.id AND u.status = 'DESCARTADA' AND u.file_name ILIKE '%StockBodegaDespacho%';
    UPDATE public.inv_state SET dirty = true WHERE id = 1;
  END IF;
  RAISE NOTICE 'Fotos de stock del ERP descartadas: %', v_n;
END $$;

COMMIT;
