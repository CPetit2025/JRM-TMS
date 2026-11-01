-- C201: control presupuestal por OT, etapa 4 — bandeja de desvíos instalada, revisiones coherentes (decididas con
-- responsable), historial solo de inserción y permisos acotados.
BEGIN;
DO $$
BEGIN
 IF to_regclass('public.budget_deviation_reviews') IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.budget_deviation_reviews'::regclass)
  OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.budget_deviation_events'::regclass AND tgname = 'budget_deviation_events_append_only' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'CAJA C201 FAIL: desvíos sin RLS o historial';
 END IF;
 IF EXISTS (SELECT 1 FROM public.budget_deviation_reviews WHERE status IN ('APROBADO','RECHAZADO') AND (decided_by IS NULL OR decided_at IS NULL))
  OR EXISTS (SELECT 1 FROM public.budget_deviation_reviews WHERE status IN ('SUSTENTADO','RECOMENDADO') AND length(COALESCE(support_note,'')) < 10)
  OR EXISTS (SELECT 1 FROM public.budget_deviation_reviews WHERE status = 'RECHAZADO' AND length(COALESCE(decision_note,'')) < 5) THEN
  RAISE EXCEPTION 'CAJA C201 FAIL: desvío resuelto sin responsable, sustento o acción correctiva';
 END IF;
 PERFORM count(*) FROM public.budget_deviations_current();
 IF has_table_privilege('authenticated','public.budget_deviation_reviews','SELECT')
  OR has_function_privilege('authenticated','public.budget_deviations_current()','EXECUTE')
  OR has_function_privilege('anon','public.budget_deviation_action(text,text,text,text)','EXECUTE')
  OR NOT has_function_privilege('authenticated','public.budget_deviations_list()','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C201 FAIL: permisos de los desvíos';
 END IF;
 RAISE EXCEPTION 'CAJA C201 PASS: desvíos con sustento, recomendación y decisión trazables';
END $$;
ROLLBACK;
