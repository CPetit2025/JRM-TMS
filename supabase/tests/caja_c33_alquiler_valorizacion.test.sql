-- CAJA C33 — Alquiler CJS716 (Hyundai H100, Transportes Valeriani): valorización de agosto y setiembre 2026 y km por ruta.
--   T1 contrato con los factores del Excel (mensual 3.676,92, 3.900 km, km adicional 1,9428, base 26 días, garantía 2.000,
--   km por ruta); T2 agosto = Excel (4.293 km, exceso 393, S/ 763,52, subtotal 4.440,44); T3 setiembre = Excel (3.981 km,
--   exceso 81, S/ 157,37, subtotal 3.834,29) con el GPS como control (km fuera de ruta); T4 liquidaciones de agosto y
--   setiembre registradas; T5 89 viajes y 30 días de GPS cargados; T6 octubre en adelante sale de las rutas del sistema;
--   T7 un contrato por odómetro sigue igual que antes; T8 sin permiso no se calcula. Solo lectura (se revierte).
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE v_user uuid; r_p uuid; r_n uuid; c record; r jsonb; ago jsonb; sep jsonb; v_fail text[] := '{}'; v_pass int := 0; n int; v_rep text;
BEGIN
  SELECT id INTO v_user FROM public.profiles WHERE id IN (SELECT u2.id FROM auth.users u2)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C33 liquida', '["caja-liquidaciones"]') RETURNING id INTO r_p;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ C33 nada', '["clientes"]') RETURNING id INTO r_n;
  UPDATE public.profiles SET role_id = r_p, is_active = true WHERE id = v_user;

  SELECT k.* INTO c FROM public.vehicle_lease_contracts k JOIN public.vehicles v ON v.id = k.vehicle_id
  WHERE public.fe_code(v.plate) = 'CJS 716' AND k.status = 'ACTIVO' ORDER BY k.start_date DESC LIMIT 1;
  IF c.id IS NULL THEN RAISE EXCEPTION 'CAJA C33 FAIL (0/8): no hay contrato activo de CJS716'; END IF;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (v_user, c.site_id) ON CONFLICT DO NOTHING;

  -- T1
  IF c.rate_type = 'MENSUAL' AND c.rate_amount = 3676.92 AND c.included_km = 3900 AND c.excess_km_rate_exact = 1.9428
     AND c.days_base = 26 AND c.guarantee_amount = 2000 AND c.km_source = 'RUTA' AND c.start_date = DATE '2026-08-01'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 contrato'::text; END IF;

  -- T2 y T3
  PERFORM pg_temp.as_user(v_user);
  ago := public.calculate_lease_settlement(c.id, DATE '2026-08-01', DATE '2026-08-31');
  sep := public.calculate_lease_settlement(c.id, DATE '2026-09-01', DATE '2026-09-30');
  PERFORM pg_temp.as_user(NULL);
  IF (ago ->> 'success')::boolean AND ago ->> 'km_fuente' = 'VALORIZACION' AND (ago ->> 'km_used')::numeric = 4293
     AND (ago ->> 'excess_km')::numeric = 393 AND (ago ->> 'excess_km_amount')::numeric = 763.52 AND (ago ->> 'subtotal')::numeric = 4440.44
     AND (ago ->> 'costo_diario')::numeric = 141.42
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 agosto: ' || left(ago::text, 250)); END IF;
  IF (sep ->> 'success')::boolean AND sep ->> 'km_fuente' = 'VALORIZACION' AND (sep ->> 'km_used')::numeric = 3981
     AND (sep ->> 'excess_km')::numeric = 81 AND (sep ->> 'excess_km_amount')::numeric = 157.37 AND (sep ->> 'subtotal')::numeric = 3834.29
     AND (sep ->> 'km_gps')::numeric = 4727.38 AND (sep ->> 'km_fuera_de_ruta')::numeric = 746.38
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 setiembre: ' || left(sep::text, 250)); END IF;

  -- T4
  SELECT count(*) INTO n FROM public.lease_settlements
  WHERE contract_id = c.id AND status <> 'ANULADA'
    AND ((period_start = DATE '2026-08-01' AND subtotal = 4440.44) OR (period_start = DATE '2026-09-01' AND subtotal = 3834.29));
  IF n = 2 THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 liquidaciones: ' || n); END IF;

  -- T5
  IF (SELECT count(*) FROM public.lease_usage_records WHERE vehicle_id = c.vehicle_id AND fecha BETWEEN DATE '2026-08-01' AND DATE '2026-09-30') = 89
     AND (SELECT count(*) FROM public.lease_gps_days WHERE vehicle_id = c.vehicle_id AND fecha BETWEEN DATE '2026-09-01' AND DATE '2026-09-30') = 30
     AND jsonb_array_length(ago -> 'viajes') + jsonb_array_length(sep -> 'viajes') = 89
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T5 carga'::text; END IF;

  -- T6
  PERFORM pg_temp.as_user(v_user); r := public.calculate_lease_settlement(c.id, DATE '2026-10-01', DATE '2026-10-31'); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND r ->> 'km_fuente' = 'RUTA' AND (r ->> 'base_amount')::numeric = 3676.92 THEN v_pass := v_pass + 1;
  ELSE v_fail := v_fail || ('T6 octubre: ' || left(r::text, 200)); END IF;
  v_rep := 'ago ' || (ago ->> 'subtotal') || ' (' || (ago ->> 'km_used') || ' km), set ' || (sep ->> 'subtotal') || ' (' || (sep ->> 'km_used')
        || ' km, GPS ' || (sep ->> 'km_gps') || ', fuera de ruta ' || (sep ->> 'km_fuera_de_ruta') || '), oct a la fecha '
        || COALESCE(r ->> 'km_used', '?') || ' km en ' || COALESCE(jsonb_array_length(r -> 'viajes')::text, '?') || ' viajes';

  -- T7
  UPDATE public.vehicle_lease_contracts SET km_source = 'ODOMETRO' WHERE id = c.id;
  PERFORM pg_temp.as_user(v_user); r := public.calculate_lease_settlement(c.id, DATE '2026-10-01', DATE '2026-10-31'); PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND r ->> 'km_fuente' = 'ODOMETRO' AND (r ->> 'km_used')::numeric = (r ->> 'km_odometro')::numeric
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 odómetro: ' || left(r::text, 200)); END IF;

  -- T8
  UPDATE public.profiles SET role_id = r_n WHERE id = v_user;
  PERFORM pg_temp.as_user(v_user); r := public.calculate_lease_settlement(c.id, DATE '2026-08-01', DATE '2026-08-31'); PERFORM pg_temp.as_user(NULL);
  IF NOT (r ->> 'success')::boolean THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T8 sin permiso'::text; END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C33 PASS (%/8) %', v_pass, v_rep;
  ELSE
    RAISE EXCEPTION 'CAJA C33 FAIL (%/8): % || %', v_pass, array_to_string(v_fail, ' || '), v_rep;
  END IF;
END $test$;
