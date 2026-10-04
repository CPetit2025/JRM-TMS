-- ============================================================
-- Notificaciones dirigidas por rol (permiso)
-- ============================================================
-- Antes: toda la web se cargaba como "admin" y cada usuario recibía todas las alertas (solicitudes, fallas, anticipos);
-- vivían solo en la memoria del navegador y no llevaban a la pantalla donde se atienden.
-- Ahora:
--   * notifications: cada aviso guarda su categoría, gravedad, enlace y los permisos de quienes deben recibirlo
--     (según Roles y Permisos) o un usuario puntual (el solicitante). Lectura por usuario (notification_reads).
--   * notif_reglas: evento → categoría, gravedad y permisos destinatarios (editable sin cambiar código).
--   * Disparadores sobre solicitudes, despachos, anticipos, gastos de viaje, fallas y OT. Están protegidos: si un
--     aviso falla, la operación del usuario sigue (nunca bloquean una solicitud, un despacho o un gasto).
--   * notif_refresh(): avisos por tiempo (despachos atrasados, documentos pendientes, SOAT, revisión técnica y
--     licencias por vencer), a lo más cada 10 minutos, sin duplicar (clave única por evento).
--   * Preferencias: cada usuario puede silenciar una categoría.
-- Producción no coincide con las migraciones: las columnas se leen con to_jsonb y cada tabla se verifica antes de
-- crear su disparador. Toda sentencia UPDATE/DELETE lleva WHERE (pg-safeupdate).
BEGIN;

-- ------------------------------------------------------------
-- Tablas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notif_reglas (
  evento text PRIMARY KEY,
  categoria text NOT NULL CHECK (categoria IN ('TRANSPORTE', 'DESPACHO', 'CAJA', 'MANTENIMIENTO', 'CUMPLIMIENTO')),
  descripcion text NOT NULL,
  severidad text NOT NULL DEFAULT 'info' CHECK (severidad IN ('crit', 'warn', 'info')),
  permisos text[] NOT NULL DEFAULT '{}',
  al_solicitante boolean NOT NULL DEFAULT false,
  activo boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  evento text NOT NULL,
  categoria text NOT NULL,
  severidad text NOT NULL DEFAULT 'info',
  titulo text NOT NULL,
  cuerpo text,
  link text,
  permisos text[] NOT NULL DEFAULT '{}',
  target_user uuid,
  dedupe_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON public.notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_created_idx ON public.notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_target_idx ON public.notifications (target_user) WHERE target_user IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.notification_reads (
  user_id uuid NOT NULL,
  notification_id bigint NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);

CREATE TABLE IF NOT EXISTS public.notif_prefs (
  user_id uuid NOT NULL,
  categoria text NOT NULL,
  silenciada boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, categoria)
);

CREATE TABLE IF NOT EXISTS public.notif_state (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_refresh timestamptz
);
INSERT INTO public.notif_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Reglas por defecto (se conservan las ya editadas)
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('SOLICITUD_NUEVA',          'TRANSPORTE', 'Nueva solicitud de transporte',                         'info', ARRAY['solicitudes', 'despacho-aprobacion'], false),
  ('SOLICITUD_POR_APROBAR',    'TRANSPORTE', 'Solicitud pendiente de aprobación',                      'warn', ARRAY['despacho-aprobacion'], false),
  ('SOLICITUD_OBSERVADA',      'TRANSPORTE', 'Solicitud observada (falta partida o datos)',            'warn', ARRAY['solicitudes'], true),
  ('SOLICITUD_APROBADA',       'TRANSPORTE', 'Solicitud aprobada: lista para programar',              'info', ARRAY['despacho'], true),
  ('SOLICITUD_RECHAZADA',      'TRANSPORTE', 'Solicitud rechazada o cancelada',                        'info', ARRAY['solicitudes'], true),
  ('SOLICITUD_REPROGRAMADA',   'TRANSPORTE', 'Solicitud reprogramada',                                 'info', ARRAY['solicitudes', 'despacho'], true),
  ('DESPACHO_PROGRAMADO',      'DESPACHO',   'Despacho programado',                                    'info', ARRAY['despacho', 'torre-control'], false),
  ('DESPACHO_EN_RUTA',         'DESPACHO',   'Despacho en ruta',                                       'info', ARRAY['torre-control', 'monitoreo'], false),
  ('DESPACHO_ESPERA',          'DESPACHO',   'Despacho esperando autorización',                        'warn', ARRAY['despacho', 'torre-control'], false),
  ('DESPACHO_ENTREGADO',       'DESPACHO',   'Despacho entregado',                                     'info', ARRAY['despacho', 'solicitudes', 'documentario'], false),
  ('DESPACHO_CANCELADO',       'DESPACHO',   'Despacho cancelado',                                     'warn', ARRAY['despacho', 'solicitudes', 'torre-control'], false),
  ('DESPACHO_ATRASADO',        'DESPACHO',   'Despacho atrasado: su fecha pasó y no se cerró',         'crit', ARRAY['despacho', 'torre-control', 'solicitudes'], false),
  ('DOCUMENTOS_PENDIENTES',    'DESPACHO',   'Despacho con documentos (guías) pendientes',             'warn', ARRAY['documentario', 'despacho'], false),
  ('ANTICIPO_SOLICITADO',      'CAJA',       'Anticipo de viaje solicitado',                           'warn', ARRAY['caja-anticipos', 'caja-aprobacion'], false),
  ('GASTO_POR_APROBAR',        'CAJA',       'Gasto de viaje por aprobar',                             'warn', ARRAY['caja-aprobacion'], false),
  ('GASTO_OBSERVADO',          'CAJA',       'Gasto de viaje observado',                               'info', ARRAY['caja-gastos', 'caja-aprobacion'], false),
  ('FALLA_CRITICA',            'MANTENIMIENTO', 'Falla crítica o alta reportada',                      'crit', ARRAY['mantenimiento-fallas', 'mantenimiento-ot', 'mantenimiento-dashboard'], false),
  ('FALLA_REPORTADA',          'MANTENIMIENTO', 'Falla reportada',                                     'info', ARRAY['mantenimiento-fallas'], false),
  ('OT_CERRADA',               'MANTENIMIENTO', 'Orden de trabajo cerrada: unidad disponible',         'info', ARRAY['mantenimiento-ot', 'despacho', 'flota'], false),
  ('SOAT_VENCE',               'CUMPLIMIENTO', 'SOAT vencido o por vencer',                            'warn', ARRAY['mantenimiento-flota', 'mantenimiento-vencimientos', 'flota'], false),
  ('REVISION_TECNICA_VENCE',   'CUMPLIMIENTO', 'Revisión técnica vencida o por vencer',                'warn', ARRAY['mantenimiento-flota', 'mantenimiento-vencimientos', 'flota'], false),
  ('LICENCIA_VENCE',           'CUMPLIMIENTO', 'Licencia de conducir vencida o por vencer',            'warn', ARRAY['flota', 'maestros-trabajadores', 'despacho'], false)
ON CONFLICT (evento) DO NOTHING;

-- ------------------------------------------------------------
-- Permisos del usuario y visibilidad
-- ------------------------------------------------------------
-- Permisos del usuario actual sin sufijo (:read/:write); NULL si es Administrador (ve todo)
CREATE OR REPLACE FUNCTION public.notif_my_perms()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN bool_or(lower(btrim(r.name)) IN ('administrador', 'admin')) THEN NULL
              ELSE COALESCE(array_agg(DISTINCT split_part(x, ':', 1)) FILTER (WHERE x IS NOT NULL), '{}') END
  FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.permissions) = 'array' THEN r.permissions ELSE '[]'::jsonb END) x ON true
  WHERE p.id = auth.uid() AND p.is_active
$$;

CREATE OR REPLACE FUNCTION public.notif_can_see(p_permisos text[], p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text[];
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF p_target IS NOT NULL AND p_target = auth.uid() THEN RETURN true; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_active) THEN RETURN false; END IF;
  v := public.notif_my_perms();
  IF v IS NULL THEN RETURN cardinality(p_permisos) > 0 OR p_target IS NULL; END IF;   -- Administrador
  RETURN p_permisos && v;
END $$;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notif_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notif_reglas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notif_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated USING (public.notif_can_see(permisos, target_user));
DROP POLICY IF EXISTS notification_reads_own ON public.notification_reads;
CREATE POLICY notification_reads_own ON public.notification_reads FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS notif_prefs_own ON public.notif_prefs;
CREATE POLICY notif_prefs_own ON public.notif_prefs FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS notif_reglas_read ON public.notif_reglas;
CREATE POLICY notif_reglas_read ON public.notif_reglas FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.notifications, public.notification_reads, public.notif_prefs, public.notif_reglas TO authenticated;

-- Tiempo real: los usuarios reciben solo las filas que su permiso les deja ver
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- ------------------------------------------------------------
-- Emisión (nunca falla hacia afuera)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_emit(p_evento text, p_dedupe text, p_titulo text, p_cuerpo text, p_link text, p_target uuid DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; v_id bigint;
BEGIN
  SELECT * INTO r FROM public.notif_reglas WHERE evento = p_evento AND activo;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.notifications (evento, categoria, severidad, titulo, cuerpo, link, permisos, target_user, dedupe_key)
  VALUES (p_evento, r.categoria, r.severidad, left(p_titulo, 200), left(p_cuerpo, 500), p_link, r.permisos,
          CASE WHEN r.al_solicitante THEN p_target END, p_dedupe)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.notif_emit(text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notif_uuid(p text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN NULLIF(p, '')::uuid; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;

-- ------------------------------------------------------------
-- Disparadores (protegidos: un error en el aviso no afecta la operación)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_trg_solicitud()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); o jsonb; st text; ost text; ref text; who uuid; ev text;
BEGIN
  st := upper(COALESCE(n ->> 'status', ''));
  ref := COALESCE(NULLIF(n ->> 'request_code', ''), NULLIF(n ->> 'code', ''), NULLIF(n ->> 'ot_code', ''), left(n ->> 'id', 8));
  who := COALESCE(public.notif_uuid(n ->> 'created_by'), public.notif_uuid(n ->> 'requested_by'), public.notif_uuid(n ->> 'user_id'));
  IF TG_OP = 'INSERT' THEN
    PERFORM public.notif_emit('SOLICITUD_NUEVA', 'sol-new-' || (n ->> 'id'), 'Nueva solicitud de transporte ' || ref,
      concat_ws(' · ', NULLIF(n ->> 'department', ''), NULLIF(n ->> 'required_date', '')), '/solicitudes', who);
  ELSE
    o := to_jsonb(OLD); ost := upper(COALESCE(o ->> 'status', ''));
    IF st = ost THEN RETURN NULL; END IF;
    ev := CASE WHEN st LIKE '%APROBACI%' OR st = 'PENDIENTE' THEN 'SOLICITUD_POR_APROBAR'
               WHEN st = 'OBSERVADA' THEN 'SOLICITUD_OBSERVADA'
               WHEN st IN ('APROBADA', 'ASIGNADA') THEN 'SOLICITUD_APROBADA'
               WHEN st IN ('RECHAZADA', 'CANCELADA', 'ANULADA') THEN 'SOLICITUD_RECHAZADA'
               WHEN st = 'REPROGRAMADA' THEN 'SOLICITUD_REPROGRAMADA' END;
    IF ev IS NOT NULL THEN
      PERFORM public.notif_emit(ev, 'sol-' || (n ->> 'id') || '-' || st || '-' || to_char(now(), 'YYYYMMDDHH24MI'),
        'Solicitud ' || ref || ': ' || lower(replace(st, '_', ' ')),
        concat_ws(' · ', NULLIF(n ->> 'department', ''), NULLIF(n ->> 'observation_reason', ''), NULLIF(n ->> 'rejection_reason', '')), '/solicitudes', who);
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.notif_trg_despacho()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); st text; ost text; ref text; ev text; body text;
BEGIN
  st := upper(COALESCE(n ->> 'status', ''));
  ref := COALESCE(NULLIF(n ->> 'dispatch_number', ''), left(n ->> 'id', 8));
  body := concat_ws(' · ', NULLIF(n ->> 'vehicle_plate', ''), NULLIF(n ->> 'driver_name', ''), NULLIF(n ->> 'client_name', ''));
  IF TG_OP = 'INSERT' THEN
    PERFORM public.notif_emit('DESPACHO_PROGRAMADO', 'desp-new-' || (n ->> 'id'), 'Despacho ' || ref || ' programado', body, '/despacho');
    RETURN NULL;
  END IF;
  ost := upper(COALESCE(to_jsonb(OLD) ->> 'status', ''));
  IF st = ost THEN RETURN NULL; END IF;
  ev := CASE WHEN st IN ('EN_CURSO', 'EN RUTA', 'EN_RUTA', 'EN_TRANSITO') THEN 'DESPACHO_EN_RUTA'
             WHEN st = 'ESPERANDO_AUTORIZACION' THEN 'DESPACHO_ESPERA'
             WHEN st IN ('ENTREGADO', 'RETORNO_COMPLETADO') THEN 'DESPACHO_ENTREGADO'
             WHEN st IN ('CANCELADO', 'ANULADO') THEN 'DESPACHO_CANCELADO' END;
  IF ev IS NOT NULL THEN
    PERFORM public.notif_emit(ev, 'desp-' || (n ->> 'id') || '-' || st, 'Despacho ' || ref || ': ' || lower(replace(st, '_', ' ')), body, '/despacho');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.notif_trg_anticipo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW);
BEGIN
  IF upper(COALESCE(n ->> 'status', 'SOLICITADO')) NOT IN ('SOLICITADO', 'PENDIENTE') THEN RETURN NULL; END IF;
  PERFORM public.notif_emit('ANTICIPO_SOLICITADO', 'ant-' || (n ->> 'id'),
    'Anticipo ' || COALESCE(NULLIF(n ->> 'code', ''), left(n ->> 'id', 8)) || ' por S/ ' || COALESCE(n ->> 'amount', '—'),
    NULLIF(n ->> 'reason', ''), '/caja/anticipos');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.notif_trg_gasto()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); st text; ost text;
BEGIN
  st := upper(COALESCE(n ->> 'status', ''));
  ost := CASE WHEN TG_OP = 'UPDATE' THEN upper(COALESCE(to_jsonb(OLD) ->> 'status', '')) END;
  IF TG_OP = 'UPDATE' AND st = ost THEN RETURN NULL; END IF;
  IF st = 'PENDIENTE' THEN
    PERFORM public.notif_emit('GASTO_POR_APROBAR', 'gas-' || (n ->> 'id') || '-PEND',
      'Gasto por aprobar: ' || initcap(COALESCE(n ->> 'expense_type', 'gasto')) || ' S/ ' || COALESCE(n ->> 'amount', '—'),
      concat_ws(' · ', NULLIF(n ->> 'vehicle_plate', ''), NULLIF(n ->> 'description', '')), '/caja/aprobaciones');
  ELSIF st = 'OBSERVADO' THEN
    PERFORM public.notif_emit('GASTO_OBSERVADO', 'gas-' || (n ->> 'id') || '-OBS-' || to_char(now(), 'YYYYMMDDHH24MI'),
      'Gasto observado: ' || initcap(COALESCE(n ->> 'expense_type', 'gasto')) || ' S/ ' || COALESCE(n ->> 'amount', '—'),
      NULLIF(n ->> 'observation', ''), '/caja/gastos');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.notif_trg_falla()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); sev text; plate text;
BEGIN
  sev := upper(COALESCE(n ->> 'severity', n ->> 'priority', ''));
  plate := COALESCE(NULLIF(n ->> 'vehicle_plate', ''), (SELECT v.plate FROM public.vehicles v WHERE v.id::text = n ->> 'vehicle_id'));
  PERFORM public.notif_emit(CASE WHEN sev IN ('CRITICA', 'CRÍTICA', 'ALTA') THEN 'FALLA_CRITICA' ELSE 'FALLA_REPORTADA' END, 'fal-' || (n ->> 'id'),
    'Falla ' || lower(COALESCE(NULLIF(sev, ''), 'reportada')) || CASE WHEN plate IS NOT NULL THEN ' en ' || plate ELSE '' END,
    left(COALESCE(n ->> 'description', n ->> 'title', ''), 200), '/mantenimiento/fallas');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.notif_trg_ot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n jsonb := to_jsonb(NEW); st text; plate text;
BEGIN
  st := upper(COALESCE(n ->> 'status', ''));
  IF st NOT IN ('CERRADA', 'COMPLETADA') OR st = upper(COALESCE(to_jsonb(OLD) ->> 'status', '')) THEN RETURN NULL; END IF;
  plate := (SELECT v.plate FROM public.vehicles v WHERE v.id::text = n ->> 'vehicle_id');
  PERFORM public.notif_emit('OT_CERRADA', 'ot-' || (n ->> 'id') || '-' || st,
    'OT ' || COALESCE(NULLIF(n ->> 'ot_code', ''), left(n ->> 'id', 8)) || ' cerrada' || CASE WHEN plate IS NOT NULL THEN ': ' || plate || ' disponible' ELSE '' END,
    NULLIF(n ->> 'description', ''), '/mantenimiento/gestor-ot');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('transport_requests', 'notif_solicitud', 'notif_trg_solicitud', 'INSERT OR UPDATE'),
      ('dispatches', 'notif_despacho', 'notif_trg_despacho', 'INSERT OR UPDATE'),
      ('trip_advances', 'notif_anticipo', 'notif_trg_anticipo', 'INSERT'),
      ('dispatch_expenses', 'notif_gasto', 'notif_trg_gasto', 'INSERT OR UPDATE'),
      ('vehicle_failures', 'notif_falla', 'notif_trg_falla', 'INSERT'),
      ('maintenance_work_orders', 'notif_ot', 'notif_trg_ot', 'UPDATE')) AS x(tbl, trg, fn, ev)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t.trg, t.tbl);
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()', t.trg, t.ev, t.tbl, t.fn);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Avisos por tiempo (a lo más cada 10 minutos)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_refresh(p_force boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_last timestamptz; r record; d date;
BEGIN
  SELECT last_refresh INTO v_last FROM public.notif_state WHERE id = 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT p_force AND v_last IS NOT NULL AND v_last > now() - interval '10 minutes' THEN RETURN; END IF;
  UPDATE public.notif_state SET last_refresh = now() WHERE id = 1;

  -- Despachos atrasados: su fecha ya pasó y no están cerrados (un aviso por despacho y día)
  IF to_regclass('public.dispatches') IS NOT NULL THEN
    BEGIN
      FOR r IN EXECUTE $q$SELECT d.id, to_jsonb(d) AS j, public.fe_jdate(to_jsonb(d), public.fe_desp_keys()) AS f FROM public.dispatches d
          WHERE upper(COALESCE(to_jsonb(d) ->> 'status', '')) IN ('PROGRAMADO', 'ASIGNADO', 'PENDIENTE', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION')
            AND public.fe_jdate(to_jsonb(d), public.fe_desp_keys()) BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1 LIMIT 200$q$ LOOP
        PERFORM public.notif_emit('DESPACHO_ATRASADO', 'desp-late-' || r.id || '-' || CURRENT_DATE,
          'Despacho ' || COALESCE(NULLIF(r.j ->> 'dispatch_number', ''), left(r.id::text, 8)) || ' atrasado (' || to_char(r.f, 'DD/MM') || ')',
          concat_ws(' · ', lower(replace(r.j ->> 'status', '_', ' ')), NULLIF(r.j ->> 'vehicle_plate', ''), NULLIF(r.j ->> 'driver_name', '')), '/despacho');
      END LOOP;
      -- Documentos pendientes: el despacho exige documentos y aún no están listos
      FOR r IN EXECUTE $q$SELECT d.id, to_jsonb(d) AS j FROM public.dispatches d
          WHERE COALESCE((to_jsonb(d) ->> 'docs_required')::boolean, false) AND NULLIF(to_jsonb(d) ->> 'docs_ready_at', '') IS NULL
            AND upper(COALESCE(to_jsonb(d) ->> 'status', '')) NOT IN ('CANCELADO', 'ANULADO', 'CERRADO', 'LIQUIDADO')
            AND public.fe_jdate(to_jsonb(d), public.fe_desp_keys()) >= CURRENT_DATE - 7 LIMIT 200$q$ LOOP
        PERFORM public.notif_emit('DOCUMENTOS_PENDIENTES', 'desp-docs-' || r.id,
          'Despacho ' || COALESCE(NULLIF(r.j ->> 'dispatch_number', ''), left(r.id::text, 8)) || ': documentos pendientes',
          concat_ws(' · ', NULLIF(r.j ->> 'vehicle_plate', ''), NULLIF(r.j ->> 'client_name', '')), '/despacho/documentos');
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- SOAT y revisión técnica: vencidos o que vencen en 15 días (un aviso por unidad, documento y fecha)
  IF to_regclass('public.vehicles') IS NOT NULL THEN
    BEGIN
      FOR r IN EXECUTE $q$SELECT v.plate, NULLIF(to_jsonb(v) ->> 'soat_expiration', '')::date AS soat, NULLIF(to_jsonb(v) ->> 'technical_review_expiration', '')::date AS rt
          FROM public.vehicles v WHERE v.plate IS NOT NULL AND upper(COALESCE(to_jsonb(v) ->> 'status', '')) <> 'FUERA_DE_SERVICIO'$q$ LOOP
        IF r.soat IS NOT NULL AND r.soat <= CURRENT_DATE + 15 THEN
          PERFORM public.notif_emit('SOAT_VENCE', 'soat-' || r.plate || '-' || r.soat || CASE WHEN r.soat < CURRENT_DATE THEN '-v' ELSE '' END,
            'SOAT de ' || r.plate || CASE WHEN r.soat < CURRENT_DATE THEN ' vencido' ELSE ' vence el ' || to_char(r.soat, 'DD/MM') END, NULL, '/mantenimiento/documentos');
        END IF;
        IF r.rt IS NOT NULL AND r.rt <= CURRENT_DATE + 15 THEN
          PERFORM public.notif_emit('REVISION_TECNICA_VENCE', 'rt-' || r.plate || '-' || r.rt || CASE WHEN r.rt < CURRENT_DATE THEN '-v' ELSE '' END,
            'Revisión técnica de ' || r.plate || CASE WHEN r.rt < CURRENT_DATE THEN ' vencida' ELSE ' vence el ' || to_char(r.rt, 'DD/MM') END, NULL, '/mantenimiento/documentos');
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Licencias de conducir
  IF to_regclass('public.drivers') IS NOT NULL THEN
    BEGIN
      FOR r IN EXECUTE $q$SELECT dr.id, COALESCE(NULLIF(to_jsonb(dr) ->> 'full_name', ''), concat_ws(' ', to_jsonb(dr) ->> 'first_name', to_jsonb(dr) ->> 'last_name')) AS nombre,
            NULLIF(to_jsonb(dr) ->> 'license_expiration', '')::date AS lic
          FROM public.drivers dr WHERE COALESCE((to_jsonb(dr) ->> 'is_active')::boolean, true)$q$ LOOP
        IF r.lic IS NOT NULL AND r.lic <= CURRENT_DATE + 15 THEN
          PERFORM public.notif_emit('LICENCIA_VENCE', 'lic-' || r.id || '-' || r.lic || CASE WHEN r.lic < CURRENT_DATE THEN '-v' ELSE '' END,
            'Licencia de ' || COALESCE(NULLIF(btrim(r.nombre), ''), 'conductor') || CASE WHEN r.lic < CURRENT_DATE THEN ' vencida' ELSE ' vence el ' || to_char(r.lic, 'DD/MM') END,
            NULL, '/mantenimiento/documentos');
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- Retención: 90 días
  DELETE FROM public.notifications WHERE created_at < now() - interval '90 days';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
REVOKE ALL ON FUNCTION public.notif_refresh(boolean) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- RPC para la campana
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_list(p_categoria text DEFAULT NULL, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); v_items jsonb; v_counts jsonb; v_unread int; v_muted text[];
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  PERFORM public.notif_refresh(false);
  SELECT COALESCE(array_agg(categoria), '{}') INTO v_muted FROM public.notif_prefs WHERE user_id = v_uid AND silenciada;

  DROP TABLE IF EXISTS pg_temp.nx;
  CREATE TEMP TABLE nx ON COMMIT DROP AS
  SELECT n.*, EXISTS (SELECT 1 FROM public.notification_reads r WHERE r.user_id = v_uid AND r.notification_id = n.id) AS leida
  FROM public.notifications n
  WHERE n.created_at > now() - interval '30 days' AND public.notif_can_see(n.permisos, n.target_user) AND NOT (n.categoria = ANY (v_muted))
  ORDER BY n.created_at DESC LIMIT 300;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'evento', evento, 'categoria', categoria, 'severidad', severidad,
           'titulo', titulo, 'cuerpo', cuerpo, 'link', link, 'leida', leida, 'para_mi', target_user = v_uid) ORDER BY created_at DESC), '[]')
  INTO v_items FROM (SELECT * FROM nx WHERE p_categoria IS NULL OR categoria = p_categoria ORDER BY created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) z;
  SELECT COALESCE(jsonb_object_agg(categoria, n), '{}') INTO v_counts FROM (SELECT categoria, count(*) FILTER (WHERE NOT leida) AS n FROM nx GROUP BY categoria) z;
  SELECT count(*) FILTER (WHERE NOT leida) INTO v_unread FROM nx;
  RETURN jsonb_build_object('success', true, 'items', v_items, 'no_leidas', v_unread, 'por_categoria', v_counts, 'silenciadas', to_jsonb(v_muted));
END $$;

CREATE OR REPLACE FUNCTION public.notif_mark_read(p_ids bigint[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_uid uuid := auth.uid(); n int;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  INSERT INTO public.notification_reads (user_id, notification_id)
  SELECT v_uid, x.id FROM public.notifications x
  WHERE (p_ids IS NULL OR x.id = ANY (p_ids)) AND x.created_at > now() - interval '30 days' AND public.notif_can_see(x.permisos, x.target_user)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'marcadas', n);
END $$;

CREATE OR REPLACE FUNCTION public.notif_set_pref(p_categoria text, p_silenciada boolean)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  IF p_categoria NOT IN ('TRANSPORTE', 'DESPACHO', 'CAJA', 'MANTENIMIENTO', 'CUMPLIMIENTO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Categoría no válida');
  END IF;
  INSERT INTO public.notif_prefs (user_id, categoria, silenciada) VALUES (auth.uid(), p_categoria, COALESCE(p_silenciada, false))
  ON CONFLICT (user_id, categoria) DO UPDATE SET silenciada = EXCLUDED.silenciada;
  RETURN jsonb_build_object('success', true);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['notif_list(text,integer)', 'notif_mark_read(bigint[])', 'notif_set_pref(text,boolean)', 'notif_my_perms()', 'notif_can_see(text[],uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
