-- C175: sustento del acordado al programar y unidades de cobro UNIDAD y TONELADA (Etapa D).
BEGIN;
DO $$
DECLARE v_check text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO v_check FROM pg_constraint
 WHERE conrelid='public.transport_unloading_costs'::regclass AND conname='transport_unloading_costs_agreement_check';
 IF v_check IS NULL OR position('TONELADA' IN v_check)=0 OR position('UNIDAD' IN v_check)=0 OR position('fraction_minutes' IN v_check)=0
  OR position('workers' IN v_check)=0 THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: la regla del acuerdo no admite UNIDAD/TONELADA o perdió sus demás condiciones';
 END IF;
 IF public.economic_billable_qty('TONELADA',4,NULL,5)<>5 OR public.economic_billable_qty('TONELADA',12.75,30,5)<>12.75
  OR public.economic_billable_qty('UNIDAD',0,NULL,5)<>0 OR public.economic_billable_qty('HORA',2.25,30,3)<>3 THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: cantidad facturable por unidad o tonelada incorrecta';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_freight_stages' AND column_name='agreed_reason') THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: falta el motivo del flete acordado';
 END IF;
 IF position('freight_reason' IN (SELECT prosrc FROM pg_proc WHERE oid='public.schedule_route_resources(jsonb)'::regprocedure))=0
  OR position('inherit_route_unloading' IN (SELECT prosrc FROM pg_proc WHERE oid='public.schedule_route_resources(jsonb)'::regprocedure))=0
  OR position('set_special_service_agreements' IN (SELECT prosrc FROM pg_proc WHERE oid='public.schedule_route_resources(jsonb)'::regprocedure))=0
  OR position('v_referential' IN (SELECT prosrc FROM pg_proc WHERE oid='public.set_special_service_agreements(uuid,jsonb)'::regprocedure))=0
  OR position('agreed_reason' IN (SELECT prosrc FROM pg_proc WHERE oid='public.dispatch_freight_stage_sync()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: la programación no exige el motivo del acordado o del flete';
 END IF;
 IF EXISTS(SELECT 1 FROM public.transport_unloading_costs WHERE billing_unit IN ('UNIDAD','TONELADA') AND (concept='MONTACARGAS' OR fraction_minutes IS NOT NULL OR workers IS NOT NULL)) THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: acuerdo por unidad o tonelada con montacarga, fracción o trabajadores';
 END IF;
 IF has_function_privilege('anon','public.schedule_route_resources(jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.set_special_service_agreements(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.validate_service_final(uuid,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.dispatch_freight_stage_sync()','EXECUTE')
  OR has_table_privilege('authenticated','public.dispatch_freight_stages','SELECT') THEN
  RAISE EXCEPTION 'CAJA C175 FAIL: acceso indebido a la programación de costos';
 END IF;
 RAISE EXCEPTION 'CAJA C175 PASS: motivo del acordado y del flete al programar; cobro por unidad y tonelada';
END $$;
ROLLBACK;
