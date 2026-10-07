-- Pruebas C11 — Bloque 1: autor real de las novedades del despacho y RUC de clientes válido y sin duplicados.
-- Termina en error para forzar ROLLBACK: "CAJA C11 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c11_trazabilidad_ruc.test.sql
BEGIN;

CREATE FUNCTION pg_temp.try_client(p_name text, p_ruc text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active)
  VALUES (p_name, p_ruc, 'Av. Prueba 123', 'Contacto', '999', 'zz@x', true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_user uuid; v_site uuid; v_disp uuid; v_legacy uuid;
  v_fail text[] := '{}';
  v_pass int := 0;
  v_err text; v_err2 text; v_err3 text; v_err4 text; v_by text; v_byu uuid;
BEGIN
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C11 FAIL: se requiere un perfil'; END IF;
  UPDATE public.profiles SET first_name = 'Operadora', last_name = 'Prueba C11' WHERE id = v_user;
  INSERT INTO public.dispatches (dispatch_number, vehicle_plate, status, site_id) VALUES ('ZZ-C11-D1', 'EXTERNO', 'PROGRAMADO', v_site)
  RETURNING id INTO v_disp;

  -- T1: la novedad guarda al usuario de la sesión aunque la web envíe otro texto
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  INSERT INTO public.dispatch_events (dispatch_id, event_type, description, created_by)
  VALUES (v_disp, 'INCIDENCIA', 'Tráfico en Panamericana', 'Operador GPS');
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SELECT created_by, created_by_user INTO v_by, v_byu FROM public.dispatch_events WHERE dispatch_id = v_disp;
  IF v_by = 'Operadora Prueba C11' AND v_byu = v_user
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 autor: ' || COALESCE(v_by, '∅') || ' / ' || COALESCE(v_byu::text, '∅')); END IF;

  -- T2: RUC con dígito verificador inválido, vacío o de longitud rara no se registra; el válido sí
  v_err := pg_temp.try_client('ZZ C11 Inválido', '20999999907');
  v_err2 := pg_temp.try_client('ZZ C11 Vacío', '  ');
  v_err3 := pg_temp.try_client('ZZ C11 Corto', '12345');
  v_err4 := pg_temp.try_client('ZZ C11 Válido', '20999999906');
  IF v_err LIKE 'RUC 20999999907 inválido%' AND v_err2 LIKE 'Ingrese el RUC%' AND v_err3 LIKE 'El RUC debe tener 11 dígitos%' AND v_err4 IS NULL
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 validación: ' || concat_ws(' | ', COALESCE(v_err, '∅'), COALESCE(v_err2, '∅'), COALESCE(v_err3, '∅'), COALESCE(v_err4, '∅'))); END IF;

  -- T3: el mismo RUC (aun con espacios o guiones) no se repite, ni al crear ni al cambiar el RUC de otro cliente
  v_err := pg_temp.try_client('ZZ C11 Copia', ' 20999999906 ');
  PERFORM pg_temp.try_client('ZZ C11 Otro', '20999999914');
  v_err2 := NULL;
  BEGIN
    UPDATE public.clients SET tax_id = '20-999999906' WHERE business_name = 'ZZ C11 Otro';
  EXCEPTION WHEN OTHERS THEN v_err2 := SQLERRM;
  END;
  IF v_err LIKE 'Ya existe un cliente con el RUC 20999999906: ZZ C11 Válido' AND v_err2 LIKE 'Ya existe un cliente%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 duplicado: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T4: un cliente antiguo con RUC fuera de norma se puede seguir editando si no cambia su RUC
  ALTER TABLE public.clients DISABLE TRIGGER clients_tax_id_guard;
  INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active)
  VALUES ('ZZ C11 Antiguo', '123', 'Av. Antigua', 'Contacto', '111', 'old@x', true) RETURNING id INTO v_legacy;
  ALTER TABLE public.clients ENABLE TRIGGER clients_tax_id_guard;
  v_err := NULL;
  BEGIN UPDATE public.clients SET phone = '222' WHERE id = v_legacy;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  v_err2 := NULL;
  BEGIN UPDATE public.clients SET tax_id = '20999999999' WHERE id = v_legacy;
  EXCEPTION WHEN OTHERS THEN v_err2 := SQLERRM;
  END;
  IF v_err IS NULL AND v_err2 LIKE 'RUC 20999999999 inválido%'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 históricos: ' || COALESCE(v_err, '∅') || ' | ' || COALESCE(v_err2, '∅')); END IF;

  -- T5: la importación de Excel (upsert por tax_id) actualiza el cliente existente sin error de duplicado
  v_err := NULL;
  BEGIN
    INSERT INTO public.clients (business_name, tax_id, address, contact_name, phone, email, is_active)
    VALUES ('ZZ C11 Válido SAC', '20999999906', 'Av. Nueva 456', 'Contacto', '333', 'zz@x', true)
    ON CONFLICT (tax_id) DO UPDATE SET business_name = EXCLUDED.business_name, address = EXCLUDED.address;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL AND (SELECT count(*) = 1 AND min(business_name) = 'ZZ C11 Válido SAC' FROM public.clients WHERE tax_id = '20999999906')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 importación: ' || COALESCE(v_err, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C11 PASS (%/5)', v_pass;
  END IF;
  RAISE EXCEPTION 'CAJA C11 FAIL: %', array_to_string(v_fail, ' || ');
END $test$;

ROLLBACK;
