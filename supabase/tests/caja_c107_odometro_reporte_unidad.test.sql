-- CAJA C107 — Odómetro diario con foto (checklist y «Cerrar jornada») y reporte diario por unidad. Siempre se revierte.
BEGIN;
CREATE FUNCTION pg_temp.odo(p_user uuid, p_km numeric) RETURNS jsonb LANGUAGE plpgsql AS $odo$
DECLARE v_path text := p_user::text || '/odometro/' || gen_random_uuid()::text || '.jpg';
BEGIN
 INSERT INTO storage.objects(bucket_id, name) VALUES ('driver_evidence', v_path);
 RETURN jsonb_build_object('odometer', p_km::text, 'odometer_photo', v_path);
END $odo$;
GRANT EXECUTE ON FUNCTION pg_temp.odo(uuid, numeric) TO authenticated;
-- En la prueba el odómetro ya es obligatorio (fuera de ella rige desde el despliegue)
CREATE OR REPLACE FUNCTION public.unit_odometer_required_since() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $f$SELECT '2000-01-01'::timestamptz$f$;
DO $test$
DECLARE admin_id uuid; actor uuid; driver uuid; site uuid; carrier uuid; unit jsonb; data jsonb; r jsonb; rep jsonb; d jsonb;
  bad text; op uuid := gen_random_uuid(); pass int := 0; fails text[] := '{}';
BEGIN
 FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
   PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.is_tms_admin(); admin_id := NULL;
 END LOOP;
 SELECT id INTO actor FROM public.profiles WHERE id IN (SELECT id FROM auth.users) AND id <> admin_id
   AND id NOT IN (SELECT profile_id FROM public.drivers WHERE profile_id IS NOT NULL) LIMIT 1;
 SELECT carrier_id, site_id INTO carrier, site FROM public.vehicles WHERE carrier_id IS NOT NULL AND site_id IS NOT NULL LIMIT 1;
 IF admin_id IS NULL OR actor IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C107 FAIL: faltan administrador, perfil disponible o sede'; END IF;
 UPDATE public.profiles SET is_active = true, role_id = NULL WHERE id = actor;
 INSERT INTO public.user_site_access(user_id, site_id) VALUES (actor, site) ON CONFLICT DO NOTHING;
 INSERT INTO public.drivers(carrier_id, profile_id, first_name, last_name, document_number, license_number, is_active)
 VALUES (carrier, actor, 'Conductor', 'C107', 'ZZ-C107-DNI', 'ZZ-C107-LIC', true) RETURNING id INTO driver;
 INSERT INTO public.vehicles(plate, carrier_id, site_id, type, status, current_odometer, soat_expiration, technical_review_expiration)
 VALUES ('ZZC107A', carrier, site, 'CAMION', 'DISPONIBLE', 1000, current_date + 365, current_date + 365);
 PERFORM set_config('request.jwt.claim.sub', actor::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
 unit := public.select_driver_preuse_unit('ZZC107A');
 SELECT jsonb_build_object('format_code', 'FR-DT 007', 'format_version', '01', 'license', 'ZZ-C107-LIC',
   'soat_expiration', current_date + 365, 'technical_review_expiration', current_date + 365, 'vehicle_operational', true,
   'observation', 'Prueba C107', 'inspector_name', 'Conductor C107', 'signature', '[[{"x":0.1,"y":0.3},{"x":0.2,"y":0.5},{"x":0.4,"y":0.4},{"x":0.7,"y":0.6}]]'::jsonb,
   'answers', jsonb_agg(jsonb_build_object('code', i.code, 'response', 'B', 'comment', ''))) INTO data
 FROM public.checklist_items i JOIN public.checklist_templates t ON t.id = i.template_id WHERE t.code = 'FR_DT007';

 -- T1: el checklist exige odómetro y foto del tablero
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(), (unit->>'revision')::uuid, now(), data); bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF bad LIKE 'Ingrese el odómetro%' THEN pass := pass + 1; ELSE fails := fails || ('T1 sin odómetro: ' || COALESCE(bad, 'aceptado')); END IF;
 BEGIN PERFORM public.submit_driver_preuse(gen_random_uuid(), (unit->>'revision')::uuid, now(), data || jsonb_build_object('odometer', '1500', 'odometer_photo', actor::text || '/odometro/no-existe.jpg')); bad := NULL;
 EXCEPTION WHEN raise_exception THEN bad := SQLERRM; END;
 IF bad NOT LIKE 'Tome la foto%' OR bad IS NULL THEN fails := fails || ('T1 sin foto: ' || COALESCE(bad, 'aceptado')); END IF;

 -- T2: con odómetro y foto registra el inicio y actualiza el odómetro de la unidad
 r := public.submit_driver_preuse(op, (unit->>'revision')::uuid, now(), data || pg_temp.odo(actor, 1500));
 IF r->>'success' = 'true' AND (SELECT odometer FROM public.unit_odometer_readings WHERE operation_id = op AND kind = 'INICIO') = 1500
    AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZC107A') = 1500
    AND (public.get_driver_workday()->'start'->>'odometer')::numeric = 1500
 THEN pass := pass + 1; ELSE fails := fails || ('T2 inicio: ' || COALESCE(r::text, '∅')); END IF;

 -- T3: cerrar jornada: km del día, idempotente y una sola vez por unidad
 op := gen_random_uuid();
 r := public.close_driver_workday(op, '1620', (pg_temp.odo(actor, 1620))->>'odometer_photo', now() + interval '5 seconds');
 IF r->>'success' = 'true' AND (r->>'km')::numeric = 120
    AND (public.close_driver_workday(op, '1620', 'x', now())->>'duplicate') = 'true'
    AND (public.close_driver_workday(gen_random_uuid(), '1700', (pg_temp.odo(actor, 1700))->>'odometer_photo', now())->>'error') LIKE '%ya fue cerrada%'
    AND (public.get_driver_workday()->'close'->>'odometer')::numeric = 1620
 THEN pass := pass + 1; ELSE fails := fails || ('T3 cierre: ' || COALESCE(r::text, '∅')); END IF;

 -- T4: odómetro menor que el anterior (otra lectura del día): no bloquea, queda marcado y no retrocede la unidad
 PERFORM public.unit_odometer_record(gen_random_uuid(), 'ZZC107A', driver, (now() AT TIME ZONE 'America/Lima')::date, 'INICIO', '1400',
   (pg_temp.odo(actor, 1400))->>'odometer_photo', now() + interval '10 seconds', actor, NULL);
 r := jsonb_build_object('success', true);
 IF r->>'success' = 'true' AND EXISTS (SELECT 1 FROM public.unit_odometer_readings WHERE vehicle_plate = 'ZZC107A' AND odometer = 1400 AND flag = 'RETROCESO')
    AND (SELECT current_odometer FROM public.vehicles WHERE plate = 'ZZC107A') = 1620
 THEN pass := pass + 1; ELSE fails := fails || ('T4 retroceso: ' || COALESCE(r::text, '∅')); END IF;

 -- T5: reporte diario: el conductor no lo ve; el administrador ve odómetro, km, checklist y alertas
 IF (public.unit_daily_report('ZZC107A', current_date - 1, current_date)->>'success') = 'true' THEN fails := fails || 'T5 conductor ve reporte'::text; END IF;
 PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
 PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
 rep := public.unit_daily_report('ZZC107A', (now() AT TIME ZONE 'America/Lima')::date, (now() AT TIME ZONE 'America/Lima')::date);
 d := rep->'days'->0;
 IF rep->>'success' = 'true' AND (d->>'odo_start')::numeric = 1500 AND (d->>'checklists')::int = 1 AND (d->>'routes')::int = 0
    AND d->'alerts' ? 'ODOMETRO_RETROCEDE' AND jsonb_array_length(d->'readings') = 3
    AND (public.unit_daily_report('ZZC107A', current_date - 500, current_date)->>'success') = 'false'
    AND (SELECT count(*) FROM jsonb_array_elements(public.unit_report_plates()) p WHERE p->>'plate' = 'ZZC107A') = 1
 THEN pass := pass + 1; ELSE fails := fails || ('T5 reporte: ' || COALESCE(d::text, rep::text)); END IF;

 IF has_function_privilege('anon', 'public.unit_daily_report(text,date,date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.unit_odometer_record(uuid,text,uuid,date,text,text,text,timestamptz,uuid,uuid)', 'EXECUTE')
    OR has_table_privilege('authenticated', 'public.unit_odometer_readings', 'SELECT') THEN fails := fails || 'T6 permisos'::text; ELSE pass := pass + 1; END IF;
 IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C107 FAIL (%/6): %', pass, array_to_string(fails, ' | '); END IF;
 RAISE EXCEPTION 'CAJA C107 PASS (6/6) odómetro diario con foto (checklist y cierre de jornada), retroceso marcado y reporte diario por unidad';
END $test$;
ROLLBACK;
