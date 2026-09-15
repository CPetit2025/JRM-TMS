-- ============================================================
-- 00044: Fase 3 - Caja Chica: Analítica y Trazabilidad (Auditoría)
-- ============================================================

-- 1. Vista de Análisis de Gastos por Categoría
CREATE OR REPLACE VIEW view_expense_analytics_category AS
SELECT 
    category,
    currency,
    COUNT(id) as expense_count,
    SUM(total_amount) as total_sum
FROM public.expense_records
WHERE status NOT IN ('ANULADO', 'RECHAZADO')
GROUP BY category, currency;

-- 2. Vista de Análisis de Gastos por Placa (Vehículo)
CREATE OR REPLACE VIEW view_expense_analytics_vehicle AS
SELECT 
    vehicle_plate,
    currency,
    COUNT(id) as expense_count,
    SUM(total_amount) as total_sum
FROM public.expense_records
WHERE vehicle_plate IS NOT NULL 
  AND status NOT IN ('ANULADO', 'RECHAZADO')
GROUP BY vehicle_plate, currency;

-- 3. Vista de Análisis de Gastos por Centro de Costo (Opcional si se vincula)
CREATE OR REPLACE VIEW view_expense_analytics_cost_center AS
SELECT 
    cost_center_id,
    currency,
    COUNT(id) as expense_count,
    SUM(total_amount) as total_sum
FROM public.expense_records
WHERE cost_center_id IS NOT NULL 
  AND status NOT IN ('ANULADO', 'RECHAZADO')
GROUP BY cost_center_id, currency;


-- 4. Trigger para Trazabilidad Fuerte (Auditoría en expense_audit_logs)
CREATE OR REPLACE FUNCTION log_expense_changes()
RETURNS TRIGGER AS $$
DECLARE
    v_changes JSONB := '{}'::JSONB;
BEGIN
    -- Capturar cambios críticos (Monto, Estado, Anomalías)
    IF TG_OP = 'UPDATE' THEN
        IF OLD.total_amount != NEW.total_amount THEN
            v_changes := jsonb_set(v_changes, '{total_amount}', jsonb_build_object('old', OLD.total_amount, 'new', NEW.total_amount));
        END IF;
        IF OLD.status != NEW.status THEN
            v_changes := jsonb_set(v_changes, '{status}', jsonb_build_object('old', OLD.status, 'new', NEW.status));
        END IF;
        
        -- Si hubo cambios, registramos (Asumimos que el usuario actual se pasa de alguna forma, para MVP dejamos changed_by nulo o manejado por auth context si se pudiera)
        IF v_changes != '{}'::JSONB THEN
            INSERT INTO public.expense_audit_logs (
                expense_record_id,
                changed_by,
                action,
                changes
            ) VALUES (
                NEW.id,
                (SELECT auth.uid()), -- Intenta extraer UID actual si está en sesión
                'UPDATE',
                v_changes
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_log_expense_changes ON public.expense_records;
CREATE TRIGGER trigger_log_expense_changes
AFTER UPDATE ON public.expense_records
FOR EACH ROW
EXECUTE FUNCTION log_expense_changes();

-- Refrescar esquema
NOTIFY pgrst, 'reload schema';
