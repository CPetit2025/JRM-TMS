-- 20260924151505_cmms_schema_reconciliation.sql
-- Concilia el esquema real de producción con el que asumen las funciones CMMS (Fases 4-11).
-- maintenance_work_orders en producción usa ot_code / vehicle_id; las funciones nuevas
-- (convert_request_to_wo, generate_preventive_wo, cierre de OT, trigger de inventario)
-- usan ot_number / vehicle_plate / type / plan_id. Se agregan columnas de compatibilidad
-- y un trigger que mantiene ambas representaciones sincronizadas.

BEGIN;

-- ------------------------------------------------------------
-- 1. maintenance_work_orders: columnas de compatibilidad
-- ------------------------------------------------------------
ALTER TABLE public.maintenance_work_orders
  ADD COLUMN IF NOT EXISTS ot_number VARCHAR(50),
  ADD COLUMN IF NOT EXISTS vehicle_plate TEXT,
  ADD COLUMN IF NOT EXISTS type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES public.maintenance_plans(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.sync_work_order_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.ot_code   := COALESCE(NEW.ot_code, NEW.ot_number);
  NEW.ot_number := COALESCE(NEW.ot_number, NEW.ot_code);

  IF NEW.vehicle_id IS NULL AND NEW.vehicle_plate IS NOT NULL THEN
    SELECT id INTO NEW.vehicle_id FROM public.vehicles WHERE plate = NEW.vehicle_plate;
  ELSIF NEW.vehicle_plate IS NULL AND NEW.vehicle_id IS NOT NULL THEN
    SELECT plate INTO NEW.vehicle_plate FROM public.vehicles WHERE id = NEW.vehicle_id;
  END IF;

  NEW.source_type := COALESCE(NEW.source_type, NEW.type);
  NEW.type        := COALESCE(NEW.type, NEW.source_type);
  NEW.description := COALESCE(NEW.description, NEW.diagnostic, 'OT ' || NEW.ot_code);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_work_order_identity ON public.maintenance_work_orders;
CREATE TRIGGER trg_sync_work_order_identity
BEFORE INSERT OR UPDATE ON public.maintenance_work_orders
FOR EACH ROW
EXECUTE FUNCTION public.sync_work_order_identity();

-- Backfill (la tabla puede tener datos en otros entornos)
UPDATE public.maintenance_work_orders wo
SET ot_number = COALESCE(wo.ot_number, wo.ot_code),
    vehicle_plate = COALESCE(wo.vehicle_plate, v.plate)
FROM public.vehicles v
WHERE v.id = wo.vehicle_id
  AND (wo.ot_number IS NULL OR wo.vehicle_plate IS NULL);

CREATE INDEX IF NOT EXISTS idx_mwo_vehicle_plate ON public.maintenance_work_orders(vehicle_plate);
CREATE INDEX IF NOT EXISTS idx_mwo_plan_id ON public.maintenance_work_orders(plan_id);

-- ------------------------------------------------------------
-- 2. inventory_transactions: formato usado por process_work_order_completion()
--    y update_work_order_total_cost(). La tabla legada (part_id / transaction_type)
--    impide que CREATE TABLE IF NOT EXISTS de 20260924150500 la cree.
-- ------------------------------------------------------------
ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS spare_part_id UUID REFERENCES public.spare_parts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS type TEXT CHECK (type IN ('INGRESO', 'SALIDA', 'AJUSTE')),
  ADD COLUMN IF NOT EXISTS total_cost NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS reference_document TEXT,
  ADD COLUMN IF NOT EXISTS work_order_reference UUID REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'inventory_transactions' AND column_name = 'part_id') THEN
    ALTER TABLE public.inventory_transactions ALTER COLUMN part_id DROP NOT NULL;
    UPDATE public.inventory_transactions SET spare_part_id = part_id WHERE spare_part_id IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'inventory_transactions' AND column_name = 'transaction_type') THEN
    ALTER TABLE public.inventory_transactions ALTER COLUMN transaction_type DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inv_tx_work_order ON public.inventory_transactions(work_order_reference);

COMMIT;
