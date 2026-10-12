-- Optimize the read-only APT summary without changing balances, cohort scope or access.
-- Normalize filters once, collect planner statistics and reuse documentary scope.
-- No statement-timeout change: query cost must fit the existing service budget.
BEGIN;
-- The quality query needs only reversed-date allocations, not the full FIFO ledger.
CREATE INDEX IF NOT EXISTS apt_allocations_temporal_quality_idx
 ON public.apt_allocations(fecha_salida,layer_id) WHERE fecha_salida<fecha_ingreso;
CREATE OR REPLACE FUNCTION public.apt_operational_summary(p jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 s public.apt_flow_state%ROWTYPE;
 v_cut date; v_from date; v_to date; v_max date; v_applied timestamptz;
 v_alm text; v_limit integer; v_offset integer; v_current boolean;
 v_meta jsonb; v_kpis jsonb; v_series jsonb; v_rows jsonb; v_warehouses jsonb; v_coverage jsonb;
 v_total integer; v_missing integer; v_temporal integer; v_negative integer; v_alert integer;
 v_stock numeric; v_average numeric; v_out numeric; v_inferred numeric; v_known numeric;
 v_unknown numeric; v_age numeric; v_exposure numeric; v_version text;
 v_lote text; v_ot text; v_clients text[];
BEGIN
 IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success',false,'error','Sin acceso al módulo APT'); END IF;
 p:=COALESCE(p,'{}'::jsonb);
 IF jsonb_typeof(p)<>'object' THEN RETURN jsonb_build_object('success',false,'error','Filtros APT inválidos'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('desde','hasta','cutoff','almacen','lote','ot','clientes','limit','offset')) THEN
  RETURN jsonb_build_object('success',false,'error','Hay filtros no compatibles con el análisis operativo APT');
 END IF;
 IF p ? 'clientes' AND jsonb_typeof(p->'clientes')<>'array' THEN
  RETURN jsonb_build_object('success',false,'error','Clientes debe ser una lista');
 END IF;
 IF p ? 'clientes' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p->'clientes') c WHERE jsonb_typeof(c)<>'string') THEN
  RETURN jsonb_build_object('success',false,'error','Cada cliente debe ser un texto');
 END IF;
 IF jsonb_array_length(COALESCE(p->'clientes','[]'))>100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(p->'clientes','[]')) c WHERE length(c)>200)
  OR length(COALESCE(p->>'lote',''))>100 OR length(COALESCE(p->>'ot',''))>100 THEN
  RETURN jsonb_build_object('success',false,'error','Los filtros superan el tamaño permitido');
 END IF;
 SELECT * INTO s FROM public.apt_flow_state WHERE id=1;
 SELECT max(fecha) INTO v_max FROM public.apt_movements WHERE active AND valid;
 SELECT max(applied_at) INTO v_applied FROM public.apt_uploads WHERE status='APLICADA';
 SELECT alert_days INTO v_alert FROM public.apt_settings WHERE id=1;
 v_alert:=COALESCE(v_alert,60);
 FOREACH v_alm IN ARRAY ARRAY['cutoff','desde','hasta'] LOOP
  IF NULLIF(p->>v_alm,'') IS NOT NULL AND public.apt_date(p->v_alm) IS NULL THEN
   RETURN jsonb_build_object('success',false,'error','Fecha inválida: '||v_alm);
  END IF;
 END LOOP;
 v_cut:=COALESCE(public.apt_date(p->'cutoff'),s.cutoff);
 IF v_cut>s.cutoff THEN RETURN jsonb_build_object('success',false,'error','El corte supera la fecha del modelo. Actualice los datos antes de analizar.'); END IF;
 IF v_cut<s.data_min THEN RETURN jsonb_build_object('success',false,'error','El corte es anterior al inicio de los datos disponibles'); END IF;
 v_to:=COALESCE(public.apt_date(p->'hasta'),v_cut);
 v_from:=COALESCE(public.apt_date(p->'desde'),GREATEST(s.data_min,v_to-29));
 IF v_from>v_to OR v_to>v_cut OR v_to-v_from>365 THEN
  RETURN jsonb_build_object('success',false,'error','Seleccione un período de hasta 366 días, ordenado y anterior o igual al corte');
 END IF;
 IF v_from<s.data_min THEN RETURN jsonb_build_object('success',false,'error','El período comienza antes de los datos disponibles'); END IF;
 v_alm:=NULLIF(btrim(p->>'almacen'),'');
 IF v_alm IS NOT NULL AND v_alm NOT IN ('647','540','ST') THEN RETURN jsonb_build_object('success',false,'error','Almacén no compatible'); END IF;
 IF COALESCE(p->>'limit','25') !~ '^[0-9]{1,6}$' OR COALESCE(p->>'offset','0') !~ '^[0-9]{1,9}$' THEN
  RETURN jsonb_build_object('success',false,'error','Paginación inválida');
 END IF;
 v_limit:=LEAST(GREATEST(COALESCE((p->>'limit')::integer,25),1),100);
 v_offset:=GREATEST(COALESCE((p->>'offset')::integer,0),0);
 v_current:=v_cut=s.cutoff;
 v_lote:=NULLIF(btrim(p->>'lote'),'');
 v_ot:=CASE WHEN NULLIF(btrim(p->>'ot'),'') IS NOT NULL THEN COALESCE(public.apt_ot_raiz(p->>'ot'),upper(btrim(p->>'ot'))) END;
 SELECT COALESCE(array_agg(c),'{}'::text[]) INTO v_clients FROM jsonb_array_elements_text(COALESCE(p->'clientes','[]')) c;
 v_version:=concat_ws('|',s.rebuilt_at::text,v_applied::text,v_max::text);
 v_meta:=jsonb_build_object('cutoff',v_cut,'desde',v_from,'hasta',v_to,'data_min',s.data_min,'data_max',v_max,
  'flow_rebuilt_at',s.rebuilt_at,'latest_applied_at',v_applied,
  'model_fresh',s.cutoff IS NOT NULL AND s.rebuilt_at IS NOT NULL AND (v_applied IS NULL OR s.rebuilt_at>=v_applied),
  'calculation_basis','DOCUMENTAL_RECONSTRUIDO','composition_available',COALESCE(v_current,false),
  'physical_reconciliation','NO_VERIFICADA','age_basis',CASE WHEN v_current THEN 'ORIGEN' ELSE 'NO_DISPONIBLE' END,
  'alert_days',v_alert,'version',v_version);
 IF s.cutoff IS NULL THEN
  RETURN jsonb_build_object('success',true,'schema_version',1,'vacio',true,'filters',p-'limit'-'offset','meta',v_meta,
   'kpis',jsonb_build_object('stock_tn',0,'inferred_opening_tn',NULL,'known_origin_stock_tn',NULL,'unknown_origin_stock_tn',NULL,
    'weighted_age_days',NULL,'stock_tn_days',NULL,'production_tn',0,'dispatch_tn',0,'consumption_tn',0,'returns_tn',0,
    'average_stock_tn',NULL,'turnover',NULL,'observed_days',0),
   'quality',jsonb_build_object('missing_weight_rows',0,'temporal_anomaly_rows',0,'negative_balance_rows',0),
   'coverage','[]'::jsonb,'series','[]'::jsonb,'warehouses','[]'::jsonb,'rows','[]'::jsonb,'total',0,'limit',v_limit,'offset',v_offset);
 END IF;
 DROP TABLE IF EXISTS pg_temp.apt_op_scope;
 DROP TABLE IF EXISTS pg_temp.apt_op_mv;
 DROP TABLE IF EXISTS pg_temp.apt_op_keys;
 DROP TABLE IF EXISTS pg_temp.apt_op_bal;
 DROP TABLE IF EXISTS pg_temp.apt_op_series;
 DROP TABLE IF EXISTS pg_temp.apt_op_composition;
 -- Select one inventory cohort first. An exit's customer may be absent or differ from the
 -- inferred layer customer; filtering each event independently would create fictitious stock.
 CREATE TEMP TABLE apt_op_keys ON COMMIT DROP AS
 SELECT DISTINCT almacen,lote,producto FROM public.apt_flow_layers
 WHERE (v_alm IS NULL OR almacen=v_alm)
 AND (v_lote IS NULL OR lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(lote)=v_ot)
 AND (cardinality(v_clients)=0 OR COALESCE(cliente,'(Sin cliente identificado)')=ANY(v_clients));
 CREATE UNIQUE INDEX ON apt_op_keys(almacen,lote,producto);
 ANALYZE apt_op_keys;
 CREATE TEMP TABLE apt_op_mv ON COMMIT DROP AS
 SELECT l.almacen,l.lote,l.producto,l.cliente,l.fecha,l.tipo,l.kg_in AS kg FROM public.apt_flow_layers l
 JOIN apt_op_keys k USING(almacen,lote,producto) WHERE l.fecha IS NULL OR l.fecha<=v_cut
 UNION ALL
 SELECT e.almacen,e.lote,e.producto,e.cliente,e.fecha,e.tipo,-e.kg FROM public.apt_flow_exits e
 JOIN apt_op_keys k USING(almacen,lote,producto) WHERE e.fecha<=v_cut;
 ANALYZE apt_op_mv;
 -- Group before pagination. Never clamp negatives: they remain visible as reconciliation exceptions.
 CREATE TEMP TABLE apt_op_bal ON COMMIT DROP AS
 SELECT almacen,lote,max(cliente) AS cliente,sum(kg) AS kg FROM apt_op_mv GROUP BY almacen,lote;
 CREATE TEMP TABLE apt_op_composition ON COMMIT DROP AS
 SELECT almacen,lote,sum(kg) FILTER(WHERE origen LIKE 'INICIAL%') AS inferred,
  sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut) AS known,
  sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut) AS unknown,
  sum(kg*(v_cut-fecha_origen)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut) AS kg_days
 FROM public.apt_flow_pieces pc JOIN apt_op_keys k USING(almacen,lote,producto)
 WHERE v_current AND es_saldo GROUP BY almacen,lote;
 CREATE UNIQUE INDEX ON apt_op_bal(almacen,lote);
 CREATE UNIQUE INDEX ON apt_op_composition(almacen,lote);
 ANALYZE apt_op_bal;
 ANALYZE apt_op_composition;
 -- Mean inventory is the mean of daily closing balances of the requested observed window.
 CREATE TEMP TABLE apt_op_series ON COMMIT DROP AS
 WITH daily AS (SELECT fecha,sum(kg) AS delta,
   sum(kg) FILTER(WHERE tipo='PRODUCCION') AS production,
   -sum(kg) FILTER(WHERE tipo='DESPACHO') AS dispatch
   FROM apt_op_mv WHERE fecha BETWEEN v_from AND v_to GROUP BY fecha),
 opening AS (SELECT COALESCE(sum(kg),0) AS kg FROM apt_op_mv WHERE fecha IS NULL OR fecha<v_from)
 SELECT d::date AS fecha, o.kg+sum(COALESCE(m.delta,0)) OVER(ORDER BY d) AS kg,
  COALESCE(m.production,0) AS production,COALESCE(m.dispatch,0) AS dispatch
 FROM generate_series(v_from,v_to,interval '1 day') d CROSS JOIN opening o LEFT JOIN daily m ON m.fecha=d::date;
 SELECT COALESCE(sum(kg),0) INTO v_stock FROM apt_op_bal;
 SELECT avg(kg) INTO v_average FROM apt_op_series;
 SELECT COALESCE(sum(-kg),0) INTO v_out FROM apt_op_mv WHERE tipo='DESPACHO' AND fecha BETWEEN v_from AND v_to;
 SELECT CASE WHEN v_current THEN COALESCE(sum(inferred),0) END,
  CASE WHEN v_current THEN COALESCE(sum(known),0) END,CASE WHEN v_current THEN COALESCE(sum(unknown),0) END,
  CASE WHEN v_current THEN round(sum(kg_days)/NULLIF(sum(known),0),1) END,
  CASE WHEN v_current THEN round(sum(kg_days)/1000,1) END
 INTO v_inferred,v_known,v_unknown,v_age,v_exposure FROM apt_op_composition;
 v_kpis:=jsonb_build_object('stock_tn',round(v_stock/1000,3),'inferred_opening_tn',round(v_inferred/1000,3),
  'known_origin_stock_tn',round(v_known/1000,3),'unknown_origin_stock_tn',round(v_unknown/1000,3),
  'weighted_age_days',v_age,'stock_tn_days',v_exposure,
  'production_tn',(SELECT round(COALESCE(sum(kg),0)/1000,3) FROM apt_op_mv WHERE tipo='PRODUCCION' AND fecha BETWEEN v_from AND v_to),
  'dispatch_tn',round(v_out/1000,3),
  'consumption_tn',(SELECT round(COALESCE(sum(-kg),0)/1000,3) FROM apt_op_mv WHERE tipo='CONSUMO' AND fecha BETWEEN v_from AND v_to),
  'returns_tn',(SELECT round(COALESCE(sum(kg),0)/1000,3) FROM apt_op_mv WHERE tipo='DEVOLUCION' AND fecha BETWEEN v_from AND v_to),
  'average_stock_tn',round(v_average/1000,3),
  'turnover',CASE WHEN v_average>0 THEN round(v_out/v_average,3) END,
  'observed_days',v_to-v_from+1);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('fecha',fecha,'stock_tn',round(kg/1000,3),
  'production_tn',round(production/1000,3),'dispatch_tn',round(dispatch/1000,3)) ORDER BY fecha),'[]') INTO v_series FROM apt_op_series;
 SELECT count(*) INTO v_total FROM apt_op_bal WHERE abs(kg)>0.0005;
 SELECT count(*) INTO v_negative FROM (SELECT almacen,lote,producto FROM apt_op_mv GROUP BY almacen,lote,producto HAVING sum(kg)< -0.0005) deficits;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen',b.almacen,'lote',b.lote,'cliente',b.cliente,'stock_tn',round(b.kg/1000,3),
  'inferred_opening_tn',CASE WHEN v_current THEN round(COALESCE(c.inferred,0)/1000,3) END,
  'age_days',CASE WHEN v_current THEN round(c.kg_days/NULLIF(c.known,0),1) END,
  'stock_tn_days',CASE WHEN v_current THEN round(c.kg_days/1000,1) END) ORDER BY b.kg DESC,b.almacen,b.lote),'[]')
 INTO v_rows FROM (SELECT * FROM apt_op_bal WHERE abs(kg)>0.0005 ORDER BY kg DESC,almacen,lote LIMIT v_limit OFFSET v_offset) b
 LEFT JOIN apt_op_composition c USING(almacen,lote);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('almacen',almacen,'stock_tn',round(kg/1000,3),
  'inferred_opening_tn',CASE WHEN v_current THEN round(inferred/1000,3) END) ORDER BY almacen),'[]') INTO v_warehouses
 FROM (SELECT b.almacen,sum(b.kg) AS kg,COALESCE(sum(c.inferred),0) AS inferred FROM apt_op_bal b
  LEFT JOIN apt_op_composition c USING(almacen,lote) GROUP BY b.almacen) x;
 -- Materialize raw documentary scope once. Unlike the inventory cohort, it includes
 -- missing-weight documents even when they have no layer; customer scope still requires
 -- an inventory key, preserving the previous EXISTS semantics.
 CREATE TEMP TABLE apt_op_scope ON COMMIT DROP AS
 SELECT m.id,m.kind,m.fecha,m.peso_kg,m.almacen,m.lote FROM public.apt_movements m
 WHERE m.active AND m.valid AND (v_alm IS NULL OR m.almacen=v_alm)
 AND (v_lote IS NULL OR m.lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(m.lote)=v_ot)
 AND (cardinality(v_clients)=0 OR EXISTS(SELECT 1 FROM apt_op_keys k WHERE k.almacen=m.almacen AND k.lote=m.lote));
 CREATE UNIQUE INDEX ON apt_op_scope(id);
 ANALYZE apt_op_scope;
 SELECT count(*) INTO v_missing FROM apt_op_scope WHERE peso_kg<=0 AND fecha<=v_cut;
 -- Restrict anomalies first, before joining the historical entry and source tables.
 -- apt_layers may contain repeated movement identifiers in historical installations;
 -- retaining this join preserves the previous anomaly count exactly.
 SELECT count(*) INTO v_temporal FROM public.apt_allocations a
 JOIN public.apt_layers l ON l.movement_id=a.layer_id
 JOIN public.apt_movements m ON m.id=l.movement_id
 WHERE a.fecha_salida<a.fecha_ingreso AND a.fecha_salida<=v_cut
 AND (v_alm IS NULL OR m.almacen=v_alm)
 AND (v_lote IS NULL OR l.lote ILIKE '%'||v_lote||'%')
 AND (v_ot IS NULL OR public.apt_ot_raiz(l.lote)=v_ot)
 AND (cardinality(v_clients)=0 OR EXISTS(SELECT 1 FROM apt_op_keys k WHERE k.almacen=m.almacen AND k.lote=l.lote));
 -- Coverage remains first/last observed dates, not proof of continuous activity.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'desde',desde,'hasta',hasta,'rows',rows,'missing_weight_rows',missing) ORDER BY kind),'[]')
 INTO v_coverage FROM (SELECT kind,min(fecha) AS desde,max(fecha) AS hasta,count(*) AS rows,count(*) FILTER(WHERE peso_kg<=0) AS missing
 FROM apt_op_scope GROUP BY kind) x;
 RETURN jsonb_build_object('success',true,'schema_version',1,'filters',p-'limit'-'offset','meta',v_meta,'kpis',v_kpis,
  'quality',jsonb_build_object('missing_weight_rows',v_missing,'temporal_anomaly_rows',v_temporal,'negative_balance_rows',v_negative),
  'coverage',v_coverage,'series',v_series,'warehouses',v_warehouses,'rows',v_rows,'total',v_total,'limit',v_limit,'offset',v_offset);
END $$;
REVOKE ALL ON FUNCTION public.apt_operational_summary(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apt_operational_summary(jsonb) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
