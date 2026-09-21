-- Fase 1: Añadir la columna de relación específica para Subcontratos
ALTER TABLE public.contracts
ADD COLUMN IF NOT EXISTS subcontract_id UUID REFERENCES public.contracts(id);

-- Fase 1: Crear una vista que agrupa la data (Evita N+1 queries en el Frontend)
CREATE OR REPLACE VIEW public.vw_contracts_dashboard AS
SELECT 
    c.*,
    (SELECT COUNT(*) FROM public.contracts sc WHERE sc.parent_contract_id = c.id AND sc.type = 'SUBCONTRATO') as subcontracts_count,
    (SELECT COUNT(*) FROM public.contracts err WHERE err.parent_contract_id = c.id AND err.type = 'ERROR') as errors_count,
    (SELECT COUNT(*) FROM public.transport_requests tr WHERE tr.contract_id = c.id) as requests_count,
    cli.business_name as client_name,
    cb.allocated_usd,
    cb.allocated_pen,
    cb.reserved_pen,
    cb.consumed_pen,
    cb.balance_pen
FROM public.contracts c
LEFT JOIN public.clients cli ON cli.id = c.client_id
LEFT JOIN public.contract_budgets cb ON cb.contract_id = c.id
WHERE c.type IN ('CONTRATO', 'OT_INDEPENDIENTE');
