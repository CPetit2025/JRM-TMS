-- Match production's FK coverage guard. Counting evidence preserves the author relation
-- without forcing a table scan when an authenticated account changes or is removed.
BEGIN;
CREATE INDEX IF NOT EXISTS apt_stock_observations_created_by_idx
 ON public.apt_stock_observations(created_by);
COMMIT;
