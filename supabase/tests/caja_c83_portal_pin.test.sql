-- CAJA C83 — Portal público: código de acceso de 4 caracteres alfanuméricos, sin distinguir mayúsculas,
-- y los PIN de 8 dígitos ya entregados siguen sirviendo. Bloque que siempre se revierte.
BEGIN;
DO $test$
DECLARE site uuid; actor uuid; tok uuid; old_tok uuid; r jsonb; i integer; pin text;
BEGIN
  SELECT id INTO site FROM public.sites ORDER BY id LIMIT 1;
  SELECT id INTO actor FROM public.profiles ORDER BY id LIMIT 1;
  IF site IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'CAJA C83 FAIL: faltan sede o perfil'; END IF;

  -- T1: el código generado tiene 4 caracteres sin 0/O ni 1/I/L
  FOR i IN 1..200 LOOP
    pin := public.portal_pin_generate();
    IF pin !~ '^[A-HJKMNP-Z2-9]{4}$' THEN RAISE EXCEPTION 'CAJA C83 FAIL: formato del código (T1): %', pin; END IF;
  END LOOP;

  -- T2: la emisión y la rotación usan el nuevo código; la consulta y los documentos aceptan 4 u 8
  IF position('portal_pin_generate()' IN pg_get_functiondef('public.manage_tracking_portal_link(uuid,text)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%tracking_portal_link%'
                    AND proname <> 'manage_tracking_portal_link' AND position('portal_pin_generate()' IN prosrc) > 0)
     OR position('NOT IN (4,8)' IN pg_get_functiondef('public.get_public_tracking_portal_info(uuid,text,date,date)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_public_tracking_document' AND position('NOT IN (4,8)' IN prosrc) > 0) THEN
    RAISE EXCEPTION 'CAJA C83 FAIL: emisión o validación sin el código de 4 caracteres (T2)'; END IF;

  -- T3: el código vale en minúsculas; uno incorrecto no; un PIN anterior de 8 dígitos sigue sirviendo
  INSERT INTO public.tracking_portal_links(site_id, pin_hash, created_by) VALUES (site, extensions.crypt('AB2C', extensions.gen_salt('bf', 8)), actor) RETURNING token INTO tok;
  INSERT INTO public.tracking_portal_links(site_id, pin_hash, created_by) VALUES (site, extensions.crypt('12345678', extensions.gen_salt('bf', 8)), actor) RETURNING token INTO old_tok;
  r := public.get_public_tracking_portal_info(tok, 'ab2c', current_date, current_date);
  IF r ? 'error' THEN RAISE EXCEPTION 'CAJA C83 FAIL: código en minúsculas rechazado (T3): %', r->>'error'; END IF;
  r := public.get_public_tracking_portal_info(tok, 'AB2D', current_date, current_date);
  IF r->>'error' IS DISTINCT FROM 'Código de acceso incorrecto' THEN RAISE EXCEPTION 'CAJA C83 FAIL: aceptó un código incorrecto (T3)'; END IF;
  r := public.get_public_tracking_portal_info(old_tok, '12345678', current_date, current_date);
  IF r ? 'error' THEN RAISE EXCEPTION 'CAJA C83 FAIL: PIN anterior de 8 dígitos rechazado (T3): %', r->>'error'; END IF;

  -- T4: el generador no está expuesto
  IF has_function_privilege('anon', 'public.portal_pin_generate()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.portal_pin_generate()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C83 FAIL: generador expuesto (T4)'; END IF;

  RAISE EXCEPTION 'CAJA C83 PASS (4/4) portal público: código de 4 caracteres alfanuméricos, sin distinguir mayúsculas, PIN anteriores vigentes';
END $test$;
ROLLBACK;
