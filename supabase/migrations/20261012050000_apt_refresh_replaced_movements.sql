-- La carga ERP posterior al último recálculo sustituyó IDs de movimientos y dejó
-- el FIFO anterior. Recalcula solo el modelo derivado, sin modificar el ERP,
-- observaciones físicas ni controles manuales. Conserva la prueba C24 de cuadre.
BEGIN;
SET LOCAL statement_timeout='5min';
SET LOCAL lock_timeout='30s';
CREATE OR REPLACE FUNCTION public.apt_flow_ensure_current_core()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_applied timestamptz; v_rebuilt timestamptz; v_cut date; v_target date; v_result jsonb; v_missing boolean;
BEGIN
 -- El chequeo y su reparación comparten los bloqueos del reemplazo y del FIFO.
 PERFORM pg_advisory_xact_lock(hashtext('apt_rebuild'));
 PERFORM pg_advisory_xact_lock(hashtext('apt_flow_rebuild'));
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_flow_state WHERE id=1;
 SELECT COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id=1),max(fecha))
  INTO v_target FROM public.apt_movements WHERE active AND valid;
 SELECT EXISTS(
  SELECT 1 FROM public.apt_movements m
  WHERE m.active AND m.valid AND m.fecha<=v_cut AND m.peso_kg>0
   AND m.lote IS NOT NULL AND m.producto IS NOT NULL
   AND (m.almacen IS NOT NULL OR m.kind='ENTRADA')
   AND ((m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION')
         AND NOT EXISTS(SELECT 1 FROM public.apt_flow_layers l WHERE l.id=m.id))
     OR (m.kind IN ('SALIDA','TRASPASO_SAL','CONSUMO')
         AND NOT EXISTS(SELECT 1 FROM public.apt_flow_exits x WHERE x.id=m.id)))
 ) INTO v_missing;
 IF v_cut IS DISTINCT FROM v_target OR v_missing OR (v_applied IS NOT NULL AND (v_rebuilt IS NULL OR v_rebuilt<v_applied)) THEN
  v_result:=public.apt_flow_rebuild_core();
  IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'No se pudo reconciliar el flujo APT con los movimientos actuales: %',v_result;
  END IF;
  RETURN v_result || jsonb_build_object('rebuilt',true);
 END IF;
 RETURN jsonb_build_object('success',true,'rebuilt',false,'cutoff',v_cut);
END $$;
REVOKE ALL ON FUNCTION public.apt_flow_ensure_current_core() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apt_flow_ensure_current_core() TO service_role;
SELECT public.apt_flow_ensure_current_core();
COMMIT;
