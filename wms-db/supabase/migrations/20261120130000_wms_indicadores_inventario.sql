-- Inventario y Logística Inversa · Fase 7: modelo analítico (solo lectura). Mismas reglas que Despacho: numerador,
-- denominador, n, universo y fecha base explícitos; NO_CALCULABLE (denominador 0) y SIN_REGISTROS; peso desconocido no
-- es 0; saldos al corte y flujos del período no se mezclan; fechas en hora de Lima.
-- Filtros: cliente (texto), ot, motivo, condition, disposition.
-- Volátil: usa tablas temporales de trabajo (solo lectura de datos)
CREATE OR REPLACE FUNCTION public.wh_inventory_kpis(p_from date, p_to date, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f jsonb := coalesce(p_filters, '{}'::jsonb); out jsonb := '[]'::jsonb; r record;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Período no válido (máximo 400 días)'; END IF;

  -- Universo de retornos filtrado
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.k_ret ON COMMIT DROP AS SELECT * FROM public.wh_returns WITH NO DATA;
  TRUNCATE pg_temp.k_ret;
  INSERT INTO pg_temp.k_ret SELECT * FROM public.wh_returns x WHERE public.can_access_site(x.site_id)
    AND (nullif(f->>'cliente', '') IS NULL OR upper(coalesce(x.cliente, '')) LIKE '%' || upper(f->>'cliente') || '%')
    AND (nullif(f->>'ot', '') IS NULL OR x.ot = f->>'ot') AND (nullif(f->>'motivo', '') IS NULL OR x.motivo = f->>'motivo');

  -- R1 Documentos y R2 toneladas devueltas (ingresos del ERP en el período; las bajas del ERP no cuentan)
  SELECT count(DISTINCT x.id) docs, count(l.id) n, sum(l.kg_declared) kg, count(l.id) FILTER (WHERE l.kg_declared IS NULL) sin_peso, count(l.id) FILTER (WHERE l.erp_state = 'BAJA_ERP') bajas INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id AND l.erp_state <> 'BAJA_ERP'
  WHERE x.source = 'ERP' AND x.fecha BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('R1', 'Retornos', 'Documentos de devolución', 'doc', r.docs, NULL, r.docs, 'Guías de recojo en alcance con ingreso en el período', 'Fecha del ingreso ERP',
    jsonb_build_object('lineas', r.n));
  out := out || wms_private.wh_kpi('R2', 'Retornos', 'Toneladas devueltas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Líneas de guías de recojo del período (peso del ERP o del maestro)', 'Fecha del ingreso ERP',
    jsonb_build_object('sin_peso', r.sin_peso));

  -- R3 Diferencia anunciado-recibido (líneas recibidas del período)
  SELECT count(*) n, sum(l.qty_received - l.qty_declared) FILTER (WHERE l.qty_received IS NOT NULL) dif, count(*) FILTER (WHERE l.qty_received <> l.qty_declared) con_dif INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id WHERE (l.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('R3', 'Retornos', 'Líneas recibidas con diferencia', '%', r.con_dif, r.n, r.n, 'Líneas con cantidad recibida distinta de la declarada / líneas recibidas en el período', 'Recepción física',
    jsonb_build_object('diferencia_neta_unidades', r.dif));

  -- R4 Pendiente de clasificación (corte: recibido sin inspección completa)
  SELECT count(*) n, sum(coalesce(l.kg_received, l.kg_declared) * (l.qty_received - coalesce(fx.q, 0)) / nullif(l.qty_received, 0)) kg INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id
  LEFT JOIN LATERAL (SELECT sum(qty) q FROM public.wh_return_fractions WHERE line_id = l.id) fx ON true
  WHERE x.status <> 'CERRADO' AND l.qty_received > coalesce(fx.q, 0);
  out := out || wms_private.wh_kpi('R4', 'Retornos', 'Pendiente de clasificación', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Líneas recibidas aún sin inspeccionar por completo', 'Corte: ahora');

  -- R5 Tiempo de clasificación y R6 tiempo de decisión (mediana, p90)
  SELECT count(*) n, percentile_cont(0.5) WITHIN GROUP (ORDER BY h) p50, percentile_cont(0.9) WITHIN GROUP (ORDER BY h) p90 INTO r FROM (
    SELECT extract(epoch FROM min(fr.inspected_at) - l.received_at) / 3600 h FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id JOIN public.wh_return_fractions fr ON fr.line_id = l.id
    GROUP BY l.id, l.received_at HAVING (min(fr.inspected_at) AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) s;
  out := out || wms_private.wh_kpi('R5', 'Retornos', 'Tiempo de clasificación (mediana)', 'h', NULL, NULL, r.n, 'Líneas con primera inspección en el período (recepción → inspección)', 'Inspección',
    jsonb_build_object('p50', round(r.p50::numeric, 1), 'p90', round(r.p90::numeric, 1)), round(r.p50::numeric, 1));
  SELECT count(*) n, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fr.authorized_at - fr.inspected_at) / 3600) p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM fr.authorized_at - fr.inspected_at) / 3600) p90 INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id JOIN public.wh_return_fractions fr ON fr.line_id = l.id
  WHERE fr.disposition_status IN ('AUTORIZADA','EJECUTADA','VERIFICADA') AND (fr.authorized_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
    AND (nullif(f->>'disposition', '') IS NULL OR fr.disposition = f->>'disposition');
  out := out || wms_private.wh_kpi('R6', 'Retornos', 'Tiempo de decisión (mediana)', 'h', NULL, NULL, r.n, 'Fracciones con disposición autorizada en el período (inspección → autorización)', 'Autorización',
    jsonb_build_object('p50', round(r.p50::numeric, 1), 'p90', round(r.p90::numeric, 1)), round(r.p50::numeric, 1));

  -- R7 Recuperación por cohorte: kg reincorporados o recuperados verificados / kg recibidos (retornos recibidos en el período)
  SELECT sum(l.kg_received) den, count(l.id) n, count(l.id) FILTER (WHERE l.kg_received IS NULL) sin_peso,
         (SELECT coalesce(sum(fr.kg), 0) FROM public.wh_return_fractions fr JOIN public.wh_return_lines l2 ON l2.id = fr.line_id JOIN pg_temp.k_ret x2 ON x2.id = l2.return_id
           WHERE fr.disposition IN ('REINCORPORAR','ACONDICIONAR') AND fr.disposition_status = 'VERIFICADA' AND (l2.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)
         -- Recuperado de reproceso asignado a cada fracción de entrada según su masa, y contado solo si su línea es de la cohorte
         + (SELECT coalesce(sum(o.kg_recovered * i3.kg / nullif((SELECT sum(i4.kg) FROM public.wh_reprocess_inputs i4 WHERE i4.order_id = o.id), 0)), 0) FROM public.wh_reprocess_orders o JOIN public.wh_reprocess_inputs i3 ON i3.order_id = o.id
              JOIN public.wh_return_fractions fr3 ON fr3.id = i3.fraction_id JOIN public.wh_return_lines l3 ON l3.id = fr3.line_id JOIN pg_temp.k_ret x3 ON x3.id = l3.return_id
            WHERE o.status = 'VERIFICADA' AND i3.kg > 0
              AND (l3.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) num,
         (SELECT count(*) FROM pg_temp.k_ret x4 WHERE x4.status <> 'CERRADO' AND EXISTS (SELECT 1 FROM public.wh_return_lines l4 WHERE l4.return_id = x4.id AND (l4.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to)) abiertos INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id WHERE (l.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('R7', 'Retornos', 'Recuperación por cohorte', '%', r.num, coalesce(r.den, 0), r.n, 'kg reincorporados o recuperados verificados / kg recibidos de los retornos recibidos en el período', 'Cohorte de recepción',
    jsonb_build_object('expedientes_abiertos', r.abiertos, 'sin_peso', r.sin_peso));

  -- R8 Cumplimiento de plazo y R9 regularización pendiente
  SELECT count(*) FILTER (WHERE (x.due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) n,
         count(*) FILTER (WHERE (x.due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to AND x.closed_at IS NOT NULL AND x.closed_at <= x.due_at) ok,
         count(*) FILTER (WHERE x.due_at < now() AND x.status NOT IN ('RESUELTO','CERRADO')) vencidos INTO r FROM pg_temp.k_ret x;
  out := out || wms_private.wh_kpi('R8', 'Retornos', 'Cumplimiento de plazo', '%', r.ok, r.n, r.n, 'Expedientes cerrados a tiempo / expedientes con compromiso en el período', 'Compromiso',
    jsonb_build_object('abiertos_vencidos', r.vencidos));
  SELECT count(DISTINCT x.id) n, sum(l.kg_declared) kg, count(l.id) FILTER (WHERE l.kg_declared IS NULL) sin_peso INTO r
  FROM pg_temp.k_ret x JOIN public.wh_return_lines l ON l.return_id = x.id
  WHERE x.status <> 'CERRADO' AND (x.source = 'NO_ANUNCIADO' OR l.producto IS NULL OR EXISTS (SELECT 1 FROM public.wh_return_fractions fr WHERE fr.line_id = l.id AND fr.condition = 'NO_IDENTIFICADO'));
  out := out || wms_private.wh_kpi('R9', 'Pendientes', 'Regularización pendiente', 'exp', r.n, NULL, r.n, 'Expedientes abiertos no anunciados o con material no identificado', 'Corte: ahora',
    jsonb_build_object('kg', r.kg, 'sin_peso', r.sin_peso));

  -- P1 Trabajo en proceso, P2 rendimiento y P3 repetición de reproceso
  SELECT count(*) n, sum(o.kg_input + o.kg_added) kg INTO r FROM public.wh_reprocess_orders o JOIN pg_temp.k_ret x ON x.id = o.return_id WHERE o.status IN ('ABIERTA','EN_PROCESO','EN_PAUSA');
  out := out || wms_private.wh_kpi('P1', 'Reprocesos', 'Trabajo en proceso', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Órdenes de reproceso abiertas, en proceso o en pausa', 'Corte: ahora');
  SELECT count(*) n, sum(o.kg_recovered) num, sum(o.kg_input + o.kg_added) den, count(*) FILTER (WHERE o.cycle > 1) ciclos INTO r
  FROM public.wh_reprocess_orders o JOIN pg_temp.k_ret x ON x.id = o.return_id WHERE o.status = 'VERIFICADA' AND (o.verified_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('P2', 'Reprocesos', 'Rendimiento de reproceso', '%', coalesce(r.num, 0), coalesce(r.den, 0), r.n, 'kg recuperados verificados / (kg de entrada + insumos) de órdenes verificadas en el período', 'Verificación');
  out := out || wms_private.wh_kpi('P3', 'Reprocesos', 'Repetición de tratamiento', '%', r.ciclos, r.n, r.n, 'Órdenes de segundo ciclo o más / órdenes verificadas en el período', 'Verificación');

  -- B1 Bajas efectivas (ejecutadas; la propuesta no cuenta)
  SELECT count(*) n, sum(fr.kg) kg INTO r FROM public.wh_return_fractions fr JOIN public.wh_return_lines l ON l.id = fr.line_id JOIN pg_temp.k_ret x ON x.id = l.return_id
  WHERE fr.disposition = 'BAJA' AND fr.disposition_status IN ('EJECUTADA','VERIFICADA') AND (fr.executed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('B1', 'Retornos', 'Bajas efectivas', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Fracciones con baja autorizada y ejecutada en el período', 'Ejecución');

  -- C1 Exactitud de registros (tolerancia 0), C2 diferencias y C3 ajustes
  SELECT count(*) n, count(*) FILTER (WHERE rr.result = 'CUADRA') ok, sum(abs(rr.counted_qty - rr.expected_qty)) abs_dif, sum(rr.counted_qty - rr.expected_qty) dif INTO r
  FROM public.wh_count_results rr JOIN public.wh_count_campaigns c ON c.id = rr.campaign_id
  WHERE public.can_access_site(c.site_id) AND c.status = 'CERRADA' AND (c.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('C1', 'Inventario', 'Exactitud de registros (tolerancia 0)', '%', r.ok, r.n, r.n, 'Producto-lote que cuadran / producto-lote contados en campañas cerradas en el período', 'Cierre de campaña');
  out := out || wms_private.wh_kpi('C2', 'Inventario', 'Diferencia absoluta de conteo', 'und', r.abs_dif, NULL, r.n, 'Suma de |contado − esperado| por producto-lote (sin compensar faltantes con sobrantes)', 'Cierre de campaña',
    jsonb_build_object('diferencia_firmada', r.dif));
  SELECT count(*) n, count(*) FILTER (WHERE a.status IN ('AUTORIZADO','REGISTRADO_ERP')) aut, count(*) FILTER (WHERE a.status = 'AUTORIZADO') sin_erp, sum(abs(a.diff_qty)) FILTER (WHERE a.status IN ('AUTORIZADO','REGISTRADO_ERP')) mag INTO r
  FROM public.wh_adjustments a WHERE public.can_access_site(a.site_id) AND (a.requested_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to;
  out := out || wms_private.wh_kpi('C3', 'Inventario', 'Ajustes autorizados', 'aj', r.aut, NULL, r.n, 'Ajustes solicitados en el período y autorizados (un ajuste no es necesariamente pérdida)', 'Solicitud',
    jsonb_build_object('solicitados', r.n, 'pendientes_erp', r.sin_erp, 'magnitud_unidades', r.mag));

  -- E1 Existencias por condición (corte) y E2 calidad de identificación
  SELECT count(*) n, sum(w.kg) FILTER (WHERE p.hold_status IS NULL AND NOT p.count_hold AND p.task_id IS NULL AND p.status = 'AVAILABLE') disp,
         sum(w.kg) FILTER (WHERE p.hold_status IS NOT NULL OR p.count_hold) bloq, sum(w.kg) FILTER (WHERE p.hold_status = 'CUARENTENA' AND p.source_kind = 'RETORNO') cuar,
         sum(w.kg) kg, count(*) FILTER (WHERE w.kg IS NULL) sin_peso, count(*) FILTER (WHERE p.location_id IS NOT NULL) ubicados INTO r
  FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w WHERE p.status NOT IN ('VOID','LOADED') AND public.can_access_site(p.site_id);
  out := out || wms_private.wh_kpi('E1', 'Inventario', 'Existencia física en el WMS', 't', round(coalesce(r.kg, 0) / 1000, 3), NULL, r.n, 'Paquetes vigentes no cargados', 'Corte: ahora',
    jsonb_build_object('disponible_t', round(coalesce(r.disp, 0) / 1000, 3), 'bloqueado_t', round(coalesce(r.bloq, 0) / 1000, 3), 'retornos_en_cuarentena_t', round(coalesce(r.cuar, 0) / 1000, 3), 'sin_peso', r.sin_peso));
  out := out || wms_private.wh_kpi('E2', 'Pendientes', 'Paquetes con ubicación registrada', '%', r.ubicados, r.n, r.n, 'Paquetes vigentes con ubicación / paquetes vigentes', 'Corte: ahora');

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'filters', f, 'generated_at', now(), 'kpis', out);
END $$;

-- Detalle para desglosar los indicadores de retornos, reprocesos, conteos y ajustes
CREATE OR REPLACE FUNCTION public.wh_inventory_kpi_detail(p_code text, p_from date, p_to date, p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c text := upper(btrim(p_code)); f jsonb := coalesce(p_filters, '{}'::jsonb);
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF c IN ('C1','C2') THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('campana', cc.code, 'bodega', cc.bodega, 'producto', rr.cod_producto, 'lote', rr.lote_key, 'esperado', rr.expected_qty, 'contado', rr.counted_qty,
        'diferencia', rr.counted_qty - rr.expected_qty, 'resultado', rr.result, 'motivo', rr.reason, 'cerrada', cc.closed_at) ORDER BY cc.closed_at DESC)
      FROM public.wh_count_results rr JOIN public.wh_count_campaigns cc ON cc.id = rr.campaign_id
      WHERE public.can_access_site(cc.site_id) AND cc.status = 'CERRADA' AND (cc.closed_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to LIMIT 1000), '[]'::jsonb);
  ELSIF c = 'C3' THEN RETURN (public.wh_adjustments_list(NULL))->'adjustments';
  ELSIF c IN ('P1','P2','P3') THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('orden', o.code, 'expediente', r.code, 'ciclo', o.cycle, 'estado', o.status, 'ejecutor', coalesce(o.executor_name, o.executor_type),
        'kg_entrada', o.kg_input, 'kg_insumos', o.kg_added, 'kg_recuperado', o.kg_recovered, 'kg_residuo', o.kg_waste, 'kg_en_proceso', o.kg_in_process, 'diferencia', o.kg_diff, 'explicacion', o.diff_note,
        'verificada', o.verified_at) ORDER BY o.created_at DESC)
      FROM public.wh_reprocess_orders o JOIN public.wh_returns r ON r.id = o.return_id WHERE public.can_access_site(o.site_id)
        AND (c = 'P1' AND o.status IN ('ABIERTA','EN_PROCESO','EN_PAUSA') OR c <> 'P1' AND o.status = 'VERIFICADA' AND (o.verified_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to) LIMIT 1000), '[]'::jsonb);
  ELSE
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('expediente', r.code, 'origen', r.source, 'guia', r.numero, 'fecha', r.fecha, 'cliente', r.cliente, 'ot', r.ot, 'motivo', r.motivo, 'estado', r.status,
        'producto', l.producto, 'unidad', l.unidad, 'declarado', l.qty_declared, 'recibido', l.qty_received, 'kg', coalesce(l.kg_received, l.kg_declared), 'peso', l.peso_origen, 'erp', l.erp_state) ORDER BY r.fecha DESC NULLS FIRST, r.code)
      FROM public.wh_returns r JOIN public.wh_return_lines l ON l.return_id = r.id
      WHERE public.can_access_site(r.site_id) AND (nullif(f->>'ot', '') IS NULL OR r.ot = f->>'ot') AND (nullif(f->>'motivo', '') IS NULL OR r.motivo = f->>'motivo')
        AND CASE WHEN c IN ('R4','R9') THEN r.status <> 'CERRADO' WHEN c IN ('R3','R5','R7') THEN (l.received_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to
                 WHEN c = 'R8' THEN (r.due_at AT TIME ZONE 'America/Lima')::date BETWEEN p_from AND p_to ELSE r.fecha BETWEEN p_from AND p_to END LIMIT 1000), '[]'::jsonb);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.wh_inventory_kpis(date, date, jsonb), public.wh_inventory_kpi_detail(text, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_inventory_kpis(date, date, jsonb), public.wh_inventory_kpi_detail(text, date, date, jsonb) TO authenticated;
