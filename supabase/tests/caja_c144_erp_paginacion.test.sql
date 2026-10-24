-- CAJA C144 — ERP análisis: con más de 20.000 documento-producto, una sola consulta no alcanza (tope 20.000) y la
-- exportación por páginas con orden estable recorre todas las filas una vez: las exportadas coinciden con el total
-- filtrado, sin faltantes ni repetidos, en las dos vistas. Siempre se revierte.
BEGIN;
DO $test$
DECLARE admin_id uuid; up uuid; res jsonb; pass int := 0; fails text[] := '{}'; n int := 20503; pg int := 5000; o int;
  tot int; tdoc int; keys text[] := '{}'; okeys text[] := '{}'; tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
BEGIN
  FOR admin_id IN SELECT id FROM public.profiles WHERE is_active AND id IN (SELECT id FROM auth.users) LOOP
    PERFORM set_config('request.jwt.claim.sub', admin_id::text, true); EXIT WHEN public.apt_can_load(); admin_id := NULL;
  END LOOP;
  IF admin_id IS NULL THEN RAISE EXCEPTION 'CAJA C144 FAIL: falta un usuario con carga APT'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  -- 20.503 líneas: 7.000 OT con varios productos; muchas con el mismo pendiente para forzar empates en el orden
  up := (public.erp_upload_begin('CONTRATOS', 'C144.xlsx', '2099-04-01 18:00-05', n)->>'upload_id')::uuid;
  PERFORM public.erp_upload_rows(up, (SELECT jsonb_agg(jsonb_build_object('linea', i + 1, 'nro_contrato', 'P' || tag || (i % 7000),
      'nro_documento', 'P' || tag || (i % 7000), 'secuencia', i, 'tipo_documento', CASE WHEN i % 7 = 0 THEN 'SUBCONTRATO DE VENTAS' ELSE 'CONTRATO DE VENTAS' END,
      'correlativo', i, 'cliente', 'CLIENTE C144', 'cod_producto', 'PR' || (i % 13), 'producto', 'PRODUCTO', 'unidad', CASE WHEN i % 11 = 0 THEN 'KG' ELSE 'UND' END,
      'cant_contrato', 10, 'cant_despachada', 5, 'cant_reemplazada', 0, 'cant_pendiente', 5 * (i % 2), 'fecha_contrato', '2026-01-01', 'fecha_vcto', '2099-01-01'))
    FROM generate_series(1, n) i));
  res := public.erp_upload_apply(up);
  IF COALESCE(res->>'success', 'true') = 'false' THEN RAISE EXCEPTION 'CAJA C144 FAIL: carga %', res; END IF;

  -- T1 más de 20.000 filas filtradas y una sola consulta queda corta (tope)
  res := public.erp_analisis(jsonb_build_object('limit', 50000));
  tot := (res->>'total')::int;
  IF tot > 20000 AND jsonb_array_length(res->'filas') = 20000 THEN pass := pass + 1;
  ELSE fails := fails || format('T1 total %s, una consulta %s', tot, jsonb_array_length(res->'filas')); END IF;

  -- T2 por páginas: todas las filas, una vez cada una, y el total no cambia entre páginas
  o := 0;
  WHILE o < tot LOOP
    res := public.erp_analisis(jsonb_build_object('limit', pg, 'offset', o));
    IF (res->>'total')::int <> tot THEN fails := fails || 'T2 total cambió'::text; EXIT; END IF;
    keys := keys || ARRAY(SELECT x->>'documento' || '|' || (x->>'cod_producto') || '|' || (x->>'unidad') FROM jsonb_array_elements(res->'filas') x);
    o := o + pg;
  END LOOP;
  IF cardinality(keys) = tot AND (SELECT count(DISTINCT k) FROM unnest(keys) k) = tot
     AND tot = (SELECT count(*) FROM (SELECT DISTINCT public.erp_key(nro_documento), public.erp_key(cod_producto), public.erp_key(COALESCE(unidad_erp, unidad))
                FROM public.erp_contract_lines WHERE import_id = up) z)
  THEN pass := pass + 1; ELSE fails := fails || format('T2 documentos: %s filas, %s distintas, total %s', cardinality(keys), (SELECT count(DISTINCT k) FROM unnest(keys) k), tot); END IF;

  tdoc := tot;
  -- T3 lo mismo con filtro (solo con pendiente) y en la vista por OT, tipo y unidad
  res := public.erp_analisis(jsonb_build_object('vista', 'OT', 'limit', 1));
  tot := (res->>'total')::int; o := 0;
  WHILE o < tot LOOP
    res := public.erp_analisis(jsonb_build_object('vista', 'OT', 'limit', pg, 'offset', o));
    okeys := okeys || ARRAY(SELECT (x->>'ot') || '|' || COALESCE(x->>'tipo_documento', '') || '|' || (x->>'unidad') FROM jsonb_array_elements(res->'filas') x);
    o := o + pg;
  END LOOP;
  keys := '{}'; o := 0;
  res := public.erp_analisis(jsonb_build_object('solo_pendiente', true, 'limit', 1));
  WHILE o < (res->>'total')::int LOOP
    keys := keys || ARRAY(SELECT x->>'documento' || '|' || (x->>'cod_producto') || '|' || (x->>'unidad')
      FROM jsonb_array_elements(public.erp_analisis(jsonb_build_object('solo_pendiente', true, 'limit', pg, 'offset', o))->'filas') x);
    o := o + pg;
  END LOOP;
  IF cardinality(okeys) = tot AND (SELECT count(DISTINCT k) FROM unnest(okeys) k) = tot
     AND cardinality(keys) = (res->>'total')::int AND (SELECT count(DISTINCT k) FROM unnest(keys) k) = cardinality(keys) AND cardinality(keys) > 0
  THEN pass := pass + 1; ELSE fails := fails || format('T3 OT %s/%s, pendiente %s/%s', cardinality(okeys), tot, cardinality(keys), res->>'total'); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C144 FAIL (%/3): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C144 PASS (3/3) ERP análisis: % documento-producto exportados por páginas sin faltantes ni repetidos (una consulta llega a 20.000)', tdoc;
END $test$;
ROLLBACK;
