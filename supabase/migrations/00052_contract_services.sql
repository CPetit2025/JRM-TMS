-- Script para crear la tabla de servicios de contratos y el RPC asociado

CREATE TABLE IF NOT EXISTS public.contract_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
    service_type VARCHAR(50) NOT NULL,
    description TEXT,
    amount_pen DECIMAL(15, 2) NOT NULL,
    service_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(50) DEFAULT 'REGISTRADO',
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.contract_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for authenticated users on contract_services" 
ON public.contract_services 
FOR ALL 
TO authenticated 
USING (true) 
WITH CHECK (true);

-- Función transaccional para registrar el servicio y descontar la partida
CREATE OR REPLACE FUNCTION register_contract_service(
    p_contract_id UUID,
    p_service_type VARCHAR(50),
    p_description TEXT,
    p_amount_pen DECIMAL,
    p_service_date DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_balance DECIMAL;
BEGIN
    -- Verificar el saldo de la partida principal del contrato
    SELECT balance_pen INTO v_balance 
    FROM public.contract_budgets 
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';
    
    IF v_balance IS NULL THEN
        RAISE EXCEPTION 'Contrato o partida de transporte no encontrada';
    END IF;

    IF (v_balance - p_amount_pen) < 0 THEN
        RAISE EXCEPTION 'Saldo insuficiente en el contrato. Saldo actual disponible: % PEN', v_balance;
    END IF;

    -- Insertar el registro del servicio
    INSERT INTO public.contract_services (
        contract_id, service_type, description, amount_pen, service_date, created_by
    ) VALUES (
        p_contract_id, p_service_type, p_description, p_amount_pen, COALESCE(p_service_date, CURRENT_DATE), auth.uid()
    );

    -- Actualizar el presupuesto sumando el gasto al consumido, lo cual reducirá automáticamente el balance_pen
    UPDATE public.contract_budgets 
    SET consumed_pen = consumed_pen + p_amount_pen,
        updated_at = NOW()
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';

    RETURN TRUE;
END;
$$;
