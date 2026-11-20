-- C231: el rechazo parcial registra las líneas no entregadas con su cantidad; solo quien registró el rechazo las
-- informa y se validan. Usa un rechazo real dentro de la transacción y siempre se revierte.
BEGIN;
DO $test$
DECLARE r record; ok boolean; otro uuid;
BEGIN
  SELECT * INTO r FROM public.delivery_rejections ORDER BY created_at DESC LIMIT 1;
  IF r.id IS NULL THEN RAISE EXCEPTION 'CAJA C231 PASS: sin rechazos para probar (función instalada)'; END IF;
  UPDATE public.delivery_rejections SET kind = 'PARCIAL' WHERE id = r.id;
  PERFORM set_config('request.jwt.claim.sub', r.created_by::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', r.created_by, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.delivery_rejection_set_lines(r.operation_id, '[{"descripcion":"Perno","cantidad":0}]'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C231 FAIL: aceptó una línea sin cantidad'; END IF;
  PERFORM public.delivery_rejection_set_lines(r.operation_id, '[{"descripcion":"Perno 3/4","cantidad":12,"unidad":"UND"},{"descripcion":"Placa base","cantidad":2}]');
  IF (SELECT jsonb_array_length(missing_lines) FROM public.delivery_rejections WHERE id = r.id) <> 2 THEN RAISE EXCEPTION 'CAJA C231 FAIL: no guardó las líneas'; END IF;
  SELECT p.id INTO otro FROM public.profiles p WHERE p.is_active AND p.id <> r.created_by LIMIT 1;
  PERFORM set_config('request.jwt.claim.sub', otro::text, true); PERFORM set_config('request.jwt.claims', json_build_object('sub', otro, 'role', 'authenticated')::text, true);
  BEGIN PERFORM public.delivery_rejection_set_lines(r.operation_id, '[{"descripcion":"Perno","cantidad":1}]'); ok := true;
  EXCEPTION WHEN OTHERS THEN ok := false; END;
  IF ok THEN RAISE EXCEPTION 'CAJA C231 FAIL: otro usuario cambió las líneas del rechazo'; END IF;
  RAISE EXCEPTION 'CAJA C231 PASS: líneas no entregadas con cantidad, validadas y solo por quien registró el rechazo';
END $test$;
ROLLBACK;
