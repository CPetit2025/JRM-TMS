-- CAJA C123 — Seguimiento de transporte desde el TMS sin código: un usuario activo abre el portal de su sede sin
-- PIN (mismo cálculo y presencia del portal), la sesión se reutiliza, un enlace interno revocado se reemplaza solo,
-- sin sesión no hay acceso y el código interno no es legible desde la web. Se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE adm uuid; v_site uuid; r jsonb; v_viewer uuid; v_tok uuid; pass int := 0; fails text[] := '{}';
BEGIN
  SELECT p.id INTO adm FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE r.name = 'Administrador' AND p.is_active ORDER BY p.id LIMIT 1;
  SELECT id INTO v_site FROM public.sites WHERE is_active ORDER BY name LIMIT 1;
  IF adm IS NULL OR v_site IS NULL THEN RAISE EXCEPTION 'CAJA C123 FAIL: falta un Administrador activo o una sede'; END IF;

  -- T1: sin sesión no hay acceso
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF public.get_internal_tracking_view(v_site, current_date, current_date) ? 'error' AND public.tracking_internal_sites() ? 'error'
  THEN pass := pass + 1; ELSE fails := fails || 'T1 acceso sin sesión'::text; END IF;

  PERFORM set_config('request.jwt.claim.sub', adm::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', adm, 'role', 'authenticated')::text, true);

  -- T2: el usuario activo ve su sede y abre el portal sin código, con su presencia
  r := public.get_internal_tracking_view(v_site, current_date - 20, current_date + 10);
  v_viewer := NULLIF(r->>'viewer_id', '')::uuid;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.tracking_internal_sites()->'sites') x WHERE (x->>'id')::uuid = v_site)
     AND NOT (r ? 'error') AND r->>'mode' = 'permanent' AND (r->>'internal')::boolean AND v_viewer IS NOT NULL
     AND jsonb_typeof(r->'rows') = 'array' AND (r->>'active_count')::int >= 1
  THEN pass := pass + 1; ELSE fails := fails || ('T2 vista ' || left(r::text, 300)); END IF;

  -- T3: la actualización reutiliza la misma sesión de presencia
  r := public.get_internal_tracking_view(v_site, current_date - 20, current_date + 10, v_viewer);
  IF (r->>'viewer_id')::uuid = v_viewer THEN pass := pass + 1; ELSE fails := fails || ('T3 sesión ' || left(r::text, 200)); END IF;

  -- T4: un enlace interno revocado desde Torre de Control se reemplaza solo
  SELECT token INTO v_tok FROM public.tracking_portal_internal WHERE site_id = v_site;
  UPDATE public.tracking_portal_links SET revoked_at = now() WHERE token = v_tok;
  r := public.get_internal_tracking_view(v_site, current_date - 20, current_date + 10, v_viewer);
  IF NOT (r ? 'error') AND (SELECT token FROM public.tracking_portal_internal WHERE site_id = v_site) <> v_tok
     AND (SELECT count(*) FROM public.tracking_portal_links l JOIN public.tracking_portal_internal i ON i.token = l.token
          WHERE i.site_id = v_site AND l.revoked_at IS NULL) = 1
  THEN pass := pass + 1; ELSE fails := fails || ('T4 enlace revocado ' || left(r::text, 200)); END IF;

  -- T5: el código interno no es legible desde la web y solo authenticated ejecuta la vista
  IF NOT has_table_privilege('authenticated', 'public.tracking_portal_internal', 'SELECT')
     AND NOT has_table_privilege('anon', 'public.tracking_portal_internal', 'SELECT')
     AND NOT has_function_privilege('authenticated', 'public.tracking_internal_link(uuid, boolean)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.get_internal_tracking_view(uuid, date, date, uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.get_internal_tracking_view(uuid, date, date, uuid)', 'EXECUTE')
  THEN pass := pass + 1; ELSE fails := fails || 'T5 permisos'::text; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C123 FAIL (%/5): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C123 PASS (5/5) seguimiento de transporte desde el TMS sin código: sede autorizada, presencia, enlace renovado y permisos';
END $test$;
ROLLBACK;
