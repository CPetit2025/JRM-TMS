-- Private deployment preflight: refresh derived FIFO only when ERP uploads
-- changed its source. Source movements and manual physical observations stay intact.
BEGIN;
SET LOCAL statement_timeout = '10min';
-- Si una carga del ERP está recalculando el APT (cada 3 h), se espera a que termine en vez de fallar el despliegue
SET LOCAL lock_timeout = '5min';
SELECT public.apt_flow_ensure_current_core();
COMMIT;
