-- C55 exige que cada FK tenga un índice válido y no parcial que la cubra. El índice único de
-- route_forklifts.unloading_cost_id era parcial (WHERE NOT NULL); un único completo mantiene la
-- regla "una línea respalda a un solo montacarga" (varios NULL siguen permitidos) y cubre la FK.
BEGIN;
SET LOCAL lock_timeout='60s';
DROP INDEX IF EXISTS public.route_forklifts_unloading_cost_key;
CREATE UNIQUE INDEX route_forklifts_unloading_cost_key ON public.route_forklifts(unloading_cost_id);
COMMIT;
