-- ============================================================
-- FASE 11: FINANZAS, COSTOS Y FACTURACIÓN
-- ============================================================

BEGIN;

-- 1. Asegurar columnas de costo en maintenance_work_orders
ALTER TABLE public.maintenance_work_orders
ADD COLUMN IF NOT EXISTS labor_cost NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS services_cost NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_cost NUMERIC(12,2) DEFAULT 0;

-- 2. Crear tabla maintenance_invoices
CREATE TABLE IF NOT EXISTS public.maintenance_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    numero VARCHAR(100) NOT NULL,
    fecha DATE NOT NULL,
    monto NUMERIC(12,2) NOT NULL DEFAULT 0,
    proveedor_id UUID,
    orden_trabajo_id UUID REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilitar RLS
ALTER TABLE public.maintenance_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Enable read for authenticated on maintenance_invoices" ON public.maintenance_invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Enable insert for authenticated on maintenance_invoices" ON public.maintenance_invoices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable update for authenticated on maintenance_invoices" ON public.maintenance_invoices FOR UPDATE TO authenticated USING (true);

-- 3. Función y Trigger para recalcular total_cost en maintenance_work_orders
CREATE OR REPLACE FUNCTION public.update_work_order_total_cost()
RETURNS TRIGGER AS $$
DECLARE
    v_parts_cost NUMERIC(12,2) := 0;
    v_labor NUMERIC(12,2) := 0;
    v_services NUMERIC(12,2) := 0;
    v_wo_id UUID;
BEGIN
    -- Determinar el ID de la OT
    IF TG_TABLE_NAME = 'inventory_transactions' THEN
        -- Manejar variaciones de esquema (si existe reference_id o work_order_reference)
        BEGIN
            EXECUTE 'SELECT work_order_reference FROM public.inventory_transactions WHERE id = $1' INTO v_wo_id USING COALESCE(NEW.id, OLD.id);
        EXCEPTION WHEN OTHERS THEN
            BEGIN
                EXECUTE 'SELECT reference_id FROM public.inventory_transactions WHERE id = $1' INTO v_wo_id USING COALESCE(NEW.id, OLD.id);
            EXCEPTION WHEN OTHERS THEN
                v_wo_id := NULL;
            END;
        END;
    ELSIF TG_TABLE_NAME = 'maintenance_work_orders' THEN
        v_wo_id := NEW.id;
    END IF;

    IF v_wo_id IS NOT NULL THEN
        -- Obtener costos base
        SELECT COALESCE(labor_cost, 0), COALESCE(services_cost, 0)
        INTO v_labor, v_services
        FROM public.maintenance_work_orders
        WHERE id = v_wo_id;

        -- Sumar transacciones de inventario vinculadas
        BEGIN
            EXECUTE 'SELECT COALESCE(SUM(total_cost), 0) FROM public.inventory_transactions WHERE work_order_reference = $1 AND type IN (''SALIDA'', ''OUT'')'
            INTO v_parts_cost USING v_wo_id;
        EXCEPTION WHEN OTHERS THEN
            v_parts_cost := 0;
        END;

        -- Actualizar OT
        UPDATE public.maintenance_work_orders
        SET total_cost = v_labor + v_services + v_parts_cost
        WHERE id = v_wo_id AND total_cost != (v_labor + v_services + v_parts_cost);
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Aplicar trigger a inventory_transactions
DROP TRIGGER IF EXISTS trg_update_wo_cost_from_inventory ON public.inventory_transactions;
CREATE TRIGGER trg_update_wo_cost_from_inventory
AFTER INSERT OR UPDATE OR DELETE ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION public.update_work_order_total_cost();

-- Aplicar trigger a maintenance_work_orders
DROP TRIGGER IF EXISTS trg_update_wo_cost_self ON public.maintenance_work_orders;
CREATE TRIGGER trg_update_wo_cost_self
AFTER UPDATE OF labor_cost, services_cost ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_work_order_total_cost();


-- 4. Crear Vista Maestra vw_asset_tco
CREATE OR REPLACE VIEW public.vw_asset_tco AS
WITH wo_costs AS (
    SELECT 
        wo.vehicle_plate,
        wo.created_at,
        wo.id,
        COALESCE(wo.labor_cost, 0) AS labor_cost,
        COALESCE(wo.services_cost, 0) AS services_cost,
        COALESCE((
            SELECT SUM(COALESCE(it.total_cost, 0))
            FROM public.inventory_transactions it
            WHERE it.work_order_reference = wo.id
              AND it.type IN ('SALIDA', 'OUT')
        ), 0) AS repuestos_cost
    FROM public.maintenance_work_orders wo
    WHERE wo.status IN ('CERRADA', 'TERMINADA')
)
SELECT 
    vehicle_plate AS placa,
    EXTRACT(YEAR FROM created_at) AS anio,
    EXTRACT(MONTH FROM created_at) AS mes,
    COUNT(id) AS ots_count,
    SUM(labor_cost) AS total_labor,
    SUM(services_cost) AS total_services,
    SUM(repuestos_cost) AS total_repuestos,
    SUM(labor_cost + services_cost + repuestos_cost) AS total_tco
FROM wo_costs
GROUP BY 
    vehicle_plate,
    EXTRACT(YEAR FROM created_at),
    EXTRACT(MONTH FROM created_at);

-- Permisos
GRANT SELECT ON public.vw_asset_tco TO authenticated;
GRANT ALL ON public.vw_asset_tco TO service_role;

COMMIT;
