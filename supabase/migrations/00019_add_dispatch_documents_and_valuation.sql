-- Migración para añadir GR/Nota de Salida y Costos de Valorización

-- 1. Añadir campos documentales a los despachos
ALTER TABLE dispatches 
ADD COLUMN document_type VARCHAR(20) DEFAULT 'GR', -- 'GR' o 'NOTA_SALIDA'
ADD COLUMN document_number VARCHAR(50),
ADD COLUMN estimated_km DECIMAL(10,2),
ADD COLUMN estimated_cost DECIMAL(10,2);

-- 2. Crear tabla de costos vehiculares para la Valorización
CREATE TABLE vehicle_costs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  vehicle_type VARCHAR(50) NOT NULL, -- ej. Furgón, Camión 2T, Trailer
  fixed_cost_per_km DECIMAL(10,2) DEFAULT 0, -- Combustible, desgaste, etc.
  driver_cost_per_km DECIMAL(10,2) DEFAULT 0, -- Viáticos y sueldo base ponderado al KM
  tolls_estimated_cost DECIMAL(10,2) DEFAULT 0, -- Peaje base promedio
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE vehicle_costs ENABLE ROW LEVEL SECURITY;

-- Políticas temporales para desarrollo
CREATE POLICY "Enable all for all users" ON vehicle_costs FOR ALL USING (true) WITH CHECK (true);

-- Insertar data base de prueba
INSERT INTO vehicle_costs (vehicle_type, fixed_cost_per_km, driver_cost_per_km, tolls_estimated_cost)
VALUES 
  ('Furgón', 1.50, 0.50, 10.00),
  ('Camión 2T', 2.20, 0.80, 15.00),
  ('Trailer', 4.50, 1.20, 30.00);
