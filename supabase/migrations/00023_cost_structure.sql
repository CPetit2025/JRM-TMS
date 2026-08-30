-- ============================================================
-- 00023: Estructura completa de costos y valorizacion por OT
-- ============================================================

-- 1. Enriquecer vehicle_costs con soporte por placa y tipo
ALTER TABLE public.vehicle_costs
ADD COLUMN IF NOT EXISTS vehicle_plate VARCHAR(20),
ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS description TEXT;

-- Actualizar registros existentes para que sean default por tipo
UPDATE public.vehicle_costs SET is_default = true WHERE vehicle_plate IS NULL;

-- 2. Agregar Partida y Costo/KM a transport_requests
ALTER TABLE public.transport_requests
ADD COLUMN IF NOT EXISTS budget_amount DECIMAL(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS cost_per_km DECIMAL(10, 2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS liquidation_notes TEXT;

-- 3. Crear tabla de gastos variables por despacho
CREATE TABLE IF NOT EXISTS public.dispatch_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
  expense_type VARCHAR(50) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.dispatch_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "All access dispatch_expenses" ON public.dispatch_expenses
  FOR ALL USING (true) WITH CHECK (true);

-- 4. Insertar tarifas base si no existen
INSERT INTO public.vehicle_costs (vehicle_type, fixed_cost_per_km, driver_cost_per_km, tolls_estimated_cost, is_default, description)
VALUES
  ('Furgon',     1.50, 0.50, 10.00, true, 'Furgon hasta 1.5T'),
  ('Camion 2T',  2.20, 0.80, 15.00, true, 'Camion de 2 toneladas'),
  ('Camion 5T',  3.00, 1.00, 20.00, true, 'Camion de 5 toneladas'),
  ('Trailer',    4.50, 1.20, 30.00, true, 'Semi-trailer'),
  ('Moto',       0.50, 0.20,  0.00, true, 'Moto mensajeria')
ON CONFLICT DO NOTHING;
