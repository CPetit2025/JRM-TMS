-- Hallazgos de auditoría · F3: un hallazgo MAYOR o CRITICO sin cerrar bloquea la salida del despacho vinculado.
-- Un solo trigger sobre dispatches.status frena todos los caminos de salida (Torre de Control, app del conductor,
-- checklist, cola offline, hitos del tercero), siguiendo el patrón de driver_preuse_driver_start_guard.
-- La excepción formal la dan Jefe de Distribución / Administrador (permiso hallazgos-excepcion), nunca en categorías
-- de seguridad. Requiere las tablas de F1 (20261226090000_hallazgos_auditoria.sql).

CREATE TABLE IF NOT EXISTS public.audit_finding_release_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES public.audit_findings(id),
  dispatch_id uuid NOT NULL REFERENCES public.dispatches(id),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 20),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_finding_release_exceptions_active
  ON public.audit_finding_release_exceptions(finding_id, dispatch_id) WHERE revoked_at IS NULL;

ALTER TABLE public.audit_finding_release_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.audit_finding_release_exceptions;
CREATE POLICY security_active_account ON public.audit_finding_release_exceptions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS audit_finding_release_exceptions_read ON public.audit_finding_release_exceptions;
-- Se ve la excepción si se ve el hallazgo (hereda la RLS de audit_findings de F1).
CREATE POLICY audit_finding_release_exceptions_read ON public.audit_finding_release_exceptions FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.audit_findings f WHERE f.id = finding_id));
REVOKE ALL ON public.audit_finding_release_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_finding_release_exceptions TO authenticated;

-- Hallazgos que bloquean hoy la salida de un despacho (con o sin excepción vigente).
CREATE OR REPLACE FUNCTION public.audit_finding_release_findings(p_dispatch uuid)
RETURNS TABLE(id uuid, number text, severity text, status text, has_safety boolean, excepted boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.id, f.number::text, f.severity::text, f.status::text,
    EXISTS (SELECT 1 FROM public.audit_finding_category_links l JOIN public.audit_finding_categories c ON c.id = l.category_id
      WHERE l.finding_id = f.id AND c.is_safety),
    EXISTS (SELECT 1 FROM public.audit_finding_release_exceptions e
      WHERE e.finding_id = f.id AND e.dispatch_id = p_dispatch AND e.revoked_at IS NULL)
  FROM public.audit_findings f
  WHERE f.dispatch_id = p_dispatch AND f.severity IN ('MAYOR', 'CRITICO')
    AND f.status IN ('ABIERTO', 'EN_CORRECCION', 'PENDIENTE_VALIDACION')
  ORDER BY f.number
$$;

CREATE OR REPLACE FUNCTION public.audit_finding_release_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_numbers text;
BEGIN
  -- Solo la salida: cancelar, reprogramar, quitar paradas o el corte diario no pasan por aquí.
  -- EN_CURSO → EN RUTA también es salida en flota propia («Preparar salida» y luego el conductor inicia);
  -- en un tercero EN_CURSO ya es la salida registrada.
  IF NEW.status IN ('EN_CURSO', 'EN RUTA', 'EN_RUTA', 'EN_TRANSITO') AND NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status = 'PROGRAMADO'
       OR (OLD.status = 'EN_CURSO' AND to_jsonb(NEW) ->> 'modalidad' IS DISTINCT FROM 'TERCERO')) THEN
    SELECT string_agg(b.number, ', ' ORDER BY b.number) INTO v_numbers
    FROM public.audit_finding_release_findings(NEW.id) b WHERE NOT b.excepted;
    IF v_numbers IS NOT NULL THEN
      RAISE EXCEPTION 'HALLAZGO_BLOQUEA_SALIDA: % · La salida está bloqueada por hallazgos de auditoría Mayor/Crítico sin cerrar. Comuníquese con Despacho.', v_numbers
        USING ERRCODE = 'P0001', HINT = 'audit_finding_release_check';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS audit_finding_release_guard ON public.dispatches;
CREATE TRIGGER audit_finding_release_guard BEFORE UPDATE OF status ON public.dispatches
  FOR EACH ROW EXECUTE FUNCTION public.audit_finding_release_guard();

CREATE OR REPLACE FUNCTION public.audit_finding_release_check(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_rows jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_tms_admin() OR public.has_tms_read_permission('hallazgos')
      OR public.has_tms_read_permission('despacho') OR public.has_tms_read_permission('torre-control')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para consultar hallazgos del despacho');
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.number), '[]'::jsonb) INTO v_rows FROM public.audit_finding_release_findings(p_dispatch) b;
  RETURN jsonb_build_object('success', true,
    'blocked', EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE NOT (x ->> 'excepted')::boolean),
    'can_grant', public.is_tms_admin() OR public.has_tms_permission('hallazgos-excepcion'),
    'findings', v_rows);
END $$;

CREATE OR REPLACE FUNCTION public.audit_finding_grant_exception(p_finding uuid, p_dispatch uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.audit_findings; v_reason text := btrim(COALESCE(p_reason, '')); v_id uuid; v_dispatch_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_tms_admin() OR public.has_tms_permission('hallazgos-excepcion')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo Jefe de Distribución o Administrador autorizan excepciones de salida');
  END IF;
  IF length(v_reason) < 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo de la excepción (mínimo 20 caracteres)');
  END IF;
  SELECT * INTO f FROM public.audit_findings WHERE id = p_finding FOR UPDATE;
  IF f.id IS NULL OR f.dispatch_id IS DISTINCT FROM p_dispatch THEN
    RETURN jsonb_build_object('success', false, 'error', 'El hallazgo no está vinculado a este despacho');
  END IF;
  IF f.severity NOT IN ('MAYOR', 'CRITICO') OR f.status NOT IN ('ABIERTO', 'EN_CORRECCION', 'PENDIENTE_VALIDACION') THEN
    RETURN jsonb_build_object('success', false, 'error', 'El hallazgo no bloquea la salida');
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_finding_category_links l JOIN public.audit_finding_categories c ON c.id = l.category_id
      WHERE l.finding_id = f.id AND c.is_safety) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Los hallazgos de seguridad no admiten excepción: deben corregirse');
  END IF;
  -- Separación de funciones: el responsable de corregir (quien necesita la salida) no se autoriza a sí mismo.
  IF f.responsible_id = auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'El responsable del hallazgo no puede autorizar su propia excepción');
  END IF;
  SELECT status INTO v_dispatch_status FROM public.dispatches WHERE id = p_dispatch;
  IF v_dispatch_status IS DISTINCT FROM 'PROGRAMADO' AND v_dispatch_status IS DISTINCT FROM 'EN_CURSO' THEN
    RETURN jsonb_build_object('success', false, 'error', 'El despacho ya no está pendiente de salida');
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_finding_release_exceptions WHERE finding_id = f.id AND dispatch_id = p_dispatch AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El hallazgo ya tiene una excepción vigente para este despacho');
  END IF;

  INSERT INTO public.audit_finding_release_exceptions(finding_id, dispatch_id, reason, approved_by)
  VALUES (f.id, p_dispatch, v_reason, auth.uid()) RETURNING id INTO v_id;
  INSERT INTO public.audit_finding_events(finding_id, event_type, from_status, to_status, detail, actor)
  VALUES (f.id, 'EXCEPCION_SALIDA', f.status, f.status,
    jsonb_build_object('exception_id', v_id, 'dispatch_id', p_dispatch, 'reason', v_reason), auth.uid());
  INSERT INTO public.dispatch_events(dispatch_id, event_type, description, created_by)
  VALUES (p_dispatch, 'EXCEPCION_HALLAZGO', 'Excepción de salida por hallazgo ' || f.number || ': ' || v_reason, auth.uid()::text);
  RETURN jsonb_build_object('success', true, 'id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.audit_finding_release_findings(uuid), public.audit_finding_release_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_finding_release_check(uuid), public.audit_finding_grant_exception(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_finding_release_check(uuid), public.audit_finding_grant_exception(uuid, uuid, text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
