-- MIGRATION: Driver App Schema
-- Tablas para Checklist, Liquidacion Operativa y Liquidacion Documentaria

CREATE TABLE IF NOT EXISTS public.driver_checklists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_id UUID REFERENCES public.dispatches(id),
    driver_id UUID REFERENCES public.drivers(id),
    vehicle_plate VARCHAR(20),
    checklist_data JSONB NOT NULL, -- { llantas: true, aceite: true, luces: false, observaciones: '...' }
    photo_url TEXT,
    location_lat NUMERIC(10, 6),
    location_lon NUMERIC(10, 6),
    is_approved BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.route_stops_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_id UUID REFERENCES public.dispatches(id),
    transport_request_id UUID REFERENCES public.transport_requests(id),
    driver_id UUID REFERENCES public.drivers(id),
    stop_type VARCHAR(50), -- RECOJO, ENTREGA
    arrival_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    odometer_km NUMERIC(10, 2) NOT NULL,
    photo_url TEXT,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.expense_liquidations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_id UUID REFERENCES public.dispatches(id),
    driver_id UUID REFERENCES public.drivers(id),
    expense_type VARCHAR(50), -- PEAJE, COMBUSTIBLE, VIATICOS, OTROS
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'PEN',
    receipt_number VARCHAR(100),
    photo_url TEXT,
    status VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, APROBADO, RECHAZADO
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.document_liquidations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dispatch_id UUID REFERENCES public.dispatches(id),
    transport_request_id UUID REFERENCES public.transport_requests(id),
    document_type VARCHAR(50) DEFAULT 'GUIA_REMISION',
    document_number VARCHAR(100),
    photo_url TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'ENTREGADO', -- ENTREGADO, RECHAZADO, CON_OBSERVACIONES
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Configurar RLS (Permitimos todo para simplificar el MVP, luego se debe restringir a conductores)
ALTER TABLE public.driver_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_stops_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_liquidations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_liquidations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Permitir lectura y escritura a checklist" ON public.driver_checklists FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Permitir lectura y escritura a route_stops" ON public.route_stops_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Permitir lectura y escritura a expenses" ON public.expense_liquidations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Permitir lectura y escritura a documents" ON public.document_liquidations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Insertar storage bucket para evidencias
-- Solo informativo, el bucket 'driver_evidence' debera ser creado en Supabase Storage UI.
