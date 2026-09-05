-- Create enum for contract types
CREATE TYPE contract_type AS ENUM ('CONTRATO', 'SUBCONTRATO', 'OT_INDEPENDIENTE');

-- Create contracts table (Wallet)
CREATE TABLE IF NOT EXISTS public.contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(100) UNIQUE NOT NULL,
    type contract_type NOT NULL DEFAULT 'CONTRATO',
    client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'ACTIVO',
    is_new BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create contract_budgets table
CREATE TABLE IF NOT EXISTS public.contract_budgets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    concept VARCHAR(100) NOT NULL DEFAULT 'PARTIDA_TRANSPORTE',
    allocated_usd DECIMAL(15, 2) DEFAULT 0,
    exchange_rate DECIMAL(10, 4) DEFAULT 3.75, -- Default exchange rate to convert to PEN
    allocated_pen DECIMAL(15, 2) DEFAULT 0,    -- Computed basically: allocated_usd * exchange_rate
    reserved_pen DECIMAL(15, 2) DEFAULT 0,     -- Amount reserved by pending Transport Requests
    consumed_pen DECIMAL(15, 2) DEFAULT 0,     -- Amount fully consumed by liquidated Trips
    balance_pen DECIMAL(15, 2) GENERATED ALWAYS AS (allocated_pen - reserved_pen - consumed_pen) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(contract_id, concept)
);

-- Update transport_requests to link to contracts
ALTER TABLE public.transport_requests 
ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES public.contracts(id) ON DELETE SET NULL;

-- Enable RLS
ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_budgets ENABLE ROW LEVEL SECURITY;

-- Create Policies (allow all for internal MVP)
CREATE POLICY "Enable all for authenticated users on contracts" ON public.contracts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Enable all for authenticated users on contract_budgets" ON public.contract_budgets FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Function to handle budget reservation
CREATE OR REPLACE FUNCTION reserve_transport_budget(
    p_contract_id UUID, 
    p_estimated_cost_pen DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_balance DECIMAL;
BEGIN
    -- Check balance
    SELECT balance_pen INTO v_balance FROM public.contract_budgets WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';
    
    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'Contrato o partida de transporte no encontrada';
    END IF;

    IF v_balance - p_estimated_cost_pen < 0 THEN
        RAISE EXCEPTION 'Saldo insuficiente en el contrato. Saldo actual: % PEN', v_balance;
    END IF;

    -- Reserve the balance
    UPDATE public.contract_budgets 
    SET reserved_pen = reserved_pen + p_estimated_cost_pen,
        updated_at = NOW()
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Function to convert reserved to consumed when trip is liquidated
CREATE OR REPLACE FUNCTION liquidate_transport_budget(
    p_contract_id UUID,
    p_reserved_pen DECIMAL, -- Original reserved amount to release
    p_actual_cost_pen DECIMAL -- Actual final cost to consume
) RETURNS BOOLEAN AS $$
BEGIN
    UPDATE public.contract_budgets 
    SET reserved_pen = reserved_pen - p_reserved_pen,
        consumed_pen = consumed_pen + p_actual_cost_pen,
        updated_at = NOW()
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
