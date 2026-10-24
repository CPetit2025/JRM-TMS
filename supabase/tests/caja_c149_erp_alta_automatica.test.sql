-- CAJA C149 — Alta automática desde el ERP: las OT activas del Actualizable que no existen en el TMS se dan de alta
-- (madre con su cliente por RUC, registrado si no existe; luego subcontratos y errores), la garantía y las OT inactivas
-- no; sin RUC válido la madre y sus hijos quedan pendientes; la simulación no crea nada; repetir no duplica.
-- Cliente de las OT en el APT: sin guía ni contrato en el TMS se toma del Actualizable. Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; res jsonb; pass int := 0; fails text[] := '{}'; oa text; ob text; oc text; rb text;
  v_madre uuid; n int; hoy date := (now() AT TIME ZONE 'America/Lima')::date;
BEGIN
  SELECT p.id INTO admin_id FROM public.profiles p JOIN public.roles ro ON ro.id = p.role_id
   WHERE p.is_active AND ro.name = 'Administrador' AND p.id IN (SELECT id FROM auth.users) ORDER BY p.created_at LIMIT 1;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C149 FAIL: falta un Administrador activo'; END IF;
  PERFORM set_config('request.jwt.claim.sub', admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- Tres OT libres y un RUC válido (dígito verificador SUNAT) que no exista
  LOOP oa := (80000 + floor(random() * 9999))::int::text; EXIT WHEN NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE oa || '%'); END LOOP;
  LOOP ob := (80000 + floor(random() * 9999))::int::text; EXIT WHEN ob <> oa AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE ob || '%'); END LOOP;
  LOOP oc := (80000 + floor(random() * 9999))::int::text; EXIT WHEN oc NOT IN (oa, ob) AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE oc || '%'); END LOOP;
  LOOP
    rb := '20' || lpad((floor(random() * 99999999))::bigint::text, 8, '0');
    SELECT rb || g.k INTO rb FROM generate_series(0, 9) g(k) WHERE public.is_valid_ruc(rb || g.k) LIMIT 1;
    EXIT WHEN rb IS NOT NULL AND length(rb) = 11 AND NOT EXISTS (SELECT 1 FROM public.clients c
      WHERE public.client_tax_id_norm(COALESCE(to_jsonb(c)->>'tax_id', to_jsonb(c)->>'ruc')) = rb);
  END LOOP;

  -- ERP: A activa (despacho hace 10 días) con S001, E001 y G01; B inactiva (despacho hace 400 días); C activa con RUC inválido
  up := (public.erp_upload_begin('CONTRATOS', 'C149.xlsx', now() - interval '1 hour', 7)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, (SELECT jsonb_agg(jsonb_build_object('linea', x.i, 'nro_contrato', x.ot, 'nro_documento', x.doc, 'secuencia', 1,
      'tipo_documento', x.tipo, 'correlativo', x.ot || x.i, 'cliente', x.cli, 'ruc', x.ruc, 'cod_producto', 'P149', 'producto', 'PRODUCTO',
      'unidad', 'UND', 'cant_contrato', 10, 'cant_despachada', 4, 'cant_reemplazada', 0, 'cant_pendiente', 6,
      'fecha_contrato', to_char(x.fc, 'YYYY-MM-DD'), 'fecha_vcto', to_char(x.fc + 17, 'YYYY-MM-DD'),
      'fecha_ult_despacho', CASE WHEN x.ud IS NOT NULL THEN to_char(x.ud, 'YYYY-MM-DD') END))
    FROM (VALUES (1, oa, oa, 'CONTRATO DE VENTAS', 'CLIENTE C149 A', rb, hoy - 200, hoy - 10),
                 (2, oa, oa || '-S001', 'SUBCONTRATO DE VENTAS', 'CLIENTE C149 A', rb, hoy - 100, NULL::date),
                 (3, oa, oa || '-E001', 'ERROR DE CONTRATO', 'CLIENTE C149 A', rb, hoy - 100, NULL),
                 (4, oa, oa || '-G01', 'GARANTIA DE VENTAS', 'CLIENTE C149 A', rb, hoy - 5, NULL),
                 (5, ob, ob, 'CONTRATO DE VENTAS', 'CLIENTE C149 B', rb, hoy - 500, hoy - 400),
                 (6, oc, oc, 'CONTRATO DE VENTAS', 'CLIENTE C149 C', '12345', hoy - 50, hoy - 20),
                 (7, oc, oc || '-S001', 'SUBCONTRATO DE VENTAS', 'CLIENTE C149 C', '12345', hoy - 30, NULL)) x(i, ot, doc, tipo, cli, ruc, fc, ud)));
  PERFORM public.erp_upload_apply(up);

  -- T1 simulación: cuenta sin crear nada
  res := public.erp_contratos_alta_automatica(true);
  IF (res->>'success')::boolean AND (res->>'madres')::int = 1 AND (res->>'hijos')::int = 2 AND (res->>'garantias')::int = 1
     AND (res->>'ruc_invalido')::int = 1 AND (res->>'sin_madre')::int = 1
     AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code LIKE oa || '%')
  THEN pass := pass + 1; ELSE fails := fails || ('T1 simulación: ' || res::text); END IF;

  -- T2 alta: madre con cliente registrado desde el ERP y sede; hijos colgados de la madre con su cliente; sin B, C ni G01
  res := public.erp_contratos_alta_automatica(false);
  SELECT c.id INTO v_madre FROM public.contracts c JOIN public.clients cl ON cl.id = c.client_id
   WHERE c.code = oa AND c.type = 'CONTRATO' AND c.parent_contract_id IS NULL AND c.site_id IS NOT NULL AND cl.business_name = 'CLIENTE C149 A';
  SELECT count(*) INTO n FROM public.contracts c
   WHERE c.parent_contract_id = v_madre AND c.code IN (oa || '-S001', oa || '-E001')
     AND c.client_id = (SELECT client_id FROM public.contracts WHERE id = v_madre)
     AND c.site_id = (SELECT site_id FROM public.contracts WHERE id = v_madre);
  IF (res->>'madres')::int = 1 AND (res->>'hijos')::int = 2 AND (res->>'clientes_creados')::int = 1 AND (res->>'errores')::int = 0
     AND v_madre IS NOT NULL AND n = 2
     AND NOT EXISTS (SELECT 1 FROM public.contracts WHERE code IN (oa || '-G01', ob, oc, oc || '-S001'))
     AND (SELECT count(*) FROM public.erp_contract_altas WHERE ot = oa) = 3
  THEN pass := pass + 1; ELSE fails := fails || ('T2 alta: ' || res::text || ' madre=' || COALESCE(v_madre::text, 'null') || ' hijos=' || n); END IF;

  -- T3 repetir no duplica
  res := public.erp_contratos_alta_automatica(false);
  IF (res->>'madres')::int = 0 AND (res->>'hijos')::int = 0 AND (SELECT count(*) FROM public.contracts WHERE code LIKE oa || '%') = 3
  THEN pass := pass + 1; ELSE fails := fails || ('T3 repetir: ' || res::text); END IF;

  -- T4 cliente en el APT: C no tiene guía ni contrato en el TMS → cliente del Actualizable; la lista del APT lo usa
  IF public.inv_ot_cliente(oc) = 'CLIENTE C149 C' AND EXISTS (SELECT 1 FROM public.erp_ot_cliente_erp() e WHERE e.ot = oc AND e.cliente = 'CLIENTE C149 C')
     AND position('erp_ot_cliente_erp' IN pg_get_functiondef('public.inv_contratos_refresh(timestamptz)'::regprocedure)) > 0
  THEN pass := pass + 1; ELSE fails := fails || ('T4 cliente APT: ' || COALESCE(public.inv_ot_cliente(oc), 'null')); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C149 FAIL (%/4): %', pass, array_to_string(fails, ' | '); END IF;
  -- El despliegue exige PASS y una excepción deliberada para revertir el escenario completo.
  RAISE EXCEPTION 'CAJA C149 PASS (%/4)', pass;
END $test$;
ROLLBACK;
