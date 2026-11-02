-- La antigüedad de pendientes usa fechas de Lima en ambos lados de la resta.
BEGIN;

DO $patch$
DECLARE
  sig regprocedure := 'public.budget_pending()'::regprocedure;
  def text;
  old_expr text := '''age_days'', CASE WHEN i.since IS NOT NULL THEN (now()::date - (i.since AT TIME ZONE ''America/Lima'')::date) END,';
  new_expr text := '''age_days'', CASE WHEN i.since IS NOT NULL THEN ((now() AT TIME ZONE ''America/Lima'')::date - (i.since AT TIME ZONE ''America/Lima'')::date) END,';
BEGIN
  def := pg_get_functiondef(sig);
  IF position(new_expr IN def) > 0 THEN RETURN; END IF;
  IF position(old_expr IN def) = 0 THEN
    RAISE EXCEPTION 'Definición de budget_pending no reconocida; revisar el cálculo de antigüedad';
  END IF;
  EXECUTE replace(def, old_expr, new_expr);
END
$patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
