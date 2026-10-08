-- Versión de los datos APT para la caché de lecturas del navegador: cambia solo cuando se aplica o
-- descarta una carga, se recalcula la estadía o el flujo, o se guardan parámetros. Mientras no cambie,
-- las pantallas de /apt reutilizan sus resultados en lugar de recalcular al cambiar de vista.
CREATE OR REPLACE FUNCTION public.apt_data_version()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al módulo APT'); END IF;
  RETURN jsonb_build_object('success', true, 'version', concat_ws('|',
    (SELECT count(*) || ':' || COALESCE(max(applied_at)::text, '-') FROM public.apt_uploads WHERE status = 'APLICADA'),
    (SELECT COALESCE(max(rebuilt_at)::text, '-') FROM public.apt_state),
    (SELECT COALESCE(max(rebuilt_at)::text, '-') FROM public.apt_flow_state),
    (SELECT COALESCE(max(to_jsonb(s)->>'updated_at'), '-') FROM public.apt_settings s)));
END $$;
REVOKE ALL ON FUNCTION public.apt_data_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apt_data_version() TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
