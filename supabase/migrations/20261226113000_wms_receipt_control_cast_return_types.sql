BEGIN;

CREATE OR REPLACE FUNCTION public.wh_receipt_control_operators(p_source_movement_keys text[])
RETURNS TABLE (
  source_movement_key text,
  validated_by uuid,
  validated_at timestamptz,
  first_name text,
  last_name text,
  username text,
  customer_name text
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
  SELECT rv.source_movement_key::text,
         rv.validated_by::uuid,
         rv.validated_at::timestamptz,
         p.first_name::text,
         p.last_name::text,
         p.username::text,
         coalesce(
           nullif(s.customer_name,'')::text,
           lookup.lot_customer::text,
           lookup.contract_customer::text,
           nullif(rv.manual_customer_name,'')::text
         )::text AS customer_name
  FROM public.wh_receipt_validations rv
  JOIN (
    SELECT DISTINCT ON (wp.source_movement_key)
      wp.source_movement_key,wp.site_id,wp.source_document_no,wp.source_contract_code,wp.source_lot,wp.source_product_code
    FROM public.wh_packages wp
    WHERE wp.source_movement_key=ANY(p_source_movement_keys)
      AND wp.site_id=v_site AND wp.source_system='ERP'
      AND wp.status<>'VOID' AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  ) wp ON wp.source_movement_key=rv.source_movement_key AND wp.site_id=rv.site_id
  LEFT JOIN public.profiles p ON p.id=rv.validated_by
  LEFT JOIN LATERAL (
    SELECT rs.customer_name,rs.contract_code,rs.lot
    FROM public.wh_receipt_sources rs
    WHERE rs.active
      AND rs.document_no=wp.source_document_no
      AND rs.product_code=wp.source_product_code
      AND coalesce(rs.lot,'')=wp.source_lot
    ORDER BY rs.updated_at DESC
    LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT
      nullif(public.inv_ot_cliente(nullif(public.apt_ot_raiz(coalesce(s.lot,wp.source_lot)),'')),'')::text AS lot_customer,
      nullif(public.inv_ot_cliente(nullif(public.inv_ot(coalesce(s.contract_code,wp.source_contract_code)),'')),'')::text AS contract_customer
  ) lookup ON true
  WHERE rv.source_movement_key=ANY(p_source_movement_keys)
    AND rv.site_id=v_site
    AND public.can_access_site(rv.site_id)
  GROUP BY rv.source_movement_key,rv.validated_by,rv.validated_at,p.first_name,p.last_name,p.username,
           s.customer_name,lookup.lot_customer,lookup.contract_customer,rv.manual_customer_name
  ORDER BY rv.validated_at DESC;
END
$$;

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
      AND wp.label_print_count>0
    ORDER BY wp.source_movement_key,wp.sequence_no
  )
  SELECT pk.source_movement_key::text,
         coalesce(
           nullif(rs.customer_name,'')::text,
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

REVOKE ALL ON FUNCTION public.wh_receipt_control_operators(text[]),public.wh_receipt_control_customers(text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.wh_receipt_control_operators(text[]),public.wh_receipt_control_customers(text[]) TO authenticated;
NOTIFY pgrst,'reload schema';

COMMIT;
