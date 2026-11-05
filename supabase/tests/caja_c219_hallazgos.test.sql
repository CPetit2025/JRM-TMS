-- C219: Hallazgos de auditoría de despacho (F1) instalados: tablas con RLS y sin escritura directa, bucket privado sin
-- borrado de evidencias registradas, categorías iniciales, avisos personales y permisos de los roles base.
BEGIN;
DO $$
DECLARE v_t text; v_n int;
BEGIN
 FOREACH v_t IN ARRAY ARRAY['audit_finding_categories','audit_findings','audit_finding_category_links','audit_finding_corrections',
  'audit_finding_evidence','audit_finding_events'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=v_t AND c.relrowsecurity) THEN
   RAISE EXCEPTION 'CAJA C219 FAIL: % sin RLS', v_t; END IF;
  IF has_table_privilege('authenticated','public.'||v_t,'INSERT') OR has_table_privilege('authenticated','public.'||v_t,'UPDATE')
   OR has_table_privilege('authenticated','public.'||v_t,'DELETE') OR has_table_privilege('anon','public.'||v_t,'SELECT') THEN
   RAISE EXCEPTION 'CAJA C219 FAIL: % admite escritura directa o acceso anónimo', v_t; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='audit_findings' AND NOT public) THEN RAISE EXCEPTION 'CAJA C219 FAIL: bucket audit_findings ausente o público'; END IF;
 SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE 'audit_findings_obj_%';
 IF v_n<>3 THEN RAISE EXCEPTION 'CAJA C219 FAIL: políticas de Storage de hallazgos incompletas (%)', v_n; END IF;
 IF position('audit_finding_object_unregistered' IN (SELECT qual FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='audit_findings_obj_cleanup'))=0 THEN
  RAISE EXCEPTION 'CAJA C219 FAIL: las evidencias registradas se pueden borrar'; END IF;
 SELECT count(*) INTO v_n FROM public.audit_finding_categories WHERE active;
 IF v_n<12 OR NOT EXISTS(SELECT 1 FROM public.audit_finding_categories WHERE code='ESTIBA_SEGURIDAD' AND is_safety) THEN
  RAISE EXCEPTION 'CAJA C219 FAIL: categorías iniciales incompletas'; END IF;
 IF position('HALLAZGO_ASIGNADO' IN pg_get_functiondef('public.notif_can_see_event(text,text[],uuid)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C219 FAIL: el aviso de hallazgo asignado no es personal'; END IF;
 IF position('Quien registró la corrección no puede validarla' IN pg_get_functiondef('public.audit_finding_validate(uuid,text,text,text)'::regprocedure))=0
  OR position('foto de subsanación' IN pg_get_functiondef('public.audit_finding_validate(uuid,text,text,text)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'CAJA C219 FAIL: la validación no separa funciones o no exige foto de subsanación'; END IF;
 IF has_function_privilege('anon','public.audit_finding_create(jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.audit_finding_log(uuid,text,text,text,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C219 FAIL: funciones de hallazgos expuestas'; END IF;
 SELECT count(*) INTO v_n FROM public.audit_findings;
 RAISE EXCEPTION 'CAJA C219 PASS: hallazgos de auditoría instalados · hallazgos registrados: %', v_n;
END $$;
ROLLBACK;
