-- 00002_add_ot_budget_rules.sql

-- 1. Añadir el Administrador de Contrato a las OTs
ALTER TABLE work_orders
ADD COLUMN contract_administrator_id UUID REFERENCES profiles(id);

-- 2. Crear tabla de histórico de ampliaciones de presupuesto
CREATE TABLE budget_extensions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    work_order_id UUID NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
    requested_amount NUMERIC(10, 2) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDIENTE', -- PENDIENTE, APROBADA, RECHAZADA
    requested_by UUID REFERENCES profiles(id),
    approved_by UUID REFERENCES profiles(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Habilitar RLS en la nueva tabla
ALTER TABLE budget_extensions ENABLE ROW LEVEL SECURITY;
