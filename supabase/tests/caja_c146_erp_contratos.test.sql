-- CAJA C146 — Contratos con el ERP: OT activa por último despacho (umbral y eventos que la reactivan), garantía con su
-- Error de contrato, corrección del cliente por RUC del ERP (cliente nuevo registrado, solo solicitudes abiertas,
-- historial, aviso, aplicación a cerradas y reversión por el Administrador), alta asistida, enlace E01 = E001 y cartera.
-- Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; other_id uuid; v_role uuid; v_role_carga uuid; up uuid; res jsonb; r jsonb; pass int := 0; fails text[] := '{}';
  ot text; ra text; rb text; v_site uuid; v_madre uuid; v_sub uuid; v_gar uuid; v_err uuid; v_cla uuid; v_clb uuid;
  r_open uuid; r_closed uuid; v_corr uuid; n int; hoy date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C146 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  SELECT site_id INTO v_site FROM public.contracts WHERE site_id IS NOT NULL LIMIT 1;
  IF v_site IS NULL THEN SELECT site_id INTO v_site FROM public.vehicles WHERE site_id IS NOT NULL LIMIT 1; END IF;
  INSERT INTO public.user_site_access (user_id, site_id) VALUES (admin_id, v_site) ON CONFLICT DO NOTHING;

  -- OT y dos RUC válidos (dígito verificador SUNAT) que no existan
  LOOP ot := (70000 + floor(random() * 9999))::int::text; EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE ot || '%'); END LOOP;
  FOR n IN 1..2 LOOP
    LOOP
      rb := '20' || lpad((floor(random() * 99999999))::bigint::text, 8, '0');
      SELECT rb || g.k INTO rb FROM generate_series(0, 9) g(k) WHERE public.is_valid_ruc(rb || g.k) LIMIT 1;
      EXIT WHEN rb IS NOT NULL AND length(rb) = 11 AND NOT EXISTS (SELECT 1 FROM public.clients c
        WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = rb);
    END LOOP;
    IF n = 1 THEN ra := rb; END IF;
  END LOOP;

  -- ERP: madre (último despacho hace 200 días), subcontrato S001, errores E001/E002 (hace 300 días), garantía G01 (hace 10 días)
  up := (public.erp_upload_begin('CONTRATOS', 'C146.xlsx', now() - interval '1 hour', 5)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, (SELECT jsonb_agg(jsonb_build_object('linea', x.i + 1, 'nro_contrato', ot, 'nro_documento', x.doc, 'secuencia', 1,
      'tipo_documento', x.tipo, 'correlativo', ot || x.i, 'cliente', 'CLIENTE C146 ERP', 'ruc', rb, 'cod_producto', 'P146', 'producto', 'PRODUCTO',
      'unidad', 'UND', 'cant_contrato', 10, 'cant_despachada', 4, 'cant_reemplazada', 0, 'cant_pendiente', 6,
      'fecha_contrato', to_char(x.fc, 'YYYY-MM-DD'), 'fecha_vcto', to_char(x.fc + 17, 'YYYY-MM-DD'),
      'fecha_ult_despacho', CASE WHEN x.ud IS NOT NULL THEN to_char(x.ud, 'YYYY-MM-DD') END))
    FROM (VALUES (1, ot, 'CONTRATO DE VENTAS', hoy - 400, hoy - 200), (2, ot || '-S001', 'SUBCONTRATO DE VENTAS', hoy - 300, NULL::date),
                 (3, ot || '-E001', 'ERROR DE CONTRATO', hoy - 300, NULL), (4, ot || '-E002', 'ERROR DE CONTRATO', hoy - 300, NULL),
                 (5, ot || '-G01', 'GARANTIA DE VENTAS', hoy - 10, NULL)) x(i, doc, tipo, fc, ud)));
  PERFORM public.erp_upload_apply(up);

  -- TMS: cliente A, madre, subcontrato escrito sin ceros (S1), una solicitud abierta y una entregada
  SELECT x.id INTO v_cla FROM public.erp_cliente_por_ruc(ra, 'CLIENTE C146 TMS', true) x;
  INSERT INTO public.contracts (code, type, status, site_id, client_id) VALUES (ot, 'CONTRATO', 'ACTIVO', v_site, v_cla) RETURNING id INTO v_madre;
  INSERT INTO public.contracts (code, type, status, site_id, parent_contract_id) VALUES (ot || '-S1', 'SUBCONTRATO', 'ACTIVO', v_site, v_madre) RETURNING id INTO v_sub;
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, requester_name, department, request_type, cargo_description,
    pickup_address, pickup_district, delivery_address, delivery_district, delivery_zone, required_date, required_at) VALUES
    ('ZZ-C146-A', 'APROBADA', v_site, v_madre, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', 'LIMA', hoy + 10, ((hoy + 10) + time '10:00') AT TIME ZONE 'America/Lima')
  RETURNING id INTO r_open;
  INSERT INTO public.transport_requests (request_number, status, site_id, contract_id, requester_name, department, request_type, cargo_description,
    pickup_address, pickup_district, delivery_address, delivery_district, delivery_zone, required_date, required_at) VALUES
    ('ZZ-C146-C', 'ENTREGADA', v_site, v_madre, 'ZZ', 'Logística', 'DESPACHO', 'Carga de prueba', 'Planta', 'Lurín', 'Obra', 'Ate', 'LIMA', hoy + 10, ((hoy + 10) + time '10:00') AT TIME ZONE 'America/Lima')
  RETURNING id INTO r_closed;
  PERFORM public.erp_contratos_config_set('{"umbral_dias": 90, "corte_max_horas": 48, "reactivan": ["GARANTIA","SUBCONTRATO","ERROR","SOLICITUD_TMS"]}');

  -- T1 actividad: la garantía reciente reactiva la OT; sin eventos queda inactiva; con 365 días cuenta el despacho.
  --    S1 del TMS enlaza con S001 del ERP; los errores y la garantía aparecen sin alta; el cliente difiere.
  res := public.erp_ref_contratos(ARRAY[ot, ot || '-S1']);
  r := res->'filas'->ot;
  IF (r->>'activa')::boolean AND r->>'motivo' = 'GARANTIA' AND (res->'filas'->(ot || '-S1')->>'en_erp')::boolean
     AND r->'hijos_sin_alta' = jsonb_build_array(ot || '-E001', ot || '-E002', ot || '-G01')
     AND r->'diferencias' ? 'CLIENTE_DISTINTO' AND r->'diferencias' ? 'HIJOS_SIN_ALTA' AND (r->>'ruc_valido')::boolean
     AND (r->>'avance')::numeric = 0.4 AND r->>'estado_erp' = 'PARCIAL'
  THEN pass := pass + 1; ELSE fails := fails || ('T1a actividad/enlace: ' || res::text); END IF;
  PERFORM public.erp_contratos_config_set('{"umbral_dias": 90, "reactivan": ["ERROR"]}');
  r := public.erp_ref_contratos(ARRAY[ot])->'filas'->ot;
  IF (r->>'activa')::boolean THEN fails := fails || ('T1b sin eventos debía quedar inactiva: ' || r::text); END IF;
  PERFORM public.erp_contratos_config_set('{"umbral_dias": 365, "reactivan": []}');
  r := public.erp_ref_contratos(ARRAY[ot])->'filas'->ot;
  IF NOT ((r->>'activa')::boolean AND r->>'motivo' = 'DESPACHO') THEN fails := fails || ('T1c umbral 365: ' || r::text); ELSE pass := pass + 1; END IF;
  PERFORM public.erp_contratos_config_set('{"umbral_dias": 90, "reactivan": ["GARANTIA","SUBCONTRATO","ERROR","SOLICITUD_TMS"]}');

  -- T2 garantía: sin partida propia y con su Error de contrato (siguiente libre después de E002 del ERP)
  res := public.create_contract(jsonb_build_object('code', ot || '-G01', 'type', 'GARANTIA', 'parent_contract_id', v_madre), 100);
  IF (res->>'success')::boolean THEN fails := fails || 'T2 garantía con partida debía rechazarse'::text; END IF;
  res := public.create_contract(jsonb_build_object('code', ot || '-G01', 'type', 'GARANTIA', 'parent_contract_id', v_madre), 0);
  v_gar := (res->>'id')::uuid; v_err := (res->'error_generado'->>'id')::uuid;
  r := public.erp_ref_contratos(ARRAY[ot || '-G01', ot || '-E003'])->'filas';
  IF (res->>'success')::boolean AND res->'error_generado'->>'code' = ot || '-E003'
     AND (SELECT garantia_id FROM public.contracts WHERE id = v_err) = v_gar
     AND NOT EXISTS (SELECT 1 FROM public.contract_budgets WHERE contract_id = v_gar)
     AND (SELECT client_id FROM public.contracts WHERE id = v_gar) = v_cla
     AND r->(ot || '-G01')->>'garantia_error' = ot || '-E003' AND (r->(ot || '-G01')->>'en_erp')::boolean
     AND NOT (r->(ot || '-G01')->'diferencias' ? 'GARANTIA_SIN_ERROR')
     AND r->(ot || '-E003')->>'error_de_garantia' = ot || '-G01' AND r->(ot || '-E003')->'diferencias' ? 'NO_EN_ERP'
  THEN pass := pass + 1; ELSE fails := fails || ('T2 garantía: ' || res::text || ' ' || COALESCE(r::text, '')); END IF;

  -- T3 corrección: simulación sin cambios; luego un usuario de carga ERP (no Administrador) corrige: cliente B registrado,
  --    familia y solicitud abierta con B, la entregada conserva A, historial y aviso; la validación diferida no falla
  INSERT INTO public.roles (name, permissions) VALUES ('C146 Carga ' || ot, '["apt-carga:write"]'::jsonb) RETURNING id INTO v_role_carga;
  SELECT id INTO other_id FROM public.profiles WHERE is_active AND id <> admin_id ORDER BY created_at LIMIT 1;
  IF other_id IS NULL THEN RAISE EXCEPTION 'CAJA C146 FAIL: falta un segundo perfil activo'; END IF;
  UPDATE public.profiles SET role_id = v_role_carga WHERE id = other_id;
  res := public.erp_contratos_sincronizar_clientes(true);
  IF NOT ((res->>'corregidas')::int >= 1 AND (SELECT client_id FROM public.contracts WHERE id = v_madre) = v_cla) THEN
    fails := fails || ('T3a simulación: ' || res::text); END IF;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  res := public.erp_contratos_sincronizar_clientes(false);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  SELECT client_id INTO v_clb FROM public.contracts WHERE id = v_madre;
  SELECT id INTO v_corr FROM public.contract_client_corrections WHERE contract_id = v_madre;
  IF (res->>'success')::boolean AND (res->>'errores')::int = 0 AND v_clb IS DISTINCT FROM v_cla
     AND public.client_tax_id_norm((SELECT COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc') FROM public.clients c WHERE c.id = v_clb)) = rb
     AND (SELECT client_id FROM public.contracts WHERE id = v_sub) = v_clb AND (SELECT client_id FROM public.contracts WHERE id = v_err) = v_clb
     AND (SELECT client_id FROM public.transport_requests WHERE id = r_open) = v_clb
     AND (SELECT client_id FROM public.transport_requests WHERE id = r_closed) = v_cla
     AND (SELECT client_created AND old_client_id = v_cla AND r_open = ANY (open_request_ids) AND r_closed = ANY (kept_request_ids)
          FROM public.contract_client_corrections WHERE id = v_corr)
     AND EXISTS (SELECT 1 FROM public.notifications WHERE dedupe_key = 'ot-cliente:' || v_corr AND evento = 'OT_CLIENTE_CORREGIDO')
  THEN pass := pass + 1; ELSE fails := fails || ('T3b corrección: ' || res::text); END IF;
  res := public.erp_contratos_sincronizar_clientes(false);
  IF (SELECT count(*) FROM public.contract_client_corrections WHERE contract_id = v_madre) <> 1 THEN fails := fails || ('T3c repetida: ' || res::text); END IF;

  -- T4 Administrador: aplicar a las cerradas, revertir y no volver a corregir con el mismo RUC
  res := public.erp_cliente_correccion_aplicar_cerradas(v_corr, 'Pedido de Comercial');
  IF NOT ((res->>'actualizadas')::int = 1 AND (SELECT client_id FROM public.transport_requests WHERE id = r_closed) = v_clb) THEN
    fails := fails || ('T4a cerradas: ' || res::text); END IF;
  res := public.erp_cliente_correccion_revertir(v_corr, 'Prueba de reversión');
  r := public.erp_contratos_sincronizar_clientes(false);
  IF (res->>'success')::boolean AND (SELECT client_id FROM public.contracts WHERE id = v_madre) = v_cla
     AND (SELECT client_id FROM public.contracts WHERE id = v_sub) = v_cla
     AND (SELECT client_id FROM public.transport_requests WHERE id = r_open) = v_cla
     AND (SELECT client_id FROM public.transport_requests WHERE id = r_closed) = v_cla
     AND (r->>'omitidas_revertidas')::int >= 1 AND (SELECT client_id FROM public.contracts WHERE id = v_madre) = v_cla
  THEN pass := pass + 1; ELSE fails := fails || ('T4 aplicar/revertir: ' || res::text || ' ' || r::text); END IF;

  -- T5 alta asistida: documento sin alta, prellenado (E1 = E001) y cliente del ERP ya registrado
  res := public.erp_ref_sin_alta(jsonb_build_object('q', ot, 'solo_activas', false));
  r := public.erp_ref_documento(ot || '-E1');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(res->'filas') x WHERE x->>'documento' = ot || '-E001' AND x->>'tipo' = 'ERROR' AND (x->>'madre_en_tms')::boolean)
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(res->'filas') x WHERE x->>'documento' IN (ot || '-S001', ot || '-G01'))
     AND (r->>'en_erp')::boolean AND r->>'tipo' = 'ERROR' AND r->>'sufijo' = 'E001' AND NOT (r->>'ya_en_tms')::boolean
     AND (r->>'madre_id')::uuid = v_madre AND (r->>'client_id')::uuid = v_clb
     AND (public.erp_cliente_desde_erp(ot)->>'client_id')::uuid = v_clb
  THEN pass := pass + 1; ELSE fails := fails || ('T5 alta asistida: ' || res::text || ' ' || r::text); END IF;

  -- T6 cartera y permisos: un Administrador de Contratos sin la OT asignada no la ve; solo el Administrador configura,
  --    aplica o revierte; sin carga ERP no se sincroniza; anon no ejecuta
  INSERT INTO public.roles (name, permissions) VALUES ('C146 Cartera ' || ot, '["cartera-propia", "ot:write"]'::jsonb) RETURNING id INTO v_role;
  UPDATE public.profiles SET role_id = v_role WHERE id = other_id;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  IF (public.erp_ref_ot(ot)->>'success')::boolean OR (public.erp_ref_contratos(ARRAY[ot])->'filas') <> '{}'::jsonb
     OR (public.erp_ref_documento(ot || '-E1')->>'success')::boolean
     OR (public.erp_contratos_config_set('{"umbral_dias": 30}')->>'success')::boolean
     OR (public.erp_cliente_correccion_revertir(v_corr, 'sin permiso')->>'success')::boolean
     OR (public.erp_contratos_sincronizar_clientes(true)->>'success')::boolean
     OR has_function_privilege('anon', 'public.erp_ref_contratos(text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.erp_contratos_sincronizar_clientes(boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.erp_cliente_por_ruc(text, text, boolean)', 'EXECUTE')
  THEN fails := fails || 'T6 cartera/permisos'::text; ELSE pass := pass + 1; END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C146 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C146 PASS (7/7) Contratos con el ERP: actividad por último despacho y eventos, garantía con su Error, corrección de cliente con historial y aviso, alta asistida y cartera';
END $test$;
ROLLBACK;
