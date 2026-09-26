-- FASE 9 - COSTOS Y TCO: Consolidación Financiera (vehicle_tco_analytics)
-- Migración SQL para unificar dispatch_expenses y calcular TCO de vehículos

-- 1. DEPRECACIÓN DE TABLAS FRAGMENTADAS DE GASTOS
-- Renombramos las tablas para no perder la data existente pero sacarlas del flujo principal
ALTER TABLE IF EXISTS public.expenses RENAME TO deprecated_expenses;
ALTER TABLE IF EXISTS public.expense_records RENAME TO deprecated_expense_records;
ALTER TABLE IF EXISTS public.expense_liquidations RENAME TO deprecated_expense_liquidations;

-- 2. ASEGURAR COLUMNAS EN LA FUENTE ÚNICA DE VERDAD: dispatch_expenses
-- Nos aseguramos que tenga las columnas clave y el estado
ALTER TABLE public.dispatch_expenses
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDIENTE';

-- Drop the constraint if it exists to replace it
ALTER TABLE public.dispatch_expenses DROP CONSTRAINT IF EXISTS dispatch_expenses_status_check;

-- Add the check constraint
ALTER TABLE public.dispatch_expenses
  ADD CONSTRAINT dispatch_expenses_status_check 
  CHECK (status IN ('PENDIENTE', 'APROBADO', 'RECHAZADO'));


-- 3. CREACIÓN DE VISTA ANALÍTICA TCO (Total Cost of Ownership)
CREATE OR REPLACE VIEW public.vehicle_tco_analytics AS
SELECT
  v.id AS vehicle_id,
  v.plate,
  
  -- a) Costos Operativos: Suma de dispatch_expenses (solo aprobados)
  COALESCE(op.total_operating_cost, 0.00) AS operating_cost,
  
  -- b) Costos de Mantenimiento: Suma de work_order_costs
  COALESCE(mt.total_maintenance_cost, 0.00) AS maintenance_cost,
  
  -- c) Costos Fijos: vehicles.current_odometer * vehicle_costs.fixed_cost_per_km
  (COALESCE(vc.fixed_cost_per_km, 0.00) * COALESCE(v.current_odometer, 0.00)) AS fixed_cost,
  
  -- d) Total TCO: a + b + c
  (
    COALESCE(op.total_operating_cost, 0.00) + 
    COALESCE(mt.total_maintenance_cost, 0.00) + 
    (COALESCE(vc.fixed_cost_per_km, 0.00) * COALESCE(v.current_odometer, 0.00))
  ) AS total_tco,
  
  -- e) Costo por KM (CPK): Total TCO / Odometer
  CASE 
    WHEN COALESCE(v.current_odometer, 0.00) > 0 THEN
      (
        COALESCE(op.total_operating_cost, 0.00) + 
        COALESCE(mt.total_maintenance_cost, 0.00) + 
        (COALESCE(vc.fixed_cost_per_km, 0.00) * COALESCE(v.current_odometer, 0.00))
      ) / v.current_odometer
    ELSE 0.00
  END AS cpk

FROM public.vehicles v
-- Se hace el join para obtener el fixed_cost_per_km basado en el tipo de vehículo
LEFT JOIN public.vehicle_costs vc ON v.type = vc.vehicle_type
LEFT JOIN (
  -- Subquery para Gastos Operativos
  SELECT
    COALESCE(
      (SELECT vehicle_id FROM public.dispatches WHERE id = de.dispatch_id LIMIT 1),
      (SELECT vehicle_id FROM public.routes WHERE dispatch_id = de.dispatch_id LIMIT 1)
    ) AS vehicle_id,
    SUM(de.amount) AS total_operating_cost
  FROM public.dispatch_expenses de
  WHERE de.status = 'APROBADO'
  GROUP BY 1
) op ON v.id = op.vehicle_id
LEFT JOIN (
  -- Subquery para Gastos de Mantenimiento
  SELECT
    mwo.vehicle_plate,
    SUM(woc.amount) AS total_maintenance_cost
  FROM public.work_order_costs woc
  JOIN public.maintenance_work_orders mwo ON woc.work_order_id = mwo.id
  WHERE mwo.status != 'CANCELADO'
  GROUP BY mwo.vehicle_plate
) mt ON v.plate = mt.vehicle_plate;

-- 4. GRANT PERMISOS DE VISTA
GRANT SELECT ON public.vehicle_tco_analytics TO authenticated;
GRANT SELECT ON public.vehicle_tco_analytics TO service_role;
