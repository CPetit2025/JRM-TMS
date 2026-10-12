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
  'not_external_production_or_dispatch', true);

-- Exercise the actual reader with an existing authorized account. Only session-local
-- claims are set; profiles, roles and inventory remain untouched and no identity is published.
DO $$
DECLARE actor uuid;
BEGIN
 SELECT p.id INTO actor FROM public.profiles p JOIN public.roles r ON r.id=p.role_id
 WHERE p.is_active AND p.id IN(SELECT id FROM auth.users)
 AND (r.name='Administrador' OR r.permissions ?| ARRAY['apt','apt:read','apt:write','apt-carga','apt-carga:write'])
 ORDER BY p.id LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'No authorized APT account available for read-only performance verification'; END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
END $$;
WITH started AS MATERIALIZED (SELECT clock_timestamp() AS at),
 measured AS MATERIALIZED (SELECT at,public.apt_operational_summary('{"limit":25,"offset":0}') AS result FROM started)
SELECT 'apt_operational_performance' AS section,jsonb_build_object(
 'elapsed_ms',round((extract(epoch FROM clock_timestamp()-at)*1000)::numeric,1),
 'success',result->'success','error',result->'error','total',result->'total',
 'returned_rows',jsonb_array_length(result->'rows'),'meta',result->'meta',
 'kpis',result->'kpis','quality',result->'quality',
 'personal_data_published',false) AS finding FROM measured;

ROLLBACK;
