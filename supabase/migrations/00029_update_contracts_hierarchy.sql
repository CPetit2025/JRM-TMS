-- 00029_update_contracts_hierarchy.sql
-- Update contract types to include 'ERROR'
ALTER TYPE contract_type ADD VALUE IF NOT EXISTS 'ERROR';

-- Add self-referencing parent ID to support hierarchy (Contrato Madre -> Subcontratos / Errores)
ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS parent_contract_id UUID REFERENCES public.contracts(id) ON DELETE CASCADE;

-- Add index for fast hierarchical lookups
CREATE INDEX IF NOT EXISTS idx_contracts_parent_id ON public.contracts(parent_contract_id);

-- Enforce the mandatory 'Partida de Transporte' creation rule via trigger
CREATE OR REPLACE FUNCTION ensure_transport_budget()
RETURNS TRIGGER AS $$
BEGIN
    -- Automatically create a budget entry for the contract if it doesn't exist
    INSERT INTO public.contract_budgets (contract_id, concept, allocated_usd, allocated_pen)
    VALUES (NEW.id, 'PARTIDA_TRANSPORTE', 0, 0)
    ON CONFLICT (contract_id, concept) DO NOTHING;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ensure_transport_budget ON public.contracts;

CREATE TRIGGER trg_ensure_transport_budget
AFTER INSERT ON public.contracts
FOR EACH ROW
EXECUTE FUNCTION ensure_transport_budget();

-- Notify PostgREST to reload schema
NOTIFY pgrst, 'reload schema';
