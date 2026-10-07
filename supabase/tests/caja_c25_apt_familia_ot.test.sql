-- CAJA C25 — APT: familia de una OT. La raíz y la vertiente de cada lote se reconocen (16339-S001, 16339-E001, 16339 D),
-- el detector de digitación solo acepta un dígito de diferencia, y con los datos cargados la ficha de la familia y el kardex
-- filtrado por la OT dan el mismo saldo que el flujo para todos los lotes de esa raíz. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; v_role uuid; v_ot text; f jsonb; k jsonb; v_flow numeric; v_bad int; v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  -- T1: raíz, vertiente y parecido de raíces
  IF public.apt_ot_raiz('16339-S001') = '16339' AND public.apt_ot_raiz('16339 D') = '16339' AND public.apt_ot_raiz('2-2026-55361') IS NULL
     AND public.apt_lote_variante('16339') = 'MADRE' AND public.apt_lote_variante('16339-S001') = 'SUBCONTRATO'
     AND public.apt_lote_variante('16339-E002') = 'ERROR' AND public.apt_lote_variante('15586-G01') = 'GARANTIA'
     AND public.apt_lote_variante('16339 D') = 'DEVOLUCION' AND public.apt_lote_variante('16067-S004D') = 'DEVOLUCION'
     AND public.apt_raiz_parecida('126339', '16339') AND public.apt_raiz_parecida('16393', '16339') AND public.apt_raiz_parecida('1639', '16339')
     AND NOT public.apt_raiz_parecida('16339', '16339') AND NOT public.apt_raiz_parecida('16393', '16300') AND NOT public.apt_raiz_parecida('1633999', '16339')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 raíz/vertiente/parecido'::text; END IF;

  -- OT con más vertientes en el flujo
  SELECT public.apt_ot_raiz(lote) INTO v_ot FROM public.apt_flow_layers WHERE public.apt_ot_raiz(lote) IS NOT NULL
  GROUP BY 1 ORDER BY count(DISTINCT public.apt_lote_variante(lote)) DESC, count(DISTINCT lote) DESC, 1 LIMIT 1;

  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C25 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_user;

  IF v_ot IS NOT NULL THEN
    PERFORM pg_temp.as_user(v_user);
    f := public.apt_ot_familia(v_ot || '-S001');
    k := public.apt_kardex(jsonb_build_object('ot', v_ot), 'lote', true, 20000, 0);
    PERFORM pg_temp.as_user(NULL);
    SELECT COALESCE(sum(kg_saldo), 0) / 1000.0 INTO v_flow FROM public.apt_flow_layers WHERE public.apt_ot_raiz(lote) = v_ot;
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(k -> 'filas') x WHERE public.apt_ot_raiz(x ->> 'lote') IS DISTINCT FROM v_ot;
  END IF;

  -- T2: la ficha (buscada por un lote) agrupa la OT y su saldo cuadra con el flujo
  IF v_ot IS NULL OR ((f ->> 'success')::boolean AND f ->> 'ot' = v_ot AND abs((f #>> '{resumen,saldo_tn}')::numeric - v_flow) <= 0.01
                      AND jsonb_array_length(f -> 'miembros') >= 1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 familia ' || COALESCE(v_ot, '∅') || ': ' || left(COALESCE((f - 'miembros' - 'vinculados')::text, '∅'), 300) || ' flujo ' || v_flow); END IF;

  -- T3: el kardex por OT trae solo la familia y su saldo final cuadra con el flujo
  IF v_ot IS NULL OR ((k ->> 'success')::boolean AND v_bad = 0 AND abs((k #>> '{resumen,saldo_final_tn}')::numeric - v_flow) <= 0.01)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 kardex OT ' || COALESCE(v_ot, '∅') || ': ' || COALESCE(k ->> 'resumen', k ->> 'error', '∅') || ' ajenas ' || v_bad || ' flujo ' || v_flow); END IF;

  -- T4: todo lote señalado como posible error de digitación cumple la regla (un dígito, sin producción ni guías propias)
  SELECT count(*) INTO v_bad FROM public.apt_ot_sospechosos(COALESCE(v_ot, '0')) s
  WHERE NOT public.apt_raiz_parecida(public.apt_ot_raiz(s.lote), v_ot)
     OR EXISTS (SELECT 1 FROM public.apt_movements e WHERE e.active AND e.valid AND e.kind IN ('ENTRADA', 'SALIDA')
                AND public.apt_ot_raiz(e.lote) = public.apt_ot_raiz(s.lote));
  IF v_bad = 0 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 sospechosos inválidos: ' || v_bad); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C25 PASS (%/4)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C25 FAIL (%/4): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
