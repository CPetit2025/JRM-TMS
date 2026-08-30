-- Crear tabla del Maestro de Productos
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku VARCHAR(100) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(100),
    default_weight DECIMAL(10,2) DEFAULT 0,
    default_volume DECIMAL(10,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS para productos
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

-- Políticas de lectura/escritura (por ahora permitimos lectura y escritura a autenticados)
CREATE POLICY "Permitir lectura de productos a usuarios autenticados" 
ON public.products FOR SELECT 
TO authenticated USING (true);

CREATE POLICY "Permitir escritura de productos a usuarios autenticados" 
ON public.products FOR INSERT 
TO authenticated WITH CHECK (true);

CREATE POLICY "Permitir actualizacion de productos a usuarios autenticados" 
ON public.products FOR UPDATE
TO authenticated USING (true);


-- Crear tabla de detalle de ítems para Solicitudes de Transporte
CREATE TABLE IF NOT EXISTS public.transport_request_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transport_request_id UUID NOT NULL REFERENCES public.transport_requests(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    sku VARCHAR(100), -- Backup por si se elimina el producto
    description TEXT, -- Backup o detalle personalizado
    quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
    weight DECIMAL(10,2) DEFAULT 0,
    volume_m3 DECIMAL(10,2) DEFAULT 0,
    length_m DECIMAL(10,2) DEFAULT 0,
    width_m DECIMAL(10,2) DEFAULT 0,
    is_fragile BOOLEAN DEFAULT false,
    needs_stowage BOOLEAN DEFAULT false,
    needs_forklift BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE public.transport_request_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Permitir lectura de items a usuarios autenticados" 
ON public.transport_request_items FOR SELECT 
TO authenticated USING (true);

CREATE POLICY "Permitir insercion de items a usuarios autenticados" 
ON public.transport_request_items FOR INSERT 
TO authenticated WITH CHECK (true);

CREATE POLICY "Permitir actualizacion de items a usuarios autenticados" 
ON public.transport_request_items FOR UPDATE
TO authenticated USING (true);

CREATE POLICY "Permitir eliminacion de items a usuarios autenticados" 
ON public.transport_request_items FOR DELETE
TO authenticated USING (true);
