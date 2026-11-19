-- Fase 5 · Modelo analítico de Despacho y Auditoría (solo lectura). Un indicador = numerador / denominador explícitos,
-- universo y fecha base declarados, n de registros, y estado honesto:
--   CALCULADO · NO_CALCULABLE (denominador 0) · SIN_REGISTROS (no hay datos en el período).
-- Reglas de masa: un paquete cuenta una sola vez por universo (varias categorías o hallazgos sobre el mismo paquete no
-- suman: se toma la mayor masa afectada del paquete); peso desconocido no es 0 (se excluye del kg y se informa como
-- «sin peso»); la reinspección no suma cobertura; las revisiones no suman masa. Fechas en hora de Lima.

CREATE OR REPLACE FUNCTION wms_private.wh_kpi(p_code text, p_group text, p_name text, p_unit text, p_num numeric, p_den numeric,
  p_n bigint, p_universe text, p_date text, p_extra jsonb DEFAULT '{}'::jsonb, p_value numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('code', p_code, 'group', p_group, 'name', p_name, 'unit', p_unit, 'num', p_num, 'den', p_den, 'n', coalesce(p_n, 0),
    'universe', p_universe, 'date_basis', p_date,
    'value', CASE WHEN p_value IS NOT NULL THEN p_value WHEN p_den IS NULL THEN p_num WHEN p_den = 0 THEN NULL
                  WHEN p_unit = '%' THEN round(100 * p_num / p_den, 1) ELSE round(p_num / p_den, 2) END,
    'state', CASE WHEN coalesce(p_n, 0) = 0 THEN 'SIN_REGISTROS' WHEN p_den = 0 THEN 'NO_CALCULABLE' ELSE 'CALCULADO' END) || coalesce(p_extra, '{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION wms_private.wh_kpi(text, text, text, text, numeric, numeric, bigint, text, text, jsonb, numeric) FROM PUBLIC, anon, authenticated;

-- Paquetes con peso, estado del peso y contexto (base común de los indicadores de masa)
CREATE OR REPLACE FUNCTION wms_private.wh_kpi_packages(p_filters jsonb)
RETURNS TABLE(package_id uuid, lpn_id uuid, task_id uuid, site_id uuid, kg numeric, weight_state text, contract_code text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, p.lpn_id, l.task_id, l.site_id, w.kg, w.estado, p.source_contract_code, p.status
  FROM public.wh_packages p JOIN public.wh_lpns l ON l.id = p.lpn_id CROSS JOIN LATERAL public.wh_package_weight(p) w
  WHERE p.status <> 'VOID' AND l.status <> 'VOID' AND public.can_access_site(l.site_id)
    AND (nullif(p_filters->>'ot', '') IS NULL OR p.source_contract_code LIKE (p_filters->>'ot') || '%')
$$;
REVOKE ALL ON FUNCTION wms_private.wh_kpi_packages(jsonb) FROM PUBLIC, anon, authenticated;

-- Volátil: usa tablas temporales de trabajo (solo lectura de datos)
CREATE OR REPLACE FUNCTION public.wh_dispatch_kpis(p_from date, p_to date, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); out jsonb := '[]'::jsonb; r record; v_cut timestamptz;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-auditoria']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Período no válido (máximo 400 días)'; END IF;
  v_cut := ((p_to + 1)::timestamp AT TIME ZONE 'America/Lima');

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.k_pk (package_id uuid, lpn_id uuid, task_id uuid, site_id uuid, kg numeric, weight_state text, contract_code text, status text) ON COMMIT DROP;
  TRUNCATE pg_temp.k_pk;
  INSERT INTO pg_temp.k_pk SELECT * FROM wms_private.wh_kpi_packages(f);

  -- D1 Tn preparadas: paquetes de LPN cerrados en el período (fecha de cierre del LPN)
  SELECT count(*) n, sum(k.kg) kg, count(*) FILTER (WHERE k.kg IS NULL) sin_peso, count(*) FILTER (WHERE k.weight_state IN ('PROVISIONAL','EN_REVISION')) prov INTO r
  FROM pg_temp.k_pk k JOIN public.wh_lpns l ON l.id = k.lpn_id WHERE (l.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('D1', 'Despacho', 'Toneladas preparadas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Paquetes en LPN cerrados en el período', 'Cierre del LPN',
    jsonb_build_object('sin_peso', r.sin_peso, 'provisionales', r.prov));

  -- D2 Tn liberadas: tareas cuya primera liberación cae en el período
  SELECT count(DISTINCT k.task_id) tareas, count(*) n, sum(k.kg) kg, count(*) FILTER (WHERE k.kg IS NULL) sin_peso INTO r
  FROM pg_temp.k_pk k JOIN (SELECT e.task_id, min(e.occurred_at) at FROM public.wh_scan_events e WHERE e.event_type = 'PACKING_LIST_RELEASED' GROUP BY e.task_id) rl ON rl.task_id = k.task_id
  WHERE (rl.at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('D2', 'Despacho', 'Toneladas liberadas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Paquetes de tareas liberadas por primera vez en el período', 'Primera liberación',
    jsonb_build_object('tareas', r.tareas, 'sin_peso', r.sin_peso));

  -- D3 Tn cargadas, D4 cumplimiento de carga por tarea y D5 por masa: tareas cerradas (carga) en el período
  SELECT count(*) FILTER (WHERE k.status = 'LOADED') n, sum(k.kg) FILTER (WHERE k.status = 'LOADED') kg, count(*) FILTER (WHERE k.status = 'LOADED' AND k.kg IS NULL) sin_peso,
         sum(k.kg) FILTER (WHERE k.status <> 'LOADED') kg_pend INTO r
  FROM pg_temp.k_pk k JOIN public.wh_tasks t ON t.id = k.task_id
  WHERE t.status IN ('LOADED','PARTIAL','RECONCILED') AND (t.loaded_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('D3', 'Despacho', 'Toneladas cargadas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Paquetes cargados de tareas cerradas en el período', 'Confirmación de carga',
    jsonb_build_object('sin_peso', r.sin_peso));
  out := out || wms_private.wh_kpi('D5', 'Despacho', 'Cumplimiento de carga por masa', '%', coalesce(r.kg, 0), coalesce(r.kg, 0) + coalesce(r.kg_pend, 0),
    r.n, 'kg cargados / kg preparados de tareas cerradas en el período', 'Confirmación de carga', jsonb_build_object('nota', 'Indicador separado del cumplimiento por tarea'));
  SELECT count(*) n, count(*) FILTER (WHERE t.status <> 'PARTIAL' AND coalesce(t.close_summary->>'tipo', 'COMPLETA') = 'COMPLETA') ok INTO r
  FROM public.wh_tasks t WHERE public.can_access_site(t.site_id) AND t.status IN ('LOADED','PARTIAL','RECONCILED') AND (t.loaded_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
    AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.task_id = t.id));
  out := out || wms_private.wh_kpi('D4', 'Despacho', 'Cumplimiento de carga por tarea', '%', r.ok, r.n, r.n, 'Tareas con carga completa / tareas cerradas en el período', 'Confirmación de carga');

  -- D6 Tiempo activo de picking (mediana, p90): tareas listas para auditoría en el período con inicio registrado
  WITH tt AS (SELECT public.wh_task_times(t.id) x FROM public.wh_tasks t
              WHERE public.can_access_site(t.site_id) AND EXISTS (SELECT 1 FROM public.wh_scan_events e WHERE e.task_id = t.id AND e.event_type = 'TASK_FINISH_PICKING'
                AND (e.occurred_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
                AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.task_id = t.id)))
  SELECT count(*) FILTER (WHERE (x->>'activo_min') IS NOT NULL) n, count(*) FILTER (WHERE (x->>'activo_min') IS NULL) sin_inicio,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (x->>'activo_min')::numeric) p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY (x->>'activo_min')::numeric) p90,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (x->>'espera_min')::numeric) w50, percentile_cont(0.5) WITHIN GROUP (ORDER BY (x->>'transcurrido_min')::numeric) t50 INTO r FROM tt;
  out := out || wms_private.wh_kpi('D6', 'Despacho', 'Tiempo activo de picking (mediana)', 'min', NULL, NULL, r.n, 'Tareas listas para auditoría en el período con inicio registrado', 'Listo para auditoría',
    jsonb_build_object('p50', round(r.p50::numeric, 1), 'p90', round(r.p90::numeric, 1), 'espera_p50', round(r.w50::numeric, 1), 'transcurrido_p50', round(r.t50::numeric, 1), 'sin_inicio', r.sin_inicio), round(r.p50::numeric, 1));

  -- D7 Espera de auditoría por LPN (cierre → primera auditoría) y D8 calidad a la primera
  WITH la AS (SELECT l.id, l.closed_at, (SELECT min(a.created_at) FROM public.wh_lpn_audits a WHERE a.lpn_id = l.id AND a.result IN ('APROBADO','OBSERVADO','RECHAZADO')) first_at,
                (SELECT a.result FROM public.wh_lpn_audits a WHERE a.lpn_id = l.id AND a.result IN ('APROBADO','OBSERVADO','RECHAZADO') ORDER BY a.created_at, a.id LIMIT 1) first_result
              FROM public.wh_lpns l WHERE l.status <> 'VOID' AND l.closed_at IS NOT NULL AND public.can_access_site(l.site_id)
                AND (l.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
                AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.lpn_id = l.id)))
  SELECT count(*) FILTER (WHERE first_at IS NOT NULL) n, count(*) FILTER (WHERE first_at IS NULL) pend,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_at - closed_at) / 60) p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM first_at - closed_at) / 60) p90,
         count(*) FILTER (WHERE first_result = 'APROBADO') ok INTO r FROM la;
  out := out || wms_private.wh_kpi('D7', 'Despacho', 'Espera de auditoría por LPN (mediana)', 'min', NULL, NULL, r.n, 'LPN cerrados en el período con primera auditoría', 'Cierre del LPN',
    jsonb_build_object('p50', round(r.p50::numeric, 1), 'p90', round(r.p90::numeric, 1), 'sin_auditar', r.pend), round(r.p50::numeric, 1));
  out := out || wms_private.wh_kpi('D8', 'Despacho', 'Calidad a la primera', '%', r.ok, r.n, r.n, 'LPN aprobados en su primera auditoría / LPN auditados (cerrados en el período)', 'Cierre del LPN');

  -- A1 Tn auditadas únicas y A4 incidencia por masa (mismo universo: paquetes de LPN con auditoría en el período)
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.k_aud (package_id uuid, kg numeric) ON COMMIT DROP; TRUNCATE pg_temp.k_aud;
  INSERT INTO pg_temp.k_aud SELECT DISTINCT k.package_id, k.kg FROM pg_temp.k_pk k
    WHERE EXISTS (SELECT 1 FROM public.wh_lpn_audits a WHERE a.lpn_id = k.lpn_id AND a.result IN ('APROBADO','OBSERVADO','RECHAZADO')
      AND (a.created_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
      AND (nullif(f->>'auditor', '') IS NULL OR EXISTS (SELECT 1 FROM public.wh_lpn_audits a WHERE a.lpn_id = k.lpn_id AND a.actor_id = (f->>'auditor')::uuid));
  SELECT count(*) n, sum(kg) kg, count(*) FILTER (WHERE kg IS NULL) sin_peso INTO r FROM pg_temp.k_aud;
  out := out || wms_private.wh_kpi('A1', 'Auditoría', 'Toneladas auditadas únicas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Paquetes de LPN auditados en el período (cada paquete una vez)', 'Auditoría',
    jsonb_build_object('sin_peso', r.sin_peso));
  WITH af AS (SELECT fl.package_id, max(fl.kg) kg, bool_or(fl.kg IS NULL) sin_peso
              FROM public.wh_finding_lines fl JOIN public.wh_findings h ON h.id = fl.finding_id
              WHERE (h.created_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
                AND (nullif(f->>'severity', '') IS NULL OR h.severity = f->>'severity')
                AND (nullif(f->>'category', '') IS NULL OR f->>'category' = ANY (h.categories))
                AND (nullif(f->>'area', '') IS NULL OR h.area = f->>'area')
              GROUP BY fl.package_id)
  SELECT (SELECT sum(kg) FROM pg_temp.k_aud) den, sum(af.kg) FILTER (WHERE a.package_id IS NOT NULL) num, count(*) FILTER (WHERE a.package_id IS NOT NULL) n,
         count(*) FILTER (WHERE a.package_id IS NOT NULL AND af.sin_peso) sin_peso, sum(af.kg) total_af, count(*) total_n INTO r
  FROM af LEFT JOIN pg_temp.k_aud a ON a.package_id = af.package_id
  WHERE EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.package_id = af.package_id);
  out := out || wms_private.wh_kpi('A3', 'Auditoría', 'Toneladas afectadas únicas', 't', round(coalesce(r.total_af, 0) / 1000, 3), NULL, r.total_n, 'Paquetes con hallazgos detectados en el período (cada paquete una vez, mayor masa afectada)', 'Detección');
  out := out || wms_private.wh_kpi('A4', 'Auditoría', 'Incidencia por masa', '%', coalesce(r.num, 0), coalesce(r.den, 0), (SELECT count(*) FROM pg_temp.k_aud),
    'kg afectados / kg auditados del mismo universo (paquetes de LPN auditados en el período)', 'Auditoría', jsonb_build_object('afectados_sin_peso', r.sin_peso));

  -- A2 Cobertura (control 100 %): masa de LPN liberados en el período con auditoría válida sobre su revisión vigente
  SELECT sum(k.kg) den, sum(k.kg) FILTER (WHERE l.audit_status = 'APROBADO' AND EXISTS (SELECT 1 FROM public.wh_lpn_audits a WHERE a.lpn_id = l.id AND a.audit_rev = l.audit_rev AND a.result = 'APROBADO')) num,
         count(DISTINCT l.id) n, count(DISTINCT l.id) FILTER (WHERE NOT (l.audit_status = 'APROBADO' AND EXISTS (SELECT 1 FROM public.wh_lpn_audits a WHERE a.lpn_id = l.id AND a.audit_rev = l.audit_rev AND a.result = 'APROBADO'))) desvios INTO r
  FROM pg_temp.k_pk k JOIN public.wh_lpns l ON l.id = k.lpn_id
  JOIN (SELECT e.task_id, min(e.occurred_at) at FROM public.wh_scan_events e WHERE e.event_type = 'PACKING_LIST_RELEASED' GROUP BY e.task_id) rl ON rl.task_id = k.task_id
  WHERE (rl.at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('A2', 'Auditoría', 'Cobertura de auditoría (liberado con auditoría válida)', '%', coalesce(r.num, 0), coalesce(r.den, 0), r.n,
    'kg de LPN liberados en el período con aprobación sobre la revisión vigente / kg liberados', 'Primera liberación', jsonb_build_object('lpn_sin_auditoria_valida', r.desvios));

  -- A5 Masa pendiente al corte (situación actual de hallazgos abiertos)
  -- Cada paquete una sola vez: la mayor masa pendiente entre sus hallazgos abiertos
  SELECT (SELECT count(DISTINCT x2.finding_id) FROM public.wh_finding_lines x2 JOIN public.wh_findings h2 ON h2.id = x2.finding_id
            WHERE h2.status <> 'CERRADO' AND public.can_access_site(h2.site_id) AND EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.package_id = x2.package_id)
              AND (nullif(f->>'severity', '') IS NULL OR h2.severity = f->>'severity') AND (nullif(f->>'area', '') IS NULL OR h2.area = f->>'area')) n,
         sum(x.kg_p) kg, count(*) FILTER (WHERE x.sin) sin_peso INTO r FROM (
    SELECT fl.package_id, max(fl.kg * (fl.quantity - fl.verified_qty) / fl.quantity) kg_p, bool_or(fl.kg IS NULL) sin
    FROM public.wh_findings h JOIN public.wh_finding_lines fl ON fl.finding_id = h.id
    WHERE h.status <> 'CERRADO' AND public.can_access_site(h.site_id) AND EXISTS (SELECT 1 FROM pg_temp.k_pk k WHERE k.package_id = fl.package_id)
      AND (nullif(f->>'severity', '') IS NULL OR h.severity = f->>'severity') AND (nullif(f->>'area', '') IS NULL OR h.area = f->>'area')
    GROUP BY fl.package_id) x;
  out := out || wms_private.wh_kpi('A5', 'Auditoría', 'Masa pendiente de corregir', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Hallazgos sin cerrar a la fecha (masa afectada no verificada)', 'Corte: ahora',
    jsonb_build_object('paquetes_sin_peso', r.sin_peso));

  -- A6 Cumplimiento de cierre, A7 tiempo de cierre, A8 reapertura
  WITH h AS (SELECT x.* FROM public.wh_findings x WHERE public.can_access_site(x.site_id)
               AND (nullif(f->>'severity', '') IS NULL OR x.severity = f->>'severity') AND (nullif(f->>'area', '') IS NULL OR x.area = f->>'area')
               AND (nullif(f->>'category', '') IS NULL OR f->>'category' = ANY (x.categories))
               AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM public.wh_finding_lines fl JOIN pg_temp.k_pk k ON k.package_id = fl.package_id WHERE fl.finding_id = x.id)))
  SELECT (SELECT count(*) FROM h WHERE (due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) due_n,
         (SELECT count(*) FROM h WHERE (due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to AND closed_at IS NOT NULL AND closed_at <= due_at) due_ok,
         (SELECT count(*) FROM h WHERE (closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) cl_n,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 3600) FROM h WHERE (closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) p50,
         (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 3600) FROM h WHERE (closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) p90,
         (SELECT count(*) FROM h WHERE (created_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) cr_n,
         (SELECT count(*) FROM h WHERE (created_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to AND reopen_count > 0) re_n INTO r;
  out := out || wms_private.wh_kpi('A6', 'Auditoría', 'Cumplimiento de cierre en plazo', '%', r.due_ok, r.due_n, r.due_n, 'Hallazgos cerrados a tiempo / hallazgos con compromiso en el período', 'Compromiso');
  out := out || wms_private.wh_kpi('A7', 'Auditoría', 'Tiempo de cierre (mediana)', 'h', NULL, NULL, r.cl_n, 'Hallazgos cerrados en el período (registro → cierre)', 'Cierre',
    jsonb_build_object('p50', round(r.p50::numeric, 1), 'p90', round(r.p90::numeric, 1)), round(r.p50::numeric, 1));
  out := out || wms_private.wh_kpi('A8', 'Auditoría', 'Reapertura de hallazgos', '%', r.re_n, r.cr_n, r.cr_n, 'Hallazgos reabiertos / hallazgos registrados en el período', 'Detección');

  -- Q1 Calidad del dato (paquetes de LPN cerrados en el período)
  SELECT count(*) n, count(*) FILTER (WHERE k.weight_state = 'PROVISIONAL') prov, count(*) FILTER (WHERE k.weight_state = 'EN_REVISION') rev,
         count(*) FILTER (WHERE k.weight_state = 'CALCULADO') calc INTO r
  FROM pg_temp.k_pk k JOIN public.wh_lpns l ON l.id = k.lpn_id WHERE (l.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('Q1', 'Calidad del dato', 'Paquetes con peso provisional (sin dato)', '%', r.prov, r.n, r.n, 'Paquetes de LPN cerrados en el período', 'Cierre del LPN',
    jsonb_build_object('en_revision', r.rev, 'calculados', r.calc));

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'filters', f, 'generated_at', now(), 'cut', v_cut, 'kpis', out);
END $$;

-- Detalle para desglosar un indicador hasta el registro (tareas, LPN o hallazgos), con los mismos filtros
CREATE OR REPLACE FUNCTION public.wh_dispatch_kpi_detail(p_code text, p_from date, p_to date, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); c text := upper(btrim(p_code));
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-auditoria']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Período no válido (máximo 400 días)'; END IF;
  IF c IN ('A3','A4','A5','A6','A7','A8') THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('tipo', 'hallazgo', 'code', h.code, 'task_code', t.task_code, 'lpn_code', l.lpn_code, 'status', h.status, 'severity', h.severity,
        'categories', h.categories, 'area', h.area, 'created_at', h.created_at, 'due_at', h.due_at, 'closed_at', h.closed_at, 'reopen_count', h.reopen_count,
        'kg', (SELECT sum(kg) FROM public.wh_finding_lines WHERE finding_id = h.id),
        'kg_pendiente', (SELECT sum(kg * (quantity - verified_qty) / quantity) FROM public.wh_finding_lines WHERE finding_id = h.id)) ORDER BY h.created_at DESC)
      FROM public.wh_findings h JOIN public.wh_tasks t ON t.id = h.task_id JOIN public.wh_lpns l ON l.id = h.lpn_id
      WHERE public.can_access_site(h.site_id)
        AND CASE WHEN c = 'A5' THEN h.status <> 'CERRADO'
                 WHEN c = 'A6' THEN (h.due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
                 WHEN c = 'A7' THEN (h.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
                 ELSE (h.created_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to END
        AND (nullif(f->>'severity', '') IS NULL OR h.severity = f->>'severity') AND (nullif(f->>'area', '') IS NULL OR h.area = f->>'area')
        AND (nullif(f->>'category', '') IS NULL OR f->>'category' = ANY (h.categories))
        AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM public.wh_finding_lines fl JOIN public.wh_packages p ON p.id = fl.package_id WHERE fl.finding_id = h.id AND p.source_contract_code LIKE (f->>'ot') || '%'))
      LIMIT 1000), '[]'::jsonb);
  ELSIF c IN ('D7','D8','A1','A2','D1','Q1') THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('tipo', 'lpn', 'lpn_code', l.lpn_code, 'task_code', t.task_code, 'closed_at', l.closed_at, 'audit_status', l.audit_status,
        'audit_rev', l.audit_rev, 'kg', w.kg, 'sin_peso', w.sin_peso, 'auditado_por', public.wh_profile_name(l.audited_by), 'audited_at', l.audited_at) ORDER BY l.closed_at DESC)
      FROM public.wh_lpns l JOIN public.wh_tasks t ON t.id = l.task_id
      CROSS JOIN LATERAL (SELECT sum(x.kg) kg, count(*) FILTER (WHERE x.kg IS NULL) sin_peso FROM wms_private.wh_kpi_packages(f) x WHERE x.lpn_id = l.id) w
      WHERE public.can_access_site(l.site_id) AND l.status <> 'VOID' AND (l.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
        AND (nullif(f->>'ot', '') IS NULL OR w.kg IS NOT NULL OR w.sin_peso > 0)
      LIMIT 1000), '[]'::jsonb);
  ELSE
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('tipo', 'tarea', 'task_code', t.task_code, 'status', t.status, 'loaded_at', t.loaded_at, 'close_summary', t.close_summary,
        'tiempos', CASE WHEN c = 'D6' THEN public.wh_task_times(t.id) END) ORDER BY coalesce(t.loaded_at, t.updated_at) DESC)
      FROM public.wh_tasks t WHERE public.can_access_site(t.site_id)
        AND CASE WHEN c = 'D6' THEN EXISTS (SELECT 1 FROM public.wh_scan_events e WHERE e.task_id = t.id AND e.event_type = 'TASK_FINISH_PICKING' AND (e.occurred_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
                 WHEN c = 'D2' THEN EXISTS (SELECT 1 FROM public.wh_scan_events e WHERE e.task_id = t.id AND e.event_type = 'PACKING_LIST_RELEASED' AND (e.occurred_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
                 ELSE t.status IN ('LOADED','PARTIAL','RECONCILED') AND (t.loaded_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to END
        AND (nullif(f->>'ot', '') IS NULL OR EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.task_id = t.id AND p.source_contract_code LIKE (f->>'ot') || '%'))
      LIMIT 1000), '[]'::jsonb);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.wh_dispatch_kpis(date, date, jsonb), public.wh_dispatch_kpi_detail(text, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_dispatch_kpis(date, date, jsonb), public.wh_dispatch_kpi_detail(text, date, date, jsonb) TO authenticated;
