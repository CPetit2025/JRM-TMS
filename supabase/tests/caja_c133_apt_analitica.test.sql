-- CAJA C133 — Analítica APT/Distribución: importación con fila original y capa normalizada, archivo repetido bloqueado,
-- líneas idénticas conservadas, repetidos entre cargas en revisión, lectura del motor, revisión, reversión, equivalencias
-- y auditoría. Datos sintéticos dentro de una transacción que se revierte.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $test$
DECLARE v_user uuid; v_role uuid := gen_random_uuid(); v_role2 uuid := gen_random_uuid(); r jsonb; v_a uuid; v_b uuid; v_min bigint; v_page jsonb;
  v_rows jsonb; v_err text; v_link uuid; v_id bigint; pass int := 0; fails text[] := '{}';
  h1 text := md5(random()::text) || md5(random()::text); h2 text := md5(random()::text) || md5(random()::text);
  v_line jsonb := jsonb_build_object('side', 'S', 'tipo', 'DESPACHO VENTAS', 'bodegaRaw', '647-04  ALM PT', 'bodega', '647-04 ALM PT', 'numero', 'C133-0001',
    'fecha', '2025-03-03', 'producto', '00C133.01', 'cantidad', -5, 'unidad', 'UND', 'lote', '016339-S001');
BEGIN
  SELECT p.id INTO v_user FROM public.profiles p JOIN auth.users u ON u.id = p.id ORDER BY p.id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'CAJA C133 FAIL: no hay perfiles con usuario'; END IF;
  INSERT INTO public.roles (id, name, permissions) VALUES (v_role, 'C133-adm-' || left(v_role::text, 8), '["apt:write","apt-carga","apt-admin"]');
  INSERT INTO public.roles (id, name, permissions) VALUES (v_role2, 'C133-op-' || left(v_role2::text, 8), '["apt:write","apt-carga"]');
  UPDATE public.profiles SET role_id = v_role, is_active = true WHERE id = v_user;
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  -- T1: carga con aceptadas, rechazada, en revisión y dos líneas idénticas del mismo archivo (ambas se conservan)
  r := public.apa_import_begin(jsonb_build_object('source_type', 'SALIDAS', 'file_name', 'C133-salidas.xlsx', 'file_hash', h1, 'file_size', 1000,
    'period_from', '2025-03-03', 'period_to', '2025-03-04', 'parser_version', 'apa-1'));
  v_a := (r->>'id')::uuid;
  PERFORM public.apa_import_rows(v_a, jsonb_build_array(
    jsonb_build_object('sheet', 'Hoja1', 'row', 2, 'raw', jsonb_build_object('Bodega', '647-04  ALM PT', 'Lote', '016339-S001'), 'status', 'ACEPTADO', 'reasons', '[]'::jsonb, 'fingerprint', 'fpC133a', 'dup', 1, 'norm', v_line),
    jsonb_build_object('sheet', 'Hoja1', 'row', 3, 'raw', jsonb_build_object('Bodega', '647-04  ALM PT'), 'status', 'ACEPTADO', 'reasons', '["Línea idéntica n.° 2"]'::jsonb, 'fingerprint', 'fpC133a', 'dup', 2, 'norm', v_line),
    jsonb_build_object('sheet', 'Hoja1', 'row', 4, 'raw', jsonb_build_object('Bodega', 'C133 OTRA'), 'status', 'ACEPTADO', 'reasons', '[]'::jsonb, 'fingerprint', 'fpC133b', 'dup', 1,
      'norm', v_line || jsonb_build_object('bodega', 'C133 OTRA', 'bodegaRaw', 'C133 OTRA', 'numero', 'C133-0002')),
    jsonb_build_object('sheet', 'Hoja1', 'row', 5, 'raw', jsonb_build_object('Fecha', 'mañana'), 'status', 'RECHAZADO', 'reasons', '["Fecha no válida"]'::jsonb, 'fingerprint', NULL, 'dup', 1,
      'norm', v_line - 'fecha'),
    jsonb_build_object('sheet', 'Hoja1', 'row', 6, 'raw', jsonb_build_object('Cantidad', 0), 'status', 'REVISION', 'reasons', '["Cantidad cero"]'::jsonb, 'fingerprint', 'fpC133c', 'dup', 1,
      'norm', v_line || jsonb_build_object('cantidad', 0, 'numero', 'C133-0003'))));
  -- Reintentar el mismo bloque no duplica
  PERFORM public.apa_import_rows(v_a, jsonb_build_array(jsonb_build_object('sheet', 'Hoja1', 'row', 2, 'raw', '{}'::jsonb, 'status', 'ACEPTADO', 'reasons', '[]'::jsonb, 'fingerprint', 'fpC133a', 'dup', 1, 'norm', v_line)));
  r := public.apa_import_finish(v_a, 5);
  IF (r->>'rows_total')::int = 5 AND (r->>'rows_accepted')::int = 3 AND (r->>'rows_rejected')::int = 1 AND (r->>'rows_review')::int = 1
     AND (SELECT count(*) FROM public.apa_raw_rows WHERE import_id = v_a) = 5
     AND (SELECT data->>'Bodega' FROM public.apa_raw_rows WHERE import_id = v_a AND row_number = 2) = '647-04  ALM PT'
     AND (SELECT lote FROM public.apa_movements WHERE import_id = v_a AND row_number = 2) = '016339-S001'
     AND (SELECT count(*) FROM public.apa_movements WHERE import_id = v_a AND fingerprint = 'fpC133a' AND status = 'ACEPTADO') = 2
  THEN pass := pass + 1; ELSE fails := fails || ('T1 carga ' || r::text); END IF;

  -- T2: el mismo archivo (misma huella) no se importa dos veces
  r := public.apa_import_begin(jsonb_build_object('source_type', 'SALIDAS', 'file_name', 'otro-nombre.xlsx', 'file_hash', h1, 'file_size', 1000,
    'period_from', '2025-03-03', 'period_to', '2025-03-04'));
  IF (r->>'success')::boolean = false AND r->'duplicate'->>'id' = v_a::text THEN pass := pass + 1; ELSE fails := fails || ('T2 repetido ' || r::text); END IF;

  -- T3: otra carga con período superpuesto: la misma línea queda EN REVISIÓN (no se elimina ni se suma dos veces)
  r := public.apa_import_begin(jsonb_build_object('source_type', 'SALIDAS', 'file_name', 'C133-salidas-b.xlsx', 'file_hash', h2, 'file_size', 900,
    'period_from', '2025-03-04', 'period_to', '2025-03-05'));
  v_b := (r->>'id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'overlaps') o WHERE o->>'id' = v_a::text) THEN fails := fails || ('T3 superposición ' || r::text); END IF;
  PERFORM public.apa_import_rows(v_b, jsonb_build_array(
    jsonb_build_object('sheet', 'Hoja1', 'row', 2, 'raw', '{}'::jsonb, 'status', 'ACEPTADO', 'reasons', '[]'::jsonb, 'fingerprint', 'fpC133a', 'dup', 1, 'norm', v_line),
    jsonb_build_object('sheet', 'Hoja1', 'row', 3, 'raw', '{}'::jsonb, 'status', 'ACEPTADO', 'reasons', '[]'::jsonb, 'fingerprint', 'fpC133d', 'dup', 1,
      'norm', v_line || jsonb_build_object('numero', 'C133-0009', 'fecha', '2025-03-05'))));
  r := public.apa_import_finish(v_b, NULL);
  IF (r->>'repeated')::int = 1 AND (SELECT status FROM public.apa_movements WHERE import_id = v_b AND row_number = 2) = 'REVISION'
     AND (SELECT reasons[array_upper(reasons, 1)] FROM public.apa_movements WHERE import_id = v_b AND row_number = 2) LIKE '%C133-salidas.xlsx%'
  THEN pass := pass + 1; ELSE fails := fails || ('T3 revisión ' || r::text); END IF;

  -- T4: lectura del motor: filas vigentes del área (y no aceptadas), sin la bodega fuera de alcance
  SELECT min(id) - 1 INTO v_min FROM public.apa_movements WHERE import_id IN (v_a, v_b);
  v_rows := '[]'::jsonb;
  LOOP
    v_page := public.apa_dataset_page(v_min, 1000, 'AREAS');
    v_rows := v_rows || COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(v_page->'rows') x WHERE x->>1 IN (v_a::text, v_b::text)), '[]');
    EXIT WHEN (v_page->>'done')::boolean OR v_page->>'last_id' IS NULL;
    v_min := (v_page->>'last_id')::bigint;
  END LOOP;
  IF jsonb_array_length(v_rows) = 6
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE x->>10 = 'C133 OTRA')
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE x->>4 = 'REVISION' AND x->>1 = v_b::text)
     AND (SELECT x->>27 FROM jsonb_array_elements(v_rows) x WHERE x->>1 = v_a::text AND x->>3 = '2') = '016339-S001'
  THEN pass := pass + 1; ELSE fails := fails || ('T4 lectura ' || jsonb_array_length(v_rows) || ' ' || left(v_rows::text, 300)); END IF;

  -- T5: descartar el repetido (con motivo) y revertir una carga: salen de la lectura; queda auditado
  SELECT id INTO v_id FROM public.apa_movements WHERE import_id = v_b AND row_number = 2;
  BEGIN PERFORM public.apa_review_resolve(v_b, ARRAY[v_id], 'DESCARTAR', ''); v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  r := public.apa_review_resolve(v_b, ARRAY[v_id], 'DESCARTAR', 'Repetido de la carga anterior');
  IF v_err LIKE '%motivo%' AND (r->>'updated')::int = 1 AND (SELECT status FROM public.apa_movements WHERE id = v_id) = 'DESCARTADO'
     AND (SELECT rows_discarded FROM public.apa_imports WHERE id = v_b) = 1
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.apa_dataset_page(v_id - 1, 100, 'AREAS')->'rows') x WHERE (x->>0)::bigint = v_id)
  THEN pass := pass + 1; ELSE fails := fails || ('T5 descartar ' || COALESCE(v_err, '∅') || ' ' || r::text); END IF;
  r := public.apa_import_revert(v_a, 'Archivo equivocado');
  SELECT min(id) - 1 INTO v_min FROM public.apa_movements WHERE import_id = v_a;
  IF (SELECT status FROM public.apa_imports WHERE id = v_a) = 'REVERTIDA'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.apa_dataset_page(v_min, 100, 'AREAS')->'rows') x WHERE x->>1 = v_a::text)
     AND (SELECT count(*) FROM public.apa_audit WHERE entity_id IN (v_a::text, v_b::text)) >= 4
     AND (SELECT count(*) FROM public.apa_raw_rows WHERE import_id = v_a) = 5
  THEN pass := pass + 1; ELSE fails := fails || ('T5 revertir ' || r::text); END IF;
  -- Revertido, el mismo archivo se puede volver a cargar
  r := public.apa_import_begin(jsonb_build_object('source_type', 'SALIDAS', 'file_name', 'C133-salidas.xlsx', 'file_hash', h1, 'file_size', 1000));
  IF NOT (r->>'success')::boolean THEN fails := fails || ('T5 recarga ' || r::text); END IF;

  -- T6: equivalencias y configuración: vínculo manual con historial; el mapeo de áreas solo lo cambia un administrador
  r := public.apa_link_save(jsonb_build_object('fromKind', 'LOTE', 'fromRef', '2893', 'toKind', 'LOTE', 'toRef', '16339-S001', 'qty', 10, 'unidad', 'und',
    'origin', 'MANUAL', 'note', 'Traspaso T-1 C133'));
  v_link := (r->>'id')::uuid;
  PERFORM public.apa_link_annul(v_link, 'Asignación corregida');
  PERFORM public.apa_area_set('c133   bodega  x', 'DIST', false, 'C133');
  UPDATE public.profiles SET role_id = v_role2 WHERE id = v_user;
  BEGIN PERFORM public.apa_area_set('C133 BODEGA Y', 'APT', true, 'no'); v_err := NULL; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  IF (SELECT status FROM public.apa_links WHERE id = v_link) = 'ANULADO' AND (SELECT unidad FROM public.apa_links WHERE id = v_link) = 'UND'
     AND (SELECT count(*) FROM public.apa_audit WHERE entity = 'vinculo' AND entity_id = v_link::text) = 2
     AND EXISTS (SELECT 1 FROM public.apa_areas WHERE bodega = 'C133 BODEGA X' AND area = 'DIST' AND NOT confirmed)
     AND v_err LIKE '%administrador%'
  THEN pass := pass + 1; ELSE fails := fails || ('T6 equivalencias ' || COALESCE(v_err, '∅')); END IF;

  -- T7: la fila original se consulta desde el movimiento (archivo, hoja y fila)
  SELECT id INTO v_id FROM public.apa_movements WHERE import_id = v_a AND row_number = 2;
  r := public.apa_raw_row(v_id);
  IF r->>'file_name' = 'C133-salidas.xlsx' AND r->'raw'->>'Bodega' = '647-04  ALM PT' AND r->'movement'->>'row_number' = '2'
     AND jsonb_typeof(public.apa_meta()->'areas') = 'array' AND (public.apa_meta()->>'can_admin')::boolean = false
  THEN pass := pass + 1; ELSE fails := fails || ('T7 fila original ' || left(r::text, 300)); END IF;

  IF cardinality(fails) > 0 THEN RAISE EXCEPTION 'CAJA C133 FAIL (%/7): %', pass, array_to_string(fails, ' | '); END IF;
  RAISE EXCEPTION 'CAJA C133 PASS (7/7) Analítica APT: carga con fila original, repetidos en revisión, reversión, equivalencias y auditoría';
END $test$;
ROLLBACK;
