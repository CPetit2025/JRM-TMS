-- Control de Jornada y Reporte mensual de flota · Fase 2, datos (docs/control-jornada-plan.md, aprobado el 01/11/2026).
-- 1) unit_daily_report: las toneladas APT de una guía compartida por varias paradas se cuentan una vez; «odómetro
--    retrocede» ya no se repite en el mismo día.
-- 2) consolidation_savings (D2): con costos por hora sin cargar, el servicio queda COSTO_HORA_PENDIENTE y no suma ahorro.
-- 3) fleet_workdays: una fila por unidad y día para toda la flota visible. Reutiliza unit_daily_report (una sola fuente
--    de km, toneladas y alertas) y agrega el estado de jornada (D1), las referencias OT/OC/OS/RQ, las incidencias (D4),
--    el ahorro (D2) y el mantenimiento pendiente por unidad. Sin tablas nuevas.
BEGIN;
SET LOCAL lock_timeout = '60s';

DO $patch$
DECLARE def text := pg_get_functiondef('public.unit_daily_report(text,date,date)'::regprocedure);
 o_tn text := '(SELECT round(sum(COALESCE(s.kg_apt, s.kg_declared)) / 1000, 3) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS tn,';
 n_tn text := '(SELECT round(sum(k.kg) / 1000, 3) FROM (SELECT DISTINCT ON (CASE WHEN s.kg_apt IS NOT NULL THEN ''G:'' || public.apt_guia_key(s.guide) ELSE ''S:'' || s.dispatch_id || '':'' || s.request_id END)
         COALESCE(s.kg_apt, s.kg_declared) AS kg FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) k) AS tn,';
 o_apt text := '(SELECT round(sum(s.kg_apt) / 1000, 3) FROM stops s JOIN disp x ON x.id = s.dispatch_id WHERE x.day = d.day) AS tn_apt,';
 n_apt text := '(SELECT round(sum(k.kg) / 1000, 3) FROM (SELECT DISTINCT ON (public.apt_guia_key(s.guide)) s.kg_apt AS kg FROM stops s JOIN disp x ON x.id = s.dispatch_id
         WHERE x.day = d.day AND s.kg_apt IS NOT NULL) k) AS tn_apt,';
 o_al text := 'CASE WHEN f.odo_end IS NOT NULL AND f.odo_start IS NOT NULL AND f.odo_end < f.odo_start THEN ''ODOMETRO_RETROCEDE'' END';
 n_al text := 'CASE WHEN f.odo_end IS NOT NULL AND f.odo_start IS NOT NULL AND f.odo_end < f.odo_start AND NOT COALESCE(f.flags ? ''RETROCESO'', false) THEN ''ODOMETRO_RETROCEDE'' END';
BEGIN
 IF position('DISTINCT ON (public.apt_guia_key(s.guide))' IN def) = 0 THEN
  IF position(o_tn IN def) = 0 OR position(o_apt IN def) = 0 OR position(o_al IN def) = 0 THEN
   RAISE EXCEPTION 'unit_daily_report cambió: revisar el parche de toneladas y alertas';
  END IF;
  EXECUTE replace(replace(replace(def, o_tn, n_tn), o_apt, n_apt), o_al, n_al);
 END IF;

 def := pg_get_functiondef('public.consolidation_savings(date,date,uuid,uuid)'::regprocedure);
 IF position('COSTO_HORA_PENDIENTE' IN def) = 0 THEN
  IF position('WHEN f.modalidad <> ''TERCERO'' AND f.extra_km IS NULL THEN ''SIN_KM'' ELSE ''VALORIZADO'' END AS state' IN def) = 0 THEN
   RAISE EXCEPTION 'consolidation_savings cambió: revisar el parche de costos por hora pendientes';
  END IF;
  EXECUTE replace(def, 'WHEN f.modalidad <> ''TERCERO'' AND f.extra_km IS NULL THEN ''SIN_KM'' ELSE ''VALORIZADO'' END AS state',
   'WHEN f.modalidad <> ''TERCERO'' AND f.extra_km IS NULL THEN ''SIN_KM'' WHEN f.hours_cost_missing THEN ''COSTO_HORA_PENDIENTE'' ELSE ''VALORIZADO'' END AS state');
 END IF;
END $patch$;

CREATE OR REPLACE FUNCTION public.fleet_workdays(p_from date, p_to date, p_plates text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- v_rows / v_units son arreglos: agregar al final no copia todo el contenido
DECLARE v record; r jsonb; d jsonb; v_rows jsonb[] := '{}'; v_units jsonb[] := '{}'; v_sav jsonb; v_map jsonb := '{}'::jsonb;
 v_today date := (now() AT TIME ZONE 'America/Lima')::date; v_inc jsonb; v_maint jsonb; v_status text; v_alerts jsonb; v_s jsonb; v_has boolean;
 v_review text[] := ARRAY['ODOMETRO_RETROCEDE','ODOMETRO_SALTO','KM_SIN_RUTA','GPS_INCOMPLETO','SIN_CHECKLIST','SIN_ODOMETRO'];
BEGIN
 IF NOT public.can_view_unit_report() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin permiso para el control de jornadas'); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
  RETURN jsonb_build_object('success', false, 'error', 'Indique un período válido de hasta 3 meses');
 END IF;

 -- Ahorro por consolidación del período (D2), por ruta: solo lo valorizado; lo pendiente se cuenta aparte
 IF public.is_tms_admin() OR public.budget_can_read() THEN
  v_sav := public.consolidation_savings(p_from, p_to);
  IF COALESCE((v_sav->>'success')::boolean, false) THEN
   SELECT COALESCE(jsonb_object_agg(dn, obj), '{}'::jsonb) INTO v_map FROM (
     SELECT x->>'dispatch_number' AS dn, jsonb_build_object(
       'value', round(COALESCE(sum((x->>'standalone_pen')::numeric) FILTER (WHERE x->>'state' = 'VALORIZADO'), 0), 2),
       'marginal', round(COALESCE(sum((x->>'marginal_pen')::numeric) FILTER (WHERE x->>'state' = 'VALORIZADO'), 0), 2),
       'saving', round(COALESCE(sum((x->>'saving_pen')::numeric) FILTER (WHERE x->>'state' = 'VALORIZADO'), 0), 2),
       'valued', count(*) FILTER (WHERE x->>'state' = 'VALORIZADO'),
       'pending', count(*) FILTER (WHERE x->>'state' <> 'VALORIZADO')) AS obj
     FROM jsonb_array_elements(v_sav->'rows') x WHERE NOT (x->>'principal')::boolean GROUP BY 1) q;
  ELSE v_sav := NULL;
  END IF;
 END IF;

 FOR v IN SELECT x.plate, x.type, x.status FROM public.vehicles x
          WHERE upper(x.plate) <> 'EXTERNO' AND public.can_access_site(x.site_id) AND (p_plates IS NULL OR x.plate = ANY (p_plates))
          ORDER BY x.plate LOOP
  r := public.unit_daily_report(v.plate, p_from, p_to);
  CONTINUE WHEN NOT COALESCE((r->>'success')::boolean, false);

  -- Incidencias (D4), cada una una vez por su registro de origen; las de ruta van al día de la ruta
  SELECT COALESCE(jsonb_object_agg(day, items), '{}'::jsonb) INTO v_inc FROM (
    SELECT day, jsonb_agg(i ORDER BY i->>'at') AS items FROM (
      SELECT (x.scheduled_departure AT TIME ZONE 'America/Lima')::date AS day, jsonb_build_object('source', 'EVENTO', 'id', e.id, 'type', e.event_type,
        'at', e.created_at, 'detail', e.description, 'dispatch_number', x.dispatch_number) AS i
      FROM public.dispatch_events e JOIN public.dispatches x ON x.id = e.dispatch_id
      WHERE x.vehicle_plate = v.plate AND e.event_type IN ('INCIDENCIA','RETRASO','DESVIO')
        AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT (x.scheduled_departure AT TIME ZONE 'America/Lima')::date, jsonb_build_object('source', 'RECHAZO', 'id', j.id, 'type', 'RECHAZO_' || j.kind,
        'at', j.captured_at, 'detail', j.reason_code || COALESCE(' · ' || j.note, ''), 'dispatch_number', x.dispatch_number)
      FROM public.delivery_rejections j JOIN public.dispatches x ON x.id = j.dispatch_id
      WHERE x.vehicle_plate = v.plate AND (x.scheduled_departure AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
      UNION ALL
      SELECT (k.occurred_at AT TIME ZONE 'America/Lima')::date, jsonb_build_object('source', 'UNIDAD', 'id', k.id, 'type', k.incident_type,
        'at', k.occurred_at, 'detail', k.description, 'dispatch_number', NULL)
      FROM public.vehicle_incidents k WHERE k.vehicle_plate = v.plate AND (k.occurred_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
    ) z GROUP BY day) q;

  -- Mantenimiento pendiente: solicitudes pendientes y planes vencidos (si el módulo existe en la base)
  v_maint := '[]'::jsonb;
  IF to_regclass('public.maintenance_requests') IS NOT NULL THEN
   EXECUTE 'SELECT COALESCE(jsonb_agg(jsonb_build_object(''kind'', ''SOLICITUD'', ''detail'', description, ''at'', reported_at)), ''[]''::jsonb)
            FROM public.maintenance_requests WHERE vehicle_plate = $1 AND status = ''PENDIENTE''' INTO v_maint USING v.plate;
  END IF;
  IF to_regclass('public.maintenance_plans') IS NOT NULL THEN
   EXECUTE 'SELECT $2 || COALESCE(jsonb_agg(jsonb_build_object(''kind'', ''PLAN'', ''detail'', name, ''due_date'', next_due_date, ''due_km'', next_due_km)), ''[]''::jsonb)
            FROM public.maintenance_plans WHERE vehicle_plate = $1 AND COALESCE(is_active, true)
              AND (next_due_date <= $3 OR (next_due_km IS NOT NULL AND next_due_km <= $4))'
     INTO v_maint USING v.plate, v_maint, p_to, NULLIF(r->>'current_odometer', '')::numeric;
  END IF;
  v_units := array_append(v_units, jsonb_build_object('plate', v.plate, 'type', v.type, 'status', v.status, 'current_odometer', r->'current_odometer', 'maintenance', v_maint));

  FOR d IN SELECT value FROM jsonb_array_elements(r->'days') LOOP
   v_alerts := COALESCE(d->'alerts', '[]'::jsonb);
   v_has := COALESCE((d->>'routes')::int, 0) > 0 OR COALESCE((d->>'checklists')::int, 0) > 0 OR jsonb_array_length(COALESCE(d->'readings', '[]'::jsonb)) > 0;
   -- Estado de jornada (D1)
   v_status := CASE
     WHEN NOT v_has THEN 'SIN_OPERACION'
     WHEN d->>'odo_start' IS NOT NULL AND (d->>'end_source' IS NULL OR ((d->>'date')::date = v_today AND d->>'end_source' IS DISTINCT FROM 'CIERRE')) THEN 'ABIERTA'
     WHEN d->>'end_source' = 'SIGUIENTE_INICIO' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_alerts) a WHERE a = ANY (v_review)) THEN 'EN_REVISION'
     WHEN d->>'end_source' = 'CIERRE' THEN 'CERRADA'
     ELSE 'EN_REVISION' END;
   -- Ahorro del día: rutas de la unidad en ese día
   SELECT CASE WHEN v_sav IS NULL THEN NULL ELSE jsonb_build_object(
       'value', round(COALESCE(sum((v_map->(x->>'dispatch_number')->>'value')::numeric), 0), 2),
       'marginal', round(COALESCE(sum((v_map->(x->>'dispatch_number')->>'marginal')::numeric), 0), 2),
       'saving', round(COALESCE(sum((v_map->(x->>'dispatch_number')->>'saving')::numeric), 0), 2),
       'valued', COALESCE(sum((v_map->(x->>'dispatch_number')->>'valued')::int), 0),
       'pending', COALESCE(sum((v_map->(x->>'dispatch_number')->>'pending')::int), 0)) END
     INTO v_s FROM jsonb_array_elements(COALESCE(d->'dispatches', '[]'::jsonb)) x;
   v_rows := array_append(v_rows, d || jsonb_build_object('plate', v.plate, 'unit_type', v.type, 'status', v_status,
     'refs', (SELECT jsonb_build_object(
        'OT', COALESCE(jsonb_agg(DISTINCT s->>'ot') FILTER (WHERE s->>'ot' IS NOT NULL), '[]'::jsonb),
        'OC', COALESCE(jsonb_agg(DISTINCT s->>'ref_number') FILTER (WHERE s->>'ref_type' = 'OC'), '[]'::jsonb),
        'OS', COALESCE(jsonb_agg(DISTINCT s->>'ref_number') FILTER (WHERE s->>'ref_type' = 'OS'), '[]'::jsonb),
        'RQ', COALESCE(jsonb_agg(DISTINCT s->>'ref_number') FILTER (WHERE s->>'ref_type' = 'RQ'), '[]'::jsonb))
       FROM jsonb_array_elements(COALESCE(d->'dispatches', '[]'::jsonb)) x, jsonb_array_elements(COALESCE(x->'stops', '[]'::jsonb)) s),
     'incidents', COALESCE(v_inc->(d->>'date'), '[]'::jsonb),
     'saving', CASE WHEN v_s IS NULL OR ((v_s->>'valued')::int = 0 AND (v_s->>'pending')::int = 0) THEN NULL ELSE v_s END));
  END LOOP;
 END LOOP;

 RETURN jsonb_build_object('success', true, 'as_of', now(), 'from', p_from, 'to', p_to, 'savings_available', v_sav IS NOT NULL,
   'units', to_jsonb(v_units), 'rows', to_jsonb(v_rows));
END $$;
REVOKE ALL ON FUNCTION public.fleet_workdays(date, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fleet_workdays(date, date, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
