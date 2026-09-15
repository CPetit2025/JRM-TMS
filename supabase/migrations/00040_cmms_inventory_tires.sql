-- ============================================================
-- 00040: CMMS - Gestión de Inventario, Neumáticos y Proveedores
-- ============================================================

-- 1. Ampliación de Vehículos para Proyecciones
ALTER TABLE public.vehicles
ADD COLUMN IF NOT EXISTS average_daily_km INTEGER DEFAULT 0;

-- 2. Proveedores y Talleres
CREATE TABLE IF NOT EXISTS public.maintenance_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ruc VARCHAR(20) UNIQUE NOT NULL,
    business_name VARCHAR(200) NOT NULL,
    address TEXT,
    contact_name VARCHAR(150),
    contact_phone VARCHAR(50),
    specialty VARCHAR(100),
    rating INTEGER DEFAULT 5, -- 1 al 5
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Catálogo de Repuestos (Spare Parts)
CREATE TABLE IF NOT EXISTS public.spare_parts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    brand VARCHAR(100),
    category VARCHAR(100),
    compatibility TEXT, -- ej. "Volvo FMX, Scania"
    current_stock INTEGER DEFAULT 0,
    minimum_stock INTEGER DEFAULT 5,
    average_price_pen DECIMAL(10,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Movimientos de Repuestos (Kardex)
CREATE TABLE IF NOT EXISTS public.spare_part_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spare_part_id UUID NOT NULL REFERENCES public.spare_parts(id) ON DELETE CASCADE,
    movement_type VARCHAR(20) NOT NULL, -- 'IN' (Compra) o 'OUT' (Consumo en OT)
    quantity INTEGER NOT NULL,
    unit_price_pen DECIMAL(10,2),
    work_order_id UUID REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
    reference_document VARCHAR(100), -- Factura, Guía
    notes TEXT,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger para actualizar el stock automáticamente
CREATE OR REPLACE FUNCTION update_spare_part_stock()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.movement_type = 'IN' THEN
        UPDATE public.spare_parts
        SET current_stock = current_stock + NEW.quantity
        WHERE id = NEW.spare_part_id;
    ELSIF NEW.movement_type = 'OUT' THEN
        UPDATE public.spare_parts
        SET current_stock = current_stock - NEW.quantity
        WHERE id = NEW.spare_part_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_stock ON public.spare_part_movements;
CREATE TRIGGER trigger_update_stock
AFTER INSERT ON public.spare_part_movements
FOR EACH ROW
EXECUTE FUNCTION update_spare_part_stock();


-- 5. Llantas / Neumáticos
CREATE TABLE IF NOT EXISTS public.tires (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_code VARCHAR(50) UNIQUE NOT NULL,
    brand VARCHAR(100),
    model VARCHAR(100),
    size VARCHAR(50),
    purchase_date DATE,
    purchase_price_pen DECIMAL(10,2),
    initial_tread_depth_mm DECIMAL(5,2), -- Cocada inicial
    current_tread_depth_mm DECIMAL(5,2),
    status VARCHAR(50) DEFAULT 'ALMACEN', -- ALMACEN, INSTALADA, REENCAUCHE, BAJA
    current_vehicle_plate VARCHAR(20) REFERENCES public.vehicles(plate) ON DELETE SET NULL,
    current_position VARCHAR(20), -- ej. 'EJE1-IZQ-EXT', 'REPUESTO'
    total_km_travelled INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Historial de Movimientos de Neumáticos
CREATE TABLE IF NOT EXISTS public.tire_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tire_id UUID NOT NULL REFERENCES public.tires(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'INSTALACION', 'ROTACION', 'RETIRO', 'INSPECCION'
    vehicle_plate VARCHAR(20) REFERENCES public.vehicles(plate) ON DELETE SET NULL,
    position VARCHAR(20),
    odometer_at_action INTEGER,
    tread_depth_at_action DECIMAL(5,2),
    reason TEXT,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Modificar work_order_costs para enlazar con inventario y proveedores
ALTER TABLE public.work_order_costs
ADD COLUMN IF NOT EXISTS spare_part_id UUID REFERENCES public.spare_parts(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES public.maintenance_providers(id) ON DELETE SET NULL;


-- RLS Policies
ALTER TABLE public.maintenance_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spare_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spare_part_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tire_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for authenticated on maintenance_providers" ON public.maintenance_providers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on spare_parts" ON public.spare_parts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on spare_part_movements" ON public.spare_part_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on tires" ON public.tires FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on tire_movements" ON public.tire_movements FOR ALL TO authenticated USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
