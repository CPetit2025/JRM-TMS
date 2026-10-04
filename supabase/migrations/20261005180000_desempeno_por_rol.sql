-- ============================================================
-- Desempeño por rol: Despacho, Transporte, Asistente Documentario y Conductores
-- (docs/plan-kpi-supervisores.md, fases 1 a 3)
-- ============================================================
-- Fase 2 (datos que faltaban):
-- * kpi_dispatch_log: historial de estados del despacho con hora y usuario (disparador sobre dispatches). Se rellena con
--   los STATUS_CHANGE de dispatch_events. Da la salida real (EN CURSO), la entrega y el cierre.
-- * reprogramar_solicitud(): exige una causa (lista cerrada); queda en kpi_reprogramaciones.
-- * anular_documento(): la anulación de un documento exige una causa (lista cerrada): errores del documentario frente a
--   cambios de la operación.
-- * dispatch_cargos + registrar_cargo(): recepción de la guía firmada (cargo) con fecha, usuario y archivo.
-- * La responsabilidad (CONDUCTOR/EMPRESA/TERCERO) de multas e incidentes ya existe (F9) y se usa tal cual.
-- Fase 1 (indicadores):
-- * kpi_roles: quién se mide en cada rol (por permiso o nombre de rol). Conductores: drivers.
-- * kpi_parametros: KPI, meta, sentido y peso por rol (editables por quien tiene el permiso «desempeno»).
-- * desempeno_calcular(rol, sujeto, mes): valores, puntaje 0–100 por KPI, índice ponderado y calificación.
--   Conductor: un siniestro grave con responsabilidad del conductor deja el índice del mes en 0.
-- * desempeno_mio(mes), desempeno_equipo(rol, mes), conductor_mi_desempeno(mes).
-- Fase 3 (informe mensual):
-- * desempeno_informes: informe mensual de Despacho, Transporte y Documentario. Vence el día 3 (mismo plazo y penalidad
--   que Soporte Mecánico) y lo revisa quien tiene «desempeno».
-- * desempeno_alertas() (pg_cron cada hora): día 1, recordatorio del informe y resultado del mes a cada conductor;
--   desde el día 4, aviso diario de atraso al usuario y a los revisores.
-- Producción no coincide con las migraciones: las tablas operativas se leen con to_jsonb y cada bloque de cálculo
-- está protegido (si falta una columna, ese KPI queda sin dato en vez de fallar).
BEGIN;

-- ------------------------------------------------------------
-- 0. Permiso y helpers
-- ------------------------------------------------------------
UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(COALESCE(permissions, '[]'::jsonb) || '["desempeno"]'::jsonb) p)
WHERE name = 'Jefe de Distribución' AND jsonb_typeof(permissions) = 'array' AND NOT permissions ? 'desempeno';

CREATE OR REPLACE FUNCTION public.desempeno_es_revisor()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_tms_admin() OR public.has_tms_permission('desempeno');
$$;
REVOKE ALL ON FUNCTION public.desempeno_es_revisor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_es_revisor() TO authenticated;

CREATE OR REPLACE FUNCTION public.kpi_uuid(p text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN NULLIF(btrim(p), '')::uuid; EXCEPTION WHEN OTHERS THEN RETURN NULL; END $$;

-- ------------------------------------------------------------
-- 1. Fase 2: historial de estados del despacho
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_dispatch_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id uuid NOT NULL,
  estado_anterior text,
  estado_nuevo text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by uuid,
  origen text NOT NULL DEFAULT 'SISTEMA'
);
CREATE INDEX IF NOT EXISTS kpi_dispatch_log_idx ON public.kpi_dispatch_log (dispatch_id, estado_nuevo, at);
ALTER TABLE public.kpi_dispatch_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kpi_dispatch_log FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.kpi_trg_dispatch_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n text := upper(to_jsonb(NEW) ->> 'status'); o text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.kpi_dispatch_log (dispatch_id, estado_nuevo, by) VALUES (NEW.id, COALESCE(n, 'PROGRAMADO'), auth.uid());
  ELSE
    o := upper(to_jsonb(OLD) ->> 'status');
    IF n IS DISTINCT FROM o THEN
      INSERT INTO public.kpi_dispatch_log (dispatch_id, estado_anterior, estado_nuevo, by) VALUES (NEW.id, o, COALESCE(n, '?'), auth.uid());
    END IF;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_kpi_dispatch_log ON public.dispatches;
CREATE TRIGGER trg_kpi_dispatch_log AFTER INSERT OR UPDATE ON public.dispatches FOR EACH ROW EXECUTE FUNCTION public.kpi_trg_dispatch_log();

-- Historial previo desde dispatch_events ("Cambio de estado: A -> B", "Cierre de ruta: A -> LIQUIDADO")
DO $$
BEGIN
  IF to_regclass('public.dispatch_events') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.kpi_dispatch_log WHERE origen = 'HISTORICO') THEN
    EXECUTE $q$
      INSERT INTO public.kpi_dispatch_log (dispatch_id, estado_anterior, estado_nuevo, at, by, origen)
      SELECT e.dispatch_id,
             upper(btrim(substring(e.description from ':\s*([A-Za-z_ ]+?)\s*->'))),
             upper(btrim(substring(e.description from '->\s*([A-Za-z_ ]+?)(\.|$)'))),
             e.created_at, public.kpi_uuid(e.created_by::text), 'HISTORICO'
      FROM public.dispatch_events e
      WHERE e.event_type = 'STATUS_CHANGE' AND e.description ~ '->'
        AND substring(e.description from '->\s*([A-Za-z_ ]+?)(\.|$)') IS NOT NULL$q$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Historial de despachos no cargado: %', SQLERRM;
END $$;

-- ------------------------------------------------------------
-- 2. Fase 2: causa obligatoria al reprogramar
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_reprogramaciones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL,
  causa text NOT NULL CHECK (causa IN ('CLIENTE', 'ALMACEN_SIN_STOCK', 'PRODUCCION', 'SIN_UNIDAD', 'SIN_CONDUCTOR', 'VIA_CLIMA', 'DOCUMENTOS', 'OTRO')),
  detalle text,
  fecha_anterior date,
  fecha_nueva date NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by uuid
);
CREATE INDEX IF NOT EXISTS kpi_reprogramaciones_idx ON public.kpi_reprogramaciones (at);
ALTER TABLE public.kpi_reprogramaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_reprog_read ON public.kpi_reprogramaciones;
CREATE POLICY kpi_reprog_read ON public.kpi_reprogramaciones FOR SELECT TO authenticated
  USING (public.desempeno_es_revisor() OR public.has_tms_read_permission('solicitudes') OR public.has_tms_read_permission('despacho'));
GRANT SELECT ON public.kpi_reprogramaciones TO authenticated;

CREATE OR REPLACE FUNCTION public.reprogramar_solicitud(p_request_id uuid, p_fecha date, p_causa text, p_detalle text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_anterior date; v_causa text := upper(btrim(COALESCE(p_causa, '')));
BEGIN
  IF v_causa NOT IN ('CLIENTE', 'ALMACEN_SIN_STOCK', 'PRODUCCION', 'SIN_UNIDAD', 'SIN_CONDUCTOR', 'VIA_CLIMA', 'DOCUMENTOS', 'OTRO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la causa de la reprogramación');
  END IF;
  IF v_causa = 'OTRO' AND NULLIF(btrim(p_detalle), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Detalle la causa de la reprogramación');
  END IF;
  SELECT NULLIF(to_jsonb(t) ->> 'required_date', '')::date INTO v_anterior FROM public.transport_requests t WHERE t.id = p_request_id;
  PERFORM public.set_transport_request_status(p_request_id, 'REPROGRAMADA', p_fecha);   -- valida permisos, estado y fecha
  INSERT INTO public.kpi_reprogramaciones (request_id, causa, detalle, fecha_anterior, fecha_nueva, by)
  VALUES (p_request_id, v_causa, NULLIF(btrim(p_detalle), ''), v_anterior, p_fecha, auth.uid());
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.reprogramar_solicitud(uuid, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reprogramar_solicitud(uuid, date, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 3. Fase 2: causa al anular un documento y cargo (guía firmada)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_documento(p_document_id uuid, p_causa text, p_detalle text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_causa text := upper(btrim(COALESCE(p_causa, '')));
BEGIN
  IF v_causa NOT IN ('ERROR_DATOS', 'ERROR_CANTIDAD', 'ERROR_DESTINO', 'CAMBIO_UNIDAD', 'CAMBIO_CONDUCTOR', 'SOLICITUD_CLIENTE', 'OTRO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique la causa de la anulación');
  END IF;
  IF v_causa = 'OTRO' AND NULLIF(btrim(p_detalle), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Detalle la causa de la anulación');
  END IF;
  RETURN public.void_dispatch_document(p_document_id, '[' || v_causa || '] ' || COALESCE(NULLIF(btrim(p_detalle), ''), replace(initcap(replace(v_causa, '_', ' ')), 'Error ', 'Error en ')));
END $$;
REVOKE ALL ON FUNCTION public.anular_documento(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anular_documento(uuid, text, text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.dispatch_cargos (
  dispatch_id uuid PRIMARY KEY,
  recibido_at timestamptz NOT NULL DEFAULT now(),
  recibido_by uuid,
  file_path text,
  notas text
);
ALTER TABLE public.dispatch_cargos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_cargos_read ON public.dispatch_cargos;
CREATE POLICY dispatch_cargos_read ON public.dispatch_cargos FOR SELECT TO authenticated
  USING (public.has_tms_read_permission('documentario') OR public.has_tms_read_permission('despacho') OR public.desempeno_es_revisor());
GRANT SELECT ON public.dispatch_cargos TO authenticated;

CREATE OR REPLACE FUNCTION public.registrar_cargo(p_dispatch_id uuid, p_file_path text DEFAULT NULL, p_notas text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_tms_permission('documentario') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo el Asistente Documentario registra el cargo');
  END IF;
  SELECT to_jsonb(d) INTO j FROM public.dispatches d WHERE d.id = p_dispatch_id;
  IF j IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Despacho no encontrado'); END IF;
  IF upper(j ->> 'status') IN ('PROGRAMADO', 'CANCELADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho aún no salió: el cargo se registra después de la entrega');
  END IF;
  IF NULLIF(j ->> 'site_id', '') IS NOT NULL AND NOT public.can_access_site((j ->> 'site_id')::uuid) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Despacho de otra sede');
  END IF;
  IF NULLIF(btrim(p_file_path), '') IS NULL AND NULLIF(btrim(p_notas), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Adjunte la guía firmada o indique una nota');
  END IF;
  INSERT INTO public.dispatch_cargos (dispatch_id, recibido_at, recibido_by, file_path, notas)
  VALUES (p_dispatch_id, now(), auth.uid(), NULLIF(btrim(p_file_path), ''), NULLIF(btrim(p_notas), ''))
  ON CONFLICT (dispatch_id) DO UPDATE SET file_path = COALESCE(EXCLUDED.file_path, public.dispatch_cargos.file_path),
    notas = COALESCE(EXCLUDED.notas, public.dispatch_cargos.notas);   -- la fecha de recepción no cambia
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.registrar_cargo(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_cargo(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. Roles medidos y parámetros
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kpi_roles (
  rol text PRIMARY KEY CHECK (rol IN ('DESPACHO', 'TRANSPORTE', 'DOCUMENTARIO', 'CONDUCTOR')),
  nombre text NOT NULL,
  permisos text[] NOT NULL DEFAULT '{}',
  nombres_rol text[] NOT NULL DEFAULT '{}',
  informe boolean NOT NULL DEFAULT true,
  orden int NOT NULL DEFAULT 0
);
INSERT INTO public.kpi_roles (rol, nombre, permisos, nombres_rol, informe, orden) VALUES
  ('DESPACHO', 'Supervisor de Despacho', '{despacho-aprobacion}', '{%supervisor de despacho%}', true, 1),
  ('TRANSPORTE', 'Supervisor de Transporte / Jefe de Distribución', '{caja-aprobacion}', '{%transporte%,%distribuci%}', true, 2),
  ('DOCUMENTARIO', 'Asistente Documentario', '{}', '{%documentario%}', true, 3),
  ('CONDUCTOR', 'Conductores', '{}', '{}', false, 4)
ON CONFLICT (rol) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.kpi_parametros (
  rol text NOT NULL REFERENCES public.kpi_roles(rol),
  codigo text NOT NULL,
  nombre text NOT NULL,
  grupo text,
  unidad text NOT NULL DEFAULT '%',
  meta numeric NOT NULL,
  sentido text NOT NULL CHECK (sentido IN ('MAYOR', 'MENOR')),
  peso numeric NOT NULL DEFAULT 0 CHECK (peso >= 0),
  orden int NOT NULL DEFAULT 0,
  descripcion text,
  PRIMARY KEY (rol, codigo)
);
INSERT INTO public.kpi_parametros (rol, codigo, nombre, grupo, unidad, meta, sentido, peso, orden, descripcion) VALUES
  ('DESPACHO', 'aprob_2h', 'Solicitudes aprobadas en ≤ 2 h', 'Respuesta', '%', 90, 'MAYOR', 30, 1, 'De las solicitudes que aprobó en el mes, % aprobadas dentro de 2 h desde su registro'),
  ('DESPACHO', 'aprob_prom_h', 'Tiempo promedio de aprobación', 'Respuesta', 'h', 2, 'MENOR', 0, 2, 'Informativo'),
  ('DESPACHO', 'programacion_4h', 'Programadas en ≤ 4 h desde la aprobación', 'Respuesta', '%', 90, 'MAYOR', 20, 3, 'Despachos que armó en el mes, % creados dentro de 4 h desde la aprobación de la solicitud'),
  ('DESPACHO', 'observadas', 'Solicitudes observadas', 'Calidad', '%', 10, 'MENOR', 10, 4, 'Del mes (equipo): % de solicitudes con observación de partida o datos'),
  ('DESPACHO', 'reprogramadas', 'Solicitudes reprogramadas', 'Calidad', '%', 5, 'MENOR', 10, 5, 'Reprogramaciones del mes ÷ solicitudes aprobadas en el mes (equipo)'),
  ('DESPACHO', 'cumplimiento_fecha', 'Entregas en la fecha requerida', 'Cumplimiento', '%', 95, 'MAYOR', 15, 6, 'Despachos entregados en el mes con fecha ≤ fecha requerida de la solicitud (equipo)'),
  ('DESPACHO', 'informe', 'Puntualidad del informe mensual', 'Informe', '%', 100, 'MAYOR', 15, 9, '−15 puntos por día de atraso (vence el día 3)'),

  ('TRANSPORTE', 'salida_puntual', 'Salidas puntuales', 'Puntualidad', '%', 90, 'MAYOR', 20, 1, 'Inicio de ruta ≤ 30 min después de la hora programada (si se programó solo la fecha: el mismo día)'),
  ('TRANSPORTE', 'entrega_a_tiempo', 'Entregas a tiempo (OTD)', 'Puntualidad', '%', 95, 'MAYOR', 20, 2, 'Entregados en la fecha requerida o programada'),
  ('TRANSPORTE', 'sin_cerrar_48h', 'Despachos sin cerrar 48 h después de su fecha', 'Control', 'n', 0, 'MENOR', 10, 3, 'Despachos del mes que no se cerraron (liquidado/cerrado) dentro de 48 h de su fecha'),
  ('TRANSPORTE', 'checklist', 'Viajes con checklist previo', 'Control', '%', 100, 'MAYOR', 15, 4, 'Viajes que salieron con checklist del conductor'),
  ('TRANSPORTE', 'gastos_24h', 'Gastos de viaje revisados en ≤ 24 h', 'Caja', '%', 90, 'MAYOR', 10, 5, 'Gastos que revisó en el mes, % dentro de 24 h desde su registro'),
  ('TRANSPORTE', 'liquidacion_48h', 'Viajes liquidados en ≤ 48 h de la entrega', 'Caja', '%', 90, 'MAYOR', 10, 6, 'Viajes entregados en el mes y liquidados dentro de 48 h'),
  ('TRANSPORTE', 'informe', 'Puntualidad del informe mensual', 'Informe', '%', 100, 'MAYOR', 15, 9, '−15 puntos por día de atraso (vence el día 3)'),

  ('DOCUMENTARIO', 'docs_a_tiempo', 'Documentos listos antes de la salida', 'Respuesta', '%', 95, 'MAYOR', 30, 1, 'Despachos con documentos que confirmó, % confirmados antes de la hora de salida programada'),
  ('DOCUMENTARIO', 'anticipacion_h', 'Anticipación promedio a la salida', 'Respuesta', 'h', 2, 'MAYOR', 0, 2, 'Informativo: horas entre la confirmación y la salida programada'),
  ('DOCUMENTARIO', 'anulados_error', 'Documentos anulados por error', 'Calidad', '%', 2, 'MENOR', 25, 3, 'Documentos que cargó, % anulados con causa de error (datos, cantidad, destino)'),
  ('DOCUMENTARIO', 'reemisiones', 'Despachos con reemisión', 'Calidad', '%', 3, 'MENOR', 5, 4, 'Despachos con documentos que hubo que reemitir (equipo)'),
  ('DOCUMENTARIO', 'cargo_48h', 'Cargos (guías firmadas) recibidos en ≤ 48 h', 'Cierre', '%', 90, 'MAYOR', 25, 5, 'Despachos con documentos entregados en el mes con el cargo registrado dentro de 48 h'),
  ('DOCUMENTARIO', 'informe', 'Puntualidad del informe mensual', 'Informe', '%', 100, 'MAYOR', 15, 9, '−15 puntos por día de atraso (vence el día 3)'),

  ('CONDUCTOR', 'siniestros', 'Siniestros con responsabilidad del conductor', 'Seguridad', 'n', 0, 'MENOR', 12, 1, 'Un siniestro grave deja el índice del mes en 0'),
  ('CONDUCTOR', 'multas', 'Papeletas y multas imputadas', 'Seguridad', 'n', 0, 'MENOR', 8, 2, 'Multas con responsabilidad del conductor (fecha de infracción en el mes)'),
  ('CONDUCTOR', 'checklist_salida', 'Checklist previo a la ruta', 'Seguridad', '%', 100, 'MAYOR', 10, 3, 'Viajes con checklist de salida'),
  ('CONDUCTOR', 'salida_puntual', 'Salida puntual', 'Puntualidad y servicio', '%', 90, 'MAYOR', 10, 4, 'Inicio de ruta ≤ 30 min de la hora programada'),
  ('CONDUCTOR', 'entrega_a_tiempo', 'Entrega a tiempo', 'Puntualidad y servicio', '%', 95, 'MAYOR', 10, 5, 'Entregado en la fecha requerida o programada'),
  ('CONDUCTOR', 'evidencia', 'Evidencia de entrega (foto y odómetro)', 'Puntualidad y servicio', '%', 98, 'MAYOR', 5, 6, 'Paradas de entrega con foto y odómetro'),
  ('CONDUCTOR', 'rendimiento', 'Rendimiento de combustible frente a la base', 'Cuidado de la unidad', '%', 95, 'MAYOR', 10, 7, 'km/galón del mes ÷ km/galón esperado de la unidad'),
  ('CONDUCTOR', 'checklist_retorno', 'Checklist de retorno con odómetro', 'Cuidado de la unidad', '%', 100, 'MAYOR', 10, 8, 'Viajes con odómetro de cierre'),
  ('CONDUCTOR', 'fallas_reportadas', 'Fallas reportadas desde el app', 'Cuidado de la unidad', 'n', 0, 'MAYOR', 0, 9, 'Informativo: reportar a tiempo evita fallas mayores'),
  ('CONDUCTOR', 'gastos_48h', 'Gastos registrados en ≤ 48 h', 'Gastos y rendiciones', '%', 100, 'MAYOR', 7, 10, 'Gastos registrados dentro de 48 h de su fecha'),
  ('CONDUCTOR', 'gastos_observados', 'Gastos observados o rechazados', 'Gastos y rendiciones', '%', 5, 'MENOR', 5, 11, 'Gastos observados o rechazados ÷ presentados'),
  ('CONDUCTOR', 'rendiciones_vencidas', 'Rendiciones vencidas', 'Gastos y rendiciones', 'n', 0, 'MENOR', 3, 12, 'Anticipos sin rendir con el plazo vencido (al día de hoy)'),
  ('CONDUCTOR', 'licencia', 'Licencia vigente al cierre del mes', 'Documentos', '%', 100, 'MAYOR', 10, 13, 'Licencia de conducir vigente')
ON CONFLICT (rol, codigo) DO NOTHING;

ALTER TABLE public.kpi_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kpi_parametros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kpi_roles_read ON public.kpi_roles;
CREATE POLICY kpi_roles_read ON public.kpi_roles FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS kpi_param_read ON public.kpi_parametros;
CREATE POLICY kpi_param_read ON public.kpi_parametros FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.kpi_roles, public.kpi_parametros TO authenticated;

CREATE OR REPLACE FUNCTION public.desempeno_guardar_parametros(p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x jsonb; n int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.desempeno_es_revisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para cambiar metas y pesos');
  END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    UPDATE public.kpi_parametros SET meta = (x ->> 'meta')::numeric, peso = GREATEST((x ->> 'peso')::numeric, 0)
    WHERE rol = x ->> 'rol' AND codigo = x ->> 'codigo';
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('success', true, 'actualizados', n);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END $$;
REVOKE ALL ON FUNCTION public.desempeno_guardar_parametros(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_guardar_parametros(jsonb) TO authenticated;

-- Integrantes de cada rol (sin el Administrador); conductores: tabla drivers
CREATE OR REPLACE FUNCTION public.desempeno_miembros(p_rol text)
RETURNS TABLE (sujeto uuid, nombre text, user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k public.kpi_roles%ROWTYPE;
BEGIN
  SELECT * INTO k FROM public.kpi_roles WHERE rol = upper(p_rol);
  IF NOT FOUND THEN RETURN; END IF;
  IF k.rol = 'CONDUCTOR' THEN
    RETURN QUERY EXECUTE $q$
      SELECT d.id, COALESCE(NULLIF(btrim(concat_ws(' ', to_jsonb(d) ->> 'first_name', to_jsonb(d) ->> 'last_name')), ''), to_jsonb(d) ->> 'full_name', 'Conductor'),
             public.kpi_uuid(to_jsonb(d) ->> 'profile_id')
      FROM public.drivers d
      WHERE upper(COALESCE(to_jsonb(d) ->> 'status', 'ACTIVO')) NOT IN ('INACTIVO', 'BAJA', 'CESADO')
        AND COALESCE((to_jsonb(d) ->> 'is_active')::boolean, true)$q$;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.id, COALESCE(public.lease_person_name(p.id), 'Usuario'), p.id
  FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
  WHERE p.is_active AND lower(r.name) NOT IN ('administrador', 'admin') AND jsonb_typeof(r.permissions) = 'array'
    AND (EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.permissions) x WHERE split_part(x, ':', 1) = ANY (k.permisos))
         OR EXISTS (SELECT 1 FROM unnest(k.nombres_rol) n WHERE lower(r.name) LIKE n));
END $$;
REVOKE ALL ON FUNCTION public.desempeno_miembros(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Base de despachos para los indicadores (lectura defensiva)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.kpi_despachos_v AS
SELECT z.*,
  (SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo IN ('EN_CURSO', 'EN CURSO', 'EN RUTA', 'EN_RUTA')) AS salida_at,
  COALESCE((SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo = 'ENTREGADO'), z.llegada) AS entrega_at,
  (SELECT min(l.at) FROM public.kpi_dispatch_log l WHERE l.dispatch_id = z.id AND l.estado_nuevo IN ('LIQUIDADO', 'CERRADO')) AS cierre_at,
  (SELECT min(NULLIF(to_jsonb(t) ->> 'required_date', '')::date) FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id WHERE r.dispatch_id = z.id) AS requerida,
  (SELECT min(NULLIF(to_jsonb(t) ->> 'approved_at', '')::timestamptz) FROM public.dispatch_requests r JOIN public.transport_requests t ON t.id = r.transport_request_id WHERE r.dispatch_id = z.id) AS aprobada_at
FROM (
  SELECT d.id, j ->> 'dispatch_number' AS numero, upper(COALESCE(j ->> 'status', '')) AS estado,
         public.kpi_uuid(j ->> 'driver_id') AS driver_id, j ->> 'vehicle_plate' AS placa,
         public.kpi_uuid(j ->> 'created_by') AS creado_por, NULLIF(j ->> 'created_at', '')::timestamptz AS creado_at,
         COALESCE(NULLIF(j ->> 'scheduled_departure', '')::timestamptz, NULLIF(j ->> 'scheduled_date', '')::timestamptz) AS programado,
         COALESCE((j ->> 'docs_required')::boolean, false) AS docs_required,
         NULLIF(j ->> 'docs_ready_at', '')::timestamptz AS docs_ready_at, public.kpi_uuid(j ->> 'docs_ready_by') AS docs_ready_by,
         NULLIF(j ->> 'docs_reissue_at', '')::timestamptz AS docs_reissue_at,
         NULLIF(j ->> 'start_odometer', '')::numeric AS odo_ini, NULLIF(j ->> 'end_odometer', '')::numeric AS odo_fin,
         NULLIF(NULLIF(j ->> 'actual_distance_km', '')::numeric, 0) AS km_gps,
         NULLIF(j ->> 'arrival_time', '')::timestamptz AS llegada
  FROM (SELECT d0.id, to_jsonb(d0) AS j FROM public.dispatches d0) d
) z;
REVOKE ALL ON public.kpi_despachos_v FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.kpi_puntaje(p_valor numeric, p_meta numeric, p_sentido text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_valor IS NULL THEN NULL
    WHEN p_sentido = 'MAYOR' THEN CASE WHEN p_meta <= 0 THEN 100 ELSE round(LEAST(100, GREATEST(0, p_valor / p_meta * 100)), 1) END
    WHEN p_valor <= p_meta THEN 100
    WHEN p_meta = 0 THEN GREATEST(0, 100 - p_valor * 50)
    ELSE round(GREATEST(0, 100 - (p_valor - p_meta) / p_meta * 100), 1) END;
$$;

-- Salida puntual: si se programó solo la fecha (00:00), basta salir ese día
CREATE OR REPLACE FUNCTION public.kpi_salida_puntual(p_salida timestamptz, p_programado timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_salida IS NULL OR p_programado IS NULL THEN NULL
    WHEN (p_programado AT TIME ZONE 'America/Lima')::time = time '00:00' THEN (p_salida AT TIME ZONE 'America/Lima')::date <= (p_programado AT TIME ZONE 'America/Lima')::date
    ELSE p_salida <= p_programado + interval '30 minutes' END;
$$;

CREATE OR REPLACE FUNCTION public.kpi_pct(p_ok bigint, p_total bigint)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN COALESCE(p_total, 0) > 0 THEN round(100.0 * p_ok / p_total, 1) END $$;

-- ------------------------------------------------------------
-- 6. Informe mensual por rol
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.desempeno_informes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  rol text NOT NULL REFERENCES public.kpi_roles(rol),
  periodo date NOT NULL CHECK (extract(day FROM periodo) = 1),
  kpis jsonb NOT NULL DEFAULT '{}'::jsonb,
  logros text NOT NULL,
  problemas text,
  acciones text,
  estado text NOT NULL DEFAULT 'ENVIADO' CHECK (estado IN ('ENVIADO', 'OBSERVADO', 'REVISADO')),
  enviado_at timestamptz NOT NULL DEFAULT now(),
  actualizado_at timestamptz NOT NULL DEFAULT now(),
  dias_desde_cierre int NOT NULL DEFAULT 0,
  dias_atraso int NOT NULL DEFAULT 0,
  revisado_por uuid,
  revisado_at timestamptz,
  comentario text,
  UNIQUE (user_id, rol, periodo)
);
ALTER TABLE public.desempeno_informes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS desempeno_informes_read ON public.desempeno_informes;
CREATE POLICY desempeno_informes_read ON public.desempeno_informes FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.desempeno_es_revisor());
GRANT SELECT ON public.desempeno_informes TO authenticated;

-- ------------------------------------------------------------
-- 7. Cálculo
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desempeno_calcular(p_rol text, p_sujeto uuid, p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rol text := upper(p_rol);
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_ini date := date_trunc('month', COALESCE(p_mes, v_hoy))::date;
  v_fin date := (date_trunc('month', COALESCE(p_mes, v_hoy)) + interval '1 month - 1 day')::date;
  t0 timestamptz; t1 timestamptz;
  val jsonb := '{}'::jsonb;          -- codigo → valor
  ctx jsonb := '{}'::jsonb;          -- codigo → "n de m"
  notas text[] := '{}';
  a bigint; b bigint; x numeric; y numeric; z numeric;
  v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int;
  v_pen numeric := public.soporte_param('penalidad_dia_atraso', 15);
  inf record; v_venc date; v_atraso int; v_grave boolean := false;
  v_kpis jsonb; v_idx numeric; v_driver jsonb; v_cob numeric;
BEGIN
  t0 := v_ini::timestamp AT TIME ZONE 'America/Lima';
  t1 := (v_fin + 1)::timestamp AT TIME ZONE 'America/Lima';
  SELECT * INTO inf FROM public.desempeno_informes WHERE false;

  IF v_rol = 'DESPACHO' THEN
    BEGIN
      SELECT count(*) FILTER (WHERE apr - cre <= interval '2 hours'), count(*), round(avg(extract(epoch FROM apr - cre) / 3600)::numeric, 1)
      INTO a, b, x
      FROM (SELECT NULLIF(to_jsonb(t) ->> 'approved_at', '')::timestamptz AS apr, NULLIF(to_jsonb(t) ->> 'created_at', '')::timestamptz AS cre,
                   public.kpi_uuid(to_jsonb(t) ->> 'approved_by') AS por FROM public.transport_requests t) s
      WHERE por = p_sujeto AND apr >= t0 AND apr < t1 AND cre IS NOT NULL;
      val := val || jsonb_build_object('aprob_2h', public.kpi_pct(a, b), 'aprob_prom_h', x); ctx := ctx || jsonb_build_object('aprob_2h', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('aprobación: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE creado_at - aprobada_at <= interval '4 hours'), count(*) INTO a, b
      FROM public.kpi_despachos_v WHERE creado_por = p_sujeto AND creado_at >= t0 AND creado_at < t1 AND aprobada_at IS NOT NULL;
      val := val || jsonb_build_object('programacion_4h', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('programacion_4h', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('programación: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE NULLIF(j ->> 'budget_observation', '') IS NOT NULL OR upper(j ->> 'status') = 'OBSERVADA'), count(*) INTO a, b
      FROM (SELECT to_jsonb(t) AS j FROM public.transport_requests t) s
      WHERE NULLIF(j ->> 'created_at', '')::timestamptz >= t0 AND NULLIF(j ->> 'created_at', '')::timestamptz < t1;
      val := val || jsonb_build_object('observadas', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('observadas', a || ' de ' || b);
      SELECT count(*) INTO a FROM public.kpi_reprogramaciones WHERE at >= t0 AND at < t1;
      SELECT count(*) INTO b FROM (SELECT NULLIF(to_jsonb(t) ->> 'approved_at', '')::timestamptz AS apr FROM public.transport_requests t) s WHERE apr >= t0 AND apr < t1;
      val := val || jsonb_build_object('reprogramadas', CASE WHEN b > 0 THEN round(100.0 * a / b, 1) END); ctx := ctx || jsonb_build_object('reprogramadas', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('solicitudes: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE (entrega_at AT TIME ZONE 'America/Lima')::date <= requerida), count(*) INTO a, b
      FROM public.kpi_despachos_v WHERE entrega_at >= t0 AND entrega_at < t1 AND requerida IS NOT NULL;
      val := val || jsonb_build_object('cumplimiento_fecha', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('cumplimiento_fecha', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('entregas: ' || SQLERRM); END;

  ELSIF v_rol = 'TRANSPORTE' THEN
    BEGIN
      SELECT count(*) FILTER (WHERE public.kpi_salida_puntual(salida_at, programado)), count(*) FILTER (WHERE salida_at IS NOT NULL),
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.driver_checklists c WHERE c.dispatch_id = v.id)), count(*) FILTER (WHERE salida_at IS NOT NULL OR estado NOT IN ('PROGRAMADO', 'CANCELADO'))
      INTO a, b, x, y
      FROM public.kpi_despachos_v v WHERE programado >= t0 AND programado < t1 AND estado <> 'CANCELADO';
      val := val || jsonb_build_object('salida_puntual', public.kpi_pct(a, b), 'checklist', public.kpi_pct(x::bigint, y::bigint));
      ctx := ctx || jsonb_build_object('salida_puntual', a || ' de ' || b, 'checklist', x || ' de ' || y);
      SELECT count(*) FILTER (WHERE (entrega_at AT TIME ZONE 'America/Lima')::date <= COALESCE(requerida, (programado AT TIME ZONE 'America/Lima')::date)), count(*) INTO a, b
      FROM public.kpi_despachos_v WHERE entrega_at >= t0 AND entrega_at < t1;
      val := val || jsonb_build_object('entrega_a_tiempo', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('entrega_a_tiempo', a || ' de ' || b);
      SELECT count(*) FILTER (WHERE cierre_at IS NULL OR cierre_at > programado + interval '48 hours'), count(*) INTO a, b FROM public.kpi_despachos_v
      WHERE programado >= t0 AND programado < t1 AND estado <> 'CANCELADO' AND programado < now() - interval '48 hours';
      IF b > 0 THEN val := val || jsonb_build_object('sin_cerrar_48h', a); ctx := ctx || jsonb_build_object('sin_cerrar_48h', a || ' de ' || b); END IF;
      SELECT count(*) FILTER (WHERE cierre_at <= entrega_at + interval '48 hours'), count(*) INTO a, b
      FROM public.kpi_despachos_v WHERE entrega_at >= t0 AND entrega_at < t1 AND entrega_at < now() - interval '48 hours';
      val := val || jsonb_build_object('liquidacion_48h', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('liquidacion_48h', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('despachos: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE rev - cre <= interval '24 hours'), count(*) INTO a, b
      FROM (SELECT NULLIF(to_jsonb(e) ->> 'created_at', '')::timestamptz AS cre,
                   COALESCE(NULLIF(to_jsonb(e) ->> 'first_approved_at', '')::timestamptz, NULLIF(to_jsonb(e) ->> 'reviewed_at', '')::timestamptz) AS rev,
                   COALESCE(public.kpi_uuid(to_jsonb(e) ->> 'first_approved_by'), public.kpi_uuid(to_jsonb(e) ->> 'reviewed_by')) AS por
            FROM public.dispatch_expenses e) s
      WHERE por = p_sujeto AND rev >= t0 AND rev < t1;
      val := val || jsonb_build_object('gastos_24h', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('gastos_24h', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('gastos: ' || SQLERRM); END;

  ELSIF v_rol = 'DOCUMENTARIO' THEN
    BEGIN
      SELECT count(*) FILTER (WHERE docs_ready_at <= programado), count(*), round(avg(extract(epoch FROM programado - docs_ready_at) / 3600)::numeric, 1)
      INTO a, b, x
      FROM public.kpi_despachos_v WHERE docs_required AND docs_ready_by = p_sujeto AND programado >= t0 AND programado < t1 AND docs_ready_at IS NOT NULL;
      val := val || jsonb_build_object('docs_a_tiempo', public.kpi_pct(a, b), 'anticipacion_h', x); ctx := ctx || jsonb_build_object('docs_a_tiempo', a || ' de ' || b);
      SELECT count(*) FILTER (WHERE docs_reissue_at IS NOT NULL), count(*) INTO a, b
      FROM public.kpi_despachos_v WHERE docs_required AND programado >= t0 AND programado < t1 AND estado <> 'CANCELADO';
      val := val || jsonb_build_object('reemisiones', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('reemisiones', a || ' de ' || b);
      SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.dispatch_cargos c WHERE c.dispatch_id = v.id AND c.recibido_at <= v.entrega_at + interval '48 hours')), count(*)
      INTO a, b
      FROM public.kpi_despachos_v v WHERE docs_required AND entrega_at >= t0 AND entrega_at < t1;
      val := val || jsonb_build_object('cargo_48h', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('cargo_48h', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('despachos: ' || SQLERRM); END;
    BEGIN
      IF to_regclass('public.dispatch_documents') IS NOT NULL THEN
        EXECUTE $q$SELECT count(*) FILTER (WHERE voided_at IS NOT NULL AND (void_reason LIKE '[ERROR%' OR (void_reason NOT LIKE '[%' AND voided_at IS NOT NULL))), count(*)
                   FROM public.dispatch_documents WHERE uploaded_by = $1 AND uploaded_at >= $2 AND uploaded_at < $3$q$
        INTO a, b USING p_sujeto, t0, t1;
        val := val || jsonb_build_object('anulados_error', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('anulados_error', a || ' de ' || b);
      END IF;
    EXCEPTION WHEN OTHERS THEN notas := notas || ('documentos: ' || SQLERRM); END;

  ELSIF v_rol = 'CONDUCTOR' THEN
    SELECT to_jsonb(d) INTO v_driver FROM public.drivers d WHERE d.id = p_sujeto;
    BEGIN
      SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.driver_checklists c WHERE c.dispatch_id = v.id)),
             count(*) FILTER (WHERE salida_at IS NOT NULL OR estado NOT IN ('PROGRAMADO', 'CANCELADO'))
      INTO a, b FROM public.kpi_despachos_v v WHERE driver_id = p_sujeto AND programado >= t0 AND programado < t1 AND estado <> 'CANCELADO';
      val := val || jsonb_build_object('checklist_salida', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('checklist_salida', a || ' de ' || b);
      SELECT count(*) FILTER (WHERE public.kpi_salida_puntual(salida_at, programado)), count(*) FILTER (WHERE salida_at IS NOT NULL) INTO a, b
      FROM public.kpi_despachos_v WHERE driver_id = p_sujeto AND programado >= t0 AND programado < t1;
      val := val || jsonb_build_object('salida_puntual', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('salida_puntual', a || ' de ' || b);
      SELECT count(*) FILTER (WHERE (entrega_at AT TIME ZONE 'America/Lima')::date <= COALESCE(requerida, (programado AT TIME ZONE 'America/Lima')::date)), count(*),
             count(*) FILTER (WHERE odo_fin IS NOT NULL AND odo_fin > 0)
      INTO a, b, x FROM public.kpi_despachos_v WHERE driver_id = p_sujeto AND entrega_at >= t0 AND entrega_at < t1;
      val := val || jsonb_build_object('entrega_a_tiempo', public.kpi_pct(a, b), 'checklist_retorno', public.kpi_pct(x::bigint, b));
      ctx := ctx || jsonb_build_object('entrega_a_tiempo', a || ' de ' || b, 'checklist_retorno', x || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('viajes: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE NULLIF(s.photo_url, '') IS NOT NULL AND COALESCE(s.odometer_km, 0) > 0), count(*) INTO a, b
      FROM public.route_stops_log s
      WHERE s.driver_id = p_sujeto AND upper(COALESCE(s.stop_type, '')) = 'ENTREGA' AND s.arrival_time >= t0 AND s.arrival_time < t1;
      val := val || jsonb_build_object('evidencia', public.kpi_pct(a, b)); ctx := ctx || jsonb_build_object('evidencia', a || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('paradas: ' || SQLERRM); END;
    BEGIN   -- rendimiento: km del mes ÷ galones cargados, frente al km/galón esperado de las unidades usadas
      SELECT sum(CASE WHEN odo_fin > odo_ini AND odo_fin - odo_ini < 2000 THEN odo_fin - odo_ini ELSE km_gps END),
             (SELECT sum(NULLIF(to_jsonb(e) ->> 'fuel_gallons', '')::numeric) FROM public.dispatch_expenses e
               WHERE public.kpi_uuid(to_jsonb(e) ->> 'dispatch_id') IN (SELECT v2.id FROM public.kpi_despachos_v v2 WHERE v2.driver_id = p_sujeto AND v2.programado >= t0 AND v2.programado < t1)
                 AND upper(COALESCE(to_jsonb(e) ->> 'status', '')) NOT IN ('RECHAZADO', 'ANULADO'))
      INTO x, y FROM public.kpi_despachos_v WHERE driver_id = p_sujeto AND programado >= t0 AND programado < t1;
      SELECT avg(NULLIF(to_jsonb(vh) ->> 'expected_km_per_gallon', '')::numeric) INTO z
      FROM public.vehicles vh WHERE vh.plate IN (SELECT placa FROM public.kpi_despachos_v WHERE driver_id = p_sujeto AND programado >= t0 AND programado < t1);
      IF x > 0 AND y > 0 AND z > 0 THEN
        val := val || jsonb_build_object('rendimiento', round(100.0 * (x / y) / z, 1));
        ctx := ctx || jsonb_build_object('rendimiento', round(x / y, 1) || ' km/gal (base ' || round(z, 1) || ')');
      END IF;
    EXCEPTION WHEN OTHERS THEN notas := notas || ('combustible: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) FILTER (WHERE cre - (fec::timestamp AT TIME ZONE 'America/Lima') <= interval '72 hours'),   -- 48 h desde el fin del día del gasto
             count(*), count(*) FILTER (WHERE st IN ('OBSERVADO', 'RECHAZADO'))
      INTO a, b, x
      FROM (SELECT NULLIF(to_jsonb(e) ->> 'created_at', '')::timestamptz AS cre,
                   COALESCE(NULLIF(to_jsonb(e) ->> 'expense_date', '')::date, NULLIF(to_jsonb(e) ->> 'created_at', '')::date) AS fec,
                   upper(COALESCE(to_jsonb(e) ->> 'status', '')) AS st,
                   COALESCE(public.kpi_uuid(to_jsonb(e) ->> 'driver_id'),
                            (SELECT v.driver_id FROM public.kpi_despachos_v v WHERE v.id = public.kpi_uuid(to_jsonb(e) ->> 'dispatch_id'))) AS drv
            FROM public.dispatch_expenses e) s
      WHERE drv = p_sujeto AND cre >= t0 AND cre < t1;
      val := val || jsonb_build_object('gastos_48h', public.kpi_pct(a, b), 'gastos_observados', public.kpi_pct(x::bigint, b));
      ctx := ctx || jsonb_build_object('gastos_48h', a || ' de ' || b, 'gastos_observados', x || ' de ' || b);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('gastos: ' || SQLERRM); END;
    BEGIN
      IF v_ini = date_trunc('month', v_hoy)::date AND to_regprocedure('public.caja_driver_overdue_advances(uuid)') IS NOT NULL THEN
        SELECT count(*) INTO a FROM public.caja_driver_overdue_advances(p_sujeto);
        val := val || jsonb_build_object('rendiciones_vencidas', a);
      END IF;
    EXCEPTION WHEN OTHERS THEN notas := notas || ('rendiciones: ' || SQLERRM); END;
    BEGIN
      IF to_regclass('public.traffic_fines') IS NOT NULL THEN
        EXECUTE $q$SELECT count(*) FROM public.traffic_fines WHERE driver_id = $1 AND responsibility = 'CONDUCTOR' AND infraction_date >= $2 AND infraction_date <= $3$q$
        INTO a USING p_sujeto, v_ini, v_fin;
        val := val || jsonb_build_object('multas', a);
      END IF;
      IF to_regclass('public.vehicle_incidents') IS NOT NULL THEN
        EXECUTE $q$SELECT count(*), bool_or(severity IN ('CRITICA', 'ALTA')) FROM public.vehicle_incidents
                   WHERE driver_id = $1 AND responsibility = 'CONDUCTOR' AND occurred_at >= $2 AND occurred_at < $3$q$
        INTO a, v_grave USING p_sujeto, t0, t1;
        val := val || jsonb_build_object('siniestros', a);
      END IF;
    EXCEPTION WHEN OTHERS THEN notas := notas || ('seguridad: ' || SQLERRM); END;
    BEGIN
      SELECT count(*) INTO a FROM public.maintenance_requests m
      WHERE public.kpi_uuid(to_jsonb(m) ->> 'driver_id') = p_sujeto AND COALESCE(NULLIF(to_jsonb(m) ->> 'reported_at', '')::timestamptz, m.created_at) >= t0
        AND COALESCE(NULLIF(to_jsonb(m) ->> 'reported_at', '')::timestamptz, m.created_at) < t1;
      val := val || jsonb_build_object('fallas_reportadas', a);
    EXCEPTION WHEN OTHERS THEN notas := notas || ('fallas: ' || SQLERRM); END;
    IF NULLIF(v_driver ->> 'license_expiration', '') IS NOT NULL THEN
      val := val || jsonb_build_object('licencia', CASE WHEN (v_driver ->> 'license_expiration')::date >= LEAST(v_fin, v_hoy) THEN 100 ELSE 0 END);
    END IF;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Rol desconocido');
  END IF;

  -- Informe mensual (roles con informe)
  IF EXISTS (SELECT 1 FROM public.kpi_roles WHERE rol = v_rol AND informe) THEN
    SELECT * INTO inf FROM public.desempeno_informes WHERE user_id = p_sujeto AND rol = v_rol AND periodo = v_ini;
    v_venc := (v_ini + interval '1 month')::date + (v_plazo - 1);
    v_atraso := CASE WHEN inf.id IS NOT NULL THEN inf.dias_atraso WHEN v_hoy > v_venc THEN v_hoy - v_venc END;
    IF v_atraso IS NOT NULL THEN val := val || jsonb_build_object('informe', GREATEST(0, 100 - v_pen * v_atraso)); END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('codigo', p.codigo, 'nombre', p.nombre, 'grupo', p.grupo, 'unidad', p.unidad, 'meta', p.meta, 'sentido', p.sentido,
           'peso', p.peso, 'descripcion', p.descripcion, 'valor', (val ->> p.codigo)::numeric, 'contexto', ctx ->> p.codigo,
           'puntaje', CASE WHEN p.peso > 0 THEN public.kpi_puntaje((val ->> p.codigo)::numeric, p.meta, p.sentido) END) ORDER BY p.orden),
         round(sum(public.kpi_puntaje((val ->> p.codigo)::numeric, p.meta, p.sentido) * p.peso) FILTER (WHERE p.peso > 0 AND val ? p.codigo AND val ->> p.codigo IS NOT NULL)
               / NULLIF(sum(p.peso) FILTER (WHERE p.peso > 0 AND val ? p.codigo AND val ->> p.codigo IS NOT NULL), 0), 0),
         round(100.0 * COALESCE(sum(p.peso) FILTER (WHERE p.peso > 0 AND val ? p.codigo AND val ->> p.codigo IS NOT NULL), 0) / NULLIF(sum(p.peso) FILTER (WHERE p.peso > 0), 0), 0)
  INTO v_kpis, v_idx, v_cob
  FROM public.kpi_parametros p WHERE p.rol = v_rol;
  -- Con menos del 40 % del peso medido el índice no es representativo
  IF COALESCE(v_cob, 0) < 40 THEN v_idx := NULL; END IF;
  IF v_rol = 'CONDUCTOR' AND v_grave THEN v_idx := 0; END IF;

  RETURN jsonb_build_object('success', true, 'rol', v_rol, 'sujeto', p_sujeto, 'periodo', v_ini, 'periodo_fin', v_fin,
    'kpis', COALESCE(v_kpis, '[]'::jsonb), 'indice', v_idx, 'cobertura', v_cob, 'siniestro_grave', v_grave,
    'calificacion', CASE WHEN v_idx IS NULL THEN 'SIN_DATOS' WHEN v_idx >= 90 THEN 'EXCELENTE' WHEN v_idx >= 75 THEN 'BUENO' WHEN v_idx >= 60 THEN 'REGULAR' ELSE 'BAJO' END,
    'informe', CASE WHEN EXISTS (SELECT 1 FROM public.kpi_roles WHERE rol = v_rol AND informe) THEN jsonb_build_object(
       'id', inf.id, 'estado', COALESCE(inf.estado, CASE WHEN v_hoy > v_venc THEN 'ATRASADO' WHEN v_hoy > v_fin THEN 'PENDIENTE' ELSE 'MES_EN_CURSO' END),
       'vence', v_venc, 'enviado_at', inf.enviado_at, 'dias_atraso', v_atraso, 'comentario', inf.comentario) END,
    'notas', to_jsonb(notas));
END $$;
REVOKE ALL ON FUNCTION public.desempeno_calcular(text, uuid, date) FROM PUBLIC, anon, authenticated;

-- Mi desempeño: roles en los que me miden (y, si soy conductor, mi ficha)
CREATE OR REPLACE FUNCTION public.desempeno_mio(p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; v_items jsonb := '[]'::jsonb; k jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  FOR r IN SELECT kr.rol, kr.nombre, m.sujeto FROM public.kpi_roles kr CROSS JOIN LATERAL public.desempeno_miembros(kr.rol) m
           WHERE m.user_id = auth.uid() ORDER BY kr.orden LOOP
    k := public.desempeno_calcular(r.rol, r.sujeto, p_mes);
    v_items := v_items || jsonb_build_array(k || jsonb_build_object('rol_nombre', r.nombre));
  END LOOP;
  RETURN jsonb_build_object('success', true, 'roles', v_items, 'revisor', public.desempeno_es_revisor());
END $$;
REVOKE ALL ON FUNCTION public.desempeno_mio(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_mio(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.desempeno_equipo(p_rol text, p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m record; v_items jsonb := '[]'::jsonb; k jsonb; v_mes date := date_trunc('month', COALESCE(p_mes, (now() AT TIME ZONE 'America/Lima')::date))::date;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.desempeno_es_revisor() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo quien revisa el desempeño ve al equipo');
  END IF;
  FOR m IN SELECT * FROM public.desempeno_miembros(p_rol) ORDER BY nombre LOOP
    k := public.desempeno_calcular(p_rol, m.sujeto, v_mes);
    v_items := v_items || jsonb_build_array(k || jsonb_build_object('nombre', m.nombre, 'user_id', m.user_id));
  END LOOP;
  RETURN jsonb_build_object('success', true, 'rol', upper(p_rol), 'periodo', v_mes, 'miembros', v_items,
    'informes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'user_id', i.user_id, 'nombre', public.lease_person_name(i.user_id), 'periodo', i.periodo,
        'estado', i.estado, 'enviado_at', i.enviado_at, 'dias_atraso', i.dias_atraso, 'logros', i.logros, 'problemas', i.problemas, 'acciones', i.acciones,
        'comentario', i.comentario, 'indice', i.kpis -> 'indice') ORDER BY i.enviado_at DESC)
      FROM public.desempeno_informes i WHERE i.rol = upper(p_rol) AND i.periodo >= (v_mes - interval '2 months')::date), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.desempeno_equipo(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_equipo(text, date) TO authenticated;

-- Conductor desde el app: su resultado del mes y del mes anterior
CREATE OR REPLACE FUNCTION public.conductor_mi_desempeno(p_mes date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_driver uuid; v_mes date := date_trunc('month', COALESCE(p_mes, (now() AT TIME ZONE 'America/Lima')::date))::date;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  SELECT d.id INTO v_driver FROM public.drivers d WHERE public.kpi_uuid(to_jsonb(d) ->> 'profile_id') = auth.uid() LIMIT 1;
  IF v_driver IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'No es conductor'); END IF;
  RETURN jsonb_build_object('success', true, 'actual', public.desempeno_calcular('CONDUCTOR', v_driver, v_mes),
    'anterior', public.desempeno_calcular('CONDUCTOR', v_driver, (v_mes - interval '1 month')::date));
END $$;
REVOKE ALL ON FUNCTION public.conductor_mi_desempeno(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.conductor_mi_desempeno(date) TO authenticated;

-- ------------------------------------------------------------
-- 8. Informe: enviar y revisar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.desempeno_enviar_informe(p_rol text, p_periodo date, p_logros text, p_problemas text DEFAULT NULL, p_acciones text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rol text := upper(p_rol); v_hoy date := (now() AT TIME ZONE 'America/Lima')::date; v_per date := date_trunc('month', p_periodo)::date;
  v_sig date; v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int; i record; v_id uuid; v_sujeto uuid; k jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Sesión no válida'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kpi_roles WHERE rol = v_rol AND informe) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Este rol no presenta informe mensual');
  END IF;
  SELECT m.sujeto INTO v_sujeto FROM public.desempeno_miembros(v_rol) m WHERE m.user_id = auth.uid();
  IF v_sujeto IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Usted no está registrado en este rol'); END IF;
  IF v_per >= date_trunc('month', v_hoy)::date THEN RETURN jsonb_build_object('success', false, 'error', 'El informe se presenta cuando el mes terminó'); END IF;
  IF length(btrim(COALESCE(p_logros, ''))) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Describa sus resultados y logros del mes'); END IF;
  v_sig := (v_per + interval '1 month')::date;
  SELECT * INTO i FROM public.desempeno_informes WHERE user_id = auth.uid() AND rol = v_rol AND periodo = v_per FOR UPDATE;
  IF i.id IS NOT NULL AND i.estado = 'REVISADO' THEN RETURN jsonb_build_object('success', false, 'error', 'El informe ya fue revisado'); END IF;
  IF i.id IS NULL THEN
    INSERT INTO public.desempeno_informes (user_id, rol, periodo, logros, problemas, acciones, dias_desde_cierre, dias_atraso)
    VALUES (auth.uid(), v_rol, v_per, btrim(p_logros), NULLIF(btrim(p_problemas), ''), NULLIF(btrim(p_acciones), ''),
            GREATEST(v_hoy - v_sig + 1, 0), GREATEST(v_hoy - (v_sig + v_plazo - 1), 0))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.desempeno_informes SET logros = btrim(p_logros), problemas = NULLIF(btrim(p_problemas), ''), acciones = NULLIF(btrim(p_acciones), ''),
      estado = 'ENVIADO', actualizado_at = now() WHERE id = i.id;
    v_id := i.id;
  END IF;
  k := public.desempeno_calcular(v_rol, v_sujeto, v_per);
  UPDATE public.desempeno_informes SET kpis = k WHERE id = v_id;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'indice', k -> 'indice', 'dias_atraso', (SELECT dias_atraso FROM public.desempeno_informes WHERE id = v_id));
END $$;
REVOKE ALL ON FUNCTION public.desempeno_enviar_informe(text, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_enviar_informe(text, date, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.desempeno_revisar_informe(p_id uuid, p_estado text, p_comentario text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i record; meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
BEGIN
  IF auth.uid() IS NULL OR NOT public.desempeno_es_revisor() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para revisar informes'); END IF;
  SELECT * INTO i FROM public.desempeno_informes WHERE id = p_id FOR UPDATE;
  IF i.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Informe no encontrado'); END IF;
  IF i.user_id = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'No puede revisar su propio informe'); END IF;
  IF upper(p_estado) NOT IN ('REVISADO', 'OBSERVADO') THEN RETURN jsonb_build_object('success', false, 'error', 'Estado inválido'); END IF;
  IF upper(p_estado) = 'OBSERVADO' AND NULLIF(btrim(p_comentario), '') IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Indique qué debe corregir'); END IF;
  UPDATE public.desempeno_informes SET estado = upper(p_estado), revisado_por = auth.uid(), revisado_at = now(), comentario = NULLIF(btrim(p_comentario), '') WHERE id = p_id;
  PERFORM public.notif_emit('DESEMPENO_INFORME_REVISADO', 'des-rev-' || p_id || '-' || extract(epoch FROM now())::bigint,
    'Tu informe de ' || meses[extract(month FROM i.periodo)::int] || ' fue ' || CASE WHEN upper(p_estado) = 'REVISADO' THEN 'revisado' ELSE 'observado' END,
    COALESCE(NULLIF(btrim(p_comentario), ''), 'Sin comentarios'), '/desempeno?tab=informe', i.user_id);
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.desempeno_revisar_informe(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desempeno_revisar_informe(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 9. Avisos
-- ------------------------------------------------------------
INSERT INTO public.notif_reglas (evento, categoria, descripcion, severidad, permisos, al_solicitante) VALUES
  ('DESEMPENO_INFORME',          'CUMPLIMIENTO', 'Día 1: presentar el informe mensual de desempeño', 'warn', '{}', true),
  ('DESEMPENO_INFORME_ATRASADO', 'CUMPLIMIENTO', 'Informe mensual de desempeño atrasado',            'crit', ARRAY['desempeno'], true),
  ('DESEMPENO_INFORME_REVISADO', 'CUMPLIMIENTO', 'Informe mensual revisado u observado',             'info', '{}', true),
  ('CONDUCTOR_DESEMPENO',        'CUMPLIMIENTO', 'Resultado mensual del conductor',                  'info', '{}', true)
ON CONFLICT (evento) DO NOTHING;

CREATE OR REPLACE FUNCTION public.desempeno_alertas(p_ahora timestamptz DEFAULT NULL)
RETURNS int LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_local timestamp := COALESCE(p_ahora, now()) AT TIME ZONE 'America/Lima';
  v_hoy date := v_local::date; v_dia int := extract(day FROM v_local)::int;
  v_plazo int := public.soporte_param('plazo_informe_dia', 3)::int;
  v_per date := (date_trunc('month', v_local) - interval '1 month')::date;
  v_mes text; r record; k jsonb; n int := 0;
  meses text[] := ARRAY['enero','febrero','marzo','abril','mayo','junio','julio','agosto','setiembre','octubre','noviembre','diciembre'];
BEGIN
  IF extract(hour FROM v_local) < 8 THEN RETURN 0; END IF;
  v_mes := meses[extract(month FROM v_per)::int] || ' ' || extract(year FROM v_per);
  -- Supervisores: recordatorio y atraso del informe
  FOR r IN SELECT kr.rol, kr.nombre AS rol_nombre, m.user_id, m.nombre FROM public.kpi_roles kr CROSS JOIN LATERAL public.desempeno_miembros(kr.rol) m
           WHERE kr.informe AND m.user_id IS NOT NULL LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.desempeno_informes i WHERE i.user_id = r.user_id AND i.rol = r.rol AND i.periodo = v_per);
    IF v_dia <= v_plazo THEN
      IF public.notif_emit('DESEMPENO_INFORME', 'des-inf-' || r.user_id || '-' || r.rol || '-' || to_char(v_per, 'YYYYMM'),
           'Presenta tu informe mensual de ' || v_mes, r.rol_nombre || ' · vence el ' || lpad(v_plazo::text, 2, '0') || '/' || to_char(v_hoy, 'MM')
           || '. Los días de atraso bajan tu índice.', '/desempeno?tab=informe', r.user_id) IS NOT NULL THEN n := n + 1; END IF;
    ELSE
      IF public.notif_emit('DESEMPENO_INFORME_ATRASADO', 'des-inf-' || r.user_id || '-' || r.rol || '-' || to_char(v_per, 'YYYYMM') || '-' || to_char(v_hoy, 'DD'),
           'Informe de ' || v_mes || ' de ' || r.nombre || ': ' || (v_dia - v_plazo) || ' día' || CASE WHEN v_dia - v_plazo = 1 THEN '' ELSE 's' END || ' de atraso',
           r.rol_nombre || ' · cada día de atraso descuenta ' || public.soporte_param('penalidad_dia_atraso', 15) || ' puntos de puntualidad.',
           '/desempeno?tab=informe', r.user_id) IS NOT NULL THEN n := n + 1; END IF;
    END IF;
  END LOOP;
  -- Conductores: el día 1, su resultado del mes anterior
  IF v_dia = 1 THEN
    FOR r IN SELECT * FROM public.desempeno_miembros('CONDUCTOR') m WHERE m.user_id IS NOT NULL LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.notifications x WHERE x.dedupe_key = 'des-cond-' || r.sujeto || '-' || to_char(v_per, 'YYYYMM'));
      k := public.desempeno_calcular('CONDUCTOR', r.sujeto, v_per);
      IF public.notif_emit('CONDUCTOR_DESEMPENO', 'des-cond-' || r.sujeto || '-' || to_char(v_per, 'YYYYMM'),
           'Tu desempeño de ' || v_mes || ': ' || COALESCE(k ->> 'indice', 'sin datos') || CASE WHEN k ->> 'indice' IS NOT NULL THEN ' / 100' ELSE '' END,
           CASE k ->> 'calificacion' WHEN 'EXCELENTE' THEN '¡Excelente trabajo!' WHEN 'BUENO' THEN 'Buen trabajo. Revisa qué puedes mejorar.'
             WHEN 'REGULAR' THEN 'Revisa tus pendientes para mejorar este mes.' WHEN 'BAJO' THEN 'Conversa con tu supervisor para mejorar este mes.'
             ELSE 'Aún no hay datos suficientes.' END, '/app', r.user_id) IS NOT NULL THEN n := n + 1; END IF;
    END LOOP;
  END IF;
  RETURN n;
EXCEPTION WHEN OTHERS THEN RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.desempeno_alertas(timestamptz) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('desempeno-alertas'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('desempeno-alertas', '12 * * * *', $cron$SELECT public.desempeno_alertas()$cron$);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
