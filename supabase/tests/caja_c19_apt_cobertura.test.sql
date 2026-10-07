-- CAJA C19 — APT: cargas consecutivas se consolidan y la cobertura alerta huecos en la secuencia de fechas
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
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C19 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C19 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C19 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_viewer;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C19 nada', '["ot"]') RETURNING id INTO v_role;
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

  PERFORM pg_temp.as_user(v_loader);
  PERFORM public.apt_save_settings('{"cutoff_date":"2001-01-31","tolerance":0.02,"alert_days":60}'::jsonb);
  -- Carga 1: del 02/01 al 10/01 · Carga 2: del 11/01 al 15/01 (fechas nuevas: se suman)
  v_up := (public.apt_upload_begin('ZZ C19 a.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up, 'ENTRADA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-02', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001-001', 'PesoTotalProduccido', 500),
    jsonb_build_object('__row', 3, 'Fecha', '2001-01-10', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001-002', 'PesoTotalProduccido', 500)));
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-03', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001', 'PesoTotalProduccido', 300)));
  PERFORM public.apt_upload_apply(v_up, false);
  v_up2 := (public.apt_upload_begin('ZZ C19 b.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up2, 'ENTRADA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-11', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001-003', 'PesoTotalProduccido', 200),
    jsonb_build_object('__row', 3, 'Fecha', '2001-01-15', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001-004', 'PesoTotalProduccido', 100)));
  PERFORM public.apt_upload_rows(v_up2, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'Fecha', '2001-01-15', 'Producto', 'ZZR.A', 'NumRel', 'ZZ19-001', 'PesoTotalProduccido', 100)));
  r := public.apt_upload_apply(v_up2, false);
  PERFORM public.apt_model_rebuild();
  PERFORM pg_temp.as_user(v_viewer);
  d := public.apt_coverage(NULL);
  q := public.apt_coverage('{"ENTRADA":{"desde":"2001-01-20","hasta":"2001-01-25"}}'::jsonb);
  lo := public.apt_detail('{"lotes":["ZZ19-001"]}'::jsonb, 'lote', 'clave', false, 5, 0);
  PERFORM pg_temp.as_user(NULL);

  -- T1: la segunda carga no reemplaza la primera; el análisis contempla ambas
  IF (r #>> '{summary,entrada,reemplazadas}')::int = 0
     AND (SELECT count(*) FROM public.apt_movements WHERE active AND upload_id IN (v_up, v_up2)) = 6
     AND (lo #>> '{rows,0,tn_in}')::numeric = 1.3 AND (lo #>> '{rows,0,tn_saldo}')::numeric = 0.9
     AND (lo #>> '{rows,0,primer_ingreso}') = '2001-01-02' AND (lo #>> '{rows,0,ultimo_despacho}') = '2001-01-15'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 consolidación: ' || COALESCE(lo::text, '∅')); END IF;

  -- T2: la cobertura une ambas cargas en un solo tramo, sin hueco entre ellas
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(d #> '{hojas,ENTRADA,rangos}') e WHERE e ->> 'desde' = '2001-01-02' AND e ->> 'hasta' = '2001-01-15')
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d #> '{hojas,ENTRADA,huecos}') e WHERE (e ->> 'desde')::date < DATE '2001-01-15')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 cobertura: ' || COALESCE(d ->> 'hojas', '∅')); END IF;

  -- T3: una carga que empieza el 20/01 deja sin cargar del 16/01 al 19/01 y se alerta antes de confirmar
  IF (q #>> '{hojas,ENTRADA,preview,hueco_antes,desde}') = '2001-01-16' AND (q #>> '{hojas,ENTRADA,preview,hueco_antes,dias}')::int = 4
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(q -> 'alertas') a WHERE a ->> 'nivel' = 'error' AND a ->> 'mensaje' LIKE '%20/01/2001%')
     AND NOT (q ->> 'secuencia_ok')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T3 hueco previo: ' || COALESCE(q::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C19 PASS (%/3)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C19 FAIL (%/3): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
