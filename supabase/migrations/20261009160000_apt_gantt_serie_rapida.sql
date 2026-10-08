-- Gantt APT: la serie de saldo se calculaba con una subconsulta por cada punto del gráfico (~120) sobre todo el
-- movimiento; con la data completa superaba el statement_timeout de authenticated (8 s) y la web mostraba
-- "canceling statement due to statement timeout". Se reemplaza por un acumulado por fecha calculado una vez.
-- Mismo resultado: el saldo de cada punto suma los movimientos sin fecha más los de fecha <= punto.
BEGIN;
CREATE OR REPLACE FUNCTION public.apt_gantt(p jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_cut date; v_from date; v_to date; v_alert integer; v_tol numeric;
  v_limit integer := LEAST(50,GREATEST(1,COALESCE(p_limit,25))); v_offset integer := GREATEST(0,COALESCE(p_offset,0));
  v_rows jsonb; v_kpi jsonb; v_priority jsonb; v_series jsonb; v_coverage jsonb; v_total integer; v_max date; v_last_upload timestamptz; v_pending boolean;
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
  p := COALESCE(p,'{}');
  SELECT * INTO st FROM public.apt_flow_state WHERE id=1;
  SELECT max(applied_at) INTO v_last_upload FROM public.apt_uploads WHERE status='APLICADA';
  v_pending := COALESCE(v_last_upload>st.rebuilt_at,v_last_upload IS NOT NULL);
  SELECT max(fecha) INTO v_max FROM public.apt_movements WHERE active AND valid;
  SELECT COALESCE(alert_days,60),COALESCE(tolerance,0.02) INTO v_alert,v_tol FROM public.apt_settings WHERE id=1;
  v_alert := COALESCE(v_alert,60); v_tol := COALESCE(v_tol,0.02);
  IF st.cutoff IS NULL THEN
    RETURN jsonb_build_object('success',true,'vacio',true,'cutoff',NULL,'data_min',NULL,'data_max',v_max,'model_cutoff',NULL,'requested_cutoff',NULLIF(p->>'corte',''),'age_basis','ORIGEN','desde',NULL,'hasta',NULL,'rebuilt_at',st.rebuilt_at,'model_pending',v_pending,'last_upload_at',v_last_upload,
      'alert_days',v_alert,'tolerance',v_tol,'total',0,'limit',v_limit,'offset',v_offset,'filas','[]'::jsonb,'prioridades','[]'::jsonb,'serie','[]'::jsonb,'cobertura','[]'::jsonb,
      'kpis',jsonb_build_object('lotes',0,'ot',0,'abiertas',0,'ingresadas_tn',0,'inicial_tn',0,'asignadas_tn',0,'cedidas_tn',0,'despachadas_tn',0,'saldo_tn',0,'criticas_tn',0,'sin_fecha_tn',0,'edad_ponderada',NULL,'tn_dias',0));
  END IF;
  BEGIN
    v_cut := LEAST(st.cutoff,COALESCE(NULLIF(p->>'corte','')::date,st.cutoff));
    v_from := COALESCE(NULLIF(p->>'desde','')::date,st.data_min);
    v_to := LEAST(v_cut,COALESCE(NULLIF(p->>'hasta','')::date,v_cut));
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN jsonb_build_object('success',false,'error','Fecha inválida');
  END;
  IF v_cut < st.data_min OR v_from > v_to THEN RETURN jsonb_build_object('success',false,'error','Seleccione fechas dentro de la cobertura del modelo'); END IF;
  IF NULLIF(p->>'almacen','') IS NOT NULL AND p->>'almacen' NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén inválido'); END IF;
  IF NULLIF(p->>'estado','') IS NOT NULL AND p->>'estado' NOT IN ('CON_SALDO','PARCIAL','DESPACHADO','SALIDA_NO_ENTREGA','RESIDUAL') THEN RETURN jsonb_build_object('success',false,'error','Estado inválido'); END IF;
  DROP TABLE IF EXISTS pg_temp.apt_gantt_layers,pg_temp.apt_gantt_exits,pg_temp.apt_gantt_rows,pg_temp.apt_gantt_page;
  CREATE TEMP TABLE apt_gantt_layers ON COMMIT DROP AS
    SELECT l.*,GREATEST(l.kg_in-COALESCE(a.kg,0),0) AS saldo_corte,a.ultima_salida,
      public.apt_ot_raiz(l.lote) AS ot
    FROM public.apt_flow_layers l
    LEFT JOIN (SELECT a.layer_id,sum(a.kg) AS kg,max(e.fecha) AS ultima_salida
      FROM public.apt_flow_alloc a JOIN public.apt_flow_exits e ON e.id=a.exit_id WHERE e.fecha<=v_cut GROUP BY a.layer_id) a ON a.layer_id=l.id
    WHERE (l.fecha IS NULL OR l.fecha<=v_cut)
      AND (NULLIF(p->>'ot','') IS NULL OR public.apt_ot_raiz(l.lote)=btrim(p->>'ot'))
      AND (NULLIF(p->>'lote_exacto','') IS NULL OR l.lote=btrim(p->>'lote_exacto'))
      AND (NULLIF(p->>'lote','') IS NULL OR l.lote ILIKE '%'||btrim(p->>'lote')||'%');
  CREATE INDEX ON apt_gantt_layers(lote);
  CREATE TEMP TABLE apt_gantt_exits ON COMMIT DROP AS
    SELECT e.* FROM public.apt_flow_exits e WHERE e.fecha<=v_cut
      AND (NULLIF(p->>'ot','') IS NULL OR public.apt_ot_raiz(e.lote)=btrim(p->>'ot'))
      AND (NULLIF(p->>'lote_exacto','') IS NULL OR e.lote=btrim(p->>'lote_exacto'))
      AND (NULLIF(p->>'lote','') IS NULL OR e.lote ILIKE '%'||btrim(p->>'lote')||'%');
  CREATE INDEX ON apt_gantt_exits(lote);
  CREATE TEMP TABLE apt_gantt_rows ON COMMIT DROP AS
    WITH ly AS (SELECT lote,max(ot) AS ot,max(cliente) AS cliente,count(DISTINCT producto) AS productos,
      sum(kg_in) FILTER(WHERE tipo NOT IN ('TRASPASO','INICIAL')) AS ingreso,
      sum(kg_in) FILTER(WHERE tipo='INICIAL') AS inicial,
      sum(kg_in) FILTER(WHERE tipo='TRASPASO' AND lote_origen IS DISTINCT FROM lote) AS asignado,
      sum(saldo_corte) AS saldo,sum(saldo_corte) FILTER(WHERE fecha IS NULL) AS desconocido,
      min(fecha) AS primera,max(fecha) AS ultima,
      sum(saldo_corte*(v_cut-fecha)) FILTER(WHERE fecha IS NOT NULL) AS age_kg_days,
      sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL) AS age_kg,
      COALESCE(sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL AND v_cut-fecha>=v_alert),0) AS critico_kg,
      bool_or(almacen=COALESCE(NULLIF(p->>'almacen',''),almacen)) AS en_almacen
      FROM apt_gantt_layers GROUP BY lote),
    ex AS (SELECT lote,max(cliente) AS cliente,min(fecha) AS primera,max(fecha) AS ultima,
      sum(kg) FILTER(WHERE tipo='DESPACHO') AS despacho,
      sum(kg) FILTER(WHERE tipo IN ('CONSUMO','OTRO_ALMACEN')) AS otro,
      sum(kg) FILTER(WHERE tipo='TRASPASO' AND lote_destino IS DISTINCT FROM lote) AS cedido,
      min(fecha) FILTER(WHERE tipo='DESPACHO') AS primera_salida FROM apt_gantt_exits GROUP BY lote),
    z AS (SELECT COALESCE(ly.lote,ex.lote) AS lote,COALESCE(ly.ot,public.apt_ot_raiz(ex.lote)) AS ot,
      COALESCE(ly.cliente,ex.cliente) AS cliente,COALESCE(ly.productos,0) AS productos,
      COALESCE(ingreso,0) AS ingreso,COALESCE(inicial,0) AS inicial,COALESCE(asignado,0) AS asignado,
      COALESCE(despacho,0) AS despacho,COALESCE(otro,0) AS otro,COALESCE(cedido,0) AS cedido,
      COALESCE(saldo,0) AS saldo,COALESCE(desconocido,0) AS desconocido,
      LEAST(ly.primera,ex.primera) AS primera,GREATEST(ly.ultima,ex.ultima) AS ultima,ex.primera_salida,
      ly.age_kg_days,ly.age_kg,ly.critico_kg,COALESCE(ly.en_almacen,false) AS en_almacen
      FROM ly FULL JOIN ex USING(lote)),
    classified AS (SELECT z.*,CASE WHEN saldo<=0.0005 THEN CASE WHEN despacho>0 AND otro+cedido=0 THEN 'DESPACHADO' ELSE 'SALIDA_NO_ENTREGA' END
      WHEN saldo<=GREATEST(ingreso+inicial+asignado,0)*v_tol THEN 'RESIDUAL'
      WHEN despacho>0 THEN 'PARCIAL' ELSE 'CON_SALDO' END AS estado,
      (COALESCE(critico_kg,0)>0.0005) AS critico,
      CASE WHEN saldo>0.0005 THEN v_cut-primera ELSE ultima-primera END AS dias,
      round(age_kg_days/NULLIF(age_kg,0),1) AS edad_ponderada,
      round(COALESCE(age_kg_days,0)/1000,3) AS tn_dias FROM z)
    SELECT * FROM classified WHERE (NULLIF(p->>'cliente','') IS NULL OR cliente ILIKE '%'||btrim(p->>'cliente')||'%')
      AND (NULLIF(p->>'almacen','') IS NULL OR en_almacen)
      AND (NULLIF(p->>'estado','') IS NULL OR estado=p->>'estado')
      AND (primera IS NULL OR primera<=v_to) AND (saldo>0.0005 OR ultima>=v_from);
  -- Root composition is persisted only for final circuit exits and current balances.
  -- At the model cut it preserves age through transfers; historical intermediate
  -- balances have no persisted root composition and are explicitly stage age.
  IF v_cut=st.cutoff THEN
    UPDATE apt_gantt_rows r SET
      age_kg_days=a.days_kg,age_kg=a.known_kg,desconocido=a.unknown_kg,
      critico_kg=a.critical_kg,critico=a.critical_kg>0.0005,
      edad_ponderada=round(a.days_kg/NULLIF(a.known_kg,0),1),tn_dias=round(a.days_kg/1000,3)
    FROM (SELECT lote,COALESCE(sum(kg*GREATEST(v_cut-fecha_origen,0)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS days_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS known_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut),0) AS unknown_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND v_cut-fecha_origen>=v_alert),0) AS critical_kg
      FROM public.apt_flow_pieces WHERE es_saldo GROUP BY lote) a WHERE r.lote=a.lote;
  END IF;
  IF COALESCE(p->>'solo_criticos','false')='true' THEN DELETE FROM apt_gantt_rows WHERE NOT critico; END IF;
  SELECT count(*) INTO v_total FROM apt_gantt_rows;
  CREATE TEMP TABLE apt_gantt_page ON COMMIT DROP AS SELECT * FROM apt_gantt_rows ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote LIMIT v_limit OFFSET v_offset;
  SELECT jsonb_build_object('lotes',count(*),'ot',count(DISTINCT ot),'abiertas',count(*) FILTER(WHERE saldo>0.0005),
    'ingresadas_tn',round(COALESCE(sum(ingreso),0)/1000,3),'inicial_tn',round(COALESCE(sum(inicial),0)/1000,3),
    'asignadas_tn',round(COALESCE(sum(asignado),0)/1000,3),'cedidas_tn',round(COALESCE(sum(cedido),0)/1000,3),
    'despachadas_tn',round(COALESCE(sum(despacho),0)/1000,3),'saldo_tn',round(COALESCE(sum(saldo),0)/1000,3),
    'criticas_tn',round(COALESCE(sum(critico_kg),0)/1000,3),'sin_fecha_tn',round(COALESCE(sum(desconocido),0)/1000,3),
    'edad_ponderada',round(sum(age_kg_days)/NULLIF(sum(age_kg),0),1),'tn_dias',COALESCE(sum(tn_dias),0)) INTO v_kpi FROM apt_gantt_rows;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote',lote,'ot',ot,'cliente',cliente,'saldo_tn',round(saldo/1000,3),'dias',dias,'tn_dias',COALESCE(tn_dias,0),
    'motivo',CASE WHEN desconocido>0 THEN 'Saldo con fecha de origen desconocida' WHEN critico THEN 'Permanencia sobre el límite' ELSE 'Saldo pendiente de liberar' END) ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote),'[]')
    INTO v_priority FROM (SELECT * FROM apt_gantt_rows WHERE saldo>0.0005 ORDER BY critico DESC,tn_dias DESC NULLS LAST,lote LIMIT 8) q;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('lote',q.lote,'ot',q.ot,'cliente',q.cliente,'productos',q.productos,
    'ingresadas_tn',round(q.ingreso/1000,3),'inicial_tn',round(q.inicial/1000,3),'asignadas_tn',round(q.asignado/1000,3),'cedidas_tn',round(q.cedido/1000,3),
    'despachadas_tn',round(q.despacho/1000,3),'otras_salidas_tn',round(q.otro/1000,3),'saldo_tn',round(q.saldo/1000,3),'saldo_sin_fecha_tn',round(q.desconocido/1000,3),
    'fecha_entrega_min',pr.min_fecha,'fecha_entrega_max',pr.max_fecha,'fechas_entrega_total',pr.n,
    'primera_fecha',q.primera,'ultima_fecha',q.ultima,'primera_salida',q.primera_salida,'dias',q.dias,'edad_ponderada',q.edad_ponderada,
    'tn_dias',COALESCE(q.tn_dias,0),'estado',q.estado,'critico',q.critico,
    'segmentos_total',sg.n,'segmentos',sg.j,'eventos_total',ev.n,'eventos',ev.j) ORDER BY q.critico DESC,q.tn_dias DESC NULLS LAST,q.lote),'[]')
  INTO v_rows FROM apt_gantt_page q
  CROSS JOIN LATERAL (SELECT min(fecha_entrega) AS min_fecha,max(fecha_entrega) AS max_fecha,count(DISTINCT fecha_entrega) AS n
    FROM public.apt_movements WHERE active AND valid AND lote=q.lote AND fecha<=v_cut) pr
  CROSS JOIN LATERAL (SELECT count(*) AS n,COALESCE(jsonb_agg(j ORDER BY fecha NULLS FIRST,almacen,producto) FILTER(WHERE rn<=120),'[]') AS j
    FROM (SELECT fecha,almacen,producto,row_number() OVER(ORDER BY fecha NULLS FIRST,almacen,producto,tipo,documento) AS rn,
      jsonb_build_object('almacen',almacen,'producto',producto,'tipo',tipo,'desde',fecha,
        'hasta',CASE WHEN sum(saldo_corte)>0.0005 THEN v_cut ELSE COALESCE(max(ultima_salida),fecha,v_cut) END,
        'ingresadas_tn',round(sum(kg_in)/1000,3),'saldo_tn',round(sum(saldo_corte)/1000,3),
        'dias',CASE WHEN fecha IS NULL THEN NULL ELSE (CASE WHEN sum(saldo_corte)>0.0005 THEN v_cut ELSE COALESCE(max(ultima_salida),fecha) END)-fecha END,
        'abierto',sum(saldo_corte)>0.0005,'documento',documento,'precision','FIFO','capas',count(*)) AS j
      FROM apt_gantt_layers WHERE lote=q.lote GROUP BY fecha,almacen,producto,tipo,documento) s) sg
  CROSS JOIN LATERAL (SELECT count(*) AS n,COALESCE(jsonb_agg(j ORDER BY fecha NULLS FIRST,sentido,documento) FILTER(WHERE rn<=200),'[]') AS j
    FROM (SELECT *,row_number() OVER(ORDER BY fecha NULLS FIRST,sentido,documento,tipo,almacen,lote_rel) AS rn,
      jsonb_build_object('fecha',fecha,'tipo',tipo,'almacen',almacen,'documento',documento,'tn',round(kg/1000,3),
        'sentido',sentido,'lote_rel',lote_rel,'precision',CASE WHEN tipo='INICIAL' THEN 'INFERIDO' ELSE 'DOCUMENTAL' END) AS j
      FROM (SELECT fecha,tipo,almacen,documento,'INGRESO'::text AS sentido,NULLIF(lote_origen,lote) AS lote_rel,sum(kg_in) AS kg
        FROM apt_gantt_layers WHERE lote=q.lote GROUP BY fecha,tipo,almacen,documento,lote_origen,lote
        UNION ALL SELECT fecha,tipo,almacen,documento,'SALIDA',NULLIF(lote_destino,lote),sum(kg)
        FROM apt_gantt_exits WHERE lote=q.lote GROUP BY fecha,tipo,almacen,documento,lote_destino,lote) m) e) ev;
  -- Serie de saldo: un acumulado por fecha calculado una sola vez (antes se recalculaba por cada punto
  -- del gráfico y superaba el statement_timeout de authenticated con la data completa).
  WITH movement AS MATERIALIZED (SELECT l.fecha,sum(l.kg_in) AS kg FROM apt_gantt_layers l JOIN apt_gantt_rows r USING(lote) GROUP BY l.fecha
    UNION ALL SELECT e.fecha,-sum(e.kg) FROM apt_gantt_exits e JOIN apt_gantt_rows r USING(lote) GROUP BY e.fecha),
    sin_fecha AS (SELECT COALESCE(sum(kg),0) AS kg FROM movement WHERE fecha IS NULL),
    acumulado AS MATERIALIZED (SELECT fecha,sum(sum(kg)) OVER(ORDER BY fecha) AS kg FROM movement WHERE fecha IS NOT NULL GROUP BY fecha),
    points AS (SELECT DISTINCT LEAST(d::date,v_to) AS fecha FROM generate_series(v_from,v_to,GREATEST(1,CEIL((v_to-v_from+1)/120.0))::integer*interval '1 day') d UNION SELECT v_to)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha',p.fecha,'saldo_tn',round((s.kg+COALESCE((SELECT a.kg FROM acumulado a WHERE a.fecha<=p.fecha ORDER BY a.fecha DESC LIMIT 1),0))/1000,3)) ORDER BY p.fecha),'[]') INTO v_series
    FROM points p CROSS JOIN sin_fecha s;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]') INTO v_coverage
    FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
      FROM public.apt_movements WHERE active AND valid GROUP BY kind) c;
  RETURN jsonb_build_object('success',true,'cutoff',v_cut,'data_min',st.data_min,'data_max',v_max,'model_cutoff',st.cutoff,'requested_cutoff',NULLIF(p->>'corte',''),'age_basis',CASE WHEN v_cut=st.cutoff THEN 'ORIGEN' ELSE 'ALMACEN' END,'desde',v_from,'hasta',v_to,'rebuilt_at',st.rebuilt_at,'model_pending',v_pending,'last_upload_at',v_last_upload,
    'alert_days',v_alert,'tolerance',v_tol,'total',v_total,'limit',v_limit,'offset',v_offset,'kpis',v_kpi,'filas',v_rows,
    'prioridades',v_priority,'serie',v_series,'cobertura',v_coverage);
END $$;
REVOKE ALL ON FUNCTION public.apt_gantt(jsonb,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apt_gantt(jsonb,integer,integer) TO authenticated,service_role;
COMMIT;
