-- Reintenta modelos derivados aunque el navegador se cierre tras aplicar una carga.
-- Cada modelo tiene su propia transacción y cron: un fallo de FIFO no bloquea el flujo.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_models_ensure_current_core(p_model text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_applied timestamptz; v_settings timestamptz; v_rebuilt timestamptz;
 v_target date; v_cut date; v_result jsonb;
BEGIN
 IF p_model IS NULL OR p_model NOT IN ('estadia','flujo') THEN RAISE EXCEPTION 'Modelo APT inválido'; END IF;
 -- Nunca competir con un reemplazo o cálculo en curso ni acumular esperas del cron.
 IF NOT pg_try_advisory_xact_lock(hashtext('apt_rebuild')) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'busy',true); END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('apt_flow_rebuild')) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'busy',true); END IF;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT NULLIF(to_jsonb(s)->>'updated_at','')::timestamptz INTO v_settings FROM public.apt_settings s WHERE id=1;
 SELECT COALESCE((SELECT cutoff_date FROM public.apt_settings WHERE id=1),max(fecha))
 INTO v_target FROM public.apt_movements WHERE active AND valid;
 IF p_model='estadia' THEN
  SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_state WHERE id=1;
 ELSE
  SELECT rebuilt_at,cutoff INTO v_rebuilt,v_cut FROM public.apt_flow_state WHERE id=1;
 END IF;
 IF v_cut IS NOT DISTINCT FROM v_target AND v_rebuilt IS NOT NULL
  AND (v_applied IS NULL OR v_rebuilt>=v_applied) AND (v_settings IS NULL OR v_rebuilt>=v_settings) THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'cutoff',v_cut); END IF;
 IF v_target IS NULL AND v_rebuilt IS NULL AND v_applied IS NULL THEN
  RETURN jsonb_build_object('success',true,'rebuilt',false,'empty',true); END IF;
 IF p_model='estadia' THEN v_result:=public.apt_rebuild();
 ELSE v_result:=public.apt_flow_rebuild_core(); END IF;
 IF (v_result->>'success')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'No se pudo actualizar automáticamente APT (%): %',p_model,v_result;
 END IF;
 RETURN v_result||jsonb_build_object('rebuilt',true);
END $$;
REVOKE ALL ON FUNCTION public.apt_models_ensure_current_core(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apt_models_ensure_current_core(text) TO service_role;
-- PLATFORM_CRON_BEGIN: Supabase provisiona pg_cron; el arnés local prueba directamente el trabajador.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='apt-modelo-estadia') THEN PERFORM cron.unschedule('apt-modelo-estadia'); END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='apt-modelo-flujo') THEN PERFORM cron.unschedule('apt-modelo-flujo'); END IF;
END $$;
SELECT cron.schedule('apt-modelo-estadia','* * * * *',$job$SET statement_timeout='5min'; SELECT public.apt_models_ensure_current_core('estadia');$job$);
SELECT cron.schedule('apt-modelo-flujo','* * * * *',$job$SET statement_timeout='5min'; SELECT public.apt_models_ensure_current_core('flujo');$job$);
-- PLATFORM_CRON_END
NOTIFY pgrst,'reload schema';
COMMIT;
