-- La clave foránea maintenance_requests.preuse_operation_id (20261222090000) necesita un índice completo propio
-- (Caja C55: toda FK validada y cubierta por índice).
CREATE INDEX IF NOT EXISTS idx_maintenance_requests_preuse_operation ON public.maintenance_requests (preuse_operation_id);
