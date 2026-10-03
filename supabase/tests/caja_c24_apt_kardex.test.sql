-- CAJA C24 — APT: kardex de trazabilidad. Con los datos cargados, el saldo final del kardex por almacén cuadra con el
-- saldo del flujo multi-almacén (FIFO encadenado) a la misma fecha de corte, y un filtro por lote devuelve solo ese
-- lote con su saldo acumulado. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE v_user uuid; v_role uuid; v_cut date; r jsonb; r2 jsonb; v_lote text; v_diff numeric; v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C24 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_user;
  SELECT cutoff INTO v_cut FROM public.apt_flow_state WHERE id = 1;
  SELECT lote INTO v_lote FROM public.apt_flow_layers WHERE tipo = 'PRODUCCION' ORDER BY fecha DESC, id LIMIT 1;

  PERFORM pg_temp.as_user(v_user);
  r := public.apt_kardex(jsonb_build_object('hasta', v_cut), 'total', true, 1, 0);
  r2 := public.apt_kardex(jsonb_build_object('lote_exacto', v_lote), 'lote_producto', true, 20000, 0);
  PERFORM pg_temp.as_user(NULL);

  -- T1: saldo por almacén del kardex = saldo del flujo (tolerancia 10 kg)
  SELECT COALESCE(max(abs((a ->> 'saldo_tn')::numeric - COALESCE(f.tn, 0))), 0) INTO v_diff
  FROM jsonb_array_elements(r -> 'almacenes') a
  LEFT JOIN (SELECT almacen, sum(kg_saldo) / 1000.0 AS tn FROM public.apt_flow_layers GROUP BY 1) f ON f.almacen = a ->> 'almacen';
  IF (r ->> 'success')::boolean AND (v_cut IS NULL OR v_diff <= 0.01)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 cuadre: ' || COALESCE(r ->> 'almacenes', '∅') || ' dif ' || v_diff); END IF;

  -- T2: filtro por lote exacto: solo ese lote, con saldo acumulado en cada fila
  IF v_lote IS NULL OR ((r2 ->> 'success')::boolean
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r2 -> 'filas') x WHERE x ->> 'lote' <> v_lote)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r2 -> 'filas') x WHERE x ->> 'saldo_kg' IS NULL))
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 lote: ' || left(COALESCE(r2::text, '∅'), 400)); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C24 PASS (%/2)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C24 FAIL (%/2): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
