BEGIN;

-- 1. Table: spare_parts
CREATE TABLE IF NOT EXISTS public.spare_parts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    unit TEXT NOT NULL,
    current_stock NUMERIC(10,2) DEFAULT 0,
    min_stock NUMERIC(10,2) DEFAULT 0,
    max_stock NUMERIC(10,2) DEFAULT 0,
    unit_cost NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Table: inventory_transactions
CREATE TABLE IF NOT EXISTS public.inventory_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spare_part_id UUID REFERENCES public.spare_parts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('INGRESO', 'SALIDA', 'AJUSTE')),
    quantity NUMERIC(10,2) NOT NULL,
    total_cost NUMERIC(12,2),
    reference_document TEXT,
    work_order_reference UUID REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- 3. Table: purchase_orders
CREATE TABLE IF NOT EXISTS public.purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier TEXT NOT NULL,
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'BORRADOR' CHECK (status IN ('BORRADOR', 'ENVIADA', 'RECIBIDA', 'PARCIAL', 'CANCELADA')),
    total_amount NUMERIC(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- Note: In a real system, you'd likely want purchase_order_lines, but the requirements just specify purchase_orders basic fields.
-- We can add a simple purchase_order_lines table to link POs with spare_parts.
CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
    spare_part_id UUID REFERENCES public.spare_parts(id),
    quantity NUMERIC(10,2) NOT NULL,
    unit_cost NUMERIC(12,2) NOT NULL,
    total_cost NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
    received_quantity NUMERIC(10,2) DEFAULT 0
);


-- 4. Table: work_order_spare_parts (to track consumed parts per OT)
CREATE TABLE IF NOT EXISTS public.work_order_spare_parts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_order_id UUID NOT NULL REFERENCES public.maintenance_work_orders(id) ON DELETE CASCADE,
    spare_part_id UUID NOT NULL REFERENCES public.spare_parts(id),
    quantity NUMERIC(10,2) NOT NULL,
    unit_cost NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Automation: Deduct stock when OT is CERRADA (or COMPLETADO in this schema)
CREATE OR REPLACE FUNCTION public.process_work_order_completion()
RETURNS TRIGGER AS $$
DECLARE
    part RECORD;
BEGIN
    IF (NEW.status = 'COMPLETADO' OR NEW.status = 'CERRADA') AND (OLD.status != 'COMPLETADO' AND OLD.status != 'CERRADA') THEN
        FOR part IN SELECT * FROM public.work_order_spare_parts WHERE work_order_id = NEW.id LOOP
            -- Create inventory transaction
            INSERT INTO public.inventory_transactions (
                spare_part_id, type, quantity, total_cost, reference_document, work_order_reference, created_by
            ) VALUES (
                part.spare_part_id, 'SALIDA', part.quantity, part.quantity * part.unit_cost, 'OT-' || NEW.ot_number, NEW.id, auth.uid()
            );

            -- Deduct stock
            UPDATE public.spare_parts
            SET current_stock = current_stock - part.quantity,
                updated_at = NOW()
            WHERE id = part.spare_part_id;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_work_order_completion ON public.maintenance_work_orders;
CREATE TRIGGER trg_work_order_completion
AFTER UPDATE OF status ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.process_work_order_completion();

-- Habilitar RLS y Políticas
ALTER TABLE public.spare_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_order_spare_parts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for authenticated users on spare_parts" ON public.spare_parts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on inventory_transactions" ON public.inventory_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on purchase_orders" ON public.purchase_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on purchase_order_lines" ON public.purchase_order_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on work_order_spare_parts" ON public.work_order_spare_parts FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
