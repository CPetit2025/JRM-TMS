-- CAJA C16 — APT: carga de ENTRADA/SALIDA, normalización del lote, FIFO, clases de salida, conciliación y reemplazo diario
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
  IF v_none IS NULL THEN RAISE EXCEPTION 'CAJA C16 FAIL: se requieren 3 perfiles'; END IF;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C16 carga', '["apt-carga"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_loader;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C16 ver', '["apt:read"]') RETURNING id INTO v_role;
  UPDATE public.profiles SET is_active = true, role_id = v_role WHERE id = v_viewer;
  INSERT INTO public.roles (name, permissions) VALUES ('ZZ APT C16 nada', '["ot"]') RETURNING id INTO v_role;
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

  -- T1: permisos — sin permiso no ve ni carga; con "apt:read" ve pero no carga; con "apt-carga" carga
  PERFORM pg_temp.as_user(v_none);
  r_none := public.apt_dashboard('{}'::jsonb, 'semana');
  r := public.apt_upload_begin('zz.xlsx');
  PERFORM pg_temp.as_user(v_viewer);
  r_view := public.apt_upload_begin('zz.xlsx');
  d := public.apt_get_settings();
  PERFORM pg_temp.as_user(NULL);
  IF NOT (r_none ->> 'success')::boolean AND NOT (r ->> 'success')::boolean AND NOT (r_view ->> 'success')::boolean
     AND (d ->> 'success')::boolean AND NOT (d ->> 'can_load')::boolean
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T1 permisos: ' || r_none::text || ' | ' || r_view::text); END IF;

  -- T2: carga y normalización (lote derivado del NumRel, NumRel numérico, fecha serial y dd/mm/aaaa, filas excluidas)
  PERFORM pg_temp.as_user(v_loader);
  PERFORM public.apt_save_settings('{"cutoff_date":"2001-01-31","tolerance":0.02,"alert_days":60}'::jsonb);
  v_up := (public.apt_upload_begin('ZZ C16.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up, 'ENTRADA', v_ent);
  PERFORM public.apt_upload_rows(v_up, 'SALIDA', v_sal);
  r := public.apt_upload_apply(v_up);
  PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND (r #>> '{summary,entrada,validas}')::int = 4 AND (r #>> '{summary,entrada,excluidas}')::int = 1
     AND (r #>> '{summary,salida,validas}')::int = 6 AND (r #>> '{summary,salida,excluidas}')::int = 1
     AND (SELECT lote = 'ZZ16-001' AND lote_derivado AND producto = 'ZZP.A' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 3 AND kind = 'ENTRADA')
     AND (SELECT lote = 'ZZ16-001-S001' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 4 AND kind = 'ENTRADA')
     AND (SELECT lote = '990001' AND fecha = DATE '2001-01-04' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 5 AND kind = 'ENTRADA')
     AND (SELECT ipt = '003-000001' AND glosa = 'POSTE ZZ A' AND familia = 'POSTE' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 2 AND kind = 'ENTRADA')
     AND (SELECT lote = 'ZZ16-001' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 3 AND kind = 'SALIDA')
     AND (SELECT fecha = DATE '2001-01-04' AND lote = '990001' FROM public.apt_movements WHERE upload_id = v_up AND row_no = 6 AND kind = 'SALIDA')
     AND (SELECT raw ->> 'Cantidad 2' = '6945799.12' AND NOT valid FROM public.apt_movements WHERE upload_id = v_up AND row_no = 8 AND kind = 'SALIDA')
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T2 normalización: ' || COALESCE(r::text, '∅')); END IF;

  -- T3: FIFO por lote y producto — la salida consume primero el ingreso más antiguo; saldo con la fecha de su capa
  IF (SELECT kg_out = 1000 AND kg_saldo = 0 AND estado = 'Despachado' AND dias = 18 FROM public.apt_layers l JOIN public.apt_movements m ON m.id = l.movement_id
        WHERE m.upload_id = v_up AND m.kind = 'ENTRADA' AND m.row_no = 2)
     AND (SELECT kg_out = 300 AND kg_saldo = 200 AND estado = 'Salida parcial' AND dias_saldo = 21 AND tn_dias = 4.2
            AND rango = (SELECT label FROM public.apt_aging_ranges WHERE desde <= 21 ORDER BY desde DESC LIMIT 1)
          FROM public.apt_layers l JOIN public.apt_movements m ON m.id = l.movement_id WHERE m.upload_id = v_up AND m.kind = 'ENTRADA' AND m.row_no = 3)
     AND (SELECT estado = 'Problema de información' AND kg_out_before_in = 100 FROM public.apt_layers l JOIN public.apt_movements m ON m.id = l.movement_id
          WHERE m.upload_id = v_up AND m.kind = 'ENTRADA' AND m.row_no = 4)
     AND (SELECT estado = 'Despachado' FROM public.apt_layers l JOIN public.apt_movements m ON m.id = l.movement_id
          WHERE m.upload_id = v_up AND m.kind = 'ENTRADA' AND m.row_no = 5)
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || 'T3 FIFO'::text; END IF;

  -- T4: clases de salida, conciliación y consultas (dashboard, detalle por lote, ficha)
  PERFORM pg_temp.as_user(v_viewer);
  q := public.apt_quality();
  d := public.apt_dashboard('{"lote":"ZZ16-001"}'::jsonb, 'dia');
  lo := public.apt_lote('zz16-001');
  r := public.apt_detail('{"tipos":["SUBCONTRATO"]}'::jsonb, 'lote', 'kg_saldo', true, 10, 0);
  PERFORM pg_temp.as_user(NULL);
  IF (SELECT array_agg(c.clase ORDER BY m.row_no) = ARRAY['ASIGNADA', 'ASIGNADA', 'OTRO_PRODUCTO_DEL_LOTE', 'LOTE_SIN_INGRESO', 'EXCEDE_INGRESO', 'ASIGNADA']
        FROM public.apt_exit_class c JOIN public.apt_movements m ON m.id = c.exit_id WHERE m.upload_id = v_up)
     AND (SELECT kg_sin_entrada = 50 FROM public.apt_exit_class c JOIN public.apt_movements m ON m.id = c.exit_id WHERE m.upload_id = v_up AND m.row_no = 6)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q -> 'conciliacion') e WHERE e ->> 'estado' <> 'OK')
     AND (d #>> '{kpis,tn_saldo}')::numeric = 0.4 AND (d #>> '{kpis,lotes_activos}')::int = 2
     AND (lo #>> '{resumen,estado}') = 'Salida parcial' AND (lo #>> '{resumen,dias}')::int = 21 AND jsonb_array_length(lo -> 'capas') = 2
     AND jsonb_array_length(lo -> 'salidas') = 3 AND (r #>> '{rows,0,clave}') = 'ZZ16-001-S001'
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T4 clases/conciliación/consultas: ' || COALESCE(q ->> 'conciliacion', '∅') || ' | ' || COALESCE(d ->> 'kpis', '∅')); END IF;

  -- T5: una carga posterior reemplaza las salidas de su rango de fechas (sin duplicar) y recalcula el FIFO
  PERFORM pg_temp.as_user(v_loader);
  v_up2 := (public.apt_upload_begin('ZZ C16 dia.xlsx') ->> 'id')::uuid;
  PERFORM public.apt_upload_rows(v_up2, 'SALIDA', jsonb_build_array(
    jsonb_build_object('__row', 2, 'Numero', 'T001-1', 'Fecha', '2001-01-20', 'Producto', 'ZZP.A', 'NumRel', 'ZZ16-001', 'PesoTotalProduccido', 1500),
    jsonb_build_object('__row', 3, 'Numero', 'T001-9', 'Fecha', '2001-01-25', 'Producto', 'ZZP.B', 'NumRel', 'ZZ16-001-S001', 'PesoTotalProduccido', 10)));
  r := public.apt_upload_apply(v_up2);
  PERFORM pg_temp.as_user(NULL);
  IF (r ->> 'success')::boolean AND (r #>> '{summary,salida,reemplazadas}')::int = 5  -- 4 del rango + la fila totalizadora (sin fecha) de la carga anterior
     AND (SELECT count(*) FROM public.apt_movements WHERE kind = 'SALIDA' AND active AND upload_id IN (v_up, v_up2)) = 4
     AND (SELECT sum(kg_saldo) FROM public.apt_layers WHERE lote = 'ZZ16-001') = 0
     AND (SELECT kg_saldo FROM public.apt_layers WHERE lote = 'ZZ16-001-S001') = 190
     AND (SELECT count(*) FROM public.apt_movements WHERE kind = 'ENTRADA' AND active AND upload_id = v_up) = 5
  THEN v_pass := v_pass + 1; ELSE v_fail := v_fail || ('T5 reemplazo diario: ' || COALESCE(r::text, '∅')); END IF;

  IF array_length(v_fail, 1) IS NULL THEN
    RAISE EXCEPTION 'CAJA C16 PASS (%/5)', v_pass;
  ELSE
    RAISE EXCEPTION 'CAJA C16 FAIL (%/5): %', v_pass, array_to_string(v_fail, ' || ');
  END IF;
END $test$;
