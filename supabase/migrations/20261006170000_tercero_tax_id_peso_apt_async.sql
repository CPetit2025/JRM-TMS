-- ============================================================
-- Corrección tras el despliegue del despacho tercerizado (incidentes de Caja SQL tests)
-- ============================================================
-- C41: en producción carriers guarda el RUC en tax_id (no en ruc). schedule_dispatch_tercero dejaba el FLETE sin RUC
--      del proveedor y tercero_desempeno fallaba al leer c.ruc. Se leen ambas con to_jsonb().
-- C21: el trigger de apt_uploads recalculaba el peso de TODOS los servicios al aplicar una carga de APT y, con el
--      reporte total, superaba el tiempo de la sentencia (un timeout cancela la sentencia: no lo atrapaba el
--      EXCEPTION). La aplicación de la carga vuelve a ser liviana: el peso se recalcula con el cron (cada hora) o con
--      el botón «Actualizar peso (APT)» de Contratos → Servicios.
BEGIN;

DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.schedule_dispatch_tercero(uuid, text, text, text, text, timestamptz, numeric, numeric, uuid, jsonb)'::regprocedure);
  v_def := replace(v_def, $r$v_carrier ->> 'ruc'$r$, $r$COALESCE(v_carrier ->> 'tax_id', v_carrier ->> 'ruc')$r$);
  EXECUTE v_def;
  v_def := pg_get_functiondef('public.tercero_desempeno(date, date)'::regprocedure);
  v_def := replace(v_def, $r$'ruc', c.ruc$r$, $r$'ruc', COALESCE(to_jsonb(c) ->> 'tax_id', to_jsonb(c) ->> 'ruc')$r$);
  EXECUTE v_def;
  IF pg_get_functiondef('public.tercero_desempeno(date, date)'::regprocedure) LIKE '%c.ruc%' THEN
    RAISE EXCEPTION 'tercero_desempeno sigue leyendo c.ruc';
  END IF;
END $$;

-- Aplicar una carga de APT ya no recalcula el peso de los servicios en la misma sentencia
DROP TRIGGER IF EXISTS trg_apt_uploads_peso_servicios ON public.apt_uploads;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.apt_uploads'::regclass AND NOT tgisinternal
             AND tgfoid = 'public.apt_uploads_trg_peso_servicios()'::regprocedure LOOP
    EXECUTE format('DROP TRIGGER %I ON public.apt_uploads', t.tgname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('servicios-peso-apt'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('servicios-peso-apt', '23 * * * *', $cron$SELECT public.servicios_sync_peso_apt(NULL)$cron$);   -- cada hora
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
