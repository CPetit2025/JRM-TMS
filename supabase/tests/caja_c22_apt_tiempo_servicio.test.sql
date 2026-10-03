-- CAJA C22 — APT: el rol service_role (ruta del servidor /api/apt/procesar) tiene un tiempo límite suficiente para
-- procesar el reporte total del ERP (≥ 60 s); el navegador (authenticated) no se modifica.
DO $test$
DECLARE v_srv text; v_auth text; v_fail text[] := '{}'; v_pass int := 0;
BEGIN
  SELECT substring(c FROM '^statement_timeout=(.*)$') INTO v_srv
  FROM pg_roles r, unnest(COALESCE(r.rolconfig, '{}')) c WHERE r.rolname = 'service_role' AND c LIKE 'statement_timeout=%';
  SELECT substring(c FROM '^statement_timeout=(.*)$') INTO v_auth
  FROM pg_roles r, unnest(COALESCE(r.rolconfig, '{}')) c WHERE r.rolname = 'authenticated' AND c LIKE 'statement_timeout=%';

  -- T1: service_role con 60 s o más
  IF v_srv IS NOT NULL AND (CASE WHEN v_srv ~ '^[0-9]+$' THEN v_srv::int ELSE (extract(epoch FROM v_srv::interval) * 1000)::int END) >= 60000
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 service_role statement_timeout = ' || COALESCE(v_srv, '(sin configurar)')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C22 PASS (%/1) service_role=% authenticated=%', v_pass, v_srv, COALESCE(v_auth, '(por defecto)');
  ELSE
    RAISE EXCEPTION 'CAJA C22 FAIL (%/1): % · authenticated=%', v_pass, array_to_string(v_fail, ' || '), COALESCE(v_auth, '(por defecto)');
  END IF;
END $test$;
