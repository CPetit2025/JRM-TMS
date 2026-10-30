-- C171: servicios especiales (Etapa 2) — costo acordado por proveedor, categorías de grúa y estiba e historial de costos
-- solo de inserción, instalados y protegidos.
BEGIN;
DO $$
BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='transport_unloading_costs'
     AND column_name IN ('supplier_id','billing_unit','agreed_rate','agreed_qty','workers','min_billable_qty','fraction_minutes','agreed_reason','agreed_by','agreed_at'))<>10 THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: faltan columnas del costo acordado';
 END IF;
 IF position('''GRUA''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.suppliers'::regclass AND conname='suppliers_category_check')))=0
  OR position('''ESTIBA''' IN pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conrelid='public.suppliers'::regclass AND conname='suppliers_category_check')))=0 THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: faltan las categorías de proveedor GRUA y ESTIBA';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conname='transport_unloading_costs_supplier_fk' AND c.convalidated
   AND EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.conrelid AND i.indisvalid AND i.indpred IS NULL AND (i.indkey::smallint[])[0:cardinality(c.conkey)-1] @> c.conkey)) THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: FK del proveedor sin índice completo';
 END IF;
 IF to_regclass('public.service_cost_events') IS NULL
  OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.service_cost_events'::regclass)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.service_cost_events'::regclass AND tgname='service_cost_events_append_only' AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.transport_unloading_costs'::regclass AND tgname='log_unloading_cost_change' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: historial de costos sin RLS o sin disparadores';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE agreed_rate IS NOT NULL AND (supplier_id IS NULL OR billing_unit IS NULL)) THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: costo acordado sin proveedor o modalidad';
 END IF;
 IF position('set_special_service_agreements' IN pg_get_functiondef('public.schedule_route_resources(jsonb)'::regprocedure))=0
  OR position('inherit_route_unloading' IN pg_get_functiondef('public.schedule_route_resources(jsonb)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: la programación no registra los costos acordados';
 END IF;
 IF has_table_privilege('authenticated','public.service_cost_events','SELECT')
  OR has_table_privilege('authenticated','public.service_cost_events','INSERT')
  OR has_function_privilege('anon','public.set_special_service_agreements(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.service_cost_history(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.log_unloading_cost_change()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C171 FAIL: acceso directo al historial o a funciones internas';
 END IF;
 RAISE EXCEPTION 'CAJA C171 PASS: costo acordado por proveedor, grúa y estiba e historial de costos protegidos';
END $$;
ROLLBACK;
