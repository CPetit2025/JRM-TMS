-- Reemplaza la carga parcial de octubre por las 56 filas de CJS716 de la hoja BD CJS716.
-- Excel fuente: VALORIZACION ALQUILER CJS716 H100 - CIERRE OCTUBRE v1.xlsx.
-- Octubre: 56 viajes, 4,148.90 km medidos, 17 vacíos. Se conserva agosto y setiembre (89 filas ya coincidentes).
BEGIN;

ALTER TABLE public.lease_usage_records ALTER COLUMN km DROP NOT NULL;

DO $$
DECLARE
  v_vehicle uuid;
  v_contract uuid;
  v_count integer;
  v_km numeric;
  v_missing integer;
  v_settlement uuid;
  v_status text;
  v_decision jsonb;
  v_detail jsonb;
  v_subtotal numeric := 4160.48;
  v_tax numeric := 748.89;
BEGIN
  SELECT id INTO v_vehicle FROM public.vehicles
  WHERE public.fe_code(plate) = 'CJS 716' ORDER BY id LIMIT 1;
  IF v_vehicle IS NULL THEN RAISE EXCEPTION 'No se encontró CJS716'; END IF;

  SELECT id INTO v_contract FROM public.vehicle_lease_contracts
  WHERE vehicle_id = v_vehicle AND status = 'ACTIVO'
    AND start_date <= DATE '2026-10-31' AND COALESCE(end_date, DATE 'infinity') >= DATE '2026-10-01'
  ORDER BY start_date DESC LIMIT 1;
  IF v_contract IS NULL THEN RAISE EXCEPTION 'No se encontró contrato activo de CJS716 para octubre'; END IF;

  -- Solo se reemplazan las filas del Excel, sin tocar registros de rutas, GPS ni otros periodos.
  DELETE FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';

  INSERT INTO public.lease_usage_records
    (vehicle_id, fecha, fuente, tipo_operacion, guia, ot_oc, area, conductor, licencia,
     cliente, zona, destino, km, km_entrega, propiedad, observaciones)
  SELECT v_vehicle, x.fecha, 'VALORIZACION_EXCEL_CIERRE_OCT_2026', x.tipo, x.guia, x.ot_oc::text,
         x.area, x.conductor, x.licencia, x.cliente, x.zona, x.destino, x.km, x.km_entrega::numeric,
         x.propiedad, x.observaciones
  FROM (VALUES
      (DATE '2026-10-01', 'RECOJO DE ORDENES DE COMPRA', 'T005-0199194', '57700', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501330', 'ESTANTERIAS METALICAS JRM SAC ', NULL, 'La Victoria', 72, NULL, 'TERCERO', NULL),
      (DATE '2026-10-01', 'ENVIO O RECOJO DE SERVICIOS', 'T002-04072', '65698', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501331', 'SERVICIOS GALVANICOS MENDOZA S.A.C.', NULL, 'Puente Piedra', 108, NULL, 'TERCERO', NULL),
      (DATE '2026-10-01', 'RECOJO DE ORDENES DE COMPRA', 'T001-06564', '57708', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501332', 'AUTOMAQ CORPORATION S.A.C.', NULL, 'Lima Cercado', 6, NULL, 'TERCERO', NULL),
      (DATE '2026-10-01', 'RECOJO DE ORDENES DE COMPRA', 'T002-021600', '57685', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501333', 'ESTANTERIAS METALICAS JRM SAC ', NULL, 'La Victoria', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-02', 'RECOJO DE ORDENES DE COMPRA', 'T001-012297', '57176', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501334', 'Corporacion Klar del Peru E.I.R.L.', NULL, 'Lurin', 48, NULL, 'TERCERO', NULL),
      (DATE '2026-10-02', 'RECOJO DE ORDENES DE COMPRA', 'T001-01220', '57710', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501335', 'C & V Industrias E.I.R.L.', NULL, 'NA', 26, NULL, 'TERCERO', NULL),
      (DATE '2026-10-02', 'RECOJO DE ORDENES DE COMPRA', 'EG07-00463', '57728', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501336', 'ESTANTERIAS METALICAS JRM SAC ', NULL, 'La Victoria', 42, NULL, 'TERCERO', NULL),
      (DATE '2026-10-03', 'DESPACHO DE CONTRATOS', 'T001-0617', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'RINTI S.A.', NULL, 'Ate', 98, NULL, 'TERCERO', NULL),
      (DATE '2026-10-03', 'RECOJO DE ORDENES DE COMPRA', 'T001-08691', '57744', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'INKABOLT S.A.C.', NULL, 'Punta Hermosa', 108, NULL, 'TERCERO', NULL),
      (DATE '2026-10-05', 'TRASLADO INTERNO DE JRM', NULL, NULL, 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'MERCADO MAYORISTA', NULL, 'Santa Anita', 90, NULL, 'TERCERO', NULL),
      (DATE '2026-10-05', 'RECOJO DE ORDENES DE COMPRA', 'T001-02957', '57735', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'CIA FERRETERA MECANICA E INDUSTRIAL S.A.C.', NULL, 'Lima Cercado', 52, NULL, 'TERCERO', NULL),
      (DATE '2026-10-05', 'TRASLADO INTERNO DE JRM', 'T002-024078', NULL, 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'ESTANTERIAS METALICAS JRM SAC ', NULL, 'La Victoria', 14, NULL, 'TERCERO', NULL),
      (DATE '2026-10-05', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 19, NULL, 'TERCERO', NULL),
      (DATE '2026-10-06', 'MANTENIMIENTO', NULL, NULL, 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', NULL, NULL, NULL, 17, NULL, 'TERCERO', NULL),
      (DATE '2026-10-06', 'RECOJO DE ORDENES DE COMPRA', 'T001-003947', '57712', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 28, NULL, 'TERCERO', NULL),
      (DATE '2026-10-07', 'DESPACHO DE CONTRATOS', 'T001-03947', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'RINTI S.A.', NULL, 'Ate', 30, NULL, 'TERCERO', NULL),
      (DATE '2026-10-07', 'RECOJO DE ORDENES DE COMPRA', 'T001-02370', '57697', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'ESTANTERIAS METALICAS JRM SAC ', NULL, 'La Victoria', 21, NULL, 'TERCERO', NULL),
      (DATE '2026-10-07', 'RECOJO DE ORDENES DE COMPRA', 'T001-55290', '57764', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'COROIMPORT S.A.C.', NULL, 'Lima Cercado', 15, NULL, 'TERCERO', NULL),
      (DATE '2026-10-07', 'RECOJO DE ORDENES DE COMPRA', 'T001-04001', '57712', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 16, NULL, 'TERCERO', NULL),
      (DATE '2026-10-07', 'DESPACHO DE CONTRATOS', 'T001-04001', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'RINTI S.A.', NULL, 'Ate', 60, NULL, 'TERCERO', NULL),
      (DATE '2026-10-09', 'TRASLADO INTERNO DE JRM', 'T002-04100', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'RINTI S.A.', NULL, 'Ate', 26, NULL, 'TERCERO', NULL),
      (DATE '2026-10-09', 'TRASLADO INTERNO DE JRM', 'T002-04100', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'PROMOTORES ELECTRICOS S.A. PROMELSA', NULL, 'La Victoria', 101, NULL, 'TERCERO', NULL),
      (DATE '2026-10-09', 'ENVIO O RECOJO DE SERVICIOS', 'EG07-0119', '65299', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501337', 'SERVICIOS GALVANICOS MENDOZA S.A.C.', NULL, 'Puente Piedra', 179, NULL, 'TERCERO', NULL),
      (DATE '2026-10-10', 'RECOJO DE ORDENES DE COMPRA', NULL, 'OC57775', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501328', NULL, NULL, 'CHILCA', 139.42, NULL, 'TERCERO', NULL),
      (DATE '2026-10-10', 'RECOJO DE ORDENES DE COMPRA', NULL, 'OC57797', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501329', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-12', 'RECOJO DE ORDENES DE COMPRA', 'TE01-0928', 'OC57724', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 180, NULL, 'TERCERO', NULL),
      (DATE '2026-10-12', 'RECOJO DE ORDENES DE COMPRA', 'T002-4115', 'OC57793', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-13', 'RECOJO DE ORDENES DE COMPRA', 'T001-0049', 'OC57684', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 190, NULL, 'TERCERO', NULL),
      (DATE '2026-10-14', 'DESPACHO DE CONTRATOS', 'T003-5534', '16544', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'FARGOLINE SOCIEDAD ANONIMA - FARGOLINE S.A.', NULL, 'CALLAO', 180, NULL, 'TERCERO', NULL),
      (DATE '2026-10-14', 'RECOJO DE ORDENES DE COMPRA', 'T001-11870', 'OC57862', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-16', 'DESPACHO DE CONTRATOS', 'T001-6797', '16339', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'TIENDAS SUPERPET SOCIEDAD ANONIMA CERRADA - TIENDAS SUPERPET S.A.C.', NULL, 'PUNTA HERMOSA', 75, NULL, 'TERCERO', NULL),
      (DATE '2026-10-16', 'DESPACHO DE CONTRATOS', 'T001-6799', '16420', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'COMPAÑIA HARD DISCOUNT S.A.C.', NULL, 'PUNTA HERMOSA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-17', 'RECOJO DE ORDENES DE COMPRA', 'T001-12024', 'OC57889', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 141.77, NULL, 'TERCERO', NULL),
      (DATE '2026-10-19', 'DESPACHO DE CONTRATOS', 'T001-6811', '16533', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SUNNY CORNER EXPLORATION INTERNATIONAL PERU SOCIEDAD ANONIMA CERRADA', NULL, 'LURIN', 80, NULL, 'TERCERO', NULL),
      (DATE '2026-10-20', 'DESPACHO DE CONTRATOS', 'T003-5548', '16101', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'METALPREN S A', NULL, 'CERCADO DE LIMA', 180.74, NULL, 'TERCERO', NULL),
      (DATE '2026-10-21', 'RECOJO DE ORDENES DE COMPRA', 'T001-13155', 'OC57933', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 207.73, NULL, 'TERCERO', NULL),
      (DATE '2026-10-22', 'DESPACHO DE CONTRATOS', 'T003-5560', '16543', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'INTEGRA RETAIL S.A.C.', NULL, 'CHORRILLOS', 247.38, NULL, 'TERCERO', NULL),
      (DATE '2026-10-22', 'DESPACHO DE CONTRATOS', 'T001-6827', '16542', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SOLUCIONES VETERINARIAS S.A.C.', NULL, 'LURIN', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-22', 'RECOJO DE ORDENES DE COMPRA', 'T002-4140', 'OS66049', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'VILLA EL SALVADOR', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-23', 'RECOJO DE ORDENES DE COMPRA', 'T001-510', 'OC57836', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 171.31, NULL, 'TERCERO', NULL),
      (DATE '2026-10-23', 'RECOJO DE ORDENES DE COMPRA', 'T001-820', 'OC57941', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-23', 'RECOJO DE ORDENES DE COMPRA', 'T001-12145', 'OC57934', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-23', 'DESPACHO DE CONTRATOS', 'T003-5564', '16335', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'EMBOTELLADORA SAN MIGUEL DEL SUR S.A.C', NULL, 'LA VICTORIA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-24', 'RECOJO DE ORDENES DE COMPRA', 'T001-1568', 'OC57930', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 104.97, NULL, 'TERCERO', NULL),
      (DATE '2026-10-24', 'RECOJO DE ORDENES DE COMPRA', NULL, 'OC57869', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'SAN JUAN DE LURIGRANCHO', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-27', 'DESPACHO DE CONTRATOS', 'T001-6848', '16101', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'METALPREN S A', NULL, 'CERCADO DE LIMA', 268.12, NULL, 'TERCERO', NULL),
      (DATE '2026-10-27', 'RECOJO DE ORDENES DE COMPRA', 'T001-5005', 'OS64565', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-28', 'DESPACHO DE CONTRATOS', 'T001-6857', '16460', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'NESTLE PERU S A', NULL, 'CERCADO DE LIMA', 281.29, NULL, 'TERCERO', NULL),
      (DATE '2026-10-28', 'RECOJO DE ORDENES DE COMPRA', 'T001-1242', 'OC58003', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-29', 'RECOJO DE ORDENES DE COMPRA', 'TE01-973', 'OC57888', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', 119.14, NULL, 'TERCERO', NULL),
      (DATE '2026-10-29', 'RECOJO DE ORDENES DE COMPRA', 'T011-158497', 'OC57999', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-29', 'RECOJO DE ORDENES DE COMPRA', 'T001-12203', 'OC57937', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-30', 'DESPACHO DE CONTRATOS', 'T003-5576', '16101', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'METALPREN S A', NULL, 'CERCADO DE LIMA', 227.24, NULL, 'TERCERO', NULL),
      (DATE '2026-10-30', 'RECOJO DE ORDENES DE COMPRA', 'T002-4164', 'OSSRE0001', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'COMAS', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-30', 'RECOJO DE ORDENES DE COMPRA', 'T001-4257', 'OC58030', 'Compras', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, 'CHILCA', NULL, NULL, 'TERCERO', NULL),
      (DATE '2026-10-31', 'DESPACHO DE CONTRATOS', 'T001-6867', '16534', 'Contratos', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SOCIEDAD AGRICOLA DROKASA S.A.', NULL, 'LA VICTORIA', 178.79, NULL, 'TERCERO', NULL)
  ) AS x(fecha, tipo, guia, ot_oc, area, conductor, licencia, cliente, zona, destino, km, km_entrega, propiedad, observaciones);

  SELECT count(*), COALESCE(sum(km),0), count(*) FILTER (WHERE km IS NULL)
  INTO v_count, v_km, v_missing
  FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';
  IF v_count <> 56 OR v_km <> 4148.90 OR v_missing <> 17 THEN
    RAISE EXCEPTION 'Validación Excel octubre falló: filas %, km %, faltantes %', v_count, v_km, v_missing;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'fecha', fecha, 'ref', COALESCE(guia, tipo_operacion), 'ot_oc', ot_oc,
    'cliente', cliente, 'destino', destino, 'tipo', tipo_operacion,
    'conductor', conductor, 'km', km,
    'km_fuente', 'VALORIZACION_EXCEL_CIERRE_OCT_2026'
  ) ORDER BY fecha, guia NULLS LAST, ot_oc NULLS LAST), '[]'::jsonb)
  INTO v_detail FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';

  SELECT id, status INTO v_settlement, v_status FROM public.lease_settlements
  WHERE contract_id = v_contract AND period_start = DATE '2026-10-01' AND status <> 'ANULADA'
  ORDER BY created_at DESC LIMIT 1;
  IF v_status = 'APROBADA' THEN
    RAISE EXCEPTION 'La liquidación de octubre está aprobada; se requiere reversa autorizada antes de reemplazarla';
  END IF;
  IF v_settlement IS NOT NULL THEN
    v_decision := public.decide_lease_settlement(v_settlement, 'ANULADA',
      'Reemplazada por la versión completa del Excel de octubre 2026, filtrada por placa CJS716.');
    IF NOT COALESCE((v_decision ->> 'success')::boolean, false) THEN
      RAISE EXCEPTION 'No se pudo anular el borrador previo de octubre: %', v_decision ->> 'error';
    END IF;
  END IF;

  INSERT INTO public.lease_settlements
    (contract_id, vehicle_id, period_start, period_end, days, hours_used, km_used, downtime_days,
     base_amount, excess_km, excess_km_amount, excess_hours, excess_hours_amount, downtime_discount,
     other_discounts, penalties, consumptions, additional_costs, subtotal, tax, total, status, detail, notes)
  VALUES
    (v_contract, v_vehicle, DATE '2026-10-01', DATE '2026-10-31', 31, 0, v_km, 0,
     3676.92, 248.90, 483.56, 0, 0, 0, 0, 0, 0, 0,
     v_subtotal, v_tax, v_subtotal + v_tax, 'BORRADOR',
     jsonb_build_object('success', true, 'vehicle_plate', 'CJS716', 'period_start', '2026-10-01',
       'period_end', '2026-10-31', 'days', 31, 'km_used', v_km, 'base_amount', 3676.92,
       'included_km', 3900, 'excess_km', 248.90, 'excess_km_amount', 483.56,
       'dias_laborados', 27, 'viajes_sin_km', 17, 'downtime_days', 0, 'downtime_discount', 0,
       'km_fuente', 'VALORIZACION', 'viajes', v_detail,
       'archivo_fuente', 'VALORIZACION ALQUILER CJS716 H100 - CIERRE OCTUBRE v1.xlsx'),
     'Octubre 2026: hoja BD CJS716 del Excel adjunto. 56 filas; 4,148.90 km informados; 17 filas sin km.');
END $$;

COMMIT;
