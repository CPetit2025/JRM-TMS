-- C213: el ahorro por consolidación y el control de jornada corren sobre los datos reales del último mes sin error, y
-- ninguna solicitud que la pantalla deja editar está bloqueada por seguir vinculada a una ruta. Siempre se revierte.
BEGIN;
DO $$
DECLARE actor uuid; v jsonb; v_from date := (now() AT TIME ZONE 'America/Lima')::date - 30; v_to date := (now() AT TIME ZONE 'America/Lima')::date;
 v_err text; v_linked text; t0 timestamptz; ms_sav int; ms_fleet int; v_timeout text := current_setting('statement_timeout');
BEGIN
 FOR actor IN SELECT p.id FROM public.profiles p JOIN auth.users u ON u.id = p.id WHERE p.is_active LOOP
  PERFORM set_config('request.jwt.claim.sub', actor::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true);
  EXIT WHEN public.is_tms_admin(); actor := NULL;
 END LOOP;
 IF actor IS NULL THEN RAISE EXCEPTION 'CAJA C213 FAIL: falta administrador activo'; END IF;

 BEGIN
  t0 := clock_timestamp(); v := public.consolidation_savings(v_from, v_to); ms_sav := extract(epoch FROM clock_timestamp() - t0) * 1000;
  IF NOT COALESCE((v->>'success')::boolean, false) THEN v_err := 'consolidation_savings: ' || COALESCE(v->>'error', '?'); END IF;
 EXCEPTION WHEN OTHERS THEN v_err := 'consolidation_savings: ' || SQLERRM;
 END;
 IF v_err IS NULL THEN
  BEGIN
   t0 := clock_timestamp(); v := public.fleet_workdays(v_from, v_to); ms_fleet := extract(epoch FROM clock_timestamp() - t0) * 1000;
   IF NOT COALESCE((v->>'success')::boolean, false) THEN v_err := 'fleet_workdays: ' || COALESCE(v->>'error', '?'); END IF;
  EXCEPTION WHEN OTHERS THEN v_err := 'fleet_workdays: ' || SQLERRM;
  END;
 END IF;

 -- Editables en Solicitudes (mismos estados que la pantalla) pero con ruta vinculada: el guardado responde «ya no se puede editar»
 SELECT string_agg(t.request_number || ' ' || t.status || ' → ' || COALESCE(d.dispatch_number, '?') || ' ' || COALESCE(d.status, '?'), '; ')
 INTO v_linked FROM (SELECT DISTINCT ON (t.id) t.id, t.request_number, t.status, dr.dispatch_id FROM public.transport_requests t
   JOIN public.dispatch_requests dr ON dr.transport_request_id = t.id
   WHERE t.status IN ('PENDIENTE','PENDIENTE DE APROBACIÓN','REPROGRAMADA','APROBADA','OBSERVADA') ORDER BY t.id) t
 LEFT JOIN public.dispatches d ON d.id = t.dispatch_id;

 IF v_err IS NOT NULL OR v_linked IS NOT NULL THEN
  RAISE EXCEPTION 'CAJA C213 FAIL: % | editables con ruta vinculada: % | ms ahorro % jornada %', COALESCE(v_err, 'ahorro y jornada OK'), COALESCE(left(v_linked, 900), 'ninguna'), ms_sav, ms_fleet;
 END IF;
 -- Medición: la pantalla corre con el statement_timeout de authenticated; aquí se informa la duración real del mes
 RAISE EXCEPTION 'CAJA C213 PASS: ahorro y jornada corren con datos reales (ms ahorro %, jornada %; timeout sesión %, authenticated %); sin solicitudes editables bloqueadas por ruta',
  ms_sav, ms_fleet, v_timeout, COALESCE((SELECT array_to_string(r.rolconfig, ',') FROM pg_roles r WHERE r.rolname = 'authenticated'), 'sin config');
END $$;
ROLLBACK;
