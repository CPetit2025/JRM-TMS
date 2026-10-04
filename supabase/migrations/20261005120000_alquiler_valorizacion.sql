-- 20261005120000_alquiler_valorizacion.sql
-- Alquiler seco por valorización (CJS716 · H100 · Transportes Valeriani) y km según la ruta.
--
-- * Contrato: parámetros de la valorización del arrendador — base de 26 días (costo diario = alquiler / 26),
--   tarifa exacta del km adicional (precio del km incluido + S/ 1 = 3.676,92 / 3.900 + 1 = S/ 1,9428), garantía y
--   fuente de los km a liquidar (ODOMETRO como antes o RUTA: los viajes del sistema y la app).
-- * lease_usage_records: viajes valorizados importados (agosto y setiembre 2026, Excel del arrendador). Solo sirven
--   para esos meses: desde octubre los km salen de los despachos del sistema (odómetro de checklist o GPS de la app).
-- * lease_gps_days: km diario del GPS del arrendador (control: km de la unidad que no corresponden a viajes).
-- * calculate_lease_settlement: misma firma y mismas reglas de F11 (prorrateo, excesos, indisponibilidad); se agregan
--   la fuente de km (valorización importada › rutas › odómetro), días laborados, costo diario, garantía, control de km
--   fuera de ruta y el detalle de viajes. Los fletes al cliente no forman parte del alquiler.
-- * Carga: arrendador, contrato desde 01/08/2026, 89 viajes, 30 días GPS, odómetro de CJS716 y las liquidaciones de
--   agosto y setiembre en BORRADOR (las aprueba un usuario distinto).

BEGIN;

ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS days_base integer;
ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS excess_km_rate_exact numeric(14,6);
ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS guarantee_amount numeric(12,2);
ALTER TABLE public.vehicle_lease_contracts ADD COLUMN IF NOT EXISTS km_source text NOT NULL DEFAULT 'ODOMETRO';
ALTER TABLE public.vehicle_lease_contracts DROP CONSTRAINT IF EXISTS vehicle_lease_contracts_km_source_check;
ALTER TABLE public.vehicle_lease_contracts ADD CONSTRAINT vehicle_lease_contracts_km_source_check
  CHECK (km_source IN ('ODOMETRO', 'RUTA') AND (days_base IS NULL OR days_base BETWEEN 1 AND 31));

CREATE TABLE IF NOT EXISTS public.lease_usage_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vehicle_id uuid NOT NULL,
  fecha date NOT NULL,
  fuente text NOT NULL DEFAULT 'VALORIZACION_EXCEL',
  tipo_operacion text, guia text, ot_oc text, area text, conductor text, licencia text,
  cliente text, zona text, destino text,
  km numeric NOT NULL DEFAULT 0,        -- km valorizado del viaje (ida y vuelta)
  km_entrega numeric,                   -- km hasta el punto de entrega
  propiedad text, observaciones text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lease_usage_records_idx ON public.lease_usage_records (vehicle_id, fecha);

CREATE TABLE IF NOT EXISTS public.lease_gps_days (
  vehicle_id uuid NOT NULL,
  fecha date NOT NULL,
  km numeric NOT NULL DEFAULT 0,
  odometro numeric, tiempo text, paradas numeric, nota text,
  PRIMARY KEY (vehicle_id, fecha)
);

ALTER TABLE public.lease_usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lease_gps_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lease_usage_read ON public.lease_usage_records;
CREATE POLICY lease_usage_read ON public.lease_usage_records FOR SELECT TO authenticated
  USING (public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('caja-liquidaciones'));
DROP POLICY IF EXISTS lease_gps_read ON public.lease_gps_days;
CREATE POLICY lease_gps_read ON public.lease_gps_days FOR SELECT TO authenticated
  USING (public.menu_has_permission('mantenimiento-flota') OR public.menu_has_permission('caja-liquidaciones'));
GRANT SELECT ON public.lease_usage_records, public.lease_gps_days TO authenticated;

-- Viajes del sistema (despachos) de una unidad en un periodo, con su km: odómetro de salida y llegada del checklist
-- o, si falta, la distancia registrada por la app (GPS de la ruta)
CREATE OR REPLACE FUNCTION public.lease_route_trips(p_plate text, p_desde date, p_hasta date)
RETURNS TABLE (fecha date, ref text, destino text, km numeric, km_fuente text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF to_regclass('public.dispatches') IS NULL THEN RETURN; END IF;
  RETURN QUERY EXECUTE $q$
    SELECT z.fecha, z.ref, z.destino,
           CASE WHEN z.odo_fin > z.odo_ini AND z.odo_fin - z.odo_ini < 2000 THEN z.odo_fin - z.odo_ini ELSE z.gps END,
           CASE WHEN z.odo_fin > z.odo_ini AND z.odo_fin - z.odo_ini < 2000 THEN 'ODOMETRO' WHEN z.gps IS NOT NULL THEN 'GPS_APP' ELSE 'SIN_KM' END
    FROM (SELECT public.fe_jdate(to_jsonb(d), public.fe_desp_keys())::date AS fecha,
                 COALESCE(to_jsonb(d) ->> 'dispatch_number', left(d.id::text, 8)) AS ref,
                 COALESCE(to_jsonb(d) ->> 'destination_address', to_jsonb(d) ->> 'destination', to_jsonb(d) ->> 'route_name') AS destino,
                 NULLIF(to_jsonb(d) ->> 'start_odometer', '')::numeric AS odo_ini,
                 NULLIF(to_jsonb(d) ->> 'end_odometer', '')::numeric AS odo_fin,
                 NULLIF(NULLIF(to_jsonb(d) ->> 'actual_distance_km', '')::numeric, 0) AS gps
          FROM public.dispatches d
          WHERE public.fe_code(to_jsonb(d) ->> 'vehicle_plate') = public.fe_code($1)
            AND upper(COALESCE(to_jsonb(d) ->> 'status', '')) NOT IN ('CANCELADO', 'CANCELADA', 'ANULADO')) z
    WHERE z.fecha BETWEEN $2 AND $3$q$ USING p_plate, p_desde, p_hasta;
EXCEPTION WHEN OTHERS THEN RETURN;
END $$;
REVOKE ALL ON FUNCTION public.lease_route_trips(text, date, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.calculate_lease_settlement(
  p_contract_id uuid, p_period_start date, p_period_end date,
  p_other_discounts numeric DEFAULT 0, p_penalties numeric DEFAULT 0, p_consumptions numeric DEFAULT 0, p_additional_costs numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c         public.vehicle_lease_contracts%ROWTYPE;
  v         public.vehicles%ROWTYPE;
  v_start   date;
  v_end     date;
  v_days    int;
  v_month_days int;
  v_km      numeric := 0;
  v_hours   numeric := 0;
  v_down    numeric := 0;
  v_base    numeric;
  v_daily   numeric;
  v_inc_km  numeric;
  v_inc_h   numeric;
  v_exc_km  numeric := 0;
  v_exc_h   numeric := 0;
  v_disc    numeric := 0;
  v_sub     numeric;
  v_tax     numeric;
  v_rate_km numeric;
  v_fuente  text := 'ODOMETRO';
  v_km_odo  numeric := 0;
  v_km_gps  numeric;
  v_dias_lab int := 0;
  v_viajes  jsonb := '[]'::jsonb;
  v_sin_km  int := 0;
BEGIN
  SELECT * INTO c FROM public.vehicle_lease_contracts WHERE id = p_contract_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Contrato no encontrado');
  END IF;
  IF auth.uid() IS NOT NULL AND NOT (public.can_access_site(c.site_id)
     AND (public.has_cmms_read_permission('flota') OR public.has_tms_read_permission('caja-liquidaciones'))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para consultar este contrato');
  END IF;
  SELECT * INTO v FROM public.vehicles WHERE id = c.vehicle_id;
  IF p_period_end < p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'Periodo inválido');
  END IF;
  v_start := GREATEST(p_period_start, c.start_date);
  v_end := LEAST(p_period_end, COALESCE(c.end_date, p_period_end));
  IF v_end < v_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'El periodo no se cruza con la vigencia del contrato');
  END IF;
  v_days := v_end - v_start + 1;
  v_month_days := extract(day FROM (date_trunc('month', v_start) + interval '1 month - 1 day'))::int;

  -- Lecturas de odómetro/horómetro del periodo (fuente F11 y control)
  SELECT COALESCE(max(odometer_value) - min(odometer_value), 0), COALESCE(max(hours_value) - min(hours_value), 0)
  INTO v_km_odo, v_hours
  FROM public.vehicle_odometer_logs
  WHERE vehicle_plate = v.plate AND (created_at AT TIME ZONE 'America/Lima')::date BETWEEN v_start AND v_end;
  SELECT sum(g.km) INTO v_km_gps FROM public.lease_gps_days g WHERE g.vehicle_id = c.vehicle_id AND g.fecha BETWEEN v_start AND v_end;

  -- Km a liquidar: valorización importada (meses previos al sistema) › rutas del sistema › odómetro
  IF EXISTS (SELECT 1 FROM public.lease_usage_records u WHERE u.vehicle_id = c.vehicle_id AND u.fecha BETWEEN v_start AND v_end) THEN
    v_fuente := 'VALORIZACION';
    SELECT COALESCE(sum(u.km), 0), count(DISTINCT u.fecha),
           COALESCE(jsonb_agg(jsonb_build_object('fecha', u.fecha, 'ref', COALESCE(u.guia, u.tipo_operacion), 'cliente', u.cliente, 'destino', u.destino,
             'tipo', u.tipo_operacion, 'conductor', u.conductor, 'km', u.km, 'km_fuente', 'VALORIZACION') ORDER BY u.fecha, u.id), '[]')
    INTO v_km, v_dias_lab, v_viajes
    FROM public.lease_usage_records u WHERE u.vehicle_id = c.vehicle_id AND u.fecha BETWEEN v_start AND v_end;
  ELSIF c.km_source = 'RUTA' THEN
    v_fuente := 'RUTA';
    SELECT COALESCE(sum(t.km), 0), count(DISTINCT t.fecha), count(*) FILTER (WHERE t.km IS NULL),
           COALESCE(jsonb_agg(jsonb_build_object('fecha', t.fecha, 'ref', t.ref, 'destino', t.destino, 'km', t.km, 'km_fuente', t.km_fuente) ORDER BY t.fecha, t.ref), '[]')
    INTO v_km, v_dias_lab, v_sin_km, v_viajes
    FROM public.lease_route_trips(v.plate, v_start, v_end) t;
  ELSE
    v_km := v_km_odo;
  END IF;

  -- Indisponibilidad por mantenimiento dentro del periodo (OT con tiempo fuera de servicio)
  SELECT COALESCE(sum(extract(epoch FROM LEAST(COALESCE(downtime_end, now()), (v_end + 1)::timestamp AT TIME ZONE 'America/Lima')
                               - GREATEST(downtime_start, v_start::timestamp AT TIME ZONE 'America/Lima')) / 86400.0), 0)
  INTO v_down
  FROM public.maintenance_work_orders
  WHERE vehicle_id = c.vehicle_id AND downtime_start IS NOT NULL AND status <> 'CANCELADA'
    AND downtime_start < (v_end + 1)::timestamp AT TIME ZONE 'America/Lima'
    AND COALESCE(downtime_end, now()) > v_start::timestamp AT TIME ZONE 'America/Lima';
  v_down := round(GREATEST(v_down, 0), 2);
  v_daily := CASE c.rate_type WHEN 'MENSUAL' THEN c.rate_amount / COALESCE(c.days_base, v_month_days) WHEN 'DIARIA' THEN c.rate_amount ELSE NULL END;
  v_base := CASE c.rate_type
    WHEN 'MENSUAL' THEN round(c.rate_amount * v_days / v_month_days, 2)
    WHEN 'DIARIA'  THEN round(c.rate_amount * v_days, 2)
    WHEN 'HORARIA' THEN round(c.rate_amount * v_hours, 2)
    WHEN 'KM'      THEN round(c.rate_amount * v_km, 2) END;
  v_rate_km := COALESCE(c.excess_km_rate_exact, c.excess_km_rate);
  IF c.rate_type IN ('MENSUAL', 'DIARIA') THEN
    v_inc_km := CASE WHEN c.included_km IS NOT NULL THEN c.included_km * CASE WHEN c.rate_type = 'MENSUAL' THEN v_days::numeric / v_month_days ELSE 1 END END;
    v_inc_h  := CASE WHEN c.included_hours IS NOT NULL THEN c.included_hours * CASE WHEN c.rate_type = 'MENSUAL' THEN v_days::numeric / v_month_days ELSE 1 END END;
    IF v_inc_km IS NOT NULL AND v_rate_km IS NOT NULL THEN v_exc_km := GREATEST(v_km - v_inc_km, 0); END IF;
    IF v_inc_h IS NOT NULL AND c.excess_hour_rate IS NOT NULL THEN v_exc_h := GREATEST(v_hours - v_inc_h, 0); END IF;
    IF c.discount_downtime AND v_daily IS NOT NULL THEN v_disc := round(LEAST(v_down, v_days) * v_daily, 2); END IF;
  END IF;
  v_sub := v_base + round(v_exc_km * COALESCE(v_rate_km, 0), 2) + round(v_exc_h * COALESCE(c.excess_hour_rate, 0), 2)
           - v_disc - COALESCE(p_other_discounts, 0) + COALESCE(p_penalties, 0) + COALESCE(p_consumptions, 0) + COALESCE(p_additional_costs, 0);
  v_sub := GREATEST(v_sub, 0);
  v_tax := round(v_sub * 0.18, 2);
  RETURN jsonb_build_object('success', true,
    'contract_id', c.id, 'vehicle_id', c.vehicle_id, 'vehicle_plate', v.plate, 'rate_type', c.rate_type, 'rate_amount', c.rate_amount,
    'period_start', v_start, 'period_end', v_end, 'days', v_days, 'km_used', round(v_km, 2), 'hours_used', round(v_hours, 2),
    'downtime_days', v_down, 'base_amount', v_base,
    'included_km', round(v_inc_km, 2), 'excess_km', round(v_exc_km, 2), 'excess_km_rate', v_rate_km, 'excess_km_amount', round(v_exc_km * COALESCE(v_rate_km, 0), 2),
    'included_hours', round(v_inc_h, 2), 'excess_hours', round(v_exc_h, 2), 'excess_hours_amount', round(v_exc_h * COALESCE(c.excess_hour_rate, 0), 2),
    'downtime_discount', v_disc, 'other_discounts', COALESCE(p_other_discounts, 0), 'penalties', COALESCE(p_penalties, 0),
    'consumptions', COALESCE(p_consumptions, 0), 'additional_costs', COALESCE(p_additional_costs, 0),
    'subtotal', round(v_sub, 2), 'tax', v_tax, 'total', round(v_sub, 2) + v_tax,
    -- Valorización
    'km_fuente', v_fuente, 'dias_laborados', v_dias_lab, 'dias_base', c.days_base, 'costo_diario', round(v_daily, 2),
    'garantia', c.guarantee_amount, 'km_odometro', round(v_km_odo, 2), 'km_gps', round(v_km_gps, 2),
    'km_fuera_de_ruta', CASE WHEN v_fuente <> 'ODOMETRO' AND COALESCE(v_km_gps, NULLIF(v_km_odo, 0)) IS NOT NULL
                             THEN round(GREATEST(COALESCE(v_km_gps, v_km_odo) - v_km, 0), 2) END,
    'viajes_sin_km', v_sin_km, 'viajes', v_viajes);
END;
$$;
REVOKE ALL ON FUNCTION public.calculate_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_lease_settlement(uuid, date, date, numeric, numeric, numeric, numeric) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Carga: CJS716 (Hyundai H100) · Transportes Valeriani · agosto y setiembre 2026
-- ------------------------------------------------------------
DO $$
DECLARE v_vid uuid; v_plate text; v_car uuid; v_con uuid; r jsonb; v_has_active boolean; n int;
BEGIN
  IF to_regclass('public.vehicles') IS NULL THEN RETURN; END IF;
  EXECUTE 'SELECT id, plate FROM public.vehicles WHERE public.fe_code(plate) = ''CJS 716'' LIMIT 1' INTO v_vid, v_plate;
  IF v_vid IS NULL THEN
    INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'CJS716 no está en Flota: no se cargó la valorización');
    RETURN;
  END IF;
  EXECUTE 'UPDATE public.vehicles SET brand = COALESCE(NULLIF(brand, ''''), ''Hyundai''), model = CASE WHEN COALESCE(model, '''') IN ('''', ''Camioneta'') THEN ''H100'' ELSE model END WHERE id = $1' USING v_vid;
  -- Sin sede la unidad (y su contrato) no se ve fuera del perfil Administrador
  IF to_regclass('public.sites') IS NOT NULL THEN
    EXECUTE 'UPDATE public.vehicles SET site_id = (SELECT id FROM public.sites WHERE code = ''PRINCIPAL'' LIMIT 1) WHERE id = $1 AND site_id IS NULL' USING v_vid;
  END IF;

  -- Arrendador
  SELECT id INTO v_car FROM public.carriers WHERE upper(business_name) LIKE '%VALERIANI%' LIMIT 1;
  IF v_car IS NULL THEN
    BEGIN
      INSERT INTO public.carriers (type, business_name, ruc) VALUES ('TERCERO', 'TRANSPORTES VALERIANI', 'PEND-VALERIANI') RETURNING id INTO v_car;
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Arrendador TRANSPORTES VALERIANI creado (completar RUC)');
    EXCEPTION WHEN OTHERS THEN   -- el contrato queda sin arrendador; se asigna desde Contratos de alquiler
      INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Arrendador no creado: ' || SQLERRM);
    END;
  END IF;

  -- Contrato (si no hay uno vigente para la unidad)
  SELECT id INTO v_con FROM public.vehicle_lease_contracts WHERE vehicle_id = v_vid AND status = 'ACTIVO' ORDER BY start_date DESC LIMIT 1;
  IF v_con IS NULL THEN
    INSERT INTO public.vehicle_lease_contracts (vehicle_id, provider_id, contract_type, rate_type, rate_amount, monthly_base_fee, included_km,
      excess_km_rate, excess_km_rate_exact, days_base, guarantee_amount, km_source, discount_downtime, start_date, status, conditions, notes)
    VALUES (v_vid, v_car, 'ALQUILER_SECO', 'MENSUAL', 3676.92, 3676.92, 3900, 1.94, 1.942800, 26, 2000, 'RUTA', true, DATE '2026-08-01', 'ACTIVO',
      'Maquinaria seca (sin conductor ni combustible). Alquiler mensual S/ 3.676,92 sin IGV, base 26 días (costo diario = alquiler / 26). '
      || 'Incluye 3.900 km por mes; el km adicional se cobra a S/ 1,9428 (precio del km incluido + S/ 1). Garantía S/ 2.000. '
      || 'Los fletes facturados al cliente no forman parte del alquiler.',
      'Agosto y setiembre 2026: valorización del arrendador (Excel). Desde octubre los km salen de las rutas del sistema y la app.')
    RETURNING id INTO v_con;
    INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Contrato de CJS716 creado desde 01/08/2026');
  ELSE
    UPDATE public.vehicle_lease_contracts SET days_base = COALESCE(days_base, 26), excess_km_rate_exact = COALESCE(excess_km_rate_exact, 1.942800),
      guarantee_amount = COALESCE(guarantee_amount, 2000), km_source = 'RUTA' WHERE id = v_con;
  END IF;

  -- Viajes valorizados y GPS (una sola vez)
  IF NOT EXISTS (SELECT 1 FROM public.lease_usage_records WHERE vehicle_id = v_vid AND fecha BETWEEN DATE '2026-08-01' AND DATE '2026-09-30') THEN
    INSERT INTO public.lease_usage_records (vehicle_id, fecha, tipo_operacion, guia, ot_oc, area, conductor, licencia, cliente, zona, destino, km, km_entrega, propiedad, observaciones)
    SELECT v_vid, x.fecha::date, x.tipo, x.guia, x.ot::text, x.area, x.cond, x.lic, x.cli, x.zona, x.dest, COALESCE(x.km, 0), x.kme, x.prop, x.obs
    FROM (VALUES
      ('2026-08-03', 'DESPACHO DE CONTRATOS', 'T001-00006327', '0000016308', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'MOLITALIA S.A', 'ZONA NORTE', 'Los Olivos', 266.0, 133.0, 'TERCERO', NULL),
      ('2026-08-04', 'DESPACHO DE CONTRATOS', 'T001-00006342', '0000016071', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'REFINERIA LA PAMPILLA S.A.', 'ZONA NORTE', 'Ventanilla', 64.0, 32.0, 'TERCERO', NULL),
      ('2026-08-04', 'DESPACHO DE CONTRATOS', 'T001-00006341', '0000016392', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'HOMECENTERS PERUANOS S.A.', 'ZONA CENTRO', 'San Miguel', 64.0, 32.0, 'TERCERO', NULL),
      ('2026-08-05', 'DESPACHO DE CONTRATOS', 'T001-00006350', '0000016060', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'SOFTYS PERU S.A.C.', 'ZONA SUR', 'Punta Hermosa', 156.0, 78.0, 'TERCERO', NULL),
      ('2026-08-05', 'DESPACHO DE CONTRATOS', 'T001-00006349', '0000016405', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'CORE TECH S.A', 'ZONA SUR', 'Chorrillos', 156.0, 78.0, 'TERCERO', NULL),
      ('2026-08-06', 'DESPACHO DE CONTRATOS', 'T001-00006358', '0000016060', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'ESTANTERIAS METALICAS J.R.M. S.A.C', 'PROVINCIA', 'Cañete', 76.0, 38.0, 'TERCERO', NULL),
      ('2026-08-07', 'DESPACHO DE CONTRATOS', 'T001-00006361', '0000015304', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'RINTI S A', 'ZONA ESTE', 'Ate', 208.0, 104.0, 'TERCERO', NULL),
      ('2026-08-10', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', NULL, NULL, NULL, 122.0, 100.0, 'TERCERO', NULL),
      ('2026-08-11', 'DESPACHO DE CONTRATOS', 'T001-00006380', '0000016373', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'MT INDUSTRIAL S.A.C.', 'ZONA NORTE', 'Ventanilla', 262.0, 131.0, 'TERCERO', NULL),
      ('2026-08-12', 'DESPACHO DE CONTRATOS', 'T001-00008012', '0000016060', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'SOFTYS PERU S.A.C.', 'ZONA SUR', 'Punta Hermosa', 140.0, 70.0, 'TERCERO', NULL),
      ('2026-08-12', 'DESPACHO DE CONTRATOS', 'T001-00008011', '0000016473', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'MAERSK LOGISTICS & SERVICES PERU S.A.', 'ZONA SUR', 'Lurin', 140.0, 70.0, 'TERCERO', NULL),
      ('2026-08-13', 'DESPACHO DE CONTRATOS', 'T001-00006410', '0000015388', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'MACHU PICCHU FOODS S.A.C.', 'CALLAO', 'Callao', 86.0, 43.0, 'TERCERO', NULL),
      ('2026-08-13', 'DESPACHO DE CONTRATOS', 'T001-00006408', '0000016232', 'CONTRATOS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'LABORATORIOS BIOMONT S A', 'ZONA SUR', 'Lurin', 86.0, 43.0, 'TERCERO', NULL),
      ('2026-08-14', 'RECOJO DE ORDENES DE COMPRA', 'T001-6412', NULL, 'COMPRAS', 'ALVARO CAYTUIRO TAPIA', 'Q43501327', 'MACHU PICCHU FOODS S.A.C.', NULL, NULL, 133.0, 66.0, 'TERCERO', NULL),
      ('2026-08-17', 'DESPACHO DE CONTRATOS', 'T001-00006425', '0000016339', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'TIENDAS SUPERPET SOCIEDAD ANONIMA CERRADA - TIENDAS SUPERPET S.A.C.', 'ZONA SUR', 'Lurin', 238.0, 119.0, 'TERCERO', NULL),
      ('2026-08-18', 'DESPACHO DE CONTRATOS', 'T001-00006429', '0000015304', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'RINTI S A', 'ZONA ESTE', 'Ate', 52.0, 26.0, 'TERCERO', NULL),
      ('2026-08-18', 'DESPACHO DE CONTRATOS', 'T001-00006433', '15304-E001', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'RINTI S A', 'ZONA ESTE', 'Ate', 52.0, 26.0, 'TERCERO', NULL),
      ('2026-08-19', 'DESPACHO DE CONTRATOS', 'T001-00006441', '0000016339', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'TIENDAS SUPERPET SOCIEDAD ANONIMA CERRADA - TIENDAS SUPERPET S.A.C.', 'ZONA SUR', 'Lurin', 62.0, 31.0, 'TERCERO', NULL),
      ('2026-08-19', 'DESPACHO DE CONTRATOS', 'T001-00006444', '0000016376', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'LEO ANDES S.A.', 'ZONA ESTE', 'Huachipa', 62.0, 31.0, 'TERCERO', NULL),
      ('2026-08-20', 'DESPACHO DE CONTRATOS', 'T001-00006452', NULL, 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'HOMECENTERS PERUANOS S.A.', 'ZONA CENTRO', 'San Miguel', 266.0, 133.0, 'TERCERO', NULL),
      ('2026-08-21', 'DESPACHO DE CONTRATOS', 'T001-00006460', '0000016060', 'CONTRATOS', 'JORGE INGA CASTAÑEDA', 'R10467238', 'SOFTYS PERU S.A.C.', 'ZONA SUR', 'Punta Hermosa', 120.0, 60.0, 'TERCERO', NULL),
      ('2026-08-21', 'DESPACHO DE CONTRATOS', 'T001-00006463', '0000016119', 'CONTRATOS', 'ALEJANDRO CAMARGO ACOSTA', 'Q09703949', 'MEDIFARMA S A', 'ZONA ESTE', 'Ate', 120.0, 60.0, 'TERCERO', NULL),
      ('2026-08-22', 'DESPACHO DE CONTRATOS', 'T001-00006468', '0000014093', 'CONTRATOS', 'OMAR RONCO SALAZAR', 'Q43034603', 'HOMECENTERS PERUANOS S.A.', 'ZONA CENTRO', 'San Miguel', 198.0, 99.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006483', '0000016119', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'MEDIFARMA S A', 'ZONA ESTE', 'Ate', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006492', '0000016392', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'HOMECENTERS PERUANOS S.A.', 'ZONA CENTRO', 'San Miguel', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006493', '0000016418', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'G W YICHANG & CIA S A', 'ZONA SUR', 'Lurin', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006490', '0000016448', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'SAN MIGUEL INDUSTRIAS PET S.A - SMI', 'ZONA CENTRO', 'Lima Cercado', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006489', '0000016458', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'KIMBERLY-CLARK PERU S.R.L.', 'ZONA ESTE', 'SANTA CLARA', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-25', 'DESPACHO DE CONTRATOS', 'T001-00006494', NULL, 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'G.O.TRADERS S.A.', 'ZONA ESTE', 'SJL', 36.0, 18.0, 'TERCERO', NULL),
      ('2026-08-26', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'MULTIMALLAS', 'CERCADO LIMA', NULL, 215.0, 210.0, 'TERCERO', NULL),
      ('2026-08-27', 'DESPACHO DE CONTRATOS', 'T001-00006504', '0000016468', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'HOMECENTERS PERUANOS S.A.', 'ZONA CENTRO', 'San Miguel', 238.0, 119.0, 'TERCERO', NULL),
      ('2026-08-28', 'DESPACHO DE CONTRATOS', 'T001-00006509', '0000014369', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'PRODIMIN S.A.C.', 'CALLAO', 'Callao', 72.0, 36.0, 'TERCERO', NULL),
      ('2026-08-28', 'DESPACHO DE CONTRATOS', 'T001-00006507', '0000015304', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'RINTI S A', 'ZONA ESTE', 'Ate', 72.0, 36.0, 'TERCERO', NULL),
      ('2026-08-28', 'DESPACHO DE CONTRATOS', 'T001-00006508', '0000016269', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'TOPSA PERU SAC', 'ZONA SUR', 'Lurin', 72.0, 36.0, 'TERCERO', NULL),
      ('2026-08-29', 'RECOJO DE ORDENES DE COMPRA', 'T001-14369', NULL, 'COMPRAS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'PRODEMIN', 'LA VICTORIA', NULL, 75.0, 75.0, 'TERCERO', NULL),
      ('2026-08-31', 'DESPACHO DE CONTRATOS', 'T001-00006520', '0000016250', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'PROMOTORA GENESIS S.A.C.', 'ZONA SUR', 'Lurin', 102.0, 51.0, 'TERCERO', NULL),
      ('2026-08-31', 'DESPACHO DE CONTRATOS', 'T001-00006526', '0000016376', 'CONTRATOS', 'JHON UBERT CARDENAS SAJAMI', 'Q41511692', 'LEO ANDES S.A.', 'ZONA ESTE', 'Huachipa', 102.0, 51.0, 'TERCERO', NULL),
      ('2026-09-01', 'DESPACHO DE CONTRATOS', 'T001-6536', '16380', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'CORPORACION ENERJET S.A', NULL, 'Puente Piedra', 172.0, 165.0, 'TERCERO', NULL),
      ('2026-09-02', 'DESPACHO DE CONTRATOS', 'T001-6545', '16504', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'PROMOTORA GENESIS S.A.C.', NULL, 'ATE', 81.0, 76.0, 'TERCERO', NULL),
      ('2026-09-02', 'DESPACHO DE CONTRATOS', 'T001-6541', '16101', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'METALPREN S.A.', NULL, 'Lima Cercado', 81.0, 75.0, 'TERCERO', NULL),
      ('2026-09-02', 'RECOJO DE ORDENES DE COMPRA', 'T001-1132', '57396', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'DISFERMANG SRL', NULL, 'Lima Cercado', 81.0, 79.0, 'TERCERO', NULL),
      ('2026-09-02', 'RECOJO DE ORDENES DE COMPRA', 'T001-3274', '57302', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'VERCELLI PERU', NULL, 'Lima Cercado', 81.0, 80.0, 'TERCERO', NULL),
      ('2026-09-04', 'DESPACHO DE CONTRATOS', 'T001-6561', '16373', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'MT INDUSTRIAL S.A.C.', NULL, 'Ventanilla', 228.0, 211.0, 'TERCERO', NULL),
      ('2026-09-05', 'DESPACHO DE CONTRATOS', 'T001-6563', '15304', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'RINTI S.A.', NULL, 'Ate', 47.0, 47.0, 'TERCERO', NULL),
      ('2026-09-05', 'RECOJO DE ORDENES DE COMPRA', 'T001-3978', '57474', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 47.0, 46.0, 'TERCERO', NULL),
      ('2026-09-07', 'DESPACHO DE CONTRATOS', 'T001-3978', '15304', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'RINTI S.A.', NULL, 'Ate', 107.0, 106.0, 'TERCERO', NULL),
      ('2026-09-07', 'DESPACHO DE CONTRATOS', 'T001-6578', '16443', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'MULTIALMACENES S.A.', NULL, 'Huachipa', 107.0, 104.0, 'TERCERO', NULL),
      ('2026-09-08', 'RECOJO DE ORDENES DE COMPRA', 'T011-157263', '57464', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'INKABOLT SOCIEDAD ANONIMA CERRADA', NULL, 'Punta Hermosa', 131.0, 122.0, 'TERCERO', NULL),
      ('2026-09-09', 'DESPACHO DE CONTRATOS', 'T001-6588', '16294', 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'LEVANIA SAC', NULL, 'Lurin', 60.0, 56.0, 'TERCERO', NULL),
      ('2026-09-09', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'IMDICO SRL', NULL, 'La Victoria', 60.0, 56.0, 'TERCERO', NULL),
      ('2026-09-10', 'DESPACHO DE CONTRATOS', 'T001-6593', NULL, 'CONTRATOS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'San Juan de Lurigancho', 92.0, 83.0, 'TERCERO', NULL),
      ('2026-09-10', 'DESPACHO DE CONTRATOS', 'T001-6596', '16471', 'CONTRATOS', 'JORGE INGA CASTAÑEDA', NULL, 'TIENDAS DEL MEJORAMIENTO DEL HOGAR S.A.', NULL, 'Chorrillos', 92.0, 83.0, 'TERCERO', NULL),
      ('2026-09-10', 'RECOJO DE ORDENES DE COMPRA', NULL, '65399', 'COMPRAS', 'JORGE INGA CASTAÑEDA', NULL, 'RD RENTAL SOCIEDAD ANONIMA CERRADA', NULL, NULL, 92.0, 89.0, 'TERCERO', NULL),
      ('2026-09-10', 'DESPACHO DE CONTRATOS', 'T001-2738', '15304', 'CONTRATOS', 'JORGE INGA CASTAÑEDA', NULL, 'RINTI S.A.', NULL, 'Ate', 92.0, 90.0, 'TERCERO', NULL),
      ('2026-09-15', 'RECOJO DE ORDENES DE COMPRA', 'T011-157416', '57520', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'INKA BOLT SAC', NULL, 'Lurin', 48.0, 44.0, 'TERCERO', NULL),
      ('2026-09-15', 'RECOJO DE ORDENES DE COMPRA', 'T002-4026', '57284', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'XIMESA', NULL, 'Ate', 48.0, 43.0, 'TERCERO', NULL),
      ('2026-09-15', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 48.0, 44.0, 'TERCERO', NULL),
      ('2026-09-16', 'RECOJO DE ORDENES DE COMPRA', 'T001-3987', '57474', 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 104.0, 99.0, 'TERCERO', NULL),
      ('2026-09-16', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'CARDENAS SAJAMI JHON UBERT', 'Q41511692', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 104.0, 98.0, 'TERCERO', NULL),
      ('2026-09-17', 'DESPACHO DE CONTRATOS', 'T002-04017', NULL, 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SECTOR 62 PROYECTO DXN', NULL, 'CHILCA', 44.0, 42.0, 'TERCERO', NULL),
      ('2026-09-17', 'RECOJO DE ORDENES DE COMPRA', 'T003-04742', '16190', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 44.0, 40.0, 'TERCERO', NULL),
      ('2026-09-17', 'RECOJO DE ORDENES DE COMPRA', 'T001-0020004', '57440', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, NULL, 44.0, 42.0, 'TERCERO', NULL),
      ('2026-09-17', 'RECOJO DE ORDENES DE COMPRA', 'T001-003048', '54565', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'MULTICOVER SAC', NULL, 'Ate', 44.0, 42.0, 'TERCERO', NULL),
      ('2026-09-18', 'DESPACHO DE CONTRATOS', 'T001-6635', '16339', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'TIENDAS SUPER PET SAC', NULL, 'Punta Hermosa', 82.0, 81.0, 'TERCERO', NULL),
      ('2026-09-18', 'RECOJO DE ORDENES DE COMPRA', 'T002-21317', '57334', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'MODEPSA S.A.', NULL, 'Callao', 82.0, 82.0, 'TERCERO', NULL),
      ('2026-09-19', 'DESPACHO DE CONTRATOS', 'T001-440', NULL, 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SECTOR 62 PROYECTO DXN', NULL, 'CHILCA', 95.0, 88.0, 'TERCERO', NULL),
      ('2026-09-22', 'DESPACHO DE CONTRATOS', 'T002-4043', '16460', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'NESTLE S.A.', NULL, 'Lima Cercado', 55.0, 52.0, 'TERCERO', NULL),
      ('2026-09-22', 'RECOJO DE ORDENES DE COMPRA', 'T002-4042', '16188', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'SERVICIOS GALVANICOS MENDOZA', NULL, 'Puente Piedra', 55.0, 53.0, 'TERCERO', NULL),
      ('2026-09-22', 'RECOJO DE ORDENES DE COMPRA', 'T001-4001', '57604', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'Coair Perú S.A.C. - MANTENIMIENTO Y REPUESTOS DE COMPRESORES', NULL, NULL, 55.0, 53.0, 'TERCERO', NULL),
      ('2026-09-23', 'RECOJO DE ORDENES DE COMPRA', NULL, NULL, 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 111.0, 111.0, 'TERCERO', NULL),
      ('2026-09-23', 'RECOJO DE ORDENES DE COMPRA', 'T002-2240', NULL, 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, NULL, 111.0, 107.0, 'TERCERO', NULL),
      ('2026-09-23', 'RECOJO DE ORDENES DE COMPRA', 'T001-4047', '57000', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', NULL, NULL, NULL, 111.0, 101.0, 'TERCERO', NULL),
      ('2026-09-24', 'RECOJO DE ORDENES DE COMPRA', 'F002-022942', '57575', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'NEFU SAC', NULL, 'SAN LUIS', 62.0, 60.0, 'TERCERO', NULL),
      ('2026-09-24', 'RECOJO DE ORDENES DE COMPRA', 'T003-05428', '16484', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 62.0, 62.0, 'TERCERO', NULL),
      ('2026-09-24', 'DESPACHO DE CONTRATOS', 'T003-05279', '16401', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'M & M REPUESTOS Y SERVICIOS S.A.', NULL, 'Huachipa', 62.0, 58.0, 'TERCERO', NULL),
      ('2026-09-25', 'RECOJO DE ORDENES DE COMPRA', 'T001-0026600', '57645', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'INVERDU SA', NULL, 'Lurin', 88.0, 86.0, 'TERCERO', NULL),
      ('2026-09-25', 'DESPACHO DE CONTRATOS', 'T001-006672', '15304', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'RINTI S.A.', NULL, 'Ate', 88.0, 80.0, 'TERCERO', NULL),
      ('2026-09-25', 'RECOJO DE ORDENES DE COMPRA', 'T002-21435', '57581', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 88.0, 84.0, 'TERCERO', NULL),
      ('2026-09-26', 'DESPACHO DE CONTRATOS', 'T001-6677', '16339', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'TIENDAS SUPER PET SAC', NULL, 'PUMTA HERMOSA', 95.0, 90.0, 'TERCERO', NULL),
      ('2026-09-26', 'RECOJO DE ORDENES DE COMPRA', 'T001-3947', '57218', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'GRUPO MIRAYA SAC', NULL, 'Lima Cercado', 95.0, 87.0, 'TERCERO', NULL),
      ('2026-09-29', 'RECOJO DE ORDENES DE COMPRA', 'T001-013512', '57614', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'Promaquirsa E.I.R.L.', NULL, 'Lima Cercado', 50.0, 49.0, 'TERCERO', NULL),
      ('2026-09-29', 'RECOJO DE ORDENES DE COMPRA', 'T001-06640', '57627', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'R & C Hidraulica S.A.C.', NULL, 'San Juan de Lurigancho', 50.0, 46.0, 'TERCERO', NULL),
      ('2026-09-29', 'RECOJO DE ORDENES DE COMPRA', 'T003-05485', '16335', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 50.0, 48.0, 'TERCERO', NULL),
      ('2026-09-29', 'RECOJO DE ORDENES DE COMPRA', 'T002-060804', '57609', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'CASINELLI', NULL, 'SURQUILLO', 50.0, 48.0, 'TERCERO', NULL),
      ('2026-09-30', 'RECOJO DE ORDENES DE COMPRA', 'T001-060804', '57609', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 41.0, 41.0, 'TERCERO', NULL),
      ('2026-09-30', 'RECOJO DE ORDENES DE COMPRA', 'T001-0198', '65310', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'Tecno Fast Perú', NULL, 'Lima Cercado', 41.0, 38.0, 'TERCERO', NULL),
      ('2026-09-30', 'DESPACHO DE CONTRATOS', 'T001-06696', '16499', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'UNIQUE', NULL, 'Lurin', 41.0, 40.0, 'TERCERO', NULL),
      ('2026-09-30', 'DESPACHO DE CONTRATOS', 'T001-06697', '16283', 'CONTRATOS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'G.O.TRADERS S.A.', NULL, 'San Juan de Lurigancho', 41.0, 41.0, 'TERCERO', NULL),
      ('2026-09-30', 'RECOJO DE ORDENES DE COMPRA', 'T005-199194', '57700', 'COMPRAS', 'CAYTUIRO  TAPIA ALVARO', 'Q43501327', 'ESTANTERIAS METALICAS JRM SAC', NULL, 'La Victoria', 41.0, 39.0, 'TERCERO', NULL)
    ) AS x(fecha, tipo, guia, ot, area, cond, lic, cli, zona, dest, km, kme, prop, obs);
  END IF;
  INSERT INTO public.lease_gps_days (vehicle_id, fecha, km, odometro, tiempo, paradas, nota)
  SELECT v_vid, x.fecha::date, x.km, x.odo, x.tiempo, x.paradas, x.nota
  FROM (VALUES
    ('2026-09-30', 205.36, 34418.86, '00:09:33:31', 1866.0, NULL),
    ('2026-09-29', 200.66, 34213.5, '00:08:07:04', 1460.0, 'SCCISOR'),
    ('2026-09-28', 209.97, 34012.84, '00:07:34:20', 1426.0, NULL),
    ('2026-09-27', 0.0, 33802.87, '00:00:00:00', 480.0, NULL),
    ('2026-09-26', 189.94, 33802.87, '00:07:04:23', 1346.0, NULL),
    ('2026-09-25', 263.0, 33612.93, '00:09:49:42', 1632.0, NULL),
    ('2026-09-24', 186.9, 33349.93, '00:08:11:23', 1562.0, NULL),
    ('2026-09-23', 333.61, 33163.03, '00:09:52:35', 1317.0, NULL),
    ('2026-09-22', 166.45, 32829.42, '00:07:18:07', 1815.0, NULL),
    ('2026-09-21', 107.3, 32662.97, '00:05:28:48', 1411.0, 'NO'),
    ('2026-09-20', 0.0, 32555.67, '00:00:00:00', 480.0, NULL),
    ('2026-09-19', 94.59, 32555.67, '00:03:48:17', 1105.0, NULL),
    ('2026-09-18', 163.13, 32461.08, '00:06:05:59', 1336.0, 'Metalpren'),
    ('2026-09-17', 177.04, 32297.95, '00:06:28:59', 1351.0, NULL),
    ('2026-09-16', 208.34, 32120.91, '00:05:58:47', 1080.0, NULL),
    ('2026-09-15', 143.91, 31912.57, '00:04:20:01', 1037.0, NULL),
    ('2026-09-14', 87.81, 31768.66, '00:03:55:03', 1029.0, NULL),
    ('2026-09-13', 0.0, 31680.85, '00:00:00:00', 480.0, NULL),
    ('2026-09-12', 246.87, 31680.85, '00:06:56:08', 1127.0, NULL),
    ('2026-09-11', 47.27, 31433.98, '00:03:32:21', 1106.0, NULL),
    ('2026-09-10', 366.42, 31386.71, '00:11:26:21', 1840.0, 'SUPERPET'),
    ('2026-09-09', 119.92, 31020.29, '00:05:53:04', 1302.0, NULL),
    ('2026-09-08', 130.98, 30900.37, '00:05:26:34', 1337.0, NULL),
    ('2026-09-07', 213.11, 30769.39, '00:06:22:31', 1149.0, 'SOLVET'),
    ('2026-09-06', 0.0, 30556.28, '00:00:00:00', 480.0, NULL),
    ('2026-09-05', 93.31, 30556.28, '00:03:38:54', 946.0, NULL),
    ('2026-09-04', 227.73, 30462.97, '00:07:13:05', 1322.0, NULL),
    ('2026-09-03', 46.79, 30235.24, '00:03:55:47', 1346.0, NULL),
    ('2026-09-02', 325.1, 30188.45, '00:09:37:28', 1536.0, NULL),
    ('2026-09-01', 171.87, 29863.35, '00:05:32:30', 1074.0, 'Metalpren')
  ) AS x(fecha, km, odo, tiempo, paradas, nota)
  ON CONFLICT (vehicle_id, fecha) DO NOTHING;

  -- Odómetro de la unidad: último registro del GPS (30/09/2026: 34.418,86 km)
  BEGIN
    EXECUTE 'UPDATE public.vehicles SET current_odometer = 34418.86 WHERE id = $1 AND COALESCE(current_odometer, 0) < 34418.86' USING v_vid;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 AND to_regclass('public.vehicle_odometer_logs') IS NOT NULL THEN
      INSERT INTO public.vehicle_odometer_logs (vehicle_plate, odometer_value, source_event, status, notes, created_at)
      VALUES (v_plate, 34418.86, 'GPS_ARRENDADOR', 'VALIDADO', 'GPS del arrendador al 30/09/2026', TIMESTAMPTZ '2026-09-30 23:59:00-05');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Odómetro CJS716: ' || SQLERRM);
  END;

  -- Liquidaciones de agosto y setiembre en BORRADOR
  IF NOT EXISTS (SELECT 1 FROM public.lease_settlements WHERE contract_id = v_con AND period_start = DATE '2026-08-01' AND status <> 'ANULADA') THEN
    r := public.create_lease_settlement(v_con, DATE '2026-08-01', DATE '2026-08-31', 0, 0, 0, 0, 'Valorización de agosto 2026 importada del Excel del arrendador');
    INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Agosto: ' || COALESCE(r ->> 'subtotal', r ->> 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lease_settlements WHERE contract_id = v_con AND period_start = DATE '2026-09-01' AND status <> 'ANULADA') THEN
    r := public.create_lease_settlement(v_con, DATE '2026-09-01', DATE '2026-09-30', 0, 0, 0, 0, 'Valorización de setiembre 2026 importada del Excel del arrendador');
    INSERT INTO public.mant_setup_log (paso, detalle) VALUES ('alquiler', 'Setiembre: ' || COALESCE(r ->> 'subtotal', r ->> 'error'));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
