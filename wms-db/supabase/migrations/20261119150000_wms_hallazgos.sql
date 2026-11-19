-- Fase 3 · Hallazgos, corrección y verificación dentro del WMS, sobre el LPN, con alcance físico (paquetes) y masa.
-- Reglas:
--  · El hallazgo lo registra auditoría (no quien preparó el LPN) y deja el LPN OBSERVADO o RECHAZADO (invalida la liberación).
--  · Alcance por paquete: cantidad afectada y kg (proporcional al peso del paquete con su estado; sin peso = pendiente, no 0).
--  · Estados: ABIERTO → EN_CORRECCION → PENDIENTE_VERIFICACION → CERRADO (o vuelve a EN_CORRECCION si la verificación rechaza).
--    Verificación parcial: cierra solo si todo lo afectado quedó verificado; el pendiente baja solo al verificar, no al declarar.
--  · Separación por persona: quien corrige no registra ni verifica; quien verifica no corrigió; nadie aprueba su propia preparación.
--  · Aprobar un LPN exige que no tenga hallazgos sin cerrar. Cerrar un hallazgo no aprueba el LPN por sí solo.
--  · «Exceptuable» (para la Fase 4) solo si todas las categorías son menores y la severidad es MENOR.

CREATE SEQUENCE IF NOT EXISTS public.wh_findings_seq;
CREATE TABLE IF NOT EXISTS public.wh_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE DEFAULT 'H-' || lpad(nextval('public.wh_findings_seq')::text, 6, '0'),
  site_id uuid NOT NULL REFERENCES public.sites(id),
  task_id uuid NOT NULL REFERENCES public.wh_tasks(id),
  lpn_id uuid NOT NULL REFERENCES public.wh_lpns(id),
  audit_rev integer NOT NULL,
  categories text[] NOT NULL CHECK (cardinality(categories) > 0 AND categories <@ ARRAY['FALTANTE','SOBRANTE','CALIDAD','SKU_INCORRECTO','ROTULADO','EMBALAJE','DOCUMENTACION','COMPOSICION','ESTIBA_SEGURIDAD','NO_DECLARADO','OTRO']),
  severity text NOT NULL CHECK (severity IN ('MENOR','MAYOR','CRITICA')),
  exceptionable boolean GENERATED ALWAYS AS (severity = 'MENOR' AND categories <@ ARRAY['ROTULADO','EMBALAJE','CALIDAD','SOBRANTE']) STORED,
  description text NOT NULL CHECK (length(btrim(description)) >= 5),
  area text NOT NULL DEFAULT 'DESPACHO' CHECK (area IN ('DESPACHO','RECEPCION','INVENTARIO','DOCUMENTARIO','TRANSPORTE','OTRO')),
  assigned_to uuid REFERENCES public.profiles(id),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'ABIERTO' CHECK (status IN ('ABIERTO','EN_CORRECCION','PENDIENTE_VERIFICACION','CERRADO')),
  cause text,
  reopen_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS wh_findings_task_idx ON public.wh_findings(task_id);
CREATE INDEX IF NOT EXISTS wh_findings_lpn_idx ON public.wh_findings(lpn_id);
CREATE INDEX IF NOT EXISTS wh_findings_site_idx ON public.wh_findings(site_id);
CREATE INDEX IF NOT EXISTS wh_findings_assigned_idx ON public.wh_findings(assigned_to);
CREATE INDEX IF NOT EXISTS wh_findings_created_by_idx ON public.wh_findings(created_by);
CREATE INDEX IF NOT EXISTS wh_findings_closed_by_idx ON public.wh_findings(closed_by);
CREATE INDEX IF NOT EXISTS wh_findings_status_idx ON public.wh_findings(status, created_at);

CREATE TABLE IF NOT EXISTS public.wh_finding_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id uuid NOT NULL REFERENCES public.wh_findings(id),
  package_id uuid NOT NULL REFERENCES public.wh_packages(id),
  product_code text,
  contract_code text,
  unit text,
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  kg numeric(20,6),
  weight_state text NOT NULL,
  declared boolean NOT NULL DEFAULT true,
  corrected_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (corrected_qty >= 0),
  verified_qty numeric(20,6) NOT NULL DEFAULT 0 CHECK (verified_qty >= 0),
  UNIQUE (finding_id, package_id),
  CHECK (verified_qty <= quantity AND corrected_qty <= quantity)
);
CREATE INDEX IF NOT EXISTS wh_finding_lines_package_idx ON public.wh_finding_lines(package_id);

CREATE TABLE IF NOT EXISTS public.wh_finding_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id uuid NOT NULL REFERENCES public.wh_findings(id),
  action text NOT NULL,
  from_status text,
  to_status text,
  comment text,
  evidence_paths text[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wh_finding_events_finding_idx ON public.wh_finding_events(finding_id, created_at);
CREATE INDEX IF NOT EXISTS wh_finding_events_actor_idx ON public.wh_finding_events(actor_id);
DROP TRIGGER IF EXISTS wh_finding_events_immutable ON public.wh_finding_events;
CREATE TRIGGER wh_finding_events_immutable BEFORE UPDATE OR DELETE ON public.wh_finding_events FOR EACH ROW EXECUTE FUNCTION public.wh_reject_scan_mutation();

DO $p$
DECLARE tb text;
BEGIN
  FOREACH tb IN ARRAY ARRAY['wh_findings','wh_finding_lines','wh_finding_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tb);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tb);
    EXECUTE format('DROP POLICY IF EXISTS security_active_account ON public.%I', tb);
    EXECUTE format('CREATE POLICY security_active_account ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()))', tb);
  END LOOP;
END $p$;
REVOKE ALL ON SEQUENCE public.wh_findings_seq FROM PUBLIC, anon, authenticated;

-- Quien preparó: además del responsable, quien creó, cerró o consolidó el LPN o recogió sus paquetes
CREATE OR REPLACE FUNCTION public.wh_user_prepared(p_task_id uuid, p_lpn_id uuid DEFAULT NULL::uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
  SELECT EXISTS (SELECT 1 FROM public.wh_tasks WHERE id = p_task_id AND assigned_picker = auth.uid())
      OR EXISTS (SELECT 1 FROM public.wh_lpns WHERE task_id = p_task_id AND (p_lpn_id IS NULL OR id = p_lpn_id) AND auth.uid() IN (created_by, closed_by))
      OR EXISTS (SELECT 1 FROM public.wh_scan_events e LEFT JOIN public.wh_packages p ON p.id = e.package_id
                 WHERE e.task_id = p_task_id AND e.operator_id = auth.uid() AND e.event_type IN ('PICK','LPN_CONSOLIDATE')
                   AND (p_lpn_id IS NULL OR p.lpn_id = p_lpn_id OR e.lpn_id = p_lpn_id))
$$;

-- Aprobar: nunca quien preparó (sin excepción de supervisión) y nunca con hallazgos sin cerrar
DO $m$
DECLARE def text;
BEGIN
  def := pg_get_functiondef('wms_private.wh_audit_lpn(uuid, text, text, text, text[], text)'::regprocedure);
  IF position('  IF v_result <> ''COMENTARIO'' AND public.wh_user_prepared(t.id, l.id) THEN' IN def) = 0 THEN RAISE EXCEPTION 'wh_audit_lpn cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, '  IF v_result <> ''COMENTARIO'' AND public.wh_user_prepared(t.id, l.id) THEN',
    '  IF v_result = ''APROBADO'' AND public.wh_user_prepared(t.id, l.id) THEN RAISE EXCEPTION ''Nadie aprueba un LPN que preparó: debe aprobarlo otro auditor''; END IF;
  IF v_result = ''APROBADO'' AND EXISTS (SELECT 1 FROM public.wh_findings f WHERE f.lpn_id = l.id AND f.status <> ''CERRADO'') THEN
    RAISE EXCEPTION ''El LPN tiene hallazgos sin cerrar: corríjalos y verifíquelos antes de aprobar'';
  END IF;
  IF v_result <> ''COMENTARIO'' AND public.wh_user_prepared(t.id, l.id) THEN');
END $m$;

CREATE OR REPLACE FUNCTION wms_private.wh_finding_check_evidence(p_finding uuid, p_lpn uuid, p_paths text[])
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_paths, '{}')) x
             WHERE x LIKE '%..%' OR NOT (x LIKE p_lpn::text || '/%' OR x LIKE 'hallazgos/' || p_finding::text || '/%')) THEN
    RAISE EXCEPTION 'Evidencia no corresponde al hallazgo';
  END IF;
END $$;
REVOKE ALL ON FUNCTION wms_private.wh_finding_check_evidence(uuid, uuid, text[]) FROM PUBLIC, anon, authenticated;

-- Registrar hallazgo. p_lines: [{"package_code": "...", "quantity": n}]; vacío = todos los paquetes del LPN.
CREATE OR REPLACE FUNCTION public.wh_finding_create(p_lpn_id uuid, p_categories text[], p_severity text, p_description text,
  p_lines jsonb DEFAULT '[]'::jsonb, p_area text DEFAULT 'DESPACHO', p_assigned_to uuid DEFAULT NULL, p_due_at timestamptz DEFAULT NULL,
  p_evidence_paths text[] DEFAULT '{}', p_reject boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE; v_id uuid; v_code text; v_cats text[]; v_n int;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']) THEN RAISE EXCEPTION 'Solo auditoría registra hallazgos' USING ERRCODE = '42501'; END IF;
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id;
  IF NOT FOUND OR NOT public.can_access_site(l.site_id) OR l.status <> 'CLOSED' THEN RAISE EXCEPTION 'LPN no disponible para auditoría'; END IF;
  IF public.wh_user_prepared(l.task_id, l.id) THEN RAISE EXCEPTION 'No puede registrar hallazgos sobre un LPN que usted preparó'; END IF;
  SELECT array_agg(DISTINCT upper(btrim(c))) INTO v_cats FROM unnest(coalesce(p_categories, '{}')) c WHERE btrim(c) <> '';
  IF p_assigned_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assigned_to AND is_active) THEN RAISE EXCEPTION 'Responsable no válido'; END IF;
  IF p_assigned_to = auth.uid() THEN RAISE EXCEPTION 'Quien registra el hallazgo no puede ser responsable de corregirlo'; END IF;
  -- Deja el LPN observado o rechazado (invalida la liberación y retira la unidad asignada si no se cargó)
  PERFORM public.wh_audit_lpn(l.id, CASE WHEN p_reject THEN 'RECHAZADO' ELSE 'OBSERVADO' END, p_description, NULL, '{}', NULL);
  INSERT INTO public.wh_findings(site_id, task_id, lpn_id, audit_rev, categories, severity, description, area, assigned_to, due_at, created_by)
  VALUES (l.site_id, l.task_id, l.id, l.audit_rev, v_cats, upper(btrim(p_severity)), btrim(p_description), upper(btrim(coalesce(p_area, 'DESPACHO'))), p_assigned_to, p_due_at, auth.uid())
  RETURNING id, code INTO v_id, v_code;
  PERFORM wms_private.wh_finding_check_evidence(v_id, l.id, p_evidence_paths);
  -- Alcance: cada paquete una sola vez por hallazgo; kg proporcional a la cantidad afectada; sin peso = pendiente
  INSERT INTO public.wh_finding_lines(finding_id, package_id, product_code, contract_code, unit, quantity, kg, weight_state, declared)
  SELECT v_id, p.id, p.source_product_code, p.source_contract_code, p.unit, q.qty,
         CASE WHEN w.kg IS NOT NULL AND p.quantity > 0 THEN round(w.kg * q.qty / p.quantity, 6) END, w.estado, NOT ('NO_DECLARADO' = ANY (v_cats))
  FROM public.wh_packages p
  CROSS JOIN LATERAL public.wh_package_weight(p) w
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 THEN p.quantity
      ELSE (SELECT least(greatest((x->>'quantity')::numeric, 0), p.quantity) FROM jsonb_array_elements(p_lines) x WHERE x->>'package_code' = p.package_code LIMIT 1) END AS qty) q
  WHERE p.lpn_id = l.id AND p.status <> 'VOID' AND q.qty > 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'Indique al menos un paquete del LPN y su cantidad afectada'; END IF;
  IF jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > v_n THEN RAISE EXCEPTION 'Algún paquete indicado no pertenece al LPN'; END IF;
  INSERT INTO public.wh_finding_events(finding_id, action, to_status, comment, evidence_paths, actor_id)
  VALUES (v_id, 'REGISTRAR', 'ABIERTO', btrim(p_description), coalesce(p_evidence_paths, '{}'), auth.uid());
  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'lines', v_n);
END $$;

-- Acciones: START, CORRECTED (p_lines [{"line_id", "corrected_qty"}], por defecto todo), VERIFY_OK (p_lines [{"line_id", "verified_qty"}],
-- por defecto lo corregido), VERIFY_REJECT, REOPEN, ASSIGN (p_assigned_to, p_due_at, p_area), COMMENT, CAUSE (p_comment = causa confirmada).
CREATE OR REPLACE FUNCTION public.wh_finding_action(p_finding_id uuid, p_action text, p_comment text DEFAULT NULL, p_lines jsonb DEFAULT '[]'::jsonb,
  p_evidence_paths text[] DEFAULT '{}', p_assigned_to uuid DEFAULT NULL, p_due_at timestamptz DEFAULT NULL, p_area text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.wh_findings%ROWTYPE; v_action text := upper(btrim(p_action)); v_to text; v_comment text := nullif(btrim(p_comment), '');
  v_audit boolean; v_sup boolean; v_ops boolean; v_corrector boolean;
BEGIN
  PERFORM public.security_assert_active_session();
  SELECT * INTO f FROM public.wh_findings WHERE id = p_finding_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(f.site_id) THEN RAISE EXCEPTION 'Hallazgo no disponible'; END IF;
  v_audit := public.wh_has_permission(ARRAY['almacen-auditoria','almacen-supervisor']);
  v_sup := public.wh_has_permission(ARRAY['almacen-supervisor']);
  v_ops := public.wh_has_permission(ARRAY['almacen-picking','almacen-packing','almacen-carga','almacen-supervisor']);
  v_corrector := EXISTS (SELECT 1 FROM public.wh_finding_events e WHERE e.finding_id = f.id AND e.action IN ('START','CORRECTED') AND e.actor_id = auth.uid());
  PERFORM wms_private.wh_finding_check_evidence(f.id, f.lpn_id, p_evidence_paths);
  v_to := f.status;
  IF v_action = 'START' THEN
    IF f.status <> 'ABIERTO' THEN RAISE EXCEPTION 'El hallazgo no está abierto'; END IF;
    IF NOT (coalesce(f.assigned_to = auth.uid(), false) OR v_sup OR (f.assigned_to IS NULL AND v_ops)) THEN RAISE EXCEPTION 'Solo el responsable asignado o supervisión inician la corrección' USING ERRCODE = '42501'; END IF;
    IF auth.uid() = f.created_by THEN RAISE EXCEPTION 'Quien registró el hallazgo no puede corregirlo'; END IF;
    v_to := 'EN_CORRECCION';
  ELSIF v_action = 'CORRECTED' THEN
    IF f.status NOT IN ('ABIERTO','EN_CORRECCION') THEN RAISE EXCEPTION 'El hallazgo no está en corrección'; END IF;
    IF NOT (coalesce(f.assigned_to = auth.uid(), false) OR v_sup OR (f.assigned_to IS NULL AND v_ops)) THEN RAISE EXCEPTION 'Solo el responsable asignado o supervisión registran la corrección' USING ERRCODE = '42501'; END IF;
    IF auth.uid() = f.created_by THEN RAISE EXCEPTION 'Quien registró el hallazgo no puede corregirlo'; END IF;
    IF v_comment IS NULL THEN RAISE EXCEPTION 'Describa la corrección realizada'; END IF;
    UPDATE public.wh_finding_lines fl SET corrected_qty = least(fl.quantity, greatest(fl.verified_qty, coalesce(
        (SELECT (x->>'corrected_qty')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x WHERE (x->>'line_id')::bigint = fl.id LIMIT 1),
        CASE WHEN jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 THEN fl.quantity ELSE fl.corrected_qty END)))
      WHERE fl.finding_id = f.id;
    v_to := 'PENDIENTE_VERIFICACION';
  ELSIF v_action IN ('VERIFY_OK','VERIFY_REJECT') THEN
    IF f.status <> 'PENDIENTE_VERIFICACION' THEN RAISE EXCEPTION 'No hay corrección pendiente de verificar'; END IF;
    IF NOT v_audit THEN RAISE EXCEPTION 'Solo auditoría verifica' USING ERRCODE = '42501'; END IF;
    IF v_corrector THEN RAISE EXCEPTION 'Quien corrigió no puede verificar su propia corrección'; END IF;
    IF v_action = 'VERIFY_REJECT' THEN
      IF v_comment IS NULL THEN RAISE EXCEPTION 'Indique por qué la corrección no es conforme'; END IF;
      UPDATE public.wh_finding_lines SET corrected_qty = verified_qty WHERE finding_id = f.id;
      v_to := 'EN_CORRECCION';
    ELSE
      UPDATE public.wh_finding_lines fl SET verified_qty = least(fl.corrected_qty, greatest(fl.verified_qty, coalesce(
          (SELECT (x->>'verified_qty')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x WHERE (x->>'line_id')::bigint = fl.id LIMIT 1),
          CASE WHEN jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 THEN fl.corrected_qty ELSE fl.verified_qty END)))
        WHERE fl.finding_id = f.id;
      v_to := CASE WHEN NOT EXISTS (SELECT 1 FROM public.wh_finding_lines WHERE finding_id = f.id AND verified_qty < quantity) THEN 'CERRADO' ELSE 'EN_CORRECCION' END;
    END IF;
  ELSIF v_action = 'REOPEN' THEN
    IF f.status <> 'CERRADO' THEN RAISE EXCEPTION 'Solo se reabre un hallazgo cerrado'; END IF;
    IF NOT v_audit THEN RAISE EXCEPTION 'Solo auditoría reabre' USING ERRCODE = '42501'; END IF;
    IF v_comment IS NULL THEN RAISE EXCEPTION 'Indique el motivo de la reapertura'; END IF;
    UPDATE public.wh_finding_lines SET corrected_qty = 0, verified_qty = 0 WHERE finding_id = f.id;
    v_to := 'ABIERTO';
    -- Reabrir deja el LPN observado de nuevo (invalida su aprobación y la liberación)
    IF (SELECT status FROM public.wh_lpns WHERE id = f.lpn_id) = 'CLOSED' THEN
      PERFORM public.wh_audit_lpn(f.lpn_id, 'OBSERVADO', 'Hallazgo ' || f.code || ' reabierto: ' || v_comment, NULL, '{}', NULL);
    END IF;
  ELSIF v_action = 'ASSIGN' THEN
    IF NOT v_sup AND NOT (v_audit AND f.created_by = auth.uid()) THEN RAISE EXCEPTION 'Solo supervisión o quien registró asignan' USING ERRCODE = '42501'; END IF;
    IF p_assigned_to IS NOT NULL AND (p_assigned_to = f.created_by OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_assigned_to AND is_active)) THEN
      RAISE EXCEPTION 'Responsable no válido (no puede ser quien registró el hallazgo)';
    END IF;
    IF f.status = 'CERRADO' THEN RAISE EXCEPTION 'El hallazgo está cerrado'; END IF;
    UPDATE public.wh_findings SET assigned_to = coalesce(p_assigned_to, assigned_to), due_at = coalesce(p_due_at, due_at),
      area = coalesce(upper(nullif(btrim(p_area), '')), area) WHERE id = f.id;
  ELSIF v_action = 'CAUSE' THEN
    IF NOT v_audit THEN RAISE EXCEPTION 'Solo auditoría o supervisión confirman la causa' USING ERRCODE = '42501'; END IF;
    IF v_comment IS NULL THEN RAISE EXCEPTION 'Indique la causa'; END IF;
    UPDATE public.wh_findings SET cause = v_comment WHERE id = f.id;
  ELSIF v_action = 'COMMENT' THEN
    IF NOT (v_audit OR v_ops) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
    IF v_comment IS NULL AND coalesce(array_length(p_evidence_paths, 1), 0) = 0 THEN RAISE EXCEPTION 'Agregue un comentario o una foto'; END IF;
  ELSE RAISE EXCEPTION 'Acción no reconocida';
  END IF;
  IF v_to IS DISTINCT FROM f.status THEN
    UPDATE public.wh_findings SET status = v_to,
      closed_at = CASE WHEN v_to = 'CERRADO' THEN now() END, closed_by = CASE WHEN v_to = 'CERRADO' THEN auth.uid() END,
      reopen_count = reopen_count + CASE WHEN v_action = 'REOPEN' THEN 1 ELSE 0 END
    WHERE id = f.id;
  END IF;
  INSERT INTO public.wh_finding_events(finding_id, action, from_status, to_status, comment, evidence_paths, payload, actor_id)
  VALUES (f.id, v_action, f.status, v_to, v_comment, coalesce(p_evidence_paths, '{}'),
    jsonb_strip_nulls(jsonb_build_object('lines', nullif(p_lines, '[]'::jsonb), 'assigned_to', p_assigned_to, 'due_at', p_due_at, 'area', p_area)), auth.uid());
  RETURN jsonb_build_object('id', f.id, 'code', f.code, 'status', v_to);
END $$;

-- Hallazgos con alcance, masa y pendiente (por tarea, o por filtro para la bandeja)
CREATE OR REPLACE FUNCTION public.wh_findings_list(p_task_id uuid DEFAULT NULL, p_status text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_mine boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY ord DESC) FROM (
    SELECT jsonb_build_object('id', f.id, 'code', f.code, 'task_id', f.task_id, 'task_code', t.task_code, 'lpn_id', f.lpn_id, 'lpn_code', l.lpn_code,
      'audit_rev', f.audit_rev, 'lpn_rev', l.audit_rev, 'categories', f.categories, 'severity', f.severity, 'exceptionable', f.exceptionable,
      'description', f.description, 'area', f.area, 'status', f.status, 'cause', f.cause, 'reopen_count', f.reopen_count,
      'assigned_to', f.assigned_to, 'assigned_name', public.wh_profile_name(f.assigned_to), 'due_at', f.due_at,
      'created_by', f.created_by, 'created_name', public.wh_profile_name(f.created_by), 'created_at', f.created_at,
      'closed_at', f.closed_at, 'closed_name', public.wh_profile_name(f.closed_by),
      'request_number', (SELECT r.request_number FROM public.transport_requests r WHERE r.id = t.transport_request_id),
      'kg', (SELECT sum(kg) FROM public.wh_finding_lines WHERE finding_id = f.id),
      'kg_sin_peso', (SELECT count(*) FROM public.wh_finding_lines WHERE finding_id = f.id AND kg IS NULL),
      'kg_pendiente', (SELECT sum(kg * (quantity - verified_qty) / quantity) FROM public.wh_finding_lines WHERE finding_id = f.id),
      'lines', (SELECT jsonb_agg(jsonb_build_object('id', fl.id, 'package_code', p.package_code, 'product_code', fl.product_code, 'contract_code', fl.contract_code,
          'unit', fl.unit, 'quantity', fl.quantity, 'kg', fl.kg, 'weight_state', fl.weight_state, 'declared', fl.declared,
          'corrected_qty', fl.corrected_qty, 'verified_qty', fl.verified_qty) ORDER BY p.package_code)
        FROM public.wh_finding_lines fl JOIN public.wh_packages p ON p.id = fl.package_id WHERE fl.finding_id = f.id),
      'events', (SELECT jsonb_agg(jsonb_build_object('action', e.action, 'from', e.from_status, 'to', e.to_status, 'comment', e.comment,
          'evidence_paths', e.evidence_paths, 'by', public.wh_profile_name(e.actor_id), 'by_id', e.actor_id, 'at', e.created_at) ORDER BY e.created_at)
        FROM public.wh_finding_events e WHERE e.finding_id = f.id)) AS x, f.created_at AS ord
    FROM public.wh_findings f JOIN public.wh_tasks t ON t.id = f.task_id JOIN public.wh_lpns l ON l.id = f.lpn_id
    WHERE public.can_access_site(f.site_id) AND (p_task_id IS NULL OR f.task_id = p_task_id)
      AND (p_status IS NULL OR (p_status = 'ABIERTOS' AND f.status <> 'CERRADO') OR f.status = p_status)
      AND (p_from IS NULL OR (f.created_at AT TIME ZONE 'America/Lima')::date >= p_from)
      AND (p_to IS NULL OR (f.created_at AT TIME ZONE 'America/Lima')::date <= p_to)
      AND (NOT coalesce(p_mine, false) OR f.assigned_to = auth.uid())
    -- Los más recientes primero; shortcut: tope de 500 sin paginar, agregar paginación si una vista lo supera
    ORDER BY f.created_at DESC LIMIT 500) s), '[]'::jsonb);
END $$;

-- Evidencia de correcciones: cualquier usuario del almacén sube fotos bajo hallazgos/<id>/
DO $s$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS wh_finding_evidence_insert ON storage.objects;
    CREATE POLICY wh_finding_evidence_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'wh_audit_evidence' AND name LIKE 'hallazgos/%' AND public.wh_any_warehouse_permission());
  END IF;
END $s$;

REVOKE ALL ON FUNCTION public.wh_finding_create(uuid, text[], text, text, jsonb, text, uuid, timestamptz, text[], boolean),
  public.wh_finding_action(uuid, text, text, jsonb, text[], uuid, timestamptz, text), public.wh_findings_list(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_finding_create(uuid, text[], text, text, jsonb, text, uuid, timestamptz, text[], boolean),
  public.wh_finding_action(uuid, text, text, jsonb, text[], uuid, timestamptz, text), public.wh_findings_list(uuid, text, date, date, boolean) TO authenticated;

-- Identificar la unidad física por escaneo (LPN o paquete): distingue «de otra tarea» de «desconocido»; nunca crea unidades
CREATE OR REPLACE FUNCTION public.wh_lpn_locate(p_code text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_any_warehouse_permission() THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object('lpn_id', l.id, 'lpn_code', l.lpn_code, 'task_id', l.task_id, 'lpn_status', l.status,
      'request_number', (SELECT r.request_number FROM public.wh_tasks t JOIN public.transport_requests r ON r.id = t.transport_request_id WHERE t.id = l.task_id))
    INTO v
  FROM public.wh_lpns l
  WHERE public.can_access_site(l.site_id) AND l.status <> 'VOID'
    AND (upper(l.lpn_code) = upper(btrim(p_code)) OR l.id = (SELECT p.lpn_id FROM public.wh_packages p WHERE upper(p.package_code) = upper(btrim(p_code)) AND p.lpn_id IS NOT NULL LIMIT 1))
  ORDER BY l.created_at DESC LIMIT 1;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.wh_lpn_locate(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_lpn_locate(text) TO authenticated;
