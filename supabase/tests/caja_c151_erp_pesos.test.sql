-- CAJA C151 — Peso de cada OT desde el ERP: suma de cantidad × peso unitario (por SKU, del Stock) de las líneas con peso; se carga
-- donde el TMS no tiene peso, se actualiza si el peso vino del ERP y no pisa un peso escrito a mano; cuenta las líneas
-- sin peso (peso parcial). Siempre se revierte (termina en error a propósito).
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; v_site uuid; v_cli uuid; oa text; ob text; res jsonb; pass int := 0; fails text[] := '{}';
  hoy date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C151 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  SELECT site_id INTO v_site FROM public.contracts WHERE site_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  SELECT client_id INTO v_cli FROM public.contracts WHERE client_id IS NOT NULL AND parent_contract_id IS NULL LIMIT 1;
  LOOP oa := (60000 + floor(random() * 9999))::int::text; EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE oa || '%'); END LOOP;
  LOOP ob := (60000 + floor(random() * 9999))::int::text; EXIT WHEN ob <> oa AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE ob || '%'); END LOOP;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES (oa, 'CONTRATO', 'ACTIVO', v_site, v_cli), (ob, 'CONTRATO', 'ACTIVO', v_site, v_cli);
  EXECUTE 'UPDATE public.contracts SET total_weight_kg = 500 WHERE code = $1' USING ob;

  -- ERP: A con 10 × 2,5 kg + 4 × 5 kg + una línea sin peso (45 kg, parcial); B con 100 kg (B tiene 500 kg a mano)
  up := (public.erp_upload_begin('CONTRATOS', 'C151.xlsx', now() - interval '1 hour', 4)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, (SELECT jsonb_agg(jsonb_build_object('linea', x.i, 'nro_contrato', x.ot, 'nro_documento', x.ot, 'secuencia', x.i,
      'tipo_documento', 'CONTRATO DE VENTAS', 'correlativo', x.ot || x.i, 'cliente', 'CLIENTE C151', 'ruc', '20100000001', 'cod_producto', 'P151-' || x.i,
      'producto', 'PRODUCTO', 'unidad', 'UND', 'cant_contrato', x.cant, 'cant_despachada', 0, 'cant_reemplazada', 0, 'cant_pendiente', x.cant,
      'fecha_contrato', to_char(hoy - 10, 'YYYY-MM-DD'), 'fecha_vcto', to_char(hoy + 10, 'YYYY-MM-DD')))
    FROM (VALUES (1, oa, 10, 2.5), (2, oa, 4, 5), (3, oa, 7, NULL::numeric), (4, ob, 20, 5)) x(i, ot, cant, peso)));
  PERFORM public.erp_upload_apply(up);
  -- El peso unitario lo pone la carga por SKU (Stock del ERP o inventario); aquí se fija para la prueba
  UPDATE public.erp_contract_lines l SET peso_unit = x.peso
    FROM (VALUES (1, oa, 2.5), (2, oa, 5), (3, oa, NULL::numeric), (4, ob, 5)) x(i, ot, peso)
   WHERE l.import_id = public.erp_active_import('CONTRATOS') AND l.nro_documento = x.ot AND l.secuencia = x.i;

  -- T1 A recibe 45 kg (parcial: 1 línea sin peso); B conserva los 500 kg escritos a mano
  res := public.erp_contratos_pesos_core();
  IF (res->>'success')::boolean AND (SELECT to_jsonb(c)->>'total_weight_kg' FROM public.contracts c WHERE code = oa)::numeric = 45
     AND (SELECT to_jsonb(c)->>'total_weight_kg' FROM public.contracts c WHERE code = ob)::numeric = 500
     AND EXISTS (SELECT 1 FROM public.erp_contract_pesos p JOIN public.contracts c ON c.id = p.contract_id
                 WHERE c.code = oa AND p.kg = 45 AND p.lineas = 3 AND p.lineas_sin_peso = 1)
  THEN pass := pass + 1; ELSE fails := fails || ('T1 pesos: ' || res::text); END IF;

  -- T2 el ERP cambia: A (peso del ERP) se actualiza
  UPDATE public.erp_contract_lines SET peso_unit = 3 WHERE import_id = public.erp_active_import('CONTRATOS') AND nro_documento = oa AND secuencia = 1;
  res := public.erp_contratos_pesos_core();
  IF (SELECT to_jsonb(c)->>'total_weight_kg' FROM public.contracts c WHERE code = oa)::numeric = 50
     AND (SELECT to_jsonb(c)->>'total_weight_kg' FROM public.contracts c WHERE code = ob)::numeric = 500
  THEN pass := pass + 1; ELSE fails := fails || ('T2 actualización: ' || res::text); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C151 FAIL (%/2): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C151 PASS (%/2) Peso de cada OT desde el Actualizable sin pisar pesos manuales', pass;
END $test$;
ROLLBACK;
