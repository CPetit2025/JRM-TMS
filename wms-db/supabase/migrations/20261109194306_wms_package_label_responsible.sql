-- Identidad ya registrada por wh_label_package/wh_count_label con auth.uid().
-- Solo se expone el nombre del creador de los bultos que el usuario puede consultar.
CREATE OR REPLACE FUNCTION public.wh_package_label_responsibles(p_package_codes text[])
RETURNS TABLE(package_code text, responsible_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga','almacen-etiquetado']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar responsables de etiquetas' USING ERRCODE = '42501';
  END IF;
  IF coalesce(cardinality(p_package_codes),0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Consulta de responsables de etiquetas inválida';
  END IF;
  RETURN QUERY
    SELECT wp.package_code, nullif(btrim(concat_ws(' ',nullif(btrim(p.first_name),''),nullif(btrim(p.last_name),''))), '')
    FROM public.wh_packages wp LEFT JOIN public.profiles p ON p.id = wp.created_by
    WHERE wp.package_code = ANY(p_package_codes) AND public.can_access_site(wp.site_id);
END;
$$;
REVOKE ALL ON FUNCTION public.wh_package_label_responsibles(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_package_label_responsibles(text[]) TO authenticated;
NOTIFY pgrst, 'reload schema';
