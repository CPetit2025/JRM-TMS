-- 20260923180000_fuel_management.sql

-- 1. Alteración de dispatch_expenses: Agrega columnas para combustible
ALTER TABLE public.dispatch_expenses 
ADD COLUMN IF NOT EXISTS fuel_gallons NUMERIC DEFAULT NULL,
ADD COLUMN IF NOT EXISTS fuel_odometer NUMERIC DEFAULT NULL;

COMMENT ON COLUMN public.dispatch_expenses.fuel_gallons IS 'Cantidad de galones de combustible reportados en el gasto';
COMMENT ON COLUMN public.dispatch_expenses.fuel_odometer IS 'Odómetro del vehículo al momento del reporte del gasto de combustible';

-- 2. RPC Centralizado register_fuel_expense
CREATE OR REPLACE FUNCTION public.register_fuel_expense(
    p_dispatch_id uuid,
    p_driver_id uuid,
    p_amount numeric,
    p_gallons numeric,
    p_odometer numeric,
    p_receipt_url text,
    p_description text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_vehicle_id uuid;
    v_plate text;
    v_current_odometer numeric;
BEGIN
    -- a) Validaciones iniciales
    IF p_gallons <= 0 THEN
        RAISE EXCEPTION 'La cantidad de galones debe ser mayor a 0.';
    END IF;
    
    IF p_odometer < 0 THEN
        RAISE EXCEPTION 'El odómetro no puede ser negativo.';
    END IF;

    -- b) Obtener vehicle_id y plate desde public.dispatches
    SELECT vehicle_id INTO v_vehicle_id
    FROM public.dispatches
    WHERE id = p_dispatch_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Despacho con ID % no encontrado.', p_dispatch_id;
    END IF;

    -- Obtener odómetro actual del vehículo
    SELECT plate, current_odometer INTO v_plate, v_current_odometer
    FROM public.vehicles
    WHERE id = v_vehicle_id;

    -- c) Insertar en dispatch_expenses
    INSERT INTO public.dispatch_expenses (
        dispatch_id, 
        driver_id, 
        expense_type, 
        amount, 
        description, 
        receipt_url, 
        fuel_gallons, 
        fuel_odometer
    ) VALUES (
        p_dispatch_id, 
        p_driver_id, 
        'COMBUSTIBLE', 
        p_amount, 
        p_description, 
        p_receipt_url, 
        p_gallons, 
        p_odometer
    );

    -- d) Registrar el nuevo odómetro en la fuente de verdad (vehicle_odometer_logs)
    INSERT INTO public.vehicle_odometer_logs (
        vehicle_id, 
        dispatch_id, 
        driver_id, 
        odometer_value, 
        source_event
    ) VALUES (
        v_vehicle_id, 
        p_dispatch_id, 
        p_driver_id, 
        p_odometer, 
        'COMBUSTIBLE'
    );

    -- e) Actualizar vehicles.current_odometer si el nuevo valor es mayor o igual
    IF v_current_odometer IS NULL OR p_odometer >= v_current_odometer THEN
        UPDATE public.vehicles
        SET current_odometer = p_odometer,
            updated_at = now()
        WHERE id = v_vehicle_id;
    END IF;
END;
$$;

-- Permisos para el RPC
REVOKE ALL ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_fuel_expense(uuid, uuid, numeric, numeric, numeric, text, text) TO service_role;

-- 3. Vista vehicle_fuel_efficiency (Rendimiento de combustible)
CREATE OR REPLACE VIEW public.vehicle_fuel_efficiency AS
WITH fuel_logs AS (
    SELECT 
        de.id AS expense_id,
        de.dispatch_id,
        de.fuel_gallons,
        de.fuel_odometer,
        de.created_at,
        d.vehicle_id,
        v.plate,
        LAG(de.fuel_odometer) OVER (PARTITION BY d.vehicle_id ORDER BY de.created_at) as prev_odometer
    FROM public.dispatch_expenses de
    JOIN public.dispatches d ON de.dispatch_id = d.id
    JOIN public.vehicles v ON d.vehicle_id = v.id
    WHERE de.expense_type = 'COMBUSTIBLE' 
      AND de.fuel_gallons IS NOT NULL 
      AND de.fuel_odometer IS NOT NULL
)
SELECT 
    expense_id,
    dispatch_id,
    vehicle_id,
    plate,
    created_at,
    fuel_gallons,
    fuel_odometer,
    prev_odometer,
    (fuel_odometer - prev_odometer) AS distance_traveled,
    CASE 
        WHEN fuel_gallons > 0 AND (fuel_odometer - prev_odometer) > 0 THEN 
            ROUND((fuel_odometer - prev_odometer) / fuel_gallons, 2)
        ELSE NULL
    END AS km_per_gallon
FROM fuel_logs;

-- Comentarios vista
COMMENT ON VIEW public.vehicle_fuel_efficiency IS 'Vista para calcular el rendimiento de combustible (km/gal) por cada recarga basándose en el historial del odómetro.';

-- Permisos vista
GRANT SELECT ON public.vehicle_fuel_efficiency TO authenticated;
GRANT SELECT ON public.vehicle_fuel_efficiency TO service_role;
