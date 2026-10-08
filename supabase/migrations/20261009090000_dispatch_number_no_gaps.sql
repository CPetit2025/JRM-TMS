-- Número de despacho sin huecos.
-- La secuencia dispatch_number_seq avanza aunque la transacción se revierta: las pruebas de caja que corren en
-- producción dentro de transacciones revertidas consumían números (siguiente 10022 → 10035 entre dos despliegues)
-- y la numeración real quedaba con saltos. El disparador ahora asigna "mayor número existente + 1" bajo un bloqueo
-- transaccional, de modo que un despacho revertido no consume número y dos registros simultáneos no se repiten.
-- La secuencia se conserva solo como referencia histórica; ya no se usa.
CREATE OR REPLACE FUNCTION public.dispatch_assign_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_next bigint;
BEGIN
  IF public.dispatch_is_auto_number(NEW.dispatch_number) THEN
    PERFORM pg_advisory_xact_lock(hashtext('public.dispatches.dispatch_number'));
    SELECT GREATEST(10000, COALESCE(max(dispatch_number::bigint) FILTER (WHERE dispatch_number ~ '^[0-9]{1,15}$'), 0)) + 1
      INTO v_next FROM public.dispatches;
    NEW.dispatch_number := v_next::text;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.dispatch_assign_number() FROM PUBLIC, anon, authenticated;
COMMENT ON SEQUENCE public.dispatch_number_seq IS 'Sin uso desde 20261009090000: el número se asigna como mayor existente + 1';
