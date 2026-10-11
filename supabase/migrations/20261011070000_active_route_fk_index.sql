BEGIN;
-- The compound unique key covers dispatch_id; request_id needs its own FK index.
CREATE INDEX IF NOT EXISTS dispatch_service_additions_request_idx
 ON public.dispatch_service_additions(request_id);
COMMIT;
