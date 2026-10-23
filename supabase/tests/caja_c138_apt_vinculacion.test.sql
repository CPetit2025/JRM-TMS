BEGIN;
-- Almacén APT: estado de vinculación de la carga única (solo lectura). Informa en el resultado el estado real
-- (rango de cada módulo y desde dónde calcula) para revisar el despliegue sin consultar la base a mano.
DO $test$
DECLARE e jsonb; i jsonb; a jsonb; n jsonb; denied boolean := false;
BEGIN
  e := public.apt_vinculacion_estado();
  IF NOT COALESCE((e->>'success')::boolean, false) OR e->'inventario' IS NULL OR e->'clasico' IS NULL OR e->'analitica' IS NULL THEN
    RAISE EXCEPTION 'CAJA C138 FAIL: estado incompleto %', e;
  END IF;
  IF has_function_privilege('anon', 'public.apt_vinculacion_estado()', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAJA C138 FAIL: acceso anónimo';
  END IF;
  i := e->'inventario'; a := e->'clasico'; n := e->'analitica';
  RAISE EXCEPTION 'CAJA C138 PASS (2/2) vinculación APT | inventario % a % (% mov.), calcula desde %, foto %, sin usar % (% a %), pendiente %, en preparación %, recalculado % | clásico % a %, corte %, corte manual %, recalculado % | analítica % a % (% imp., % filas) | servicios con peso %',
    i->>'data_min', i->>'data_max', i->>'movimientos', COALESCE(i->>'model_from', 'inicio'), COALESCE(i->>'snapshot_cutoff', 'no'),
    i->>'sin_usar', i->>'sin_usar_desde', i->>'sin_usar_hasta', i->>'dirty', i->>'cargas_en_preparacion', i->>'rebuilt_at',
    a->>'data_min', a->>'data_max', a->>'cutoff', COALESCE(a->>'corte_manual', 'no'), a->>'rebuilt_at',
    n->>'desde', n->>'hasta', n->>'importaciones', n->>'filas', e->'servicios'->>'con_peso';
END $test$;
ROLLBACK;
