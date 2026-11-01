-- La FK de proveedor de OS/OC/RQ necesita índice completo para cubrir
-- las búsquedas de integridad referencial y pasar la guarda C55.
BEGIN;

DROP INDEX IF EXISTS public.transport_requests_reference_supplier_idx;
CREATE INDEX transport_requests_reference_supplier_idx
  ON public.transport_requests(reference_supplier_id);

COMMIT;
