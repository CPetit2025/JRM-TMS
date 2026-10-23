-- CAJA C136 — Mantenimiento de flota: importación idempotente al registro único (dato original y corregido),
-- equivalencias de activos y proveedores, fe_maint derivado, reglas de las OT (tipo, ingreso y salida de taller,
-- lectura validada, moneda e IGV) y registro de activos. Datos sintéticos; todo se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_user uuid; v_role uuid := gen_random_uuid(); v_carrier uuid; v_eq uuid; v_vh uuid; v_imp uuid; r jsonb; v_err text; v_wo uuid; v_id uuid;
  pass int := 0; fails text[] := '{}'; v_rows jsonb; v_t0 timestamptz := date_trunc('day', now()) - interval '10 days';
BEGIN
  SELECT p.id INTO v_user FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  SELECT id INTO v_carrier FROM public.carriers ORDER BY created_at NULLS LAST LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C136 FAIL: no hay perfiles con usuario'; END IF;
  INSERT INTO public.vehicles (plate, carrier_id, type, brand, model) VALUES ('C136-EQ1', v_carrier, 'MONTACARGAS', 'Prueba', 'Equipo') RETURNING id INTO v_eq;
  INSERT INTO public.vehicles (plate, carrier_id, type, brand, model) VALUES ('C136-VH1', v_carrier, 'CAMION', 'Prueba', 'Camión') RETURNING id INTO v_vh;
  UPDATE public.vehicles SET asset_class = 'MONTACARGAS', meter_type = 'HORAS' WHERE id = v_eq;
  UPDATE public.vehicles SET asset_class = 'VEHICULAR', meter_type = 'KM' WHERE id = v_vh;

  -- T1: importación por conexión de servicio (sin usuario): alias, filas, repetición idempotente y corrección
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  v_imp := public.mant_import_begin('{"archivo": "C136.xlsx", "huella": "c134", "hoja": "CONSOLIDADO", "filas": 3}');
  PERFORM public.mant_import_alias('[{"nombre": "C136-EQ1"}, {"nombre": "C136 vh1"}]',
    '[{"nombre": "C136 BECERRA DONAYRES MAURO", "canonico": "C136 BECERRA DONAIRES MAURO", "nota": "Agrupado por similitud (revisar)"},
      {"nombre": "C136 BECERRA DONAIRES MAURO", "canonico": "C136 BECERRA DONAIRES MAURO"}]');
  v_rows := jsonb_build_array(
    jsonb_build_object('clave_natural', 'c134|1', 'hoja', 'CONSOLIDADO', 'fila', 2, 'fila_original', '{"ACTIVO": "C136-EQ1", "TIPO_ORIGEN": "PREVENTIVO", "KM_HRS": 1500}'::jsonb,
      'activo_original', 'C136-EQ1', 'clase_activo', 'MONTACARGA', 'fecha', '2025-03-03', 'proveedor_original', 'C136 BECERRA DONAYRES MAURO', 'factura', 'F001-1',
      'monto', 1000, 'moneda', 'PEN', 'monto_pen', 1000, 'descripcion', 'Reparación de bomba hidráulica', 'tipo', 'CORRECTIVO', 'tipo_origen', 'PREVENTIVO',
      'criterio_tipo', 'Reparación en la descripción', 'km_hrs_original', 1500, 'km_hrs_validado', 1500, 'obs_medidor', 'OK'),
    jsonb_build_object('clave_natural', 'c134|2', 'hoja', 'CONSOLIDADO', 'fila', 3, 'activo_original', 'C136 vh1', 'clase_activo', 'UNIDAD VEHICULAR', 'fecha', '2025-03-04',
      'proveedor_original', 'C136 BECERRA DONAIRES MAURO', 'factura', 'F001-2', 'monto', 500, 'moneda', 'PEN', 'monto_pen', 500, 'descripcion', 'Cambio de aceite y filtros',
      'tipo', 'PREVENTIVO', 'tipo_origen', 'PREVENTIVO', 'km_hrs_original', 999999, 'km_hrs_validado', NULL, 'obs_medidor', 'PICO', 'faltantes', '["RQ"]'::jsonb));
  r := public.mant_import_rows(v_imp, v_rows);
  IF (r->>'insertados')::int = 2 AND (public.mant_import_rows(v_imp, v_rows)->>'sin_cambio')::int = 2
     AND (SELECT count(*) FROM public.mant_registros WHERE clave_natural LIKE 'c134|%') = 2
     AND (SELECT vehicle_id FROM public.mant_registros WHERE clave_natural = 'c134|1') = v_eq
     AND (SELECT vehicle_id FROM public.mant_registros WHERE clave_natural = 'c134|2') = v_vh
     AND (SELECT provider_id FROM public.mant_registros WHERE clave_natural = 'c134|1') = (SELECT provider_id FROM public.mant_registros WHERE clave_natural = 'c134|2')
     AND (SELECT ruc FROM public.maintenance_providers mp JOIN public.mant_registros m ON m.provider_id = mp.id WHERE m.clave_natural = 'c134|1') LIKE 'PENDIENTE-%'
  THEN pass := pass + 1; ELSE fails := fails || ('T1 import ' || r::text); END IF;

  -- T2: una corrección (mismo registro) se actualiza sin tocar el dato original; fe_maint se deriva del registro único
  v_rows := jsonb_set(v_rows, '{1,obs_medidor}', '"OK"');
  v_rows := jsonb_set(v_rows, '{1,km_hrs_validado}', '120000');
  r := public.mant_import_rows(v_imp, v_rows);
  PERFORM public.mant_import_finish(v_imp, '{"rechazados": 0, "dudosos": 1}');
  IF (r->>'actualizados')::int = 1 AND (SELECT km_hrs_original FROM public.mant_registros WHERE clave_natural = 'c134|2') = 999999
     AND (SELECT km_hrs_validado FROM public.mant_registros WHERE clave_natural = 'c134|2') = 120000
     AND (SELECT tipo_origen || '>' || tipo FROM public.mant_registros WHERE clave_natural = 'c134|1') = 'PREVENTIVO>CORRECTIVO'
     AND EXISTS (SELECT 1 FROM public.fe_maint WHERE asset_code = public.fe_code('C136-EQ1') AND tipo = 'PREVENTIVO' AND tipo_real = 'CORRECTIVO' AND monto = 1000)
     AND (SELECT count(*) FROM public.fe_maint) = (SELECT count(*) FROM public.mant_registros WHERE origen = 'EXCEL')
     AND EXISTS (SELECT 1 FROM public.mant_lecturas WHERE vehicle_id = v_eq AND origen = 'EXCEL' AND valor = 1500 AND obs_calidad = 'OK')
  THEN pass := pass + 1; ELSE fails := fails || ('T2 corrección ' || r::text); END IF;

  -- T3: una reparación o un cambio de componente nunca es preventivo (funciona igual en la OT)
  BEGIN
    INSERT INTO public.maintenance_work_orders (ot_number, vehicle_plate, vehicle_id, type, order_type, status, description)
    VALUES ('C136-OT0', 'C136-EQ1', v_eq, 'PREVENTIVO', 'PREVENTIVA', 'BORRADOR', 'Cambio de motor de tracción');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err LIKE '%cambio de componente%' AND public.mant_tipo_violacion('PREVENTIVO', 'Cambio de aceite y filtro de aire') IS NULL
     AND public.mant_tipo_violacion('PREVENTIVO', 'Se reparó la fuga del cilindro') IS NOT NULL AND public.mant_tipo_violacion('CORRECTIVO', 'Reparación') IS NULL
  THEN pass := pass + 1; ELSE fails := fails || ('T3 tipo ' || COALESCE(v_err, '∅')); END IF;

  -- T4: terminar exige ingreso y salida de taller y lectura; la lectura que retrocede pide motivo
  INSERT INTO public.maintenance_work_orders (ot_number, vehicle_plate, vehicle_id, type, order_type, status, description, total_cost)
  VALUES ('C136-OT1', 'C136-EQ1', v_eq, 'CORRECTIVO', 'CORRECTIVA', 'EN_PROCESO', 'Cambio de batería de tracción', 800) RETURNING id INTO v_wo;
  INSERT INTO public.mant_lecturas (vehicle_id, fecha_at, valor, unidad, origen) VALUES (v_eq, v_t0, 2000, 'HORAS', 'MANUAL');
  BEGIN UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE id = v_wo; v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%ingreso y de salida de taller%' THEN fails := fails || ('T4a sin taller ' || COALESCE(v_err, '∅')); END IF;
  UPDATE public.maintenance_work_orders SET downtime_start = v_t0 + interval '9 days', downtime_end = v_t0 + interval '10 days' WHERE id = v_wo;
  BEGIN UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE id = v_wo; v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%Falta la lectura del horómetro%' THEN fails := fails || ('T4b sin lectura ' || COALESCE(v_err, '∅')); END IF;
  UPDATE public.maintenance_work_orders SET meter_reading = 1900 WHERE id = v_wo;
  BEGIN UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE id = v_wo; v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%menor que la anterior%' THEN fails := fails || ('T4c retroceso ' || COALESCE(v_err, '∅')); END IF;
  UPDATE public.maintenance_work_orders SET meter_reading = 2050 WHERE id = v_wo;
  BEGIN UPDATE public.maintenance_work_orders SET status = 'TERMINADA' WHERE id = v_wo; v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF v_err NOT LIKE '%moneda%IGV%' THEN fails := fails || ('T4d moneda ' || COALESCE(v_err, '∅')); END IF;
  UPDATE public.maintenance_work_orders SET currency = 'PEN', includes_igv = true, status = 'TERMINADA' WHERE id = v_wo;
  IF (SELECT status FROM public.maintenance_work_orders WHERE id = v_wo) = 'TERMINADA'
     AND EXISTS (SELECT 1 FROM public.mant_lecturas WHERE origen = 'ORDEN' AND ref_id = v_wo AND valor = 2050 AND obs_calidad = 'OK')
  THEN pass := pass + 1; ELSE fails := fails || 'T4 OT terminada'; END IF;

  -- T5: salto de más de 16 h/día (equipo) y 1.200 km/día (vehículo); con motivo se confirma
  r := public.mant_lectura_check(v_eq, v_t0 + interval '11 days', 2100, 'HORAS');
  IF r->>'obs' = 'SALTO ANÓMALO' AND public.mant_lectura_check(v_eq, v_t0 + interval '11 days', 2060, 'HORAS')->>'obs' = 'OK'
     AND public.mant_lectura_check(v_vh, v_t0 + interval '1 day', 1, 'KM')->>'obs' = 'RETROCESO'
  THEN pass := pass + 1; ELSE fails := fails || ('T5 salto ' || r::text); END IF;
  INSERT INTO public.mant_lecturas (vehicle_id, fecha_at, valor, unidad, origen) VALUES (v_vh, v_t0, 50000, 'KM', 'MANUAL');
  IF public.mant_lectura_check(v_vh, v_t0 + interval '1 day', 51300, 'KM')->>'obs' <> 'SALTO ANÓMALO' THEN fails := fails || 'T5 km'; END IF;

  -- T6: registrar un activo nuevo (transpaleta ERE120) con clase, medidor y área; la baja exige motivo
  INSERT INTO public.roles (id, name, permissions) VALUES (v_role, 'C136-flota-' || left(v_role::text, 8), '["mantenimiento-flota:write","mantenimiento-finanzas:write"]');
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  r := public.mant_activo_guardar('{"plate": "C136-ERE120", "display_name": "Transpaleta eléctrica ERE120", "asset_class": "TRANSPALETA", "meter_type": "HORAS", "assigned_area": "Producción"}');
  v_id := (r->>'id')::uuid;
  BEGIN PERFORM public.mant_activo_guardar(jsonb_build_object('id', v_id, 'asset_class', 'TRANSPALETA', 'meter_type', 'HORAS', 'decommissioned_at', '2026-10-01'));
    v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF (SELECT type || '/' || asset_class || '/' || meter_type || '/' || assigned_area FROM public.vehicles WHERE id = v_id) = 'TRANSPALETA/TRANSPALETA/HORAS/Producción'
     AND v_err LIKE '%motivo de la baja%'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(public.mant_activos_lista()) x WHERE x->>'plate' = 'C136-ERE120')
  THEN pass := pass + 1; ELSE fails := fails || ('T6 activo ' || COALESCE(v_err, '∅')); END IF;

  -- T7: revisar una equivalencia de proveedor reasigna sus registros; un usuario sin permiso no importa
  r := public.mant_alias_revisar('PROVEEDOR', public.mant_norm('C136 BECERRA DONAYRES MAURO'),
    (SELECT provider_id FROM public.mant_proveedor_alias WHERE nombre_norm = public.mant_norm('C136 BECERRA DONAIRES MAURO')), 'Mismo proveedor');
  UPDATE public.roles SET permissions = '["mantenimiento-flota:read"]' WHERE id = v_role;
  BEGIN PERFORM public.mant_import_begin('{"archivo": "x", "huella": "x"}'); v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF (SELECT revisado FROM public.mant_proveedor_alias WHERE nombre_norm = public.mant_norm('C136 BECERRA DONAYRES MAURO')) AND v_err LIKE '%Sin permiso%'
  THEN pass := pass + 1; ELSE fails := fails || ('T7 equivalencias ' || COALESCE(v_err, '∅')); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C136 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C136 PASS (7/7) Mantenimiento de flota: importación idempotente, fe_maint derivado, reglas de OT y activos';
END $test$;
ROLLBACK;
