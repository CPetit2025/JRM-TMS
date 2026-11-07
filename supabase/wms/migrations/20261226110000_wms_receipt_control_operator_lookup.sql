BEGIN;

CREATE OR REPLACE FUNCTION public.wh_receipt_control_operators(p_source_movement_keys text[])
RETURNS TABLE (
  source_movement_key text,
  validated_by uuid,
  validated_at timestamptz,
  first_name text,
  last_name text,
  username text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar responsables de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de responsables de recepción inválida';
  END IF;

  RETURN QUERY
  SELECT rv.source_movement_key,rv.validated_by,rv.validated_at,
         p.first_name,p.last_name,p.username
  FROM public.wh_receipt_validations rv
  JOIN public.wh_packages wp
    ON wp.source_movement_key=rv.source_movement_key
   AND wp.site_id=rv.site_id
   AND wp.source_system='ERP'
   AND wp.status<>'VOID'
   AND wp.label_print_count>0
  LEFT JOIN public.profiles p ON p.id=rv.validated_by
  WHERE rv.source_movement_key=ANY(p_source_movement_keys)
    AND rv.site_id=v_site
    AND public.can_access_site(rv.site_id)
  GROUP BY rv.source_movement_key,rv.validated_by,rv.validated_at,p.first_name,p.last_name,p.username
  ORDER BY rv.validated_at DESC;
END
$$;

REVOKE ALL ON FUNCTION public.wh_receipt_control_operators(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_control_operators(text[]) TO authenticated;
NOTIFY pgrst,'reload schema';

COMMIT;
