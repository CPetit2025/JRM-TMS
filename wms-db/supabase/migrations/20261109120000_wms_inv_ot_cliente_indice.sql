-- La bandeja de Recepción y etiquetado (wh_receipt_candidates) llama a inv_ot_cliente dos veces por ingreso. Con los
-- movimientos del ERP ya cargados (~358 mil filas), cada llamada recorría inv_movements entera (~130 ms): ~780 llamadas
-- superaban el statement_timeout de 8 s ("canceling statement due to statement timeout").
-- Este índice cubre exactamente el filtro de inv_ot_cliente (despachos activos con razón social, por raíz de OT).
CREATE INDEX IF NOT EXISTS inv_movements_despacho_ot_raiz_idx
 ON public.inv_movements (public.apt_ot_raiz(lote))
 WHERE active AND clase = 'DESPACHO' AND razon_social IS NOT NULL;
ANALYZE public.inv_movements;
