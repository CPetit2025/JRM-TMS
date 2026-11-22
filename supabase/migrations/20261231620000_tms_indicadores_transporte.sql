-- Fases 8 de Transporte (diagnóstico 20-11-2026, sección F): indicadores sobre el marco kpi_eq_* (ficha, detalle,
-- correcciones, cierres y exportación). Sin metas nuevas: los indicadores nuevos son informativos (meta NULL) hasta
-- que se aprueben. D6 (ocupación) deja de estar pendiente: se calcula por peso con la cobertura a la vista.
-- «No calculable» (hay registros pero ninguno con dato) se separa de «sin registros» (no hubo registros).

-- 1. Estados honestos
DO $m$
DECLARE def text; a text := '    WHEN s.n_con = 0 OR s.sd = 0 THEN ''SIN_REGISTROS''';
BEGIN
  def := pg_get_functiondef('public.kpi_eq_valor(text, date, date)'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'kpi_eq_valor cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, '    WHEN s.n = 0 THEN ''SIN_REGISTROS''
    WHEN s.n_con = 0 OR s.sd = 0 THEN ''NO_CALCULABLE''');
END $m$;

-- 2. Catálogo
INSERT INTO public.kpi_eq_def (codigo,equipo,nombre,descripcion,formula,fuente,unidad,factor,sentido,meta,tolerancia,cobertura_min,responsable,frecuencias,tipo,estado_datos,nota_datos,vigente_desde,orden) VALUES
 ('D7','DESPACHO','OTIF: a tiempo y completa','Entrega a tiempo (llegada el día comprometido original o antes) y completa (guía validada, sin rechazo total ni parcial), las dos a la vez.',
  'Solicitudes con llegada ≤ día comprometido original Y guía validada sin rechazo ÷ solicitudes con llegada (más las vencidas sin llegada) × 100',
  'delivery_conformities, transport_requests.committed_date y delivery_rejections (missing_lines)','%',100,'MAYOR',NULL,5,0,'Supervisor de Despacho',
  '{SEMANAL,MENSUAL}','PERIODO','ACTIVO','Una llegada sin guía validada ni rechazo aún no se juzga como completa (baja la cobertura). Nunca es el promedio de puntualidad y completitud.',NULL,170),
 ('D8','DESPACHO','Cierre documentario completo','Viajes cerrados cuya documentación quedó completa.',
  'Viajes con todas sus solicitudes en cierre documentario COMPLETO ÷ viajes con cierre operativo × 100','documentary_closures y dispatches.operational_closed_at',
  '%',100,'MAYOR',NULL,5,0,'Asistente Documentario','{SEMANAL,MENSUAL}','PERIODO','ACTIVO',NULL,NULL,180),
 ('T7','TRANSPORTE','Incidencias en ruta por 100 viajes','Incidencias reportadas desde la app o la oficina, con su causa confirmada (filtre por causa en el detalle).',
  'Incidencias del periodo ÷ viajes que salieron en el periodo × 100','route_incidents y kpi_despachos_v',
  'por 100 viajes',100,'MENOR',NULL,5,0,'Supervisor de Transporte','{QUINCENAL,MENSUAL}','PERIODO','ACTIVO',
  'Las incidencias sin causa confirmada aparecen como SIN_CONFIRMAR. Antes del 21-11-2026 las incidencias eran texto libre y no se cuentan.',NULL,70),
 ('T8','TRANSPORTE','Costo directo por km (flota propia)','Gastos de viaje aprobados (combustible, peajes, viáticos) por km medido con odómetro.',
  'Σ gastos aprobados del viaje ÷ Σ km por odómetro, viajes propios cerrados sin gastos pendientes','dispatch_expenses (APROBADO) y dispatches (km ODOMETRO)',
  'S/ por km',1,'MENOR',NULL,5,80,'Supervisor de Transporte','{MENSUAL}','PERIODO','PARCIAL',
  'Importe del comprobante tal como se aprobó. Un viaje sin km por odómetro, sin gastos aprobados o con gastos pendientes no tiene dato. No incluye mantenimiento ni alquiler.',NULL,80),
 ('T9','TRANSPORTE','Costo por viaje de terceros','Flete final por viaje tercerizado (soles, sin IGV); la factura del transportista se muestra aparte.',
  'Σ flete final ÷ viajes de terceros con flete final registrado','dispatch_freight_stages.final_pen y dispatch_freight_invoices',
  'S/ por viaje',1,'MENOR',NULL,5,0,'Supervisor de Transporte','{MENSUAL}','PERIODO','ACTIVO','Un viaje sin flete final registrado no tiene dato.',NULL,85),
 ('T10','TRANSPORTE','Viajes con km por odómetro','Calidad del dato de km: viajes propios cerrados con odómetro de salida y llegada con foto. El control con GPS se ve en el detalle.',
  'Viajes propios cerrados con km por odómetro ÷ viajes propios cerrados × 100','dispatches.actual_distance_source y km_check',
  '%',100,'MAYOR',NULL,5,0,'Supervisor de Transporte','{QUINCENAL,MENSUAL}','PERIODO','ACTIVO','El odómetro con foto es obligatorio desde el 21-11-2026.',NULL,90)
ON CONFLICT (codigo) DO NOTHING;

UPDATE public.kpi_eq_def SET formula = 'Σ kg declarados de las solicitudes del viaje ÷ Σ capacidad en kg de la unidad × 100 (viajes propios que salieron)',
  fuente = 'transport_requests.estimated_weight y vehicles.capacity_weight', estado_datos = 'PARCIAL', cobertura_min = 80,
  nota_datos = 'Un viaje con alguna solicitud sin peso no tiene dato. El volumen no se registra.', updated_at = now()
WHERE codigo = 'D6' AND estado_datos = 'PENDIENTE_CAPTURA';

-- 3. Filas de cada indicador (se agregan ramas a kpi_eq_filas)
DO $m$
DECLARE def text; a text := E'  END IF;\n  -- T2, D6, I1, I2, A2, A3:';
BEGIN
  def := pg_get_functiondef('public.kpi_eq_filas(text, date, date)'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'kpi_eq_filas cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, $r$
  ELSIF p_codigo = 'D6' THEN
    RETURN QUERY
    WITH v AS (
      SELECT k.id, k.numero, k.placa, k.salida_at, k.driver_id,
        (SELECT NULLIF(coalesce(ve.capacity_weight, ve.weight_capacity), 0) FROM public.vehicles ve WHERE upper(btrim(ve.plate)) = upper(btrim(k.placa)) LIMIT 1) AS cap,
        (SELECT sum(NULLIF(t.estimated_weight, 0)) FROM public.dispatch_requests q JOIN public.transport_requests t ON t.id = q.transport_request_id WHERE q.dispatch_id = k.id) AS kg,
        (SELECT count(*) FROM public.dispatch_requests q JOIN public.transport_requests t ON t.id = q.transport_request_id WHERE q.dispatch_id = k.id AND coalesce(t.estimated_weight, 0) <= 0) AS sin_peso,
        upper(coalesce(to_jsonb(d) ->> 'modalidad', 'PROPIA')) AS modalidad
      FROM public.kpi_despachos_v k JOIN public.dispatches d ON d.id = k.id
      WHERE k.estado <> 'CANCELADO' AND k.salida_at >= t0 AND k.salida_at < t1)
    SELECT v.id::text, (v.salida_at AT TIME ZONE 'America/Lima')::date, coalesce(v.numero, '') || ' · ' || coalesce(v.placa, ''),
           coalesce(v.kg, 0), coalesce(v.cap, 0), v.cap IS NOT NULL AND v.kg IS NOT NULL AND v.sin_peso = 0,
           (SELECT r.profile_id FROM public.drivers r WHERE r.id = v.driver_id),
           jsonb_build_object('placa', v.placa, 'kg', v.kg, 'capacidad_kg', v.cap, 'solicitudes_sin_peso', v.sin_peso)
    FROM v WHERE v.modalidad = 'PROPIA' AND coalesce(v.placa, 'EXTERNO') <> 'EXTERNO';

  ELSIF p_codigo = 'D7' THEN
    RETURN QUERY
    WITH e AS (SELECT c.request_id, min(c.arrived_at) AS llegada, bool_or(upper(c.state) = 'VALIDADA') AS validada
               FROM public.delivery_conformities c WHERE c.arrived_at IS NOT NULL GROUP BY c.request_id),
    x AS (SELECT t.id, t.request_number, t.request_type, e.llegada, e.validada, public.kpi_uuid(to_jsonb(t) ->> 'client_id') AS cliente,
            coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date) AS comprometido,
            (SELECT CASE WHEN bool_or(upper(j.kind) = 'TOTAL') THEN 'TOTAL' WHEN count(*) > 0 THEN 'PARCIAL' END FROM public.delivery_rejections j WHERE j.request_id = t.id) AS rechazo
          FROM e JOIN public.transport_requests t ON t.id = e.request_id
          WHERE e.llegada >= t0 AND e.llegada < t1 AND t.required_date IS NOT NULL AND upper(coalesce(t.status, '')) <> 'CANCELADA')
    SELECT x.id::text, (x.llegada AT TIME ZONE 'America/Lima')::date, coalesce(x.request_number, '')::text,
           CASE WHEN (x.llegada AT TIME ZONE 'America/Lima')::date <= x.comprometido AND x.validada AND x.rechazo IS NULL THEN 1 ELSE 0 END::numeric,
           1::numeric, x.validada OR x.rechazo IS NOT NULL, NULL::uuid,
           jsonb_build_object('a_tiempo', (x.llegada AT TIME ZONE 'America/Lima')::date <= x.comprometido,
             'completa', CASE WHEN x.rechazo IS NOT NULL THEN false WHEN x.validada THEN true END, 'rechazo', coalesce(x.rechazo, 'NINGUNO'),
             'comprometido', x.comprometido, 'llegada', x.llegada, 'tipo', x.request_type,
             'cliente', (SELECT cl.business_name FROM public.clients cl WHERE cl.id = x.cliente))
    FROM x
    UNION ALL
    -- Vencidas sin llegada: no son a tiempo (mismo criterio que D1)
    SELECT t.id::text, coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date), (coalesce(t.request_number, '') || ' · sin entregar')::text,
           0::numeric, 1::numeric, true, NULL::uuid,
           jsonb_build_object('a_tiempo', false, 'completa', false, 'rechazo', 'NINGUNO', 'estado', t.status, 'tipo', t.request_type,
             'comprometido', coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date),
             'cliente', (SELECT cl.business_name FROM public.clients cl WHERE cl.id = public.kpi_uuid(to_jsonb(t) ->> 'client_id')))
    FROM public.transport_requests t
    WHERE coalesce(t.committed_date, (t.required_date AT TIME ZONE 'America/Lima')::date) BETWEEN p_desde AND LEAST(p_hasta, public.kpi_eq_hoy() - 1)
      AND upper(coalesce(t.status, '')) NOT IN ('CANCELADA','ENTREGADA')
      AND NOT EXISTS (SELECT 1 FROM public.delivery_conformities c WHERE c.request_id = t.id AND c.arrived_at IS NOT NULL);

  ELSIF p_codigo = 'D8' THEN
    RETURN QUERY
    WITH v AS (SELECT d.id, d.dispatch_number, d.vehicle_plate, coalesce(d.operational_closed_at, d.returned_at) AS cierre,
        (SELECT count(*) FROM public.documentary_closures c WHERE c.dispatch_id = d.id) AS n,
        (SELECT count(*) FROM public.documentary_closures c WHERE c.dispatch_id = d.id AND c.status = 'COMPLETO') AS ok
      FROM public.dispatches d WHERE coalesce(d.operational_closed_at, d.returned_at) >= t0 AND coalesce(d.operational_closed_at, d.returned_at) < t1 AND d.status <> 'CANCELADO')
    SELECT v.id::text, (v.cierre AT TIME ZONE 'America/Lima')::date, coalesce(v.dispatch_number, '') || ' · ' || coalesce(v.vehicle_plate, ''),
           CASE WHEN v.n > 0 AND v.ok = v.n THEN 1 ELSE 0 END::numeric, 1::numeric, true, NULL::uuid,
           jsonb_build_object('placa', v.vehicle_plate, 'documentos_completos', v.ok, 'documentos', v.n)
    FROM v;

  ELSIF p_codigo = 'T7' THEN
    RETURN QUERY
    SELECT i.id::text, (i.occurred_at AT TIME ZONE 'America/Lima')::date, i.category || ' · ' || coalesce(d.dispatch_number, ''), 1::numeric, 0::numeric, true, i.reported_by,
           jsonb_build_object('categoria', i.category, 'causa_confirmada', coalesce(i.confirmed_cause, 'SIN_CONFIRMAR'),
             'causa_reportada', coalesce(i.reported_cause, 'NO_INDICADA'), 'estado', i.status, 'placa', d.vehicle_plate)
    FROM public.route_incidents i JOIN public.dispatches d ON d.id = i.dispatch_id WHERE i.occurred_at >= t0 AND i.occurred_at < t1
    UNION ALL
    SELECT k.id::text, (k.salida_at AT TIME ZONE 'America/Lima')::date, coalesce(k.numero, '') || ' · salida', 0::numeric, 1::numeric, true, NULL::uuid,
           jsonb_build_object('placa', k.placa)
    FROM public.kpi_despachos_v k WHERE k.estado <> 'CANCELADO' AND k.salida_at >= t0 AND k.salida_at < t1;

  ELSIF p_codigo IN ('T8','T10') THEN
    RETURN QUERY
    WITH v AS (SELECT d.id, d.dispatch_number, d.vehicle_plate, d.driver_id, d.km_check, coalesce(d.operational_closed_at, d.returned_at) AS cierre,
        CASE WHEN d.actual_distance_source = 'ODOMETRO' THEN NULLIF(d.actual_distance_km, 0) END AS km,
        (SELECT sum(coalesce(e.approved_amount, e.amount)) FROM public.dispatch_expenses e WHERE e.dispatch_id = d.id AND e.status = 'APROBADO') AS costo,
        (SELECT count(*) FROM public.dispatch_expenses e WHERE e.dispatch_id = d.id AND e.status IN ('PENDIENTE','OBSERVADO')) AS pendientes
      FROM public.dispatches d
      WHERE public.dispatch_is_own_unit(d) AND d.status <> 'CANCELADO'
        AND coalesce(d.operational_closed_at, d.returned_at) >= t0 AND coalesce(d.operational_closed_at, d.returned_at) < t1)
    SELECT v.id::text, (v.cierre AT TIME ZONE 'America/Lima')::date, coalesce(v.dispatch_number, '') || ' · ' || coalesce(v.vehicle_plate, ''),
           CASE WHEN p_codigo = 'T8' THEN coalesce(v.costo, 0) ELSE CASE WHEN v.km IS NOT NULL THEN 1 ELSE 0 END END::numeric,
           CASE WHEN p_codigo = 'T8' THEN coalesce(v.km, 0) ELSE 1 END::numeric,
           CASE WHEN p_codigo = 'T8' THEN v.km IS NOT NULL AND v.costo IS NOT NULL AND v.pendientes = 0 ELSE true END,
           (SELECT r.profile_id FROM public.drivers r WHERE r.id = v.driver_id),
           jsonb_build_object('placa', v.vehicle_plate, 'km_odometro', v.km, 'control_gps', coalesce(v.km_check, 'SIN_ODOMETRO'),
             'costo_aprobado', v.costo, 'gastos_pendientes', v.pendientes)
    FROM v;

  ELSIF p_codigo = 'T9' THEN
    RETURN QUERY
    SELECT d.id::text, (d.scheduled_departure AT TIME ZONE 'America/Lima')::date, coalesce(d.dispatch_number, '') || ' · ' || coalesce(d.vehicle_plate, ''),
           coalesce(s.final_pen, 0)::numeric, 1::numeric, s.final_pen IS NOT NULL, NULL::uuid,
           jsonb_build_object('placa', d.vehicle_plate, 'flete_acordado', s.agreed_pen, 'flete_final', s.final_pen,
             'facturado_sin_igv_pen', (SELECT sum(f.base_pen) FROM public.dispatch_freight_invoices f WHERE f.dispatch_id = d.id AND f.voided_at IS NULL))
    FROM public.dispatches d LEFT JOIN public.dispatch_freight_stages s ON s.dispatch_id = d.id
    WHERE upper(coalesce(to_jsonb(d) ->> 'modalidad', '')) = 'TERCERO' AND d.status NOT IN ('CANCELADO','PROGRAMADO')
      AND d.scheduled_departure >= t0 AND d.scheduled_departure < t1;
  END IF;
  -- T2, I1, I2, A2, A3:$r$);
END $m$;

-- 4. El factor del indicador viaja a la ficha: los desgloses calculan con el mismo factor que el tablero
DO $m$
DECLARE def text; a text := '''unidad'', d.unidad,';
BEGIN
  def := pg_get_functiondef('public.kpi_eq_def_json(public.kpi_eq_def)'::regprocedure);
  IF position('''factor''' IN def) > 0 THEN RETURN; END IF;
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'kpi_eq_def_json cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, '''unidad'', d.unidad, ''factor'', d.factor,');
END $m$;
