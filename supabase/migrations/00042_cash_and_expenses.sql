-- ============================================================
-- 00042: Módulo de Caja Chica y Liquidaciones
-- ============================================================

-- 1. Tabla de Fondos / Anticipos (cash_funds)
CREATE TABLE IF NOT EXISTS public.cash_funds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(20) UNIQUE NOT NULL, -- Ej: FND-0001
    date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    given_by UUID REFERENCES auth.users(id), -- Usuario Caja/Admin
    received_by UUID REFERENCES auth.users(id), -- Conductor/Supervisor
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'PEN',
    reason TEXT,
    
    -- Contexto (Relaciones a otras tablas)
    trip_id UUID REFERENCES public.dispatches(id) ON DELETE SET NULL,
    work_order_id UUID REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    vehicle_plate VARCHAR(20) REFERENCES public.vehicles(plate) ON DELETE SET NULL,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    
    status VARCHAR(50) DEFAULT 'ENTREGADO', -- BORRADOR, ENTREGADO, PARCIALMENTE_LIQUIDADO, PENDIENTE_LIQUIDACION, LIQUIDADO, CERRADO, ANULADO
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Tabla Principal de Registro de Gastos (expense_records)
CREATE TABLE IF NOT EXISTS public.expense_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_fund_id UUID REFERENCES public.cash_funds(id) ON DELETE SET NULL,
    
    category VARCHAR(100) NOT NULL,
    provider_ruc VARCHAR(20),
    provider_name VARCHAR(200),
    document_type VARCHAR(50), -- FACTURA, BOLETA, TICKET, RECIBO_HONORARIOS, OTROS
    document_serial VARCHAR(20),
    document_number VARCHAR(50),
    issue_date DATE,
    issue_time TIME,
    
    subtotal DECIMAL(10,2) DEFAULT 0,
    igv DECIMAL(10,2) DEFAULT 0,
    total_amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'PEN',
    description TEXT,
    
    -- Evidencias e IA
    evidence_original_url TEXT,
    evidence_processed_url TEXT,
    ocr_confidence_score DECIMAL(5,2),
    ocr_raw_data JSONB,
    
    -- Control y Reglas
    status VARCHAR(50) DEFAULT 'BORRADOR', -- BORRADOR, ENVIADO, EN_REVISION, APROBADO, OBSERVADO, RECHAZADO, ANULADO
    anomalies JSONB, -- Ej: ["Fuera de ruta", "Posible duplicado"]
    
    -- Contexto Financiero/Operativo Directo (por si el gasto no viene de un fondo)
    trip_id UUID REFERENCES public.dispatches(id) ON DELETE SET NULL,
    work_order_id UUID REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
    contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL,
    vehicle_plate VARCHAR(20) REFERENCES public.vehicles(plate) ON DELETE SET NULL,
    cost_center_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL,
    
    reported_by UUID REFERENCES auth.users(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Tabla de Liquidaciones (cash_settlements)
CREATE TABLE IF NOT EXISTS public.cash_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cash_fund_id UUID NOT NULL REFERENCES public.cash_funds(id) ON DELETE CASCADE,
    total_fund DECIMAL(10,2) NOT NULL DEFAULT 0,
    total_expenses DECIMAL(10,2) NOT NULL DEFAULT 0,
    balance DECIMAL(10,2) NOT NULL DEFAULT 0, -- Positivo a favor empresa, Negativo a favor usuario
    status VARCHAR(50) DEFAULT 'EN_REVISION', -- EN_REVISION, OBSERVADO, APROBADO, CERRADO
    
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_at TIMESTAMP WITH TIME ZONE,
    approved_by UUID REFERENCES auth.users(id),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Log de Auditoría Estricto
CREATE TABLE IF NOT EXISTS public.expense_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id UUID NOT NULL, -- ID del gasto, fondo o liquidación
    record_type VARCHAR(50) NOT NULL, -- FUND, EXPENSE, SETTLEMENT
    user_id UUID REFERENCES auth.users(id),
    action VARCHAR(100) NOT NULL, -- CREATED, STATUS_CHANGED, AMOUNT_CHANGED, APPROVED, REJECTED
    old_value JSONB,
    new_value JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS en las nuevas tablas
ALTER TABLE public.cash_funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_audit_logs ENABLE ROW LEVEL SECURITY;

-- Políticas base: Permitir todo a usuarios autenticados temporalmente 
-- (En Fase 2/3 se ajustarán las reglas granulares de RBAC financiero)
CREATE POLICY "Enable all for authenticated on cash_funds" ON public.cash_funds FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on expense_records" ON public.expense_records FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on cash_settlements" ON public.cash_settlements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated on expense_audit_logs" ON public.expense_audit_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Función para generar correlativos (Ej. FND-0001)
CREATE OR REPLACE FUNCTION generate_cash_fund_code()
RETURNS TRIGGER AS $$
DECLARE
    next_num INTEGER;
BEGIN
    SELECT COUNT(*) + 1 INTO next_num FROM public.cash_funds;
    NEW.code := 'FND-' || LPAD(next_num::TEXT, 4, '0');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cash_fund_code
BEFORE INSERT ON public.cash_funds
FOR EACH ROW
WHEN (NEW.code IS NULL OR NEW.code = '')
EXECUTE FUNCTION generate_cash_fund_code();

-- Refrescar caché del schema
NOTIFY pgrst, 'reload schema';
