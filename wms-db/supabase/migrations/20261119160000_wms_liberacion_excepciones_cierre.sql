-- Fase 4 · Liberación, excepciones, carga y cierre (decisiones 4, 9a, 9b y A1).
--  · Liberación automática al aprobar todos los LPN: el liberador queda como «sistema», con referencia al último auditor.
--  · Excepción solo para hallazgos exceptuables (menores): la pide cualquiera del almacén, la autoriza supervisión (Jefatura),
--    nunca quien la pidió ni quien preparó el LPN; vale para ese hallazgo, ese LPN y esa revisión, hasta su vencimiento.
--    Vencida o revocada, el LPN vuelve a OBSERVADO y la liberación queda sin efecto. Un cambio de composición la anula.
--  · Carga parcial: requiere paquetes cargados y otros sin cargar (antes dependía de un saldo por solicitud que no existe).
--  · Cierre: al confirmar la carga (completa o parcial) se guarda el resumen real de lo preparado, cargado y pendiente.

-- 1. Liberador «sistema»
ALTER TABLE public.wh_packing_lists ALTER COLUMN released_by DROP NOT NULL;
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.refresh_packing_list(uuid)'::regprocedure);
  IF position('''auditor_name'', public.wh_profile_name(v_auditor), ''released_at'', now(),' IN def) = 0
     OR position('''LIBERADO'', v_snapshot, v_auditor, NULL);' IN def) = 0
     OR position('jsonb_build_object(''version'', v_version, ''id'', v_id, ''automatic'', true)' IN def) = 0 THEN
    RAISE EXCEPTION 'refresh_packing_list cambió: revisar esta migración';
  END IF;
  def := replace(def, '''auditor_name'', public.wh_profile_name(v_auditor), ''released_at'', now(),',
    '''auditor_name'', public.wh_profile_name(v_auditor), ''released_by'', ''Sistema (liberación automática)'', ''released_at'', now(),');
  def := replace(def, '''LIBERADO'', v_snapshot, v_auditor, NULL);', '''LIBERADO'', v_snapshot, NULL, NULL);');
  def := replace(def, 'jsonb_build_object(''version'', v_version, ''id'', v_id, ''automatic'', true)',
    'jsonb_build_object(''version'', v_version, ''id'', v_id, ''automatic'', true, ''released_by'', ''SISTEMA'', ''last_auditor'', v_auditor)');
  EXECUTE def;
END $m$;

-- 2. Excepciones
CREATE TABLE IF NOT EXISTS public.wh_finding_exceptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id uuid NOT NULL REFERENCES public.wh_findings(id),
  lpn_id uuid NOT NULL REFERENCES public.wh_lpns(id),
  audit_rev integer NOT NULL,
  status text NOT NULL DEFAULT 'SOLICITADA' CHECK (status IN ('SOLICITADA','APROBADA','RECHAZADA','REVOCADA','VENCIDA')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  conditions text,
  evidence_paths text[] NOT NULL DEFAULT '{}',
  valid_until timestamptz NOT NULL,
  requested_by uuid NOT NULL REFERENCES public.profiles(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz,
  decision_comment text,
  revoked_by uuid REFERENCES public.profiles(id),
  revoked_at timestamptz,
  revoke_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS wh_finding_exceptions_one_live ON public.wh_finding_exceptions(finding_id) WHERE status IN ('SOLICITADA','APROBADA');
CREATE INDEX IF NOT EXISTS wh_finding_exceptions_lpn_idx ON public.wh_finding_exceptions(lpn_id);
CREATE INDEX IF NOT EXISTS wh_finding_exceptions_requested_by_idx ON public.wh_finding_exceptions(requested_by);
CREATE INDEX IF NOT EXISTS wh_finding_exceptions_decided_by_idx ON public.wh_finding_exceptions(decided_by);
CREATE INDEX IF NOT EXISTS wh_finding_exceptions_revoked_by_idx ON public.wh_finding_exceptions(revoked_by);
CREATE INDEX IF NOT EXISTS wh_finding_exceptions_due_idx ON public.wh_finding_exceptions(valid_until) WHERE status = 'APROBADA';
ALTER TABLE public.wh_finding_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_finding_exceptions FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_finding_exceptions;
CREATE POLICY security_active_account ON public.wh_finding_exceptions AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));

-- Una excepción cubre el hallazgo solo si está aprobada, vigente y sobre la revisión actual del LPN
CREATE OR REPLACE FUNCTION public.wh_finding_excepted(p_finding_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.wh_finding_exceptions x JOIN public.wh_lpns l ON l.id = x.lpn_id
    WHERE x.finding_id = p_finding_id AND x.status = 'APROBADA' AND x.valid_until > now() AND x.audit_rev = l.audit_rev)
$$;
REVOKE ALL ON FUNCTION public.wh_finding_excepted(uuid) FROM PUBLIC, anon, authenticated;

-- Aprobar un LPN admite hallazgos abiertos solo si todos están cubiertos por una excepción vigente
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.wh_audit_lpn(uuid, text, text, text, text[], text)'::regprocedure);
  IF position('SELECT 1 FROM public.wh_findings f WHERE f.lpn_id = l.id AND f.status <> ''CERRADO'')' IN def) = 0 THEN
    RAISE EXCEPTION 'wh_audit_lpn cambió: revisar esta migración';
  END IF;
  EXECUTE replace(def, 'SELECT 1 FROM public.wh_findings f WHERE f.lpn_id = l.id AND f.status <> ''CERRADO'')',
    'SELECT 1 FROM public.wh_findings f WHERE f.lpn_id = l.id AND f.status <> ''CERRADO'' AND NOT public.wh_finding_excepted(f.id))');
END $m$;

-- Deja sin efecto una excepción (revocada o vencida): el LPN aprobado con hallazgo abierto vuelve a OBSERVADO y se invalida la liberación
CREATE OR REPLACE FUNCTION wms_private.wh_exception_lapse(p_id bigint, p_status text, p_actor uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x public.wh_finding_exceptions%ROWTYPE; f public.wh_findings%ROWTYPE; l public.wh_lpns%ROWTYPE;
BEGIN
  UPDATE public.wh_finding_exceptions SET status = p_status, revoked_by = p_actor, revoked_at = now(), revoke_reason = p_reason
    WHERE id = p_id AND status = 'APROBADA' RETURNING * INTO x;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO f FROM public.wh_findings WHERE id = x.finding_id;
  SELECT * INTO l FROM public.wh_lpns WHERE id = x.lpn_id FOR UPDATE;
  IF f.status <> 'CERRADO' AND l.status = 'CLOSED' AND l.audit_status = 'APROBADO' THEN
    UPDATE public.wh_lpns SET audit_status = 'OBSERVADO', audited_by = p_actor, audited_at = now() WHERE id = l.id;
    INSERT INTO public.wh_lpn_audits(lpn_id, task_id, site_id, audit_rev, result, comment, actor_id)
    VALUES (l.id, l.task_id, l.site_id, l.audit_rev, 'OBSERVADO', 'Excepción del hallazgo ' || f.code || ' ' || lower(p_status) || ': ' || p_reason, p_actor);
    PERFORM public.wh_invalidate_release(l.task_id, 'Excepción del hallazgo ' || f.code || ' ' || lower(p_status));
  END IF;
  INSERT INTO public.wh_finding_events(finding_id, action, comment, payload, actor_id)
  VALUES (f.id, 'EXCEPTION_' || p_status, p_reason, jsonb_build_object('exception_id', x.id), p_actor);
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_exception_lapse(bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wh_exception_request(p_finding_id uuid, p_reason text, p_valid_until timestamptz, p_conditions text DEFAULT NULL, p_evidence_paths text[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.wh_findings%ROWTYPE; l public.wh_lpns%ROWTYPE; v_id bigint;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor','almacen-picking','almacen-packing','almacen-carga']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  SELECT * INTO f FROM public.wh_findings WHERE id = p_finding_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(f.site_id) THEN RAISE EXCEPTION 'Hallazgo no disponible'; END IF;
  IF f.status = 'CERRADO' THEN RAISE EXCEPTION 'El hallazgo ya está cerrado'; END IF;
  IF NOT f.exceptionable THEN RAISE EXCEPTION 'Este hallazgo no admite excepción (seguridad, SKU equivocado, faltante, documentación, componente no declarado o severidad mayor)'; END IF;
  IF p_valid_until IS NULL OR p_valid_until <= now() OR p_valid_until > now() + interval '30 days' THEN RAISE EXCEPTION 'Indique una vigencia futura de hasta 30 días'; END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE id = f.lpn_id;
  PERFORM wms_private.wh_finding_check_evidence(f.id, f.lpn_id, p_evidence_paths);
  -- Retira solicitudes que ya no sirven (vencidas o de otra composición) para poder pedir una nueva
  UPDATE public.wh_finding_exceptions SET status = 'VENCIDA', revoke_reason = 'Reemplazada: vencida o de otra composición', revoked_at = now()
    WHERE finding_id = f.id AND status IN ('SOLICITADA','APROBADA') AND (valid_until <= now() OR audit_rev <> l.audit_rev);
  INSERT INTO public.wh_finding_exceptions(finding_id, lpn_id, audit_rev, reason, conditions, evidence_paths, valid_until, requested_by)
  VALUES (f.id, f.lpn_id, l.audit_rev, btrim(p_reason), nullif(btrim(p_conditions), ''), coalesce(p_evidence_paths, '{}'), p_valid_until, auth.uid())
  RETURNING id INTO v_id;
  INSERT INTO public.wh_finding_events(finding_id, action, comment, evidence_paths, payload, actor_id)
  VALUES (f.id, 'EXCEPTION_REQUESTED', btrim(p_reason), coalesce(p_evidence_paths, '{}'), jsonb_build_object('exception_id', v_id, 'valid_until', p_valid_until), auth.uid());
  RETURN jsonb_build_object('id', v_id);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'El hallazgo ya tiene una excepción pendiente o vigente';
END $$;

-- Decidir (APPROVE / REJECT) o revocar (REVOKE): solo supervisión; nadie autoriza la suya ni la de un LPN que preparó
CREATE OR REPLACE FUNCTION public.wh_exception_decide(p_id bigint, p_action text, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x public.wh_finding_exceptions%ROWTYPE; f public.wh_findings%ROWTYPE; v_action text := upper(btrim(p_action)); v_comment text := nullif(btrim(p_comment), '');
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN RAISE EXCEPTION 'Solo Jefatura (supervisión) decide excepciones' USING ERRCODE = '42501'; END IF;
  SELECT * INTO x FROM public.wh_finding_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Excepción no encontrada'; END IF;
  SELECT * INTO f FROM public.wh_findings WHERE id = x.finding_id;
  IF NOT public.can_access_site(f.site_id) THEN RAISE EXCEPTION 'Excepción no disponible'; END IF;
  IF v_action IN ('APPROVE','REJECT') THEN
    IF x.status <> 'SOLICITADA' THEN RAISE EXCEPTION 'La excepción ya fue decidida'; END IF;
    IF x.requested_by = auth.uid() THEN RAISE EXCEPTION 'Nadie autoriza la excepción que solicitó'; END IF;
    IF public.wh_user_prepared(f.task_id, f.lpn_id) THEN RAISE EXCEPTION 'No puede autorizar una excepción sobre un LPN que preparó'; END IF;
    IF v_action = 'APPROVE' AND x.valid_until <= now() THEN RAISE EXCEPTION 'La vigencia solicitada ya venció'; END IF;
    IF v_action = 'APPROVE' AND x.audit_rev <> (SELECT audit_rev FROM public.wh_lpns WHERE id = x.lpn_id) THEN RAISE EXCEPTION 'El LPN cambió de composición: solicite de nuevo'; END IF;
    IF v_action = 'REJECT' AND v_comment IS NULL THEN RAISE EXCEPTION 'Indique el motivo del rechazo'; END IF;
    UPDATE public.wh_finding_exceptions SET status = CASE WHEN v_action = 'APPROVE' THEN 'APROBADA' ELSE 'RECHAZADA' END,
      decided_by = auth.uid(), decided_at = now(), decision_comment = v_comment WHERE id = x.id;
    INSERT INTO public.wh_finding_events(finding_id, action, comment, payload, actor_id)
    VALUES (f.id, 'EXCEPTION_' || CASE WHEN v_action = 'APPROVE' THEN 'APROBADA' ELSE 'RECHAZADA' END, v_comment, jsonb_build_object('exception_id', x.id), auth.uid());
  ELSIF v_action = 'REVOKE' THEN
    IF x.status <> 'APROBADA' THEN RAISE EXCEPTION 'Solo se revoca una excepción aprobada'; END IF;
    IF v_comment IS NULL THEN RAISE EXCEPTION 'Indique el motivo de la revocación'; END IF;
    PERFORM wms_private.wh_exception_lapse(x.id, 'REVOCADA', auth.uid(), v_comment);
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  RETURN jsonb_build_object('id', x.id, 'status', (SELECT status FROM public.wh_finding_exceptions WHERE id = x.id));
END $$;

-- Vencimiento automático (cada 10 minutos)
CREATE OR REPLACE FUNCTION wms_private.wh_exceptions_expire()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x record; n integer := 0;
BEGIN
  -- Solicitudes no decididas que vencieron: salen de las vigentes sin efecto sobre el LPN
  UPDATE public.wh_finding_exceptions SET status = 'VENCIDA', revoke_reason = 'Vencida sin decisión', revoked_at = now()
    WHERE status = 'SOLICITADA' AND valid_until <= now();
  FOR x IN SELECT id, decided_by FROM public.wh_finding_exceptions WHERE status = 'APROBADA' AND valid_until <= now() ORDER BY id LOOP
    PERFORM wms_private.wh_exception_lapse(x.id, 'VENCIDA', x.decided_by, 'Vencimiento de la vigencia');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_exceptions_expire() FROM PUBLIC, anon, authenticated;
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'wh-exceptions-expire';
    PERFORM cron.schedule('wh-exceptions-expire', '*/10 * * * *', 'SELECT wms_private.wh_exceptions_expire()');
  END IF;
END $c$;

-- Las excepciones en la lista de hallazgos
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_findings_list(uuid, text, date, date, boolean)'::regprocedure);
  IF position('''lines'', (SELECT jsonb_agg(' IN def) = 0 THEN RAISE EXCEPTION 'wh_findings_list cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '''lines'', (SELECT jsonb_agg(',
    '''excepted'', public.wh_finding_excepted(f.id), ''exceptions'', (SELECT jsonb_agg(jsonb_build_object(''id'', x.id, ''status'', x.status, ''reason'', x.reason,
        ''conditions'', x.conditions, ''valid_until'', x.valid_until, ''audit_rev'', x.audit_rev, ''requested_by'', x.requested_by, ''requested_name'', public.wh_profile_name(x.requested_by),
        ''requested_at'', x.requested_at, ''decided_name'', public.wh_profile_name(x.decided_by), ''decided_at'', x.decided_at, ''decision_comment'', x.decision_comment,
        ''revoke_reason'', x.revoke_reason, ''revoked_at'', x.revoked_at) ORDER BY x.id DESC) FROM public.wh_finding_exceptions x WHERE x.finding_id = f.id),
      ''lines'', (SELECT jsonb_agg(');
END $m$;

-- 3. Carga parcial sin depender de un saldo por solicitud inexistente
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.wh_task_action(uuid, text, text)'::regprocedure);
  IF position('IF v_to=''PARTIAL'' AND (NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status=''LOADED'') OR v_open<=0) THEN' IN def) = 0 THEN
    RAISE EXCEPTION 'wh_task_action cambió: revisar esta migración';
  END IF;
  EXECUTE replace(def, 'IF v_to=''PARTIAL'' AND (NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status=''LOADED'') OR v_open<=0) THEN',
    'IF v_to=''PARTIAL'' AND (NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status=''LOADED'') OR NOT EXISTS(SELECT 1 FROM public.wh_packages WHERE task_id=t.id AND status NOT IN (''LOADED'',''VOID''))) THEN');
END $m$;

-- 4. Cierre con saldo real
ALTER TABLE public.wh_tasks ADD COLUMN IF NOT EXISTS close_summary jsonb;
CREATE OR REPLACE FUNCTION wms_private.wh_task_close_summary(p_task_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('at', now(), 'by', auth.uid(),
    'lpn_preparados', count(DISTINCT l.id) FILTER (WHERE l.status <> 'VOID'),
    'lpn_cargados', count(DISTINCT l.id) FILTER (WHERE l.status = 'LOADED' OR (l.status <> 'VOID' AND NOT EXISTS (SELECT 1 FROM public.wh_packages q WHERE q.lpn_id = l.id AND q.status NOT IN ('LOADED','VOID')))),
    'paquetes_preparados', (SELECT count(*) FROM public.wh_packages p WHERE p.task_id = p_task_id AND p.status <> 'VOID'),
    'paquetes_cargados', (SELECT count(*) FROM public.wh_packages p WHERE p.task_id = p_task_id AND p.status = 'LOADED'),
    'kg_cargado', (SELECT sum(w.kg) FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w WHERE p.task_id = p_task_id AND p.status = 'LOADED'),
    'kg_pendiente', (SELECT sum(w.kg) FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w WHERE p.task_id = p_task_id AND p.status NOT IN ('LOADED','VOID')),
    'paquetes_sin_peso', (SELECT count(*) FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w WHERE p.task_id = p_task_id AND p.status <> 'VOID' AND w.kg IS NULL))
  FROM public.wh_lpns l WHERE l.task_id = p_task_id
$$;
REVOKE ALL ON FUNCTION wms_private.wh_task_close_summary(uuid) FROM PUBLIC, anon, authenticated;
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_task_action(uuid, text, text)'::regprocedure);
  IF position('  RETURN v_result;' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_action (público) cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '  RETURN v_result;',
    '  IF v_action IN (''LOAD'',''LOAD_PARTIAL'') THEN
    UPDATE public.wh_tasks SET close_summary = wms_private.wh_task_close_summary(p_task_id) || jsonb_build_object(''tipo'', CASE WHEN v_action = ''LOAD'' THEN ''COMPLETA'' ELSE ''PARCIAL'' END, ''motivo'', nullif(btrim(p_reason), ''''))
      WHERE id = p_task_id;
  END IF;
  RETURN v_result;');
END $m$;

REVOKE ALL ON FUNCTION public.wh_exception_request(uuid, text, timestamptz, text, text[]), public.wh_exception_decide(bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_exception_request(uuid, text, timestamptz, text, text[]), public.wh_exception_decide(bigint, text, text) TO authenticated;

-- El tablero informa el resumen de cierre
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('public.wh_task_board(text, uuid, date, date)'::regprocedure);
  IF position('''assigned_at'', t.assigned_at,' IN def) = 0 THEN RAISE EXCEPTION 'wh_task_board cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '''assigned_at'', t.assigned_at,', '''assigned_at'', t.assigned_at, ''close_summary'', t.close_summary,');
END $m$;
