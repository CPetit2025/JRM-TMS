-- Alta de Contrato / OT: registrar el cliente sin salir del modal. Quien puede crear OT (create_contract) puede
-- registrar al cliente aunque no tenga el módulo Clientes. Si el RUC ya existe, devuelve ese cliente (y lo reactiva)
-- en lugar de duplicarlo; el RUC lo valida el disparador clients_tax_id_guard (dígito verificador SUNAT).
CREATE OR REPLACE FUNCTION public.register_contract_client(p_tax_id text, p_business_name text, p_address text DEFAULT NULL,
  p_contact_name text DEFAULT NULL, p_phone text DEFAULT NULL, p_email text DEFAULT NULL, p_sunat_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tax text := public.client_tax_id_norm(p_tax_id); v_name text := NULLIF(btrim(COALESCE(p_business_name, '')), '');
  v_row jsonb; v_id uuid; v_data jsonb; v_cols text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar clientes');
  END IF;
  IF v_tax IS NULL OR length(v_tax) NOT IN (8, 11) THEN RETURN jsonb_build_object('success', false, 'error', 'El RUC debe tener 11 dígitos (o DNI de 8)'); END IF;
  -- Producción no coincide con el repo (tax_id/ruc, is_active): se lee y escribe solo lo que existe.
  SELECT to_jsonb(c) INTO v_row FROM public.clients c
   WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_tax
   ORDER BY COALESCE((to_jsonb(c)->>'is_active')::boolean, true) DESC LIMIT 1;
  IF v_row IS NOT NULL THEN
    v_id := (v_row->>'id')::uuid;
    IF (v_row->>'is_active') = 'false' THEN EXECUTE 'UPDATE public.clients SET is_active = true WHERE id = $1' USING v_id; END IF;
    RETURN jsonb_build_object('success', true, 'existing', true, 'id', v_id, 'business_name', v_row->>'business_name',
      'tax_id', COALESCE(v_row->>'tax_id', v_row->>'ruc'));
  END IF;
  IF v_name IS NULL OR length(v_name) > 300 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese la razón social'); END IF;
  v_data := jsonb_strip_nulls(jsonb_build_object('business_name', v_name, 'tax_id', v_tax, 'ruc', v_tax,
    'address', NULLIF(btrim(COALESCE(p_address, '')), ''), 'contact_name', NULLIF(btrim(COALESCE(p_contact_name, '')), ''),
    'phone', NULLIF(btrim(COALESCE(p_phone, '')), ''), 'email', NULLIF(btrim(COALESCE(p_email, '')), ''), 'is_active', true,
    'sunat_status', NULLIF(btrim(COALESCE(p_sunat_status, '')), ''),
    'sunat_verified_at', CASE WHEN NULLIF(btrim(COALESCE(p_sunat_status, '')), '') IS NOT NULL THEN now() END));
  SELECT string_agg(quote_ident(k), ',') INTO v_cols FROM jsonb_object_keys(v_data) k
   WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = k);
  EXECUTE format('INSERT INTO public.clients(%s) SELECT %s FROM jsonb_populate_record(NULL::public.clients, $1) RETURNING id', v_cols, v_cols)
    INTO v_id USING v_data;
  RETURN jsonb_build_object('success', true, 'existing', false, 'id', v_id, 'business_name', v_name, 'tax_id', v_tax);
EXCEPTION WHEN raise_exception OR unique_violation OR check_violation OR not_null_violation THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.register_contract_client(text,text,text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_contract_client(text,text,text,text,text,text,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
