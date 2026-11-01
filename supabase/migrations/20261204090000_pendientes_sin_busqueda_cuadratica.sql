-- Auditoría (01/11/2026), hallazgo 12: budget_pending buscaba la fecha de cada combustible estimado comparando texto
-- ('IMP:' || id), sin índice: con miles de imputaciones, cada apertura de Pendientes recorría la tabla por fila.
-- El movimiento ya trae esa fecha (moved_on = fecha de aplicación en Lima; medianoche de Lima). Parche guardado.
BEGIN;
DO $patch$
DECLARE def text := pg_get_functiondef('public.budget_pending()'::regprocedure);
 o text := '(SELECT a.applied_at FROM public.cost_allocations a WHERE ''IMP:'' || a.id = m.id)';
BEGIN
 IF position(o IN def) = 0 THEN
  IF position('m.moved_on::timestamp AT TIME ZONE' IN def) > 0 THEN RETURN; END IF;
  RAISE EXCEPTION 'budget_pending cambió: revisar el parche de la fecha del combustible estimado';
 END IF;
 EXECUTE replace(def, o, '(m.moved_on::timestamp AT TIME ZONE ''America/Lima'')');
END $patch$;
NOTIFY pgrst, 'reload schema';
COMMIT;
