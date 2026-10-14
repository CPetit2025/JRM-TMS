-- Clientes extranjeros (Bolivia, Colombia, etc.): país + documento tributario de su país (NIT, RUT, RUC extranjero),
-- sin consulta a SUNAT. Los clientes peruanos siguen igual: RUC de 11 dígitos con dígito verificador o DNI de 8.
-- country_code vacío o 'PE' = Perú. El documento extranjero se guarda en tax_id (letras y números, sin espacios ni
-- signos) y no se repite dentro del mismo país.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS country_name text;

CREATE OR REPLACE FUNCTION public.client_foreign_tax_norm(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(upper(regexp_replace(COALESCE(p_value, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.clients_tax_id_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_country text := NULLIF(upper(btrim(COALESCE(to_jsonb(NEW)->>'country_code', ''))), '');
  v_new  text := public.client_tax_id_norm(COALESCE(to_jsonb(NEW)->>'tax_id', to_jsonb(NEW)->>'ruc'));
  v_old  text;
  v_dup  text;
BEGIN
  -- Cliente extranjero: documento de su país, sin dígito verificador SUNAT; único dentro del mismo país
  IF v_country IS NOT NULL AND v_country <> 'PE' THEN
    IF v_country !~ '^[A-Z]{2}$' THEN RAISE EXCEPTION 'País no válido (%)', v_country; END IF;
    v_new := public.client_foreign_tax_norm(COALESCE(to_jsonb(NEW)->>'tax_id', to_jsonb(NEW)->>'ruc'));
    IF v_new IS NULL OR length(v_new) NOT BETWEEN 4 AND 20 THEN
      RAISE EXCEPTION 'Ingrese el documento tributario del cliente extranjero (4 a 20 letras o números)'; END IF;
    IF TG_OP = 'UPDATE' AND v_new IS NOT DISTINCT FROM public.client_foreign_tax_norm(COALESCE(to_jsonb(OLD)->>'tax_id', to_jsonb(OLD)->>'ruc'))
       AND v_country IS NOT DISTINCT FROM NULLIF(upper(btrim(COALESCE(to_jsonb(OLD)->>'country_code', ''))), '') THEN
      RETURN NEW; END IF;
    SELECT COALESCE(to_jsonb(c)->>'business_name', '—') INTO v_dup FROM public.clients c
     WHERE c.id IS DISTINCT FROM NEW.id AND upper(COALESCE(to_jsonb(c)->>'country_code', '')) = v_country
       AND public.client_foreign_tax_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_new
     LIMIT 1;
    IF v_dup IS NOT NULL THEN RAISE EXCEPTION 'Ya existe un cliente de % con el documento %: %', v_country, v_new, v_dup; END IF;
    RETURN NEW;
  END IF;

  -- Cliente peruano (sin cambios): RUC con dígito verificador SUNAT o DNI
  IF TG_OP = 'UPDATE' THEN
    v_old := public.client_tax_id_norm(COALESCE(to_jsonb(OLD)->>'tax_id', to_jsonb(OLD)->>'ruc'));
    IF v_new IS NOT DISTINCT FROM v_old THEN RETURN NEW; END IF;  -- sin cambio de RUC: datos existentes intactos
  ELSIF EXISTS (SELECT 1 FROM public.clients c WHERE to_jsonb(c)->>'tax_id' = to_jsonb(NEW)->>'tax_id') THEN
    RETURN NEW;  -- importación con upsert (ON CONFLICT tax_id): actualiza el cliente existente
  END IF;
  IF v_new IS NULL THEN RAISE EXCEPTION 'Ingrese el RUC del cliente'; END IF;
  IF length(v_new) = 11 THEN
    IF NOT public.is_valid_ruc(v_new) THEN
      RAISE EXCEPTION 'RUC % inválido: no cumple el dígito verificador de SUNAT', v_new;
    END IF;
  ELSIF length(v_new) <> 8 THEN
    RAISE EXCEPTION 'El RUC debe tener 11 dígitos (o DNI de 8 para personas naturales sin RUC). Si el cliente es extranjero, regístrelo como «Cliente extranjero»';
  END IF;
  SELECT COALESCE(to_jsonb(c)->>'business_name', '—') INTO v_dup FROM public.clients c
  WHERE c.id IS DISTINCT FROM NEW.id
    AND COALESCE(NULLIF(upper(to_jsonb(c)->>'country_code'), ''), 'PE') = 'PE'
    AND public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_new
  LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'Ya existe un cliente con el RUC %: %', v_new, v_dup;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clients_tax_id_guard() FROM PUBLIC, anon, authenticated;

-- Registro desde el Alta de OT (mismo permiso que register_contract_client). Si el documento ya existe en ese país,
-- devuelve ese cliente (y lo reactiva) en lugar de duplicarlo.
CREATE OR REPLACE FUNCTION public.register_foreign_client(p_country_code text, p_country_name text, p_tax_id text,
  p_business_name text, p_address text DEFAULT NULL, p_contact_name text DEFAULT NULL, p_phone text DEFAULT NULL, p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_country text := NULLIF(upper(btrim(COALESCE(p_country_code, ''))), '');
  v_tax text := public.client_foreign_tax_norm(p_tax_id); v_name text := NULLIF(btrim(COALESCE(p_business_name, '')), '');
  v_row jsonb; v_id uuid; v_data jsonb; v_cols text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_tms_user() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión activa'); END IF;
  IF NOT (public.is_tms_admin() OR public.is_contract_administrator() OR public.has_tms_permission('ot') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar clientes');
  END IF;
  IF v_country IS NULL OR v_country !~ '^[A-Z]{2}$' OR v_country = 'PE' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Elija el país del cliente extranjero'); END IF;
  IF v_tax IS NULL OR length(v_tax) NOT BETWEEN 4 AND 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Ingrese el documento tributario del cliente (4 a 20 letras o números)'); END IF;
  SELECT to_jsonb(c) INTO v_row FROM public.clients c
   WHERE upper(COALESCE(to_jsonb(c)->>'country_code', '')) = v_country
     AND public.client_foreign_tax_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = v_tax
   ORDER BY COALESCE((to_jsonb(c)->>'is_active')::boolean, true) DESC LIMIT 1;
  IF v_row IS NOT NULL THEN
    v_id := (v_row->>'id')::uuid;
    IF (v_row->>'is_active') = 'false' THEN EXECUTE 'UPDATE public.clients SET is_active = true WHERE id = $1' USING v_id; END IF;
    RETURN jsonb_build_object('success', true, 'existing', true, 'id', v_id, 'business_name', v_row->>'business_name',
      'tax_id', COALESCE(v_row->>'tax_id', v_row->>'ruc'), 'country_code', v_country);
  END IF;
  IF v_name IS NULL OR length(v_name) > 300 THEN RETURN jsonb_build_object('success', false, 'error', 'Ingrese la razón social'); END IF;
  -- Solo columnas que existen en producción (el esquema difiere del repo)
  v_data := jsonb_strip_nulls(jsonb_build_object('business_name', v_name, 'tax_id', v_tax, 'ruc', v_tax, 'country_code', v_country,
    'country_name', NULLIF(btrim(COALESCE(p_country_name, '')), ''),
    'address', NULLIF(btrim(COALESCE(p_address, '')), ''), 'contact_name', NULLIF(btrim(COALESCE(p_contact_name, '')), ''),
    'phone', NULLIF(btrim(COALESCE(p_phone, '')), ''), 'email', NULLIF(btrim(COALESCE(p_email, '')), ''), 'is_active', true));
  SELECT string_agg(quote_ident(k), ',') INTO v_cols FROM jsonb_object_keys(v_data) k
   WHERE EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = k);
  EXECUTE format('INSERT INTO public.clients(%s) SELECT %s FROM jsonb_populate_record(NULL::public.clients, $1) RETURNING id', v_cols, v_cols)
    INTO v_id USING v_data;
  RETURN jsonb_build_object('success', true, 'existing', false, 'id', v_id, 'business_name', v_name, 'tax_id', v_tax, 'country_code', v_country);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success', false, 'error', format('El documento %s ya está registrado para otro cliente', v_tax));
WHEN raise_exception OR check_violation OR not_null_violation THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.register_foreign_client(text,text,text,text,text,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_foreign_client(text,text,text,text,text,text,text,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
