-- Índices de las llaves foráneas de las tablas del detalle del despacho (C55: toda FK cubierta por un índice).
-- dispatch_route_estimates tiene PK (dispatch_id, request_id): request_id no queda cubierto por la PK.
BEGIN;
SET LOCAL lock_timeout='60s';
CREATE INDEX IF NOT EXISTS dispatch_evidence_request_idx ON public.dispatch_evidence(request_id);
CREATE INDEX IF NOT EXISTS dispatch_route_estimates_request_idx ON public.dispatch_route_estimates(request_id);
COMMIT;
