-- Private deployment preflight: refresh derived FIFO only when ERP uploads
-- changed its source. Source movements and manual physical observations stay intact.
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';
SELECT public.apt_flow_ensure_current_core();
COMMIT;
