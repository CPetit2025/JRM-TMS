-- CAJA C17 — APT: cliente del lote (guías del lote, de su OT o Contratos) y análisis por cliente, OT y lote
-- Se ejecuta dentro de un bloque que siempre se revierte: no deja datos. Usa fechas de 2001 y fecha de corte manual
-- 31/01/2001, así el modelo de la prueba no mezcla movimientos reales.
CREATE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(p_user::text, ''), true);
  PERFORM set_config('role', CASE WHEN p_user IS NULL THEN 'none' ELSE 'authenticated' END, true);
END $$;

DO $test$
DECLARE
  v_loader uuid; v_viewer uuid; v_none uuid; v_role uuid;
  r jsonb; r_none jsonb; r_view jsonb; v_up uuid; v_up2 uuid; d jsonb; q jsonb; lo jsonb;
  v_ent jsonb; v_sal jsonb;
  v_fail text[] := '{}';
  v_pass int := 0;
BEGIN
  SELECT id INTO v_loader FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) ORDER BY id LIMIT 1;
  SELECT id INTO v_viewer FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id <> v_loader ORDER BY id LIMIT 1;
  SELECT id INTO v_none FROM public.profiles WHERE id IN (SELECT u.id FROM auth.users u)
    AND id NOT IN (SELECT dr.profile_id FROM public.drivers dr WHERE dr.profile_id IS NOT NULL) AND id NOT IN (v_loader, v_viewer) ORDER BY id LIMIT 1;
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C17 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C17 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C17 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_viewer;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C17 nada', '["ot"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_none;

  v_ent := jsonb_build_array(
    jsonb_build_object('__row', 2, 'TIPODOCTO', 'P/E PRODUCCION ACT.', 'BODEGA', '647-04  ALM PT', 'Numero', 1, 'Fecha', '2001-01-02', 'Producto', 'zzp.a ',
      'GLOSA', 'POSTE  ZZ A', 'Cantidad', 10, 'UNIDAD', 'UND', 'DocRel', 'ORDEN DE PRODUCCION', 'NumRel', 'ZZ16-001-001', 'Lote', 'ZZ16-001',
      'FechaEntrega', '2001-01-01', 'Comentario', 'IPT: 003-000001', 'PesoUnitario', 100, 'PesoTotalProduccido', 1000),
    jsonb_build_object('__row', 3, 'Numero', 2, 'Fecha', '2001-01-10', 'Producto', 'ZZP.A', 'GLOSA', 'POSTE ZZ A', 'Cantidad', 5, 'UNIDAD', 'UND',
      'NumRel', 'ZZ16-001-002', 'PesoUnitario', 100, 'PesoTotalProduccido', 500),
    jsonb_build_object('__row', 4, 'Numero', 3, 'Fecha', '2001-01-05', 'Producto', 'ZZP.B', 'GLOSA', 'VIGA ZZ B', 'Cantidad', 3,
      'NumRel', 'ZZ16-001-S001-005', 'PesoTotalProduccido', 300),
    jsonb_build_object('__row', 5, 'Numero', 4, 'Fecha', 36895, 'Producto', 'ZZP.C', 'GLOSA', 'ANGULO ZZ C', 'Cantidad', 2,
      'NumRel', 990001, 'PesoTotalProduccido', 200),
    jsonb_build_object('__row', 6, 'Cantidad', 99999));
  v_sal := jsonb_build_array(
    jsonb_build_object('__row', 2, 'Numero', 'T001-1', 'Fecha', '2001-01-20', 'RazonSocial', 'ZZ CLIENTE', 'Producto', 'ZZP.A', 'Cantidad', -12,
      'DocRel', 'CONTRATO DE VENTAS', 'NumRel', 'ZZ16-001', 'PesoTotalProduccido', 1200),
    jsonb_build_object('__row', 3, 'Numero', 'T001-2', 'Fecha', '2001-01-25', 'Producto', 'ZZP.A', 'Cantidad', -1,
      'DocRel', 'ERROR DE CONTRATO', 'NumRel', 'ZZ16-001-E001', 'Lote', 'ZZ16-001', 'PesoTotalProduccido', 100),
    jsonb_build_object('__row', 4, 'Numero', 'T001-3', 'Fecha', '2001-01-21', 'Producto', 'ZZP.X', 'Cantidad', -50,
      'DocRel', 'CONTRATO DE VENTAS', 'NumRel', 'ZZ16-001', 'PesoTotalProduccido', 50),
    jsonb_build_object('__row', 5, 'Numero', 'T001-4', 'Fecha', '2001-01-22', 'Producto', 'ZZP.A', 'Cantidad', -1,
      'DocRel', 'CONTRATO DE VENTAS', 'NumRel', 'ZZ16-999', 'PesoTotalProduccido', 70),
    jsonb_build_object('__row', 6, 'Numero', 'T001-5', 'Fecha', '04/01/2001', 'Producto', 'ZZP.C', 'Cantidad', -3,
      'DocRel', 'CONTRATO DE VENTAS', 'NumRel', 990001, 'PesoTotalProduccido', 250),
    jsonb_build_object('__row', 7, 'Numero', 'T001-6', 'Fecha', '2001-01-02', 'Producto', 'ZZP.B', 'Cantidad', -1,
      'DocRel', 'SUBCONTRATO DE VENTAS', 'NumRel', 'ZZ16-001-S001', 'PesoTotalProduccido', 100),
    jsonb_build_object('__row', 8, 'Cantidad', -6945799.12, 'Cantidad 2', 6945799.12));

  -- Lote ZZ17-001 (despachado a ZZ CLIENTE A), ZZ17-001-S001 (sin guías: toma el cliente de su OT) y ZZ18-900 (sin guías ni OT con guías)
  v_ent := jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-02', 'Producto', 'ZZQ.A', 'NumRel', 'ZZ17-001-001', 'PesoTotalProduccido', 1000),
    jsonb_build_object('__row', 3, 'Fecha', '2001-01-03', 'Producto', 'ZZQ.B', 'NumRel', 'ZZ17-001-S001-001', 'PesoTotalProduccido', 400),
    jsonb_build_object('__row', 4, 'Fecha', '2001-01-04', 'Producto', 'ZZQ.C', 'NumRel', 'ZZ18-900-001', 'PesoTotalProduccido', 300));
  v_sal := jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-10', 'Producto', 'ZZQ.A', 'NumRel', 'ZZ17-001', 'RazonSocial', 'ZZ CLIENTE A', 'PesoTotalProduccido', 600),
    jsonb_build_object('__row', 3, 'Fecha', '2001-01-15', 'Producto', 'ZZQ.X', 'NumRel', 'ZZ17-001', 'RazonSocial', 'ZZ CLIENTE A', 'PesoTotalProduccido', 5),
    jsonb_build_object('__row', 4, 'Fecha', '2001-01-12', 'Producto', 'ZZQ.A', 'NumRel', 'ZZ17-001', 'RazonSocial', 'ZZ CLIENTE B', 'PesoTotalProduccido', 100));

  PERFORM pg_temp.as_user(v_loader);
  PERFORM public.apt_save_settings('{"cutoff_date":"2001-01-31","tolerance":0.02,"alert_days":60}'::jsonb);
  v_up := (public.apt_upload_begin('ZZ C17.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up, 'ENTRADA', v_ent);
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', v_sal);
  PERFORM public.apt_upload_apply(v_up, false);
  PERFORM public.apt_model_rebuild();
  PERFORM pg_temp.as_user(v_viewer);
  r := public.apt_detail('{"contratos":["ZZ17"]}'::jsonb, 'contrato', 'kg_saldo', true, 10, 0);
  d := public.apt_detail('{"lote":"ZZ1"}'::jsonb, 'cliente', 'clave', false, 10, 0);
  lo := public.apt_detail('{"clientes":["ZZ CLIENTE A"]}'::jsonb, 'lote', 'clave', false, 10, 0);
  PERFORM pg_temp.as_user(NULL);

  -- T1: cliente por guías del lote (mayor TN), por guías de su OT y sin cliente
  IF (SELECT cliente = 'ZZ CLIENTE A' AND cliente_fuente = 'GUIAS_LOTE' FROM public.apt_layers WHERE lote = 'ZZ17-001')
     AND (SELECT cliente = 'ZZ CLIENTE A' AND cliente_fuente = 'GUIAS_OT' FROM public.apt_layers WHERE lote = 'ZZ17-001-S001')
     AND (SELECT cliente IS NULL FROM public.apt_layers WHERE lote = 'ZZ18-900')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T1 cliente del lote'::text; END IF;

  -- T2: OT madre agrupa sus lotes: primer ingreso, último despacho (cualquier guía) y saldo final
  IF (r ->> 'total')::int = 1 AND (r #>> '{rows,0,clave}') = 'ZZ17' AND (r #>> '{rows,0,lotes}')::int = 2
     AND (r #>> '{rows,0,primer_ingreso}') = '2001-01-02' AND (r #>> '{rows,0,ultimo_despacho}') = '2001-01-15'
     AND (r #>> '{rows,0,tn_saldo}')::numeric = 0.7 AND (r #>> '{rows,0,cliente}') = 'ZZ CLIENTE A'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 OT: ' || COALESCE(r::text, '∅')); END IF;

  -- T3: por cliente (incluye "sin cliente identificado") y filtro exacto por cliente
  IF (d ->> 'total')::int = 2
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'rows') e WHERE e ->> 'clave' = 'ZZ CLIENTE A' AND (e ->> 'tn_saldo')::numeric = 0.7 AND (e ->> 'contratos')::int = 1)
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(d -> 'rows') e WHERE e ->> 'clave' = '(Sin cliente identificado)' AND (e ->> 'tn_saldo')::numeric = 0.3)
     AND (lo ->> 'total')::int = 2
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 cliente: ' || COALESCE(d::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C17 PASS (%/3)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C17 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
