-- MIGRATION: Fase 6 - Inspecciones y Checklists Dinámicos
-- 20260924150000_fase6_dynamic_inspections.sql

BEGIN;

-- 1. checklist_templates
CREATE TABLE IF NOT EXISTS public.checklist_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- e.g., 'PRE_TRIP', 'POST_TRIP', 'MAINTENANCE'
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. checklist_items
CREATE TABLE IF NOT EXISTS public.checklist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES public.checklist_templates(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    is_critical BOOLEAN DEFAULT false,
    response_type TEXT NOT NULL DEFAULT 'YES_NO', -- 'YES_NO', 'PASS_FAIL', 'TEXT', etc.
    position INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. inspections
CREATE TABLE IF NOT EXISTS public.inspections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate TEXT NOT NULL REFERENCES public.vehicles(plate) ON DELETE RESTRICT,
    driver_id UUID REFERENCES public.drivers(id) ON DELETE SET NULL,
    template_id UUID NOT NULL REFERENCES public.checklist_templates(id) ON DELETE RESTRICT,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    global_result TEXT, -- e.g., 'PASSED', 'FAILED', 'WARNING'
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. inspection_results
CREATE TABLE IF NOT EXISTS public.inspection_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id UUID NOT NULL REFERENCES public.inspections(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES public.checklist_items(id) ON DELETE CASCADE,
    response TEXT NOT NULL,
    observation TEXT,
    photo_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inspection_results ENABLE ROW LEVEL SECURITY;

-- Policies
DO $$
BEGIN
    -- templates
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Templates visibles para todos' AND tablename = 'checklist_templates') THEN
        CREATE POLICY "Templates visibles para todos" ON public.checklist_templates FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admin gestiona templates' AND tablename = 'checklist_templates') THEN
        CREATE POLICY "Admin gestiona templates" ON public.checklist_templates FOR ALL TO authenticated USING (has_tms_permission('mantenimiento') OR has_tms_permission('admin'));
    END IF;

    -- items
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Items visibles para todos' AND tablename = 'checklist_items') THEN
        CREATE POLICY "Items visibles para todos" ON public.checklist_items FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admin gestiona items' AND tablename = 'checklist_items') THEN
        CREATE POLICY "Admin gestiona items" ON public.checklist_items FOR ALL TO authenticated USING (has_tms_permission('mantenimiento') OR has_tms_permission('admin'));
    END IF;

    -- inspections
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Conductores ven sus inspecciones' AND tablename = 'inspections') THEN
        CREATE POLICY "Conductores ven sus inspecciones" ON public.inspections FOR SELECT TO authenticated USING (driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admin ve todas inspecciones' AND tablename = 'inspections') THEN
        CREATE POLICY "Admin ve todas inspecciones" ON public.inspections FOR SELECT TO authenticated USING (has_tms_permission('mantenimiento') OR has_tms_permission('despacho') OR has_tms_permission('admin'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Conductores crean inspecciones' AND tablename = 'inspections') THEN
        CREATE POLICY "Conductores crean inspecciones" ON public.inspections FOR INSERT TO authenticated WITH CHECK (true);
    END IF;

    -- results
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Conductores ven sus resultados' AND tablename = 'inspection_results') THEN
        CREATE POLICY "Conductores ven sus resultados" ON public.inspection_results FOR SELECT TO authenticated USING (inspection_id IN (SELECT id FROM public.inspections WHERE driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Admin ve todos resultados' AND tablename = 'inspection_results') THEN
        CREATE POLICY "Admin ve todos resultados" ON public.inspection_results FOR SELECT TO authenticated USING (has_tms_permission('mantenimiento') OR has_tms_permission('despacho') OR has_tms_permission('admin'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Conductores crean resultados' AND tablename = 'inspection_results') THEN
        CREATE POLICY "Conductores crean resultados" ON public.inspection_results FOR INSERT TO authenticated WITH CHECK (true);
    END IF;
END $$;


-- Trigger for critical failures
CREATE OR REPLACE FUNCTION public.process_inspection_critical_failure()
RETURNS TRIGGER AS $$
DECLARE
    v_item RECORD;
    v_inspection RECORD;
BEGIN
    -- Check if item is critical
    SELECT * INTO v_item FROM public.checklist_items WHERE id = NEW.item_id;
    
    IF v_item.is_critical = true AND UPPER(NEW.response) IN ('NO', 'FALLO', 'FAIL', 'MALO') THEN
        -- Get inspection details
        SELECT * INTO v_inspection FROM public.inspections WHERE id = NEW.inspection_id;
        
        -- Insert maintenance request
        INSERT INTO public.maintenance_requests (
            vehicle_plate,
            driver_id,
            description,
            severity,
            status,
            notes,
            reported_at
        ) VALUES (
            v_inspection.vehicle_plate,
            v_inspection.driver_id,
            'Fallo Crítico en Inspección: ' || v_item.text || COALESCE(' - ' || NEW.observation, ''),
            'CRITICA', -- 'CRITICA' triggers the existing transition to 'BLOQUEADA'
            'PENDIENTE',
            'Generado automáticamente por fallo en inspección (ID: ' || v_inspection.id || ')',
            NOW()
        );
        
        -- Update global result of inspection to FAILED if not already
        UPDATE public.inspections SET global_result = 'FAILED' WHERE id = NEW.inspection_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_inspection_fail'
    ) THEN
        CREATE TRIGGER trg_inspection_fail
        AFTER INSERT OR UPDATE ON public.inspection_results
        FOR EACH ROW
        EXECUTE FUNCTION public.process_inspection_critical_failure();
    END IF;
END $$;

COMMIT;
