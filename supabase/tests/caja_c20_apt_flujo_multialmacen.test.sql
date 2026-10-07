-- CAJA C20 — APT: flujo multi-almacén 647 → ST VENTAS → guía, con 540 (adelanto con asignación de contrato),
-- retorno de ST a 647, consumo interno y traspaso a otro almacén. FIFO encadenado y composición por producción.
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos. Usa fechas de 2001 y fecha de corte manual
-- 31/01/2001, así el modelo de la prueba no mezcla movimientos reales.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

-- Test-only temporary helpers: public execution defaults are intentionally revoked.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

DO $test$
DECLARE
  v_loader uuid; v_viewer uuid; v_none uuid; v_role uuid; v_up uuid;
  rb jsonb; rb_view jsonb; s_none jsonb; sm jsonb; st jsonb; ad jsonb; lt jsonb; g1 jsonb; g2 jsonb; tl jsonb; ql jsonb; cv jsonb; stk jsonb;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT id INTO v_loader FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_viewer FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_loader ORDER BY id LIMIT 1;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_loader, v_viewer) ORDER BY id LIMIT 1;
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C20 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C20 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C20 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_viewer;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C20 nada', '["ot"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_none;

  PERFORM pg_temp.as_user(v_loader);
  PERFORM public.apt_save_settings('{"cutoff_date":"2001-01-31","tolerance":0.02,"alert_days":60}'::jsonb);
  v_up := (public.apt_upload_begin('ZZ C20.xlsx') ->> 'id')::uuid;
  -- Producción: 1000 kg a 647 el 02/01
  PERFORM public.apt_upload_rows(v_up, 'ENTRADA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04  ALM PT', 'Fecha', '2001-01-02', 'Producto', 'ZZX',
      'GLOSA', 'POSTE ZZ', 'NumRel', 'ZZ20-001-001', 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 1000)));
  -- Traspasos (lado origen): 647→ST 600 kg (10/01); adelanto 540→ST 300 kg con asignación de contrato (15/01);
  -- retorno ST→647 100 kg (20/01); 647→otro almacén 20 kg (26/01, sin lado destino APT)
  PERFORM public.apt_upload_rows(v_up, 'TRASPASO_SAL', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04  ALM PT', 'Numero', 'ZZT1', 'Fecha', '2001-01-10',
      'Producto', 'ZZX', 'Cantidad', -6, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 600),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '540-04 APT LB', 'Numero', 'ZZT2', 'Fecha', '2001-01-15',
      'Producto', 'ZZY', 'Cantidad', -3, 'Lote', 'ZZ761', 'Comentario', 'IPT: 003-000777', 'PesoTotalProduccido', 300),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZT3', 'Fecha', '2001-01-20',
      'Producto', 'ZZX', 'Cantidad', -1, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 100),
    jsonb_build_object('__row', 5, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04  ALM PT', 'Numero', 'ZZT4', 'Fecha', '2001-01-26',
      'Producto', 'ZZX', 'Cantidad', -0.2, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 20),
    jsonb_build_object('__row', 6, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ALM MATERIA PRIMA CH', 'Numero', 'ZZT5', 'Fecha', '2001-01-26',
      'Producto', 'ZZX', 'Cantidad', -1, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 5)));
  PERFORM public.apt_upload_rows(v_up, 'TRASPASO_ENT', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZT1', 'Fecha', '2001-01-10',
      'Producto', 'ZZX', 'Cantidad', 6, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 600),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZT2', 'Fecha', '2001-01-15',
      'Producto', 'ZZY', 'Cantidad', 3, 'Lote', 'ZZ20-002', 'Contrato', 'ZZ20-002', 'PesoTotalProduccido', 300),
    jsonb_build_object('__row', 4, 'TIPODOCTO', 'TRASPASO DE ALMACEN', 'BODEGA', '647-04  ALM PT', 'Numero', 'ZZT3', 'Fecha', '2001-01-20',
      'Producto', 'ZZX', 'Cantidad', 1, 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 100)));
  -- Guías desde ST: 500 kg el mismo día del traspaso (10/01) y el adelanto ya asignado (17/01)
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZG-1', 'Fecha', '2001-01-10',
      'RazonSocial', 'ZZ CLIENTE C20', 'Producto', 'ZZX', 'Cantidad', -5, 'DocRel', 'CONTRATO DE VENTAS', 'NumRel', 'ZZ20-001', 'PesoTotalProduccido', 500),
    jsonb_build_object('__row', 3, 'TIPODOCTO', 'DESPACHO VENTAS', 'BODEGA', 'ST-VENTAS-IMD', 'Numero', 'ZZG-2', 'Fecha', '2001-01-17',
      'RazonSocial', 'ZZ CLIENTE C20', 'Producto', 'ZZY', 'Cantidad', -3, 'DocRel', 'SUBCONTRATO DE VENTAS', 'NumRel', 'ZZ20-002', 'PesoTotalProduccido', 300)));
  -- Consumo interno (vale de consumo) de 647: 50 kg el 25/01
  PERFORM public.apt_upload_rows(v_up, 'CONSUMO', jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'V/C ACTIVOS', 'BODEGA', '647-04  ALM PT', 'Numero', 'ZZV1', 'Fecha', '2001-01-25',
      'Producto', 'ZZX', 'Cantidad', -1, 'DocRel', 'OT ACTIVOS', 'NumRel', '908', 'Lote', 'ZZ20-001', 'PesoTotalProduccido', 50)));
  PERFORM public.apt_upload_apply(v_up, false);
  PERFORM public.apt_model_rebuild();
  rb := public.apt_flow_rebuild();
  PERFORM pg_temp.as_user(v_viewer);
  rb_view := public.apt_flow_rebuild();
  sm := public.apt_flow_summary('{}'::jsonb);
  st := public.apt_flow_st('{}'::jsonb);
  ad := public.apt_flow_adelantos('{}'::jsonb);
  lt := public.apt_flow_leadtime('{}'::jsonb, 'cliente');
  stk := public.apt_flow_stock('{"almacen":"647"}'::jsonb);
  g1 := public.apt_flow_trace('zzg-1');
  g2 := public.apt_flow_trace('ZZG-2');
  tl := public.apt_flow_trace('ZZ20-001');
  ql := public.apt_flow_quality();
  cv := public.apt_coverage(NULL);
  PERFORM pg_temp.as_user(v_none);
  s_none := public.apt_flow_summary('{}'::jsonb);
  PERFORM pg_temp.as_user(NULL);

  -- T1: permisos — sin módulo no ve; quien solo ve no recalcula; quien carga sí
  IF NOT (s_none ->> 'success')::boolean AND NOT (rb_view ->> 'success')::boolean AND (rb ->> 'success')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permisos: ' || COALESCE(s_none::text, '∅') || ' / ' || COALESCE(rb_view::text, '∅')); END IF;

  -- T2: carga — la fila de una bodega fuera de APT queda excluida; traspasos emparejados por documento, producto y cantidad
  IF (SELECT invalid_reason FROM public.apt_movements WHERE upload_id = v_up AND kind = 'TRASPASO_SAL' AND row_no = 6) LIKE 'Fuera de los almacenes APT%'
     AND (SELECT lote FROM public.apt_movements WHERE upload_id = v_up AND kind = 'TRASPASO_ENT' AND row_no = 3) = 'ZZ20-002'
     AND (SELECT count(*) FROM public.apt_flow_exits WHERE tipo = 'TRASPASO') = 3
     AND (SELECT count(*) FROM public.apt_flow_exits WHERE tipo = 'OTRO_ALMACEN' AND documento = 'ZZT4') = 1
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 emparejamiento: ' || COALESCE(rb::text, '∅')); END IF;

  -- T3: saldos por almacén (647: 1000 + 100 retorno − 600 − 50 − 20 = 430 kg; ST y 540 en cero) y stock inicial de 540 = 300 kg
  IF (SELECT sum(kg_saldo) FROM public.apt_flow_layers WHERE almacen = '647') = 430
     AND (SELECT COALESCE(sum(kg_saldo), 0) FROM public.apt_flow_layers WHERE almacen IN ('ST', '540')) = 0
     AND (SELECT kg_in FROM public.apt_flow_layers WHERE almacen = '540' AND tipo = 'INICIAL') = 300
     AND (SELECT sum(kg) FROM public.apt_flow_pieces WHERE es_saldo AND origen = 'PRODUCCION') = 430
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ql -> 'almacenes') a WHERE (a ->> 'diferencia_tn')::numeric <> 0)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 saldos: ' || COALESCE(ql ->> 'almacenes', '∅')); END IF;

  -- T4: la guía ZZG-1 viene de la producción del 02/01, llegó a ST el 10/01 y se guió el mismo día (8 + 0 días)
  IF g1 ->> 'modo' = 'guia' AND jsonb_array_length(g1 -> 'lineas') = 1
     AND g1 #>> '{lineas,0,origen}' = 'PRODUCCION' AND g1 #>> '{lineas,0,fecha_origen}' = '2001-01-02' AND g1 #>> '{lineas,0,via}' = '647'
     AND (g1 #>> '{lineas,0,dias_total}')::int = 8 AND (g1 #>> '{lineas,0,dias_previo}')::int = 8 AND (g1 #>> '{lineas,0,dias_final}')::int = 0
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 guía 1: ' || COALESCE(g1::text, '∅')); END IF;

  -- T5: la guía ZZG-2 sale del stock previo de 540 (adelanto ZZ761) que se asignó al contrato ZZ20-002 en el traspaso
  IF g2 #>> '{lineas,0,origen}' = 'INICIAL_540' AND g2 #>> '{lineas,0,lote_origen}' = 'ZZ761' AND g2 #>> '{lineas,0,lote}' = 'ZZ20-002'
     AND (g2 #>> '{lineas,0,dias_final}')::int = 2
     AND (ad #>> '{kpis,asignacion_tn}')::numeric = 0.3 AND (ad #>> '{kpis,inicial_540_tn}')::numeric = 0.3
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(ad -> 'cambios') c WHERE c ->> 'clase' = 'ASIGNACION' AND c ->> 'lote_destino' = 'ZZ20-002')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 adelanto: ' || COALESCE(g2::text, '∅') || ' / ' || COALESCE(ad ->> 'kpis', '∅')); END IF;

  -- T6: KPIs del resumen y de ST — 0.8 TN despachadas, 62.5 % trazado a producción, consumo 0.05 TN,
  -- retorno ST→647 0.1 TN tras 10 días en ST, saldo de ST en cero
  IF (sm #>> '{kpis,despacho_tn}')::numeric = 0.8 AND (sm #>> '{kpis,trazado_pct}')::numeric = 62.5
     AND (sm #>> '{kpis,consumo_tn}')::numeric = 0.05 AND (sm #>> '{kpis,otro_almacen_tn}')::numeric = 0.02
     AND (st #>> '{kpis,retorno_tn}')::numeric = 0.1 AND (st #>> '{kpis,retorno_dias_pond}')::numeric = 10
     AND (st #>> '{kpis,saldo_tn}')::numeric = 0
     AND (lt #>> '{kpis,dias_total}')::numeric = 8 AND (lt #>> '{kpis,mismo_dia_pct}')::numeric = 100
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(sm -> 'flujos') f WHERE f ->> 'desde' = 'ST' AND f ->> 'hacia' = '647' AND (f ->> 'tn')::numeric = 0.1)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T6 KPIs: ' || COALESCE(sm ->> 'kpis', '∅') || ' / ' || COALESCE(st ->> 'kpis', '∅')); END IF;

  -- T7: línea de tiempo del lote y stock de 647 con su antigüedad desde la producción (29 días al corte)
  IF tl ->> 'modo' = 'lote' AND jsonb_array_length(tl -> 'eventos') >= 7
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(tl -> 'saldo') x WHERE x ->> 'almacen' = '647' AND (x ->> 'tn')::numeric = 0.43)
     AND (stk #>> '{lotes,0,lote}') = 'ZZ20-001' AND (stk #>> '{lotes,0,edad_pond}')::numeric = 29
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T7 lote: ' || COALESCE(tl ->> 'saldo', '∅') || ' / ' || COALESCE(stk ->> 'lotes', '∅')); END IF;

  -- T8: la cobertura informa las hojas nuevas con su etiqueta
  IF cv #>> '{hojas,TRASPASO_SAL,etiqueta}' = 'TRASPASOS (salidas)' AND cv #>> '{hojas,CONSUMO,etiqueta}' = 'CONSUMOS'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T8 cobertura: ' || COALESCE(cv ->> 'hojas', '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C20 PASS (%/8)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C20 FAIL (%/8): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
