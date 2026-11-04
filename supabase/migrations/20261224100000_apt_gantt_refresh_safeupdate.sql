-- El recálculo del flujo APT por la API (/api/apt/procesar) fallaba con «DELETE requires a WHERE clause»: en Supabase
-- las consultas de la API pasan por pg_safeupdate y apt_gantt_refresh (trigger al actualizar apt_flow_state.rebuilt_at,
-- la última sentencia del recálculo) vaciaba sus tablas con DELETE sin WHERE. Desde la tarea programada (conexión
-- directa) sí funcionaba. Misma función con WHERE true; la lógica no cambia (como 20261025110000_erp_derivacion_safeupdate).
BEGIN;

CREATE OR REPLACE FUNCTION public.apt_gantt_refresh() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st record; v_cut date; v_alert integer;
BEGIN
  SELECT * INTO st FROM public.apt_flow_state WHERE id=1;
  SELECT COALESCE(alert_days,60) INTO v_alert FROM public.apt_settings WHERE id=1;
  v_alert := COALESCE(v_alert,60); v_cut := st.cutoff;
  DELETE FROM public.apt_gantt_lotes WHERE true; DELETE FROM public.apt_gantt_daily WHERE true;
  IF v_cut IS NOT NULL THEN
    DROP TABLE IF EXISTS pg_temp.apt_gr_layers, pg_temp.apt_gr_exits;
    CREATE TEMP TABLE apt_gr_layers ON COMMIT DROP AS
      SELECT l.*,GREATEST(l.kg_in-COALESCE(a.kg,0),0) AS saldo_corte,a.ultima_salida,public.apt_ot_raiz(l.lote) AS ot
      FROM public.apt_flow_layers l
      LEFT JOIN (SELECT a.layer_id,sum(a.kg) AS kg,max(e.fecha) AS ultima_salida
        FROM public.apt_flow_alloc a JOIN public.apt_flow_exits e ON e.id=a.exit_id WHERE e.fecha<=v_cut GROUP BY a.layer_id) a ON a.layer_id=l.id
      WHERE l.fecha IS NULL OR l.fecha<=v_cut;
    CREATE TEMP TABLE apt_gr_exits ON COMMIT DROP AS SELECT e.* FROM public.apt_flow_exits e WHERE e.fecha<=v_cut;
    INSERT INTO public.apt_gantt_lotes
    WITH ly AS (SELECT lote,max(ot) AS ot,max(cliente) AS cliente,count(DISTINCT producto) AS productos,
      sum(kg_in) FILTER(WHERE tipo NOT IN ('TRASPASO','INICIAL')) AS ingreso,
      sum(kg_in) FILTER(WHERE tipo='INICIAL') AS inicial,
      sum(kg_in) FILTER(WHERE tipo='TRASPASO' AND lote_origen IS DISTINCT FROM lote) AS asignado,
      sum(saldo_corte) AS saldo,sum(saldo_corte) FILTER(WHERE fecha IS NULL) AS desconocido,
      min(fecha) AS primera,max(fecha) AS ultima,
      sum(saldo_corte*(v_cut-fecha)) FILTER(WHERE fecha IS NOT NULL) AS age_kg_days,
      sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL) AS age_kg,
      COALESCE(sum(saldo_corte) FILTER(WHERE fecha IS NOT NULL AND v_cut-fecha>=v_alert),0) AS critico_kg,
      array_agg(DISTINCT almacen) FILTER(WHERE almacen IS NOT NULL) AS almacenes
      FROM apt_gr_layers GROUP BY lote),
    ex AS (SELECT lote,max(cliente) AS cliente,min(fecha) AS primera,max(fecha) AS ultima,
      sum(kg) FILTER(WHERE tipo='DESPACHO') AS despacho,
      sum(kg) FILTER(WHERE tipo IN ('CONSUMO','OTRO_ALMACEN')) AS otro,
      sum(kg) FILTER(WHERE tipo='TRASPASO' AND lote_destino IS DISTINCT FROM lote) AS cedido,
      min(fecha) FILTER(WHERE tipo='DESPACHO') AS primera_salida FROM apt_gr_exits GROUP BY lote)
    SELECT COALESCE(ly.lote,ex.lote),COALESCE(ly.ot,public.apt_ot_raiz(ex.lote)),
      COALESCE(ly.cliente,ex.cliente),COALESCE(ly.productos,0),
      COALESCE(ingreso,0),COALESCE(inicial,0),COALESCE(asignado,0),
      COALESCE(despacho,0),COALESCE(otro,0),COALESCE(cedido,0),
      COALESCE(saldo,0),COALESCE(desconocido,0),
      LEAST(ly.primera,ex.primera),GREATEST(ly.ultima,ex.ultima),ex.primera_salida,
      ly.age_kg_days,ly.age_kg,ly.critico_kg,ly.almacenes
    FROM ly FULL JOIN ex USING(lote);
    UPDATE public.apt_gantt_lotes r SET age_kg_days=a.days_kg,age_kg=a.known_kg,desconocido=a.unknown_kg,critico_kg=a.critical_kg
    FROM (SELECT lote,COALESCE(sum(kg*GREATEST(v_cut-fecha_origen,0)) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS days_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND fecha_origen<=v_cut),0) AS known_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NULL OR fecha_origen>v_cut),0) AS unknown_kg,
      COALESCE(sum(kg) FILTER(WHERE fecha_origen IS NOT NULL AND v_cut-fecha_origen>=v_alert),0) AS critical_kg
      FROM public.apt_flow_pieces WHERE es_saldo GROUP BY lote) a WHERE r.lote=a.lote;
    INSERT INTO public.apt_gantt_daily (lote,fecha,kg)
      SELECT lote,fecha,sum(kg_in) FROM apt_gr_layers GROUP BY lote,fecha
      UNION ALL SELECT lote,fecha,-sum(kg) FROM apt_gr_exits GROUP BY lote,fecha;
  END IF;
  UPDATE public.apt_gantt_meta SET flow_rebuilt_at=st.rebuilt_at, cutoff=v_cut, alert_days=v_alert, built_at=now(),
    data_max=(SELECT max(fecha) FROM public.apt_movements WHERE active AND valid),
    coverage=(SELECT COALESCE(jsonb_agg(jsonb_build_object('tipo',kind,'desde',f0,'hasta',f1,'filas',n,'sin_peso',sp) ORDER BY kind),'[]')
      FROM (SELECT kind,min(fecha) AS f0,max(fecha) AS f1,count(*) AS n,count(*) FILTER(WHERE peso_kg IS NULL OR peso_kg<=0) AS sp
        FROM public.apt_movements WHERE active AND valid GROUP BY kind) c)
  WHERE id=1;
END $$;
REVOKE ALL ON FUNCTION public.apt_gantt_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apt_gantt_refresh() TO service_role;

COMMIT;
