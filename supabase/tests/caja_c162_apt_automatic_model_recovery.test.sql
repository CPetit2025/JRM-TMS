BEGIN;
DO $$
BEGIN
 IF to_regprocedure('public.apt_models_ensure_current_core(text)') IS NULL THEN
  RAISE EXCEPTION 'CAJA C162 FAIL: falta recuperación automática APT'; END IF;
 IF has_function_privilege('authenticated','public.apt_models_ensure_current_core(text)','EXECUTE')
 OR has_function_privilege('anon','public.apt_models_ensure_current_core(text)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.apt_models_ensure_current_core(text)','EXECUTE') THEN
  RAISE EXCEPTION 'CAJA C162 FAIL: permisos incorrectos de recuperación APT'; END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname IN ('apt-modelo-estadia','apt-modelo-flujo') AND active AND schedule='* * * * *')<>2 THEN
  RAISE EXCEPTION 'CAJA C162 FAIL: falta programación automática de ambos modelos'; END IF;
 RAISE EXCEPTION 'CAJA C162 PASS: recuperación APT programada y protegida; estadia_actualizada=%, flujo_actualizado=%',
  (SELECT rebuilt_at IS NOT NULL AND COALESCE(rebuilt_at>=(SELECT max(applied_at) FROM public.apt_uploads WHERE status='APLICADA'),true) FROM public.apt_state WHERE id=1),
  (SELECT rebuilt_at IS NOT NULL AND COALESCE(rebuilt_at>=(SELECT max(applied_at) FROM public.apt_uploads WHERE status='APLICADA'),true) FROM public.apt_flow_state WHERE id=1);
END $$;
ROLLBACK;
