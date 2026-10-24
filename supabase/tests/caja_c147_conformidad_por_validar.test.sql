-- CAJA C147 — Guías por validar (Supervisor de Transporte y JRM IA) y placa tracto/semirremolque de terceros.
-- Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; other_id uuid; v_role uuid; res jsonb; n int; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C147 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- T1 el total coincide con las conformidades RECIBIDAS de servicios abiertos que el usuario puede ver; un término
  --    inexistente no devuelve nada; cada fila trae el enlace de revisión
  res := public.delivery_pending_reviews(NULL, 200);
  SELECT count(*) INTO n FROM public.delivery_conformities c JOIN public.dispatches d ON d.id = c.dispatch_id
   WHERE c.state = 'RECIBIDA' AND c.current_submission_id IS NOT NULL AND COALESCE(d.status, '') NOT IN ('LIQUIDADO', 'CERRADO', 'CANCELADO')
     AND (public.delivery_can_review(d.id) OR public.delivery_can_read(d.id));
  IF (res->>'success')::boolean AND (res->>'total')::int = n
     AND (public.delivery_pending_reviews('ZZ-C147-NO-EXISTE')->>'total')::int = 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(res->'filas') x WHERE x->>'url' NOT LIKE '/torre-control?despacho=%&revisar=%')
  THEN pass := pass + 1; ELSE fails := fails || format('T1 total %s vs %s', res->>'total', n); END IF;

  -- T2 un rol sin módulos no ve guías ni puede validar; con «Validar conformidad de entregas» sí puede validar; anon no ejecuta
  INSERT INTO public.roles (name, permissions) VALUES ('C147 ' || left(gen_random_uuid()::text, 8), '[]'::jsonb) RETURNING id INTO v_role;
  -- Perfil sin vínculo de conductor (un conductor ve las guías de sus propios viajes)
  SELECT p.id INTO other_id FROM public.profiles p WHERE p.is_active AND p.id <> admin_id
     AND NOT EXISTS (SELECT 1 FROM public.drivers d WHERE d.profile_id = p.id) ORDER BY p.created_at LIMIT 1;
  IF other_id IS NULL THEN RAISE EXCEPTION 'CAJA C147 FAIL: falta un perfil activo sin vínculo de conductor'; END IF;
  UPDATE public.profiles SET role_id = v_role WHERE id = other_id;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  res := public.delivery_pending_reviews(NULL, 50);
  IF (res->>'total')::int = 0 AND NOT (res->>'puede_validar')::boolean THEN
    UPDATE public.roles SET permissions = '["entregas-validacion"]'::jsonb WHERE id = v_role;
    IF (public.delivery_pending_reviews(NULL, 50)->>'puede_validar')::boolean
       AND NOT has_function_privilege('anon', 'public.delivery_pending_reviews(text, integer)', 'EXECUTE')
    THEN pass := pass + 1; ELSE fails := fails || 'T2 permiso de validación o anon'::text; END IF;
  ELSE fails := fails || ('T2 sin módulos: ' || res::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);

  -- T3 placa de tercero: tracto/semirremolque válido; una sola placa válida; tres placas o una placa corta no
  CREATE TEMP TABLE c147_veh (LIKE public.supplier_vehicles INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP;
  INSERT INTO c147_veh (id, supplier_id, plate, unit_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'ALZ721/AFM975', 'TRAILER'),
    (gen_random_uuid(), gen_random_uuid(), 'ABC123', 'CAMION');
  BEGIN
    INSERT INTO c147_veh (id, supplier_id, plate, unit_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'ALZ721/AFM975/XYZ123', 'TRAILER');
    fails := fails || 'T3 aceptó tres placas'::text;
  EXCEPTION WHEN check_violation THEN
    BEGIN
      INSERT INTO c147_veh (id, supplier_id, plate, unit_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'ALZ721/AB1', 'TRAILER');
      fails := fails || 'T3 aceptó un semirremolque corto'::text;
    EXCEPTION WHEN check_violation THEN pass := pass + 1;
    END;
  END;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C147 FAIL (%/3): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C147 PASS (3/3) guías por validar con enlace de revisión, permisos y placa tracto/semirremolque de terceros';
END $test$;
ROLLBACK;
