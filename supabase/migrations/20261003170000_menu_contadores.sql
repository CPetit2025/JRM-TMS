-- ============================================================
-- Menú lateral: contadores de pendientes (solo lectura)
-- ============================================================
-- menu_pending_counts() devuelve, por pantalla del menú, cuántas cosas esperan acción. Cada contador se calcula solo si el
-- usuario tiene el permiso de esa pantalla (mismas reglas que el menú: rol Administrador, permiso exacto o con sufijo
-- ":read"/":write"). Las mismas reglas que muestran las pantallas:
--   /caja/aprobaciones      gastos de viaje en PENDIENTE u OBSERVADO                       (caja-aprobacion)  rojo
--   /caja/anticipos         anticipos SOLICITADO (aún no entregados)                      (caja-anticipos)   rojo
--   /solicitudes            solicitudes de carga PENDIENTE / PENDIENTE DE APROBACIÓN      (solicitudes)      azul
--   /mantenimiento/fallas   fallas abiertas (reportada, validada, diagnosticada, programada) (mantenimiento-fallas) rojo
--   /mantenimiento/documentos documentos de unidades y conductores vencidos o que vencen en 15 días (mantenimiento-vencimientos) ámbar
--   /apt/flujo              TN en ST VENTAS con más de un día sin guía                     (APT)              ámbar
-- Producción no coincide con las migraciones: cada tabla y columna se verifica antes de usarla y cada contador falla
-- por separado sin afectar a los demás.
BEGIN;

CREATE OR REPLACE FUNCTION public.menu_has_permission(p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active
      AND (lower(btrim(r.name)) IN ('administrador', 'admin')
           OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.permissions) = 'array' THEN r.permissions ELSE '[]'::jsonb END) x
                      WHERE x = p_permission OR x LIKE p_permission || ':%')));
$$;
REVOKE ALL ON FUNCTION public.menu_has_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.menu_has_permission(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.menu_col_exists(p_table text, p_col text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = p_table AND column_name = p_col);
$$;

CREATE OR REPLACE FUNCTION public.menu_pending_counts()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint; n2 bigint; t numeric;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;

  -- Gastos de viaje por aprobar
  IF public.menu_has_permission('caja-aprobacion') AND public.menu_col_exists('dispatch_expenses', 'status') THEN
    BEGIN
      EXECUTE $q$SELECT count(*) FROM public.dispatch_expenses WHERE status IN ('PENDIENTE', 'OBSERVADO')$q$ INTO n;
      IF n > 0 THEN v := v || jsonb_build_object('/caja/aprobaciones', jsonb_build_object('n', n, 'tono', 'crit', 'texto', n || ' gastos por aprobar u observados')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Anticipos solicitados sin entregar
  IF public.menu_has_permission('caja-anticipos') AND public.menu_col_exists('trip_advances', 'status') THEN
    BEGIN
      EXECUTE $q$SELECT count(*) FROM public.trip_advances WHERE status = 'SOLICITADO'$q$ INTO n;
      IF n > 0 THEN v := v || jsonb_build_object('/caja/anticipos', jsonb_build_object('n', n, 'tono', 'crit', 'texto', n || ' anticipos solicitados sin entregar')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Solicitudes de carga esperando aprobación
  IF public.menu_has_permission('solicitudes') AND public.menu_col_exists('transport_requests', 'status') THEN
    BEGIN
      EXECUTE $q$SELECT count(*) FROM public.transport_requests WHERE upper(btrim(status)) IN ('PENDIENTE', 'PENDIENTE DE APROBACIÓN', 'PENDIENTE DE APROBACION')$q$ INTO n;
      IF n > 0 THEN v := v || jsonb_build_object('/solicitudes', jsonb_build_object('n', n, 'tono', 'info', 'texto', n || ' solicitudes esperando aprobación')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Fallas abiertas
  IF public.menu_has_permission('mantenimiento-fallas') AND public.menu_col_exists('maintenance_requests', 'status') THEN
    BEGIN
      EXECUTE $q$SELECT count(*) FROM public.maintenance_requests WHERE status IN ('REPORTADA', 'VALIDADA', 'DIAGNOSTICADA', 'PROGRAMADA')$q$ INTO n;
      IF n > 0 THEN v := v || jsonb_build_object('/mantenimiento/fallas', jsonb_build_object('n', n, 'tono', 'crit', 'texto', n || ' fallas abiertas')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Documentos vencidos o que vencen en 15 días (unidades y conductores)
  IF public.menu_has_permission('mantenimiento-vencimientos') THEN
    n := 0;
    IF public.menu_col_exists('vehicle_documents', 'expiration_date') THEN
      BEGIN
        EXECUTE format($q$SELECT count(*) FROM public.vehicle_documents WHERE expiration_date <= CURRENT_DATE + 15 %s$q$,
          CASE WHEN public.menu_col_exists('vehicle_documents', 'is_active') THEN 'AND is_active IS NOT FALSE' ELSE '' END) INTO n2;
        n := n + COALESCE(n2, 0);
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    IF public.menu_col_exists('driver_documents', 'expiry_date') THEN
      BEGIN
        EXECUTE format($q$SELECT count(*) FROM public.driver_documents WHERE expiry_date <= CURRENT_DATE + 15 %s$q$,
          CASE WHEN public.menu_col_exists('driver_documents', 'is_active') THEN 'AND is_active IS NOT FALSE' ELSE '' END) INTO n2;
        n := n + COALESCE(n2, 0);
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
    IF n > 0 THEN v := v || jsonb_build_object('/mantenimiento/documentos', jsonb_build_object('n', n, 'tono', 'warn', 'texto', n || ' documentos vencidos o por vencer en 15 días')); END IF;
  END IF;

  -- Material detenido en ST VENTAS (más de un día sin guía)
  IF to_regprocedure('public.apt_can_view()') IS NOT NULL AND public.apt_can_view()
     AND to_regclass('public.apt_flow_layers') IS NOT NULL AND to_regclass('public.apt_flow_state') IS NOT NULL THEN
    BEGIN
      EXECUTE $q$SELECT round(COALESCE(sum(l.kg_saldo), 0) / 1000.0, 1) FROM public.apt_flow_layers l, public.apt_flow_state s
                 WHERE s.id = 1 AND l.almacen = 'ST' AND l.kg_saldo > 0 AND (l.fecha IS NULL OR s.cutoff - l.fecha >= 1)$q$ INTO t;
      IF t >= 0.1 THEN v := v || jsonb_build_object('/apt/flujo', jsonb_build_object('n', t, 'unidad', 't', 'tono', 'warn',
        'texto', replace(t::text, '.', ',') || ' TN en ST VENTAS con más de un día sin guía')); END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  RETURN jsonb_build_object('success', true, 'counts', v);
END $$;
REVOKE ALL ON FUNCTION public.menu_pending_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.menu_pending_counts() TO authenticated, service_role;

COMMIT;
