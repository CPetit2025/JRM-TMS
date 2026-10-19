-- Incidente C55 tras 20261021050000: FK nuevas de HHEE sin índice que las cubra.
CREATE INDEX IF NOT EXISTS hhee_people_history_recorded_by_idx ON public.hhee_people_history (recorded_by);
CREATE INDEX IF NOT EXISTS hhee_authorizations_approved_by_idx ON public.hhee_authorizations (approved_by);
