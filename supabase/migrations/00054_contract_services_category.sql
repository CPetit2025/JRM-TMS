-- Script para extender la tabla de servicios de contratos con la Categoría
ALTER TABLE public.contract_services 
ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Actualizar la función para recibir la Categoría
DROP FUNCTION IF EXISTS register_contract_service(UUID, VARCHAR, TEXT, DECIMAL, DATE, VARCHAR, VARCHAR, DECIMAL, VARCHAR, VARCHAR);

CREATE OR REPLACE FUNCTION register_contract_service(
    p_contract_id UUID,
    p_service_type VARCHAR(50),
    p_description TEXT,
    p_amount_pen DECIMAL,
    p_service_date DATE,
    p_plate VARCHAR(20) DEFAULT NULL,
    p_driver_name VARCHAR(150) DEFAULT NULL,
    p_hours DECIMAL DEFAULT NULL,
    p_provider_ruc VARCHAR(20) DEFAULT NULL,
    p_provider_name VARCHAR(150) DEFAULT NULL,
    p_category VARCHAR(50) DEFAULT 'Contrato'
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
        contract_id, service_type, description, amount_pen, service_date,
        plate, driver_name, hours, provider_ruc, provider_name, category, created_by
    ) VALUES (
        p_contract_id, p_service_type, p_description, p_amount_pen, COALESCE(p_service_date, CURRENT_DATE),
        p_plate, p_driver_name, p_hours, p_provider_ruc, p_provider_name, p_category, auth.uid()
    );

    -- Actualizar el presupuesto sumando el gasto al consumido, lo cual reducirá automáticamente el balance_pen
    UPDATE public.contract_budgets 
    SET consumed_pen = consumed_pen + p_amount_pen,
        updated_at = NOW()
    WHERE contract_id = p_contract_id AND concept = 'PARTIDA_TRANSPORTE';

    RETURN TRUE;
END;
$$;
