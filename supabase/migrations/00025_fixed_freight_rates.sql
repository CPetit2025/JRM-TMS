-- 00025_fixed_freight_rates.sql
-- Crea la tabla para almacenar tarifas fijas punto a punto

CREATE TABLE IF NOT EXISTS public.freight_rates (
    id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
    origin VARCHAR(255) NOT NULL,
    district VARCHAR(255) NOT NULL,
    zone VARCHAR(100),
    vehicle_type VARCHAR(100) NOT NULL,
    plate_number VARCHAR(20),
    capacity_ton NUMERIC(10, 2),
    rate NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- Habilitar RLS e ignorarlo (política pública) por ser MVP
ALTER TABLE public.freight_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on freight_rates" 
ON public.freight_rates FOR ALL 
USING (true) 
WITH CHECK (true);

-- Trigger to update updated_at
CREATE TRIGGER update_freight_rates_modtime
    BEFORE UPDATE ON public.freight_rates
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();
