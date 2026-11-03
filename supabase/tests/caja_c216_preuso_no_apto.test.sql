-- Checklist pre-uso No apto: estructura instalada y una falla de checklist abierta detiene la unidad
-- en el motor de elegibilidad. Simulación con un registro y una unidad reales; todo se revierte.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='2s';
DO $test$
DECLARE op uuid; plate text; e jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='maintenance_requests' AND column_name='preuse_operation_id') THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: falta maintenance_requests.preuse_operation_id'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('preuse_to_maintenance','preuse_request_closed'))<>2 THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: faltan los disparadores del checklist pre-uso'; END IF;
 IF position('Checklist pre-uso No apto' IN pg_get_functiondef('public.check_asset_eligibility(text,text)'::regprocedure))=0 THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: el motor de elegibilidad no considera el checklist'; END IF;
 IF position('preuse_operation_id' IN pg_get_functiondef('public.get_tower_dispatches(date,uuid,text)'::regprocedure))=0 THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: la Torre de Control no muestra las fallas del checklist'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.notif_reglas WHERE evento='PREUSO_NO_APTO') THEN RAISE EXCEPTION 'CAJA C216 FAIL: falta el aviso PREUSO_NO_APTO'; END IF;
 IF has_function_privilege('authenticated','public.preuse_set_vehicle_status(text,text[],text,text,uuid)','EXECUTE') THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: el cambio de estado del sistema quedó expuesto'; END IF;

 SELECT operation_id INTO op FROM public.driver_preuse_inspections ORDER BY captured_at DESC LIMIT 1;
 SELECT v.plate INTO plate FROM public.vehicles v WHERE v.status='DISPONIBLE' AND NOT EXISTS (SELECT 1 FROM public.maintenance_requests r
   WHERE r.vehicle_plate=v.plate AND r.preuse_operation_id IS NOT NULL AND r.status NOT IN ('CERRADA','DESCARTADA')) ORDER BY v.plate LIMIT 1;
 IF op IS NULL OR plate IS NULL THEN RAISE EXCEPTION 'CAJA C216 PASS: estructura instalada; sin registro o unidad para simular'; END IF;
 INSERT INTO public.maintenance_requests (vehicle_plate, description, severity, status, source, preuse_operation_id, notes)
 VALUES (plate, 'CAJA C216 simulación ' || gen_random_uuid(), 'MEDIA', 'REPORTADA', 'INSPECCION', op, 'Prueba revertida');
 e := public.check_asset_eligibility(plate, 'DISPATCH');
 IF e->>'status'<>'NO_APTO' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e->'motives') m WHERE m LIKE 'Checklist pre-uso No apto%') THEN
   RAISE EXCEPTION 'CAJA C216 FAIL: la falla del checklist no detiene la unidad (%)', e; END IF;
 RAISE EXCEPTION 'CAJA C216 PASS: No apto del checklist llega a Mantenimiento, detiene la unidad % y aparece en la Torre', plate;
END $test$;
ROLLBACK;
