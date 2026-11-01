-- Hallazgos 5 a 8 de la auditoría (01/11/2026). Parches guardados: si ya están aplicados no hacen nada; si la
-- función cambió, la migración falla con un mensaje en lugar de aplicar un reemplazo a ciegas.
-- 5) review_dispatch_expense: un gasto de un anticipo ya liquidado no se revisa (igual que el de un viaje liquidado).
-- 6) Liquidar mientras entra un gasto: el gasto toma un bloqueo compartido del viaje o del anticipo, así la liquidación
--    (que los bloquea en exclusiva) termina antes o espera; nunca queda un gasto PENDIENTE en una liquidación cerrada.
-- 7) caja_driver_overdue_label corre con privilegios del dueño: solo la llaman funciones internas; nadie la ejecuta directo.
-- 8) Cuota de autorizaciones de anulación (5 por usuario cada 15 minutos) con el mismo registro de intentos.
BEGIN;
SET LOCAL lock_timeout = '60s';

DO $patch$
DECLARE def text;
 o1 text := '  IF e.dispatch_id IS NOT NULL AND public.caja_trip_is_settled(e.dispatch_id) THEN';
 n1 text := '  -- Bloqueo compartido: una liquidación en curso termina antes de evaluar
  IF e.dispatch_id IS NOT NULL THEN PERFORM 1 FROM public.dispatches WHERE id = e.dispatch_id FOR SHARE; END IF;
  IF e.advance_id IS NOT NULL THEN
    PERFORM 1 FROM public.trip_advances WHERE id = e.advance_id FOR SHARE;
    IF public.caja_advance_is_settled(e.advance_id) THEN
      RETURN jsonb_build_object(''success'', false, ''error'', ''El anticipo ya fue liquidado: reabra la liquidación para revisar el gasto'');
    END IF;
  END IF;
  IF e.dispatch_id IS NOT NULL AND public.caja_trip_is_settled(e.dispatch_id) THEN';
BEGIN
 def := pg_get_functiondef('public.review_dispatch_expense(uuid,text,text,numeric,boolean)'::regprocedure);
 IF position('El anticipo ya fue liquidado: reabra' IN def) = 0 THEN
  IF position(o1 IN def) = 0 THEN RAISE EXCEPTION 'review_dispatch_expense cambió: revisar el parche de liquidaciones'; END IF;
  EXECUTE replace(def, o1, n1);
 END IF;

 def := pg_get_functiondef('public.caja_expense_normalize()'::regprocedure);
 IF position('FROM public.trip_advances WHERE id = NEW.advance_id FOR SHARE' IN def) = 0 THEN
  IF position('  IF NEW.advance_id IS NOT NULL AND public.caja_advance_is_settled(NEW.advance_id)' IN def) = 0
     OR position('SELECT id, vehicle_plate, site_id, driver_id INTO d FROM public.dispatches WHERE id = NEW.dispatch_id;' IN def) = 0 THEN
   RAISE EXCEPTION 'caja_expense_normalize cambió: revisar el parche de liquidaciones';
  END IF;
  def := replace(def, '  IF NEW.advance_id IS NOT NULL AND public.caja_advance_is_settled(NEW.advance_id)',
   '  IF NEW.advance_id IS NOT NULL THEN PERFORM 1 FROM public.trip_advances WHERE id = NEW.advance_id FOR SHARE; END IF;
  IF NEW.advance_id IS NOT NULL AND public.caja_advance_is_settled(NEW.advance_id)');
  def := replace(def, 'SELECT id, vehicle_plate, site_id, driver_id INTO d FROM public.dispatches WHERE id = NEW.dispatch_id;',
   'SELECT id, vehicle_plate, site_id, driver_id INTO d FROM public.dispatches WHERE id = NEW.dispatch_id FOR SHARE;');
  EXECUTE def;
 END IF;

 def := pg_get_functiondef('public.reserve_registration_attempt(text,text)'::regprocedure);
 IF position('''authorizer''' IN def) = 0 THEN
  IF position('p_scope NOT IN (''driver'',''staff'')' IN def) = 0 THEN RAISE EXCEPTION 'reserve_registration_attempt cambió: revisar la cuota de autorizaciones'; END IF;
  EXECUTE replace(def, 'p_scope NOT IN (''driver'',''staff'')', 'p_scope NOT IN (''driver'',''staff'',''authorizer'')');
 END IF;
END $patch$;

DO $c$
DECLARE c text;
BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.registration_request_limits'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%scope%' AND pg_get_constraintdef(oid) NOT LIKE '%authorizer%' LOOP
  EXECUTE format('ALTER TABLE public.registration_request_limits DROP CONSTRAINT %I', c);
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.registration_request_limits'::regclass AND pg_get_constraintdef(oid) LIKE '%authorizer%') THEN
  ALTER TABLE public.registration_request_limits ADD CONSTRAINT registration_request_limits_scope_check CHECK (scope IN ('driver','staff','authorizer'));
 END IF;
END $c$;

REVOKE EXECUTE ON FUNCTION public.caja_driver_overdue_label(uuid, uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
