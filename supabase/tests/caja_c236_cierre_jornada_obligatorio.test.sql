-- CAJA C236 — Cierre de jornada obligatorio: el inicio del día exige la jornada anterior cerrada (con odómetro o con motivo).
-- Usa un conductor y una unidad creados dentro de la transacción. Siempre se revierte.
BEGIN;
CREATE OR REPLACE FUNCTION public.unit_odometer_close_required_since() RETURNS date LANGUAGE sql IMMUTABLE AS $f$SELECT DATE '2000-01-01'$f$;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; site uuid; carrier uuid; r jsonb; bad text;
  today date := (now() AT TIME ZONE 'America/Lima')::date; fails text[] := '{}';
BEGIN
 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.is_tms_admin(); admin_id := NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT id FROM auth.users) AND id IS DISTINCT FROM admin_id
   AND id NOT IN (SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) LIMIT 1;
 SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C236 FAIL: faltan perfil disponible o sede'; END IF;
 UPDATE public.profiles SET is_active = true, role_id = NULL WHERE id = actor;
 INSERT INTO public.drivers(carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
 VALUES (carrier, actor, 'Conductor', 'C236', 'ZZ-C236-DNI', 'ZZ-C236-LIC', true) RETURNING id INTO driver;
 INSERT INTO public.vehicles(plate, carrier_id, site_id, type, status, current_odometer, soat_expiration, technical_review_expiration)
 VALUES ('ZZC236A', carrier, site, 'CAMION', 'DISPONIBLE', 1000, current_date + 365, current_date + 365);
 PERFORM set_config('request.jwt.claim.sub', actor::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);

 -- T1: jornada de anteayer sin cierre → se declara el motivo (sin acceso a la unidad)
 PERFORM public.unit_odometer_record(gen_random_uuid(), 'ZZC236A', driver, today - 2, 'INICIO', '1000', NULL, now() - interval '2 days', actor, NULL);
 r := public.get_driver_pending_close();
 IF (r->'pending'->>'operation_date')::date IS DISTINCT FROM today - 2 THEN fails := fails || ('T1 pendiente: ' || r::text); END IF;
 r := public.close_driver_pending_workday(gen_random_uuid(), NULL, 'corto');
 IF r->>'success' <> 'false' THEN fails := fails || ('T1 motivo corto aceptado: ' || r::text); END IF;
 r := public.close_driver_pending_workday(gen_random_uuid(), NULL, 'La unidad quedó en taller, sin acceso al tablero');
 IF r->>'waived' IS DISTINCT FROM 'true' OR public.get_driver_pending_close()->'pending' <> 'null'::jsonb THEN fails := fails || ('T1 motivo: ' || r::text); END IF;

 -- T2: ayer sin cierre bloquea el inicio de hoy
 PERFORM public.unit_odometer_record(gen_random_uuid(), 'ZZC236A', driver, today - 1, 'INICIO', '1100', NULL, now() - interval '1 day', actor, NULL);
 BEGIN PERFORM public.unit_odometer_record(gen_random_uuid(), 'ZZC236A', driver, today, 'INICIO', '1200', NULL, now(), actor, NULL); bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF bad IS NULL OR bad NOT LIKE 'Primero cierre la jornada%ZZC236A%' THEN fails := fails || ('T2 sin bloqueo: ' || COALESCE(bad, 'aceptado')); END IF;

 -- T3: se cierra con el odómetro actual (km del día) y el inicio de hoy pasa; idempotente
 r := public.close_driver_pending_workday('00000000-0000-0000-0000-000000000236', '1180', NULL);
 IF r->>'success' <> 'true' OR (r->>'km')::numeric <> 80 OR (r->>'operation_date')::date <> today - 1 THEN fails := fails || ('T3 cierre: ' || r::text); END IF;
 IF public.close_driver_pending_workday('00000000-0000-0000-0000-000000000236', '1180', NULL)->>'duplicate' IS DISTINCT FROM 'true' THEN fails := fails || 'T3 no idempotente'; END IF;
 BEGIN PERFORM public.unit_odometer_record(gen_random_uuid(), 'ZZC236A', driver, today, 'INICIO', '1200', NULL, now(), actor, NULL); bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF bad IS NOT NULL THEN fails := fails || ('T3 inicio tras cierre: ' || bad); END IF;

 -- T4: privilegios — las funciones internas y la tabla de motivos no se exponen
 IF has_function_privilege('authenticated', 'public.driver_pending_workday_close(uuid,date)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.unit_odometer_close_waivers', 'SELECT')
    OR has_function_privilege('anon', 'public.close_driver_pending_workday(uuid,text,text)', 'EXECUTE') THEN fails := fails || 'T4 privilegios'; END IF;

 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C236 FAIL: %', array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C236 PASS: jornada anterior sin cierre bloquea el inicio; cierre con odómetro (80 km) o con motivo';
END $test$;
ROLLBACK;
