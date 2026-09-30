-- ============================================================
-- CONTRATOS — Alta de contrato/OT en una sola función del servidor
-- ============================================================
-- El alta desde la pantalla hacía varios pasos sueltos (INSERT del contrato, lectura del registro recién
-- creado y otro INSERT de la partida), con estas fallas:
--   * la partida se insertaba sin considerar que ya existiera (duplicado contract_id + concepto);
--   * la sede se tomaba siempre de la sede principal, aunque el usuario solo tuviera acceso a otra
--     (y los subcontratos no heredaban la sede del contrato madre);
--   * el Administrador de Contratos seguía un camino distinto según el nombre del rol en la pantalla.
-- create_contract valida permisos y datos, elige la sede, crea el contrato, fija la partida y devuelve
-- {success, id} o {success:false, error} con un mensaje claro. Las columnas opcionales (peso, volumen,
-- destino) se guardan solo si existen en la base.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_contract(p_payload jsonb, p_budget_pen numeric DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_code    text := trim(COALESCE(p_payload->>'code', ''));
  v_type    text := upper(COALESCE(NULLIF(trim(p_payload->>'type'), ''), 'CONTRATO'));
  v_parent  uuid;
  v_client  uuid;
  v_site    uuid;
  v_id      uuid;
  v_budget  numeric;
  v_weight  numeric;
  v_volume  numeric;
  v_ca      boolean := public.is_contract_administrator();
  v_col     text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sin sesión'); END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Datos del contrato inválidos');
  END IF;
  IF NOT (public.is_tms_admin() OR v_ca OR public.has_tms_permission('ot') OR public.has_tms_permission('clientes')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para registrar contratos u OT');
  END IF;

  BEGIN
    v_parent := NULLIF(p_payload->>'parent_contract_id', '')::uuid;
    v_client := NULLIF(p_payload->>'client_id', '')::uuid;
    v_site   := NULLIF(p_payload->>'site_id', '')::uuid;
    v_budget := COALESCE(p_budget_pen, 0);
    v_weight := COALESCE(NULLIF(p_payload->>'total_weight_kg', '')::numeric, 0);
    v_volume := COALESCE(NULLIF(p_payload->>'total_volume_m3', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('success', false, 'error', 'Revise los montos, pesos y selecciones del formulario');
  END;

  IF v_type NOT IN ('CONTRATO', 'OT_INDEPENDIENTE', 'SUBCONTRATO', 'ERROR') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tipo de contrato inválido');
  END IF;
  IF length(v_code) NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el código del contrato');
  END IF;
  IF v_budget < 0 OR v_budget > 999999999999.99 OR v_weight < 0 OR v_volume < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'La partida, el peso y el volumen no pueden ser negativos');
  END IF;

  IF v_type IN ('SUBCONTRATO', 'ERROR') THEN
    IF v_parent IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione el contrato madre'); END IF;
    SELECT c.site_id INTO v_site FROM public.contracts c WHERE c.id = v_parent;
    IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'El contrato madre no existe'); END IF;
    IF v_ca AND NOT public.has_assigned_contract(v_parent, true) THEN
      RETURN jsonb_build_object('success', false, 'error', 'El contrato madre no está asignado a usted');
    END IF;
  ELSE
    v_parent := NULL;
    -- Sede: la indicada, la principal si el usuario tiene acceso, o la primera sede a la que tenga acceso
    IF v_site IS NULL THEN
      v_site := public.primary_site_id();
      IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
        SELECT a.site_id INTO v_site FROM public.user_site_access a WHERE a.user_id = auth.uid() ORDER BY a.site_id LIMIT 1;
      END IF;
    END IF;
  END IF;
  IF v_site IS NULL OR NOT public.can_access_site(v_site) THEN
    RETURN jsonb_build_object('success', false, 'error', 'No tiene acceso a la sede del contrato; pida al administrador que le asigne la sede');
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts c WHERE c.code = v_code) THEN
    RETURN jsonb_build_object('success', false, 'error', format('El código "%s" ya está en uso. No se permiten duplicados.', v_code));
  END IF;

  BEGIN
    INSERT INTO public.contracts (code, type, parent_contract_id, site_id, client_id, status)
    VALUES (v_code, v_type::public.contract_type, v_parent, v_site, v_client, 'ACTIVO')
    RETURNING id INTO v_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'error', format('El código "%s" ya está en uso. No se permiten duplicados.', v_code));
    WHEN foreign_key_violation THEN
      RETURN jsonb_build_object('success', false, 'error', 'El cliente o el contrato madre seleccionado ya no existe');
  END;

  -- Datos opcionales: solo las columnas que existen en esta base
  FOREACH v_col IN ARRAY ARRAY['total_weight_kg', 'total_volume_m3'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = v_col) THEN
      EXECUTE format('UPDATE public.contracts SET %I = $1 WHERE id = $2', v_col)
        USING CASE v_col WHEN 'total_weight_kg' THEN v_weight ELSE v_volume END, v_id;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY ARRAY['destination_department', 'destination_province', 'destination_district', 'destination_address'] LOOP
    IF NULLIF(trim(p_payload->>v_col), '') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'contracts' AND column_name = v_col) THEN
      EXECUTE format('UPDATE public.contracts SET %I = $1 WHERE id = $2', v_col) USING trim(p_payload->>v_col), v_id;
    END IF;
  END LOOP;

  -- Partida de transporte: se fija aunque otro proceso ya haya creado la fila en cero
  IF v_budget > 0 THEN
    UPDATE public.contract_budgets SET allocated_pen = v_budget WHERE contract_id = v_id AND concept = 'PARTIDA_TRANSPORTE';
    IF NOT FOUND THEN
      INSERT INTO public.contract_budgets (contract_id, concept, allocated_pen) VALUES (v_id, 'PARTIDA_TRANSPORTE', v_budget);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id, 'code', v_code, 'site_id', v_site);
END $$;

REVOKE ALL ON FUNCTION public.create_contract(jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_contract(jsonb, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
