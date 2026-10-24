-- CAJA C141 — Descartar la foto de stock vigente del inventario (cargada por error): queda descartada y el modelo
-- vuelve a calcular con todos los movimientos. Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; res jsonb; pass int := 0; fails text[] := '{}';
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.apt_can_load(); admin_id := NULL;
  END LOOP;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C141 FAIL: falta un usuario con carga APT'; END IF;
  -- Foto posterior a todo (la vigente)
  INSERT INTO public.inv_uploads (side, file_name, cutoff, created_by, status, applied_at, desde, hasta)
  VALUES ('STOCK', 'ZZ C141 foto.xlsx', DATE '2099-01-01', admin_id, 'APLICADA', now(), DATE '2099-01-01', DATE '2099-01-01') RETURNING id INTO up;
  UPDATE public.inv_state SET dirty = false WHERE id = 1;

  -- T1 descarta la foto vigente y deja el inventario por recalcular
  res := public.inv_snapshot_discard();
  IF res->>'success' = 'true' AND (res->>'upload_id')::uuid = up AND (SELECT status FROM public.inv_uploads WHERE id = up) = 'DESCARTADA'
     AND (SELECT dirty FROM public.inv_state WHERE id = 1)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 descartar: ' || res::text); END IF;
  -- T2 sin permiso de carga no descarta
  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  IF (public.inv_snapshot_discard()->>'success') = 'false' AND NOT has_function_privilege('anon', 'public.inv_snapshot_discard()', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T2 permisos'::text; END IF;
  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C141 FAIL (%/2): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C141 PASS (2/2) descartar la foto de stock vigente: queda descartada y el inventario recalcula con todos los movimientos';
END $test$;
ROLLBACK;
