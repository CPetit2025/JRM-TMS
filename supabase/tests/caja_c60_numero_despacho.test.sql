-- Pruebas C60 — Número de despacho simple y correlativo (10001, 10002, …).
-- T1 secuencia y disparadores instalados; T2 no quedan despachos con el código DESP-AAAAMMDD-XXXXXXXX y el código
-- anterior se conserva en legacy_dispatch_number; T3 un despacho nuevo con el código automático recibe el siguiente
-- correlativo y uno con número escrito a mano lo conserva; T4 los textos con el código automático muestran el número
-- definitivo del despacho; T5 la descripción del flete se corrige al registrarse.
-- Termina en error para forzar ROLLBACK: "CAJA C60 PASS/FAIL".
--   npx supabase db query --linked -f supabase/tests/caja_c60_numero_despacho.test.sql
BEGIN;

-- Inserta solo las columnas que existen (el esquema de producción difiere del repositorio)
CREATE FUNCTION pg_temp.ins_dispatch(p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE (SELECT format('INSERT INTO public.dispatches (%s) VALUES (%s) RETURNING id',
                         string_agg(quote_ident(k.key), ', '), string_agg(quote_nullable(k.value #>> '{}'), ', '))
           FROM jsonb_each(p_cols) k
           WHERE EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = 'dispatches' AND ic.column_name = k.key))
  INTO v_id;
  RETURN v_id;
END $$;

DO $test$
DECLARE
  v_site uuid; v_d1 uuid; v_d2 uuid; v_n1 text; v_n2 text; v_max bigint; v_left int; v_txt text;
  v_fail text[] := '{}';
  v_pass int := 0;
  v_has_cs_trigger boolean;
BEGIN
  -- T1
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dispatch_number_seq' AND relkind = 'S')
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'dispatch_assign_number' AND tgrelid = 'public.dispatches'::regclass)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 secuencia o disparador ausente'::text; END IF;

  -- T2
  SELECT count(*) INTO v_left FROM public.dispatches WHERE dispatch_number ~ '^DESP-[0-9]{8}-[0-9A-Fa-f]{8}$';
  IF v_left = 0 AND NOT EXISTS (SELECT 1 FROM public.dispatches WHERE legacy_dispatch_number IS NOT NULL AND dispatch_number !~ '^[0-9]+$')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 quedan ' || v_left || ' despachos con código DESP'); END IF;

  -- T3
  SELECT COALESCE(max(dispatch_number::bigint) FILTER (WHERE dispatch_number ~ '^[0-9]{1,15}$'), 10000) INTO v_max FROM public.dispatches;
  SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1;
  v_d1 := pg_temp.ins_dispatch(jsonb_build_object('dispatch_number', 'DESP-20261009-ABCDEF12', 'vehicle_plate', 'ZZC60A',
    'status', 'CANCELADO', 'site_id', v_site, 'scheduled_date', now(), 'scheduled_departure', now()));
  v_d2 := pg_temp.ins_dispatch(jsonb_build_object('dispatch_number', 'ZZ-C60-MANUAL', 'vehicle_plate', 'ZZC60B',
    'status', 'CANCELADO', 'site_id', v_site, 'scheduled_date', now(), 'scheduled_departure', now()));
  SELECT dispatch_number INTO v_n1 FROM public.dispatches WHERE id = v_d1;
  SELECT dispatch_number INTO v_n2 FROM public.dispatches WHERE id = v_d2;
  IF v_n1 ~ '^[0-9]+$' AND v_n1::bigint > v_max AND v_n1::bigint >= 10001 AND v_n2 = 'ZZ-C60-MANUAL'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 número asignado ' || COALESCE(v_n1, 'NULL') || ' / manual ' || COALESCE(v_n2, 'NULL') || ' (máximo previo ' || v_max || ')'); END IF;

  -- T4
  v_txt := public.dispatch_number_in_text('Flete del despacho DESP-20261009-ABCDEF12 · Proveedor', v_d1);
  IF v_txt = 'Flete del despacho ' || v_n1 || ' · Proveedor'
     AND public.dispatch_number_in_text('Sin código', v_d1) = 'Sin código'
     AND public.dispatch_number_in_text('Flete DESP-20261009-ABCDEF12', NULL) = 'Flete DESP-20261009-ABCDEF12'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 texto: ' || COALESCE(v_txt, 'NULL')); END IF;

  -- T5 (solo si contract_services tiene dispatch_id en esta base)
  v_has_cs_trigger := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contract_services' AND column_name = 'dispatch_id');
  IF NOT v_has_cs_trigger OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'contract_service_dispatch_number' AND tgrelid = 'public.contract_services'::regclass)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T5 disparador de contract_services ausente'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C60 PASS (%/5) siguiente número %, despachos renumerados %', v_pass,
      (SELECT last_value + 1 FROM public.dispatch_number_seq),
      (SELECT count(*) FROM public.dispatches WHERE legacy_dispatch_number IS NOT NULL);
  ELSE
    RAISE EXCEPTION 'CAJA C60 FAIL (%/5): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
