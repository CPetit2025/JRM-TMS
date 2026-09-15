-- ============================================================
-- 00043: Fase 2 - Caja Chica: Reglas, Duplicados y Anomalías
-- ============================================================

-- Función RPC para validar duplicidad de comprobantes
-- Retorna un booleano: TRUE si es duplicado, FALSE si no.
CREATE OR REPLACE FUNCTION public.check_expense_duplicate(
    p_ruc VARCHAR,
    p_type VARCHAR,
    p_serial VARCHAR,
    p_number VARCHAR
)
RETURNS BOOLEAN AS $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    -- Ignoramos si alguno es nulo
    IF p_ruc IS NULL OR p_type IS NULL OR p_serial IS NULL OR p_number IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Los recibos, tickets y otros a veces no tienen serie, pero si es factura/boleta es obligatorio
    SELECT EXISTS(
        SELECT 1 FROM public.expense_records
        WHERE provider_ruc = p_ruc
          AND document_type = p_type
          AND document_serial = p_serial
          AND document_number = p_number
          AND status != 'ANULADO'
    ) INTO v_exists;

    RETURN v_exists;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- Trigger para detectar anomalías antes de insertar un gasto
CREATE OR REPLACE FUNCTION detect_expense_anomalies()
RETURNS TRIGGER AS $$
DECLARE
    v_trip_start TIMESTAMP;
    v_trip_end TIMESTAMP;
    v_anomalies JSONB := '[]'::JSONB;
BEGIN
    -- 1. Regla de Duplicidad Forzosa (Si por alguna razón saltó la validación frontend)
    IF NEW.provider_ruc IS NOT NULL AND NEW.document_type IS NOT NULL AND NEW.document_serial IS NOT NULL AND NEW.document_number IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM public.expense_records
            WHERE provider_ruc = NEW.provider_ruc
              AND document_type = NEW.document_type
              AND document_serial = NEW.document_serial
              AND document_number = NEW.document_number
              AND id != NEW.id
              AND status != 'ANULADO'
        ) THEN
            v_anomalies := v_anomalies || '["Posible comprobante duplicado"]'::JSONB;
        END IF;
    END IF;

    -- 2. Regla de Contexto de Viaje (Si está vinculado a un viaje, la fecha debe coincidir aprox)
    IF NEW.trip_id IS NOT NULL AND NEW.issue_date IS NOT NULL THEN
        SELECT scheduled_at, completed_at 
        INTO v_trip_start, v_trip_end
        FROM public.dispatches 
        WHERE id = NEW.trip_id;

        -- Si la fecha de emision no coincide con la fecha de inicio del viaje 
        -- (simplificado para MVP: Comprobación de que no es de meses atrás)
        IF v_trip_start IS NOT NULL THEN
            IF NEW.issue_date < (v_trip_start::DATE - INTERVAL '2 days') THEN
                v_anomalies := v_anomalies || '["Fecha de comprobante no corresponde al viaje"]'::JSONB;
            END IF;
        END IF;
    END IF;

    -- Asignar las anomalías al registro
    IF jsonb_array_length(v_anomalies) > 0 THEN
        -- Combinar si ya traía anomalías de frontend
        IF NEW.anomalies IS NOT NULL THEN
            NEW.anomalies := (NEW.anomalies || v_anomalies);
        ELSE
            NEW.anomalies := v_anomalies;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_expense_anomalies ON public.expense_records;
CREATE TRIGGER trigger_expense_anomalies
BEFORE INSERT OR UPDATE ON public.expense_records
FOR EACH ROW
EXECUTE FUNCTION detect_expense_anomalies();

-- Refrescar esquema
NOTIFY pgrst, 'reload schema';
