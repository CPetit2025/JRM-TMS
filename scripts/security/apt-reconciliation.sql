-- Auditoría agregada de producción. Sin OT, clientes, placas, documentos ni datos personales.
-- Solo lectura: no llama rebuild ni cambia parámetros. Cuadre documental no certifica stock físico.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '45s';
SET LOCAL lock_timeout = '2s';

SELECT 'apt_metadata' AS section, jsonb_build_object(
  'captured_at', now(), 'operational_timezone', 'America/Lima',
  'physical_reconciliation', 'NO_VERIFICADA',
  'flow', (SELECT jsonb_build_object('cutoff', cutoff, 'data_min', data_min, 'rebuilt_at', rebuilt_at) FROM public.apt_flow_state WHERE id=1),
  'estadia', (SELECT jsonb_build_object('cutoff', cutoff, 'data_min', data_min, 'data_max', data_max, 'rebuilt_at', rebuilt_at) FROM public.apt_state WHERE id=1),
  'settings', (SELECT jsonb_build_object('cutoff_date', cutoff_date, 'tolerance', tolerance, 'alert_days', alert_days) FROM public.apt_settings WHERE id=1),
  'latest_applied_at', (SELECT max(applied_at) FROM public.apt_uploads WHERE status='APLICADA'),
  'flow_pending', (SELECT COALESCE(s.rebuilt_at < (SELECT max(applied_at) FROM public.apt_uploads WHERE status='APLICADA'), false) OR s.rebuilt_at IS NULL FROM public.apt_flow_state s WHERE id=1)
) AS finding
UNION ALL
SELECT 'apt_coverage', jsonb_build_object('kind', kind, 'active_rows', count(*),
  'valid_rows', count(*) FILTER(WHERE valid), 'invalid_rows', count(*) FILTER(WHERE NOT COALESCE(valid,false)),
  'first_document_date', min(fecha) FILTER(WHERE valid), 'last_document_date', max(fecha) FILTER(WHERE valid),
  'observed_dates', count(DISTINCT fecha) FILTER(WHERE valid),
  'valid_missing_weight_rows', count(*) FILTER(WHERE valid AND (peso_kg IS NULL OR peso_kg<=0)),
  'valid_reported_tn', round(COALESCE(sum(peso_kg) FILTER(WHERE valid AND peso_kg>0),0)/1000,3),
  'coverage_certifies_continuity', false)
FROM public.apt_movements WHERE active GROUP BY kind
UNION ALL
SELECT 'apt_warehouse_balance', jsonb_build_object('almacen', l.almacen,
  'inferred_opening_tn', round(COALESCE(sum(l.kg_in) FILTER(WHERE l.tipo='INICIAL'),0)/1000,3),
  'other_ingress_tn', round(COALESCE(sum(l.kg_in) FILTER(WHERE l.tipo<>'INICIAL'),0)/1000,3),
  'egress_tn', round(COALESCE((SELECT sum(x.kg) FROM public.apt_flow_exits x WHERE x.almacen=l.almacen),0)/1000,3),
  'closing_stock_tn', round(COALESCE(sum(l.kg_saldo),0)/1000,3),
  'reconstruction_difference_tn', round((COALESCE(sum(l.kg_in),0)-COALESCE((SELECT sum(x.kg) FROM public.apt_flow_exits x WHERE x.almacen=l.almacen),0)-COALESCE(sum(l.kg_saldo),0))/1000,3),
  'difference_is_physical_reconciliation', false)
FROM public.apt_flow_layers l GROUP BY l.almacen
UNION ALL
SELECT 'apt_origin_quality', jsonb_build_object(
  'closing_stock_tn', round(COALESCE(sum(kg),0)/1000,3),
  'unknown_origin_tn', round(COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NULL),0)/1000,3),
  'inferred_opening_remaining_tn', round(COALESCE(sum(kg) FILTER(WHERE origen LIKE 'INICIAL%'),0)/1000,3),
  'known_origin_tn', round(COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL),0)/1000,3))
FROM public.apt_flow_pieces WHERE es_saldo
UNION ALL
SELECT 'apt_model_differences', jsonb_build_object(
  'estadia_stock_tn', (SELECT round(COALESCE(sum(kg_saldo),0)/1000,3) FROM public.apt_layers),
  'flow_stock_tn', (SELECT round(COALESCE(sum(kg_saldo),0)/1000,3) FROM public.apt_flow_layers),
  'flow_production_origin_stock_tn', (SELECT round(COALESCE(sum(kg),0)/1000,3) FROM public.apt_flow_pieces WHERE es_saldo AND origen='PRODUCCION'),
  'same_scope', false,
  'reason', 'Estadia excluye consumos y otros egresos; flujo agrega apertura inferida y separa almacenes')
UNION ALL
SELECT 'apt_temporal_exceptions', jsonb_build_object(
  'allocations_before_entry', count(*) FILTER(WHERE fecha_salida<fecha_ingreso),
  'allocated_before_entry_tn', round(COALESCE(sum(kg) FILTER(WHERE fecha_salida<fecha_ingreso),0)/1000,3),
  'unknown_allocation_dates', count(*) FILTER(WHERE fecha_salida IS NULL OR fecha_ingreso IS NULL))
FROM public.apt_allocations
UNION ALL
SELECT 'apt_residuals', jsonb_build_object(
  'estadia_dispatched_with_stock_rows', count(*) FILTER(WHERE estado='Despachado' AND kg_saldo>0.0005),
  'estadia_dispatched_with_stock_tn', round(COALESCE(sum(kg_saldo) FILTER(WHERE estado='Despachado' AND kg_saldo>0.0005),0)/1000,3),
  'problem_flag_rows', count(*) FILTER(WHERE problema_info),
  'problem_flag_without_problem_status_rows', count(*) FILTER(WHERE problema_info AND estado IS DISTINCT FROM 'Problema de información'))
FROM public.apt_layers
UNION ALL
SELECT 'apt_internal_transfer_totals', jsonb_build_object(
  'transfer_ingress_tn', (SELECT round(COALESCE(sum(kg_in),0)/1000,3) FROM public.apt_flow_layers WHERE tipo='TRASPASO'),
  'transfer_egress_tn', (SELECT round(COALESCE(sum(kg),0)/1000,3) FROM public.apt_flow_exits WHERE tipo='TRASPASO'),
  'not_external_production_or_dispatch', true)
UNION ALL
SELECT 'apt_query_cardinality' AS section,jsonb_build_object(
 'layers',(SELECT count(*) FROM public.apt_flow_layers),
 'exits',(SELECT count(*) FROM public.apt_flow_exits),
 'pieces',(SELECT count(*) FROM public.apt_flow_pieces),
 'movements',(SELECT count(*) FROM public.apt_movements),
 'allocations',(SELECT count(*) FROM public.apt_allocations),
 'distinct_inventory_keys',(SELECT count(*) FROM (SELECT DISTINCT almacen,lote,producto FROM public.apt_flow_layers UNION SELECT DISTINCT almacen,lote,producto FROM public.apt_flow_exits) k),
 'table_statistics',(SELECT jsonb_agg(jsonb_build_object('table',relname,'estimated_rows',n_live_tup,'last_analyze',last_analyze,'last_autoanalyze',last_autoanalyze)) FROM pg_stat_user_tables WHERE schemaname='public' AND relname LIKE 'apt_%')
) AS finding
UNION ALL
SELECT 'apt_kardex_source_scope' AS section,jsonb_build_object(
 'almacen',COALESCE(m.almacen,'647'),
 'excluded_rows',count(*),
 'excluded_signed_tn',round(sum(CASE WHEN m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION') THEN 1 ELSE -1 END * COALESCE(m.peso_kg,0))/1000,6),
 'missing_product_rows',count(*) FILTER(WHERE m.producto IS NULL),
 'nonpositive_weight_rows',count(*) FILTER(WHERE m.peso_kg<=0),
 'negative_weight_tn',round(COALESCE(sum(m.peso_kg) FILTER(WHERE m.peso_kg<0),0)/1000,6),
 'unsupported_kind_rows',count(*) FILTER(WHERE m.kind NOT IN ('ENTRADA','SALIDA','TRASPASO_ENT','TRASPASO_SAL','CONSUMO','DEVOLUCION'))
) AS finding
FROM public.apt_movements m CROSS JOIN public.apt_flow_state s
WHERE s.id=1 AND m.active AND m.valid AND m.fecha<=s.cutoff AND m.lote IS NOT NULL
 AND (m.almacen IS NOT NULL OR m.kind='ENTRADA')
 AND (m.producto IS NULL OR m.peso_kg<=0 OR m.peso_kg IS NULL OR m.kind NOT IN ('ENTRADA','SALIDA','TRASPASO_ENT','TRASPASO_SAL','CONSUMO','DEVOLUCION'))
GROUP BY COALESCE(m.almacen,'647')
UNION ALL
SELECT 'apt_kardex_model_membership' AS section,jsonb_build_object(
 'kind',m.kind,'source_rows',count(*),
 'missing_model_rows',count(*) FILTER(WHERE CASE WHEN m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION') THEN l.id IS NULL ELSE x.id IS NULL END),
 'source_tn',round(sum(m.peso_kg)/1000,6),
 'model_tn',round(sum(CASE WHEN m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION') THEN l.kg_in ELSE x.kg END)/1000,6)
) AS finding
FROM public.apt_movements m CROSS JOIN public.apt_flow_state s
LEFT JOIN public.apt_flow_layers l ON l.id=m.id AND m.kind IN ('ENTRADA','TRASPASO_ENT','DEVOLUCION')
LEFT JOIN public.apt_flow_exits x ON x.id=m.id AND m.kind IN ('SALIDA','TRASPASO_SAL','CONSUMO')
WHERE s.id=1 AND m.active AND m.valid AND m.fecha<=s.cutoff AND m.lote IS NOT NULL AND m.producto IS NOT NULL AND m.peso_kg>0
 AND (m.almacen IS NOT NULL OR m.kind='ENTRADA')
GROUP BY m.kind
UNION ALL
SELECT 'apt_kardex_obsolete_model' AS section,jsonb_build_object(
 'inactive_or_missing_layer_rows',(SELECT count(*) FROM public.apt_flow_layers l LEFT JOIN public.apt_movements m ON m.id=l.id WHERE l.tipo<>'INICIAL' AND (m.id IS NULL OR NOT m.active OR NOT m.valid)),
 'inactive_or_missing_exit_rows',(SELECT count(*) FROM public.apt_flow_exits x LEFT JOIN public.apt_movements m ON m.id=x.id WHERE m.id IS NULL OR NOT m.active OR NOT m.valid)
) AS finding;
ROLLBACK;
