-- C55: toda llave foránea necesita un índice completo (sin predicado) que la cubra. El de contracts.garantia_id era
-- parcial y las del cliente anterior y nuevo de contract_client_corrections no tenían índice.
CREATE INDEX IF NOT EXISTS contracts_garantia_fk_idx ON public.contracts (garantia_id);
DROP INDEX IF EXISTS public.contracts_garantia_idx;
CREATE INDEX IF NOT EXISTS contract_client_corrections_old_client_idx ON public.contract_client_corrections (old_client_id);
CREATE INDEX IF NOT EXISTS contract_client_corrections_new_client_idx ON public.contract_client_corrections (new_client_id);
