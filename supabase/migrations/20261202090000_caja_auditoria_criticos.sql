-- Hallazgos críticos de la auditoría (01/11/2026), Caja:
-- 1) Un gasto va a un viaje o a un anticipo, nunca a ambos: con los dos se acreditaba en las dos liquidaciones (pago
--    doble). NOT VALID: no revisa filas antiguas (C204 informa cuántas hay); rige para todo gasto nuevo o modificado.
-- 2) request_advance_from_app: un doble toque creaba dos solicitudes (la verificación de pendiente no bloqueaba). Las
--    solicitudes de un mismo conductor se atienden una a la vez; la segunda ve la primera y responde el aviso existente.
BEGIN;
SET LOCAL lock_timeout = '60s';

DO $c$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_expenses_single_target') THEN
  ALTER TABLE public.dispatch_expenses ADD CONSTRAINT dispatch_expenses_single_target
   CHECK (dispatch_id IS NULL OR advance_id IS NULL) NOT VALID;
 END IF;
END $c$;

DO $patch$
DECLARE sig regprocedure; def text;
 o text := '  IF r.requires_trip THEN';
 n text := '  -- Una solicitud a la vez por conductor: un doble toque no crea dos anticipos
  PERFORM pg_advisory_xact_lock(hashtext(''trip_advance_request:'' || v_driver::text));
  IF r.requires_trip THEN';
BEGIN
 FOR sig IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.proname = 'request_advance_from_app' AND p.pronamespace = 'public'::regnamespace LOOP
  def := pg_get_functiondef(sig);
  IF position('trip_advance_request:' IN def) > 0 THEN CONTINUE; END IF;
  IF position(o IN def) = 0 THEN RAISE EXCEPTION 'request_advance_from_app cambió: revisar el parche del doble toque'; END IF;
  EXECUTE replace(def, o, n);
 END LOOP;
END $patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
