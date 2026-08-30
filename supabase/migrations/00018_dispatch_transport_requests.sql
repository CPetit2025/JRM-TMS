-- Crear tabla intermedia para vincular despachos (unidades) a solicitudes
CREATE TABLE IF NOT EXISTS public.dispatch_requests (
    dispatch_id UUID NOT NULL REFERENCES public.dispatches(id) ON DELETE CASCADE,
    transport_request_id UUID NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
    sequence_order INTEGER,
    status VARCHAR(50) DEFAULT 'PROGRAMADO', -- PROGRAMADO, EN_RUTA, ENTREGADO, RECHAZADO
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (dispatch_id, transport_request_id)
);

-- Agregar distancia estimada al despacho general
ALTER TABLE public.dispatches ADD COLUMN IF NOT EXISTS estimated_distance_km DECIMAL(10,2) DEFAULT 0;

-- Habilitar RLS
ALTER TABLE public.dispatch_requests ENABLE ROW LEVEL SECURITY;

-- Políticas
CREATE POLICY "Permitir lectura de dispatch_requests a usuarios autenticados" 
ON public.dispatch_requests FOR SELECT 
TO authenticated USING (true);

CREATE POLICY "Permitir escritura de dispatch_requests a usuarios autenticados" 
ON public.dispatch_requests FOR INSERT 
TO authenticated WITH CHECK (true);

CREATE POLICY "Permitir actualizacion de dispatch_requests a usuarios autenticados" 
ON public.dispatch_requests FOR UPDATE
TO authenticated USING (true);

CREATE POLICY "Permitir eliminacion de dispatch_requests a usuarios autenticados" 
ON public.dispatch_requests FOR DELETE
TO authenticated USING (true);
