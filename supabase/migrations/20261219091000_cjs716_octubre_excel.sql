-- Octubre 2026 de CJS716 se liquida exclusivamente con la hoja "BD CJS716" del Excel
-- VALORIZACION ALQUILER CJS716 H100 - CIERRE OCTUBRE v1.xlsx.
-- Filtrado por placa: 31 filas, 2,833.48 km conocidos y 15 km en blanco en la fuente.
-- La hoja "Liquidación" suma varias placas; no se usa su total agregado.
BEGIN;

ALTER TABLE public.lease_usage_records ALTER COLUMN km DROP NOT NULL;

DO $$
DECLARE
  v_vehicle uuid;
  v_contract uuid;
  v_carrier uuid;
  v_row_count integer;
  v_km numeric;
  v_missing_km integer;
  v_settlement_id uuid;
  v_status text;
  v_decision jsonb;
  v_detail jsonb;
  v_tax numeric := 661.85;
  v_subtotal numeric := 3676.92;
BEGIN
  SELECT id INTO v_vehicle
  FROM public.vehicles
  WHERE public.fe_code(plate) = 'CJS 716'
  ORDER BY id LIMIT 1;
  IF v_vehicle IS NULL THEN RAISE EXCEPTION 'No se encontró CJS716 en Flota'; END IF;

  SELECT id INTO v_contract
  FROM public.vehicle_lease_contracts
  WHERE contract_code = 'ALQ-261004-1DC1' AND vehicle_id = v_vehicle;
  -- En bases de prueba el código se genera aleatoriamente; usar el único contrato activo que cubre octubre.
  IF v_contract IS NULL THEN
    SELECT id INTO v_contract
    FROM public.vehicle_lease_contracts
    WHERE vehicle_id = v_vehicle AND status = 'ACTIVO'
      AND start_date <= DATE '2026-10-31' AND COALESCE(end_date, DATE 'infinity') >= DATE '2026-10-01'
    ORDER BY start_date DESC LIMIT 1;
  END IF;
  IF v_contract IS NULL THEN RAISE EXCEPTION 'No se encontró ALQ-261004-1DC1 vinculado a CJS716'; END IF;

  SELECT id INTO v_carrier FROM public.carriers
  WHERE upper(business_name) LIKE '%VALERIANI%'
  ORDER BY CASE WHEN upper(business_name) = 'TRANSPORTES VALERIANI' THEN 0 ELSE 1 END, id
  LIMIT 1;
  IF v_carrier IS NULL THEN RAISE EXCEPTION 'No se encontró TRANSPORTES VALERIANI en proveedores'; END IF;

  -- El archivo identifica a TRANSPORTES VALERIANI como arrendador del CJS716.
  UPDATE public.vehicle_lease_contracts
  SET provider_id = v_carrier,
      rate_type = 'MENSUAL', rate_amount = 3676.92, monthly_base_fee = 3676.92,
      included_km = 3900, excess_km_rate = 1.94, excess_km_rate_exact = 1.9428,
      days_base = 26, guarantee_amount = 2000, km_source = 'RUTA'
  WHERE id = v_contract;

  -- Reemplaza solo la importación Excel identificada para octubre; no mezcla km de la aplicación.
  DELETE FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';

  INSERT INTO public.lease_usage_records
    (vehicle_id, fecha, fuente, tipo_operacion, guia, ot_oc, area, conductor, licencia,
     cliente, zona, destino, km, km_entrega, propiedad, observaciones)
  SELECT v_vehicle, x.fecha, 'VALORIZACION_EXCEL_CIERRE_OCT_2026', x.tipo, x.guia, x.ot_oc,
         x.area, x.conductor, x.licencia, x.cliente, x.zona, x.destino,
         x.km, x.km_entrega::numeric, x.propiedad,
         CASE WHEN x.km IS NULL THEN concat_ws(' · ', x.observaciones, 'KM vacío en el Excel') ELSE x.observaciones END
  FROM (VALUES
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

  SELECT count(*), COALESCE(sum(km), 0), count(*) FILTER (WHERE km IS NULL)
  INTO v_row_count, v_km, v_missing_km
  FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';
  IF v_row_count <> 31 OR v_km <> 2833.48 OR v_missing_km <> 15 THEN
    RAISE EXCEPTION 'Verificación Excel falló: filas %, km %, sin km %', v_row_count, v_km, v_missing_km;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'fecha', fecha, 'ref', COALESCE(guia, tipo_operacion), 'ot_oc', ot_oc,
    'cliente', cliente, 'destino', destino, 'tipo', tipo_operacion,
    'conductor', conductor, 'km', km,
    'km_fuente', 'VALORIZACION_EXCEL_CIERRE_OCT_2026'
  ) ORDER BY fecha, guia NULLS LAST, ot_oc NULLS LAST), '[]'::jsonb)
  INTO v_detail
  FROM public.lease_usage_records
  WHERE vehicle_id = v_vehicle AND fecha >= DATE '2026-10-01' AND fecha < DATE '2026-11-01'
    AND fuente = 'VALORIZACION_EXCEL_CIERRE_OCT_2026';

  SELECT id, status INTO v_settlement_id, v_status
  FROM public.lease_settlements
  WHERE contract_id = v_contract AND period_start = DATE '2026-10-01' AND status <> 'ANULADA'
  ORDER BY created_at DESC LIMIT 1;
  IF v_status = 'APROBADA' THEN
    RAISE EXCEPTION 'La liquidación de octubre ya está aprobada; requiere reversa autorizada antes de reemplazarla';
  END IF;

  IF v_settlement_id IS NOT NULL THEN
    v_decision := public.decide_lease_settlement(v_settlement_id, 'ANULADA',
      'Reemplazada por la valorización del Excel de octubre 2026, filtrada exclusivamente para CJS716.');
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
     3676.92, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     v_subtotal, v_tax, v_subtotal + v_tax, 'BORRADOR',
     jsonb_build_object('success', true, 'vehicle_plate', 'CJS716', 'period_start', '2026-10-01',
       'period_end', '2026-10-31', 'days', 31, 'km_used', v_km, 'base_amount', v_subtotal,
       'included_km', 3900, 'excess_km', 0, 'excess_km_amount', 0,
       'dias_laborados', 16, 'viajes_sin_km', 15,
       'downtime_days', 0, 'downtime_discount', 0, 'km_fuente', 'VALORIZACION',
       'viajes', v_detail, 'archivo_fuente', 'VALORIZACION ALQUILER CJS716 H100 - CIERRE OCTUBRE v1.xlsx'),
     'Octubre 2026: exclusivamente hoja BD CJS716 del Excel adjunto. 31 filas; 2,833.48 km informados; 15 filas sin km.');
END $$;

COMMIT;
