-- Pendientes del control presupuestal: la antigüedad comparaba la fecha de hoy en UTC con la fecha del pendiente en
-- Lima. Desde las 19:00 de Lima (ya es mañana en UTC) cada pendiente salía con un día de más. Ambas fechas, en Lima.
-- Parche guardado de budget_pending.
BEGIN;
DO $patch$
DECLARE def text := pg_get_functiondef('public.budget_pending()'::regprocedure);
 o text := '(now()::date - (i.since AT TIME ZONE ''America/Lima'')::date)';
 n text := '((now() AT TIME ZONE ''America/Lima'')::date - (i.since AT TIME ZONE ''America/Lima'')::date)';
BEGIN
 IF position(n IN def) > 0 THEN RETURN; END IF;
 IF position(o IN def) = 0 THEN RAISE EXCEPTION 'budget_pending cambió: revisar el parche de la antigüedad'; END IF;
 EXECUTE replace(def, o, n);
END $patch$;
NOTIFY pgrst, 'reload schema';
COMMIT;
