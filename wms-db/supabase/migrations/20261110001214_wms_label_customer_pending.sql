-- Clientes disponibles antes de la primera impresión; misma resolución por lote que Recepción.
CREATE OR REPLACE FUNCTION public.wh_receipt_control_customers(p_source_movement_keys text[])
RETURNS TABLE (source_movement_key text, customer_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_site uuid := public.primary_site_id();
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-etiquetado','almacen-supervisor']) THEN
    RAISE EXCEPTION 'Sin permiso para consultar clientes de recepción' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_source_movement_keys),0) NOT BETWEEN 1 AND 100 OR
     v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RAISE EXCEPTION 'Consulta de clientes de recepción inválida';
  END IF;

  RETURN QUERY
  WITH package_keys AS (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,
      wp.source_contract_code,
      wp.source_lot
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site
      AND wp.source_system='ERP'
      AND wp.status<>'VOID'
    ORDER BY wp.source_movement_key,wp.sequence_no
  )
  SELECT pk.source_movement_key::text,
         coalesce(
           nullif(rs.customer_name,'')::text,
           nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(coalesce(nullif(rs.lot,''),pk.source_lot)),'')),'')::text,
           nullif(public.inv_ot_cliente(public.inv_ot(coalesce(nullif(rs.contract_code,''),nullif(rs.origin_number,''),pk.source_contract_code))),'')::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM package_keys pk
  LEFT JOIN public.wh_receipt_sources rs
    ON rs.source_key=pk.source_movement_key
   AND rs.site_id=v_site
   AND rs.active
  LEFT JOIN LATERAL (
    SELECT validation.manual_customer_name
    FROM public.wh_receipt_validations validation
    WHERE validation.source_movement_key=pk.source_movement_key
      AND validation.site_id=v_site
    ORDER BY validation.validated_at DESC,validation.id DESC
    LIMIT 1
  ) rv ON true
  WHERE public.can_access_site(v_site)
  ORDER BY pk.source_movement_key;
END
$$;

REVOKE ALL ON FUNCTION public.wh_receipt_control_customers(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_control_customers(text[]) TO authenticated;
NOTIFY pgrst,'reload schema';
