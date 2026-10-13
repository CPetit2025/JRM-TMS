-- C55: toda FK necesita índice que la cubra; la PK (dispatch_id, request_id) no cubre request_id.
CREATE INDEX IF NOT EXISTS settlement_manual_closures_request_idx ON public.settlement_manual_closures(request_id);
