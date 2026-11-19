-- Fase 2.1 · Peso con fuente y estado, tipos de unidad de carga y alerta de capacidad (sin bloquear).
-- Decisiones del 19-11-2026:
--  · Peso confirmado = el de la recepción del ERP; el maestro de SKU (peso unitario × cantidad) es «calculado»;
--    sin ninguno queda «provisional» (nunca 0). Si recepción y maestro difieren más de 5 %, queda «en revisión».
--  · La alerta para pedir una unidad adicional compara peso, pallets y volumen; si falta un dato no bloquea:
--    informa qué no se pudo calcular. Nada de esto impide preparar, liberar, asignar ni cargar.
-- Solo agrega objetos: no cambia las funciones de picking, auditoría, liberación ni carga.

-- ------------------------------------------------------------
-- 1. Peso y volumen de un paquete
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wh_package_weight(p public.wh_packages)
RETURNS TABLE(kg numeric, estado text, fuente text, m3 numeric)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH m AS (
    SELECT nullif(x.peso_unit, 0) * p.quantity AS maestro_kg, nullif(x.m3_unit, 0) * p.quantity AS maestro_m3
    FROM public.erp_sku_medidas x WHERE x.cod_producto = p.source_product_code LIMIT 1
  ), b AS (SELECT nullif(p.weight_kg, 0) AS reg_kg, (SELECT maestro_kg FROM m) AS maestro_kg, (SELECT maestro_m3 FROM m) AS maestro_m3)
  SELECT
    round(coalesce(b.reg_kg, b.maestro_kg), 3),
    CASE
      WHEN b.reg_kg IS NOT NULL AND p.source_system = 'ERP' THEN
        CASE WHEN b.maestro_kg IS NOT NULL AND abs(b.reg_kg - b.maestro_kg) > 0.05 * b.maestro_kg THEN 'EN_REVISION' ELSE 'CONFIRMADO' END
      -- Peso registrado fuera de la recepción del ERP (p. ej. inventario): no se da por confirmado.
      WHEN b.reg_kg IS NOT NULL THEN 'CALCULADO'
      WHEN b.maestro_kg IS NOT NULL THEN 'CALCULADO'
      ELSE 'PROVISIONAL' END,
    CASE WHEN b.reg_kg IS NOT NULL AND p.source_system = 'ERP' THEN 'RECEPCION_ERP'
         WHEN b.reg_kg IS NOT NULL THEN 'REGISTRADO'
         WHEN b.maestro_kg IS NOT NULL THEN 'MAESTRO_SKU'
         ELSE 'SIN_DATO' END,
    round(b.maestro_m3, 4)
  FROM b;
$$;

-- Resumen de un LPN: kg conocidos, paquetes sin peso, el peor estado y volumen. Nunca suma un peso desconocido como 0.
CREATE OR REPLACE FUNCTION public.wh_lpn_weight(p_lpn_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'kg', round(coalesce(sum(w.kg), 0), 3),
    'paquetes', count(*),
    'sin_peso', count(*) FILTER (WHERE w.kg IS NULL),
    'en_revision', count(*) FILTER (WHERE w.estado = 'EN_REVISION'),
    'estado', CASE
      WHEN count(*) = 0 THEN 'PROVISIONAL'
      WHEN bool_or(w.estado = 'PROVISIONAL') THEN 'PROVISIONAL'
      WHEN bool_or(w.estado = 'EN_REVISION') THEN 'EN_REVISION'
      WHEN bool_or(w.estado = 'CALCULADO') THEN 'CALCULADO'
      ELSE 'CONFIRMADO' END,
    'm3', round(coalesce(sum(w.m3), 0), 4),
    'sin_m3', count(*) FILTER (WHERE w.m3 IS NULL))
  FROM public.wh_packages p CROSS JOIN LATERAL public.wh_package_weight(p) w
  WHERE p.lpn_id = p_lpn_id;
$$;

-- ------------------------------------------------------------
-- 2. Tipos de unidad de carga (capacidad en kg, pallets y m³; cualquiera puede faltar)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wh_vehicle_types (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  capacity_kg numeric(14,3) CHECK (capacity_kg IS NULL OR capacity_kg > 0),
  capacity_pallets integer CHECK (capacity_pallets IS NULL OR capacity_pallets > 0),
  capacity_m3 numeric(14,3) CHECK (capacity_m3 IS NULL OR capacity_m3 > 0),
  active boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wh_vehicle_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_vehicle_types FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wh_vehicle_types TO service_role;
GRANT SELECT ON public.wh_vehicle_types TO authenticated;
DROP POLICY IF EXISTS security_active_account ON public.wh_vehicle_types;
CREATE POLICY security_active_account ON public.wh_vehicle_types AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS wh_vehicle_types_read ON public.wh_vehicle_types;
CREATE POLICY wh_vehicle_types_read ON public.wh_vehicle_types FOR SELECT TO authenticated
  USING (public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-packing','almacen-carga']));

CREATE OR REPLACE FUNCTION public.wh_vehicle_type_save(p_code text, p_name text, p_capacity_kg numeric, p_capacity_pallets integer,
  p_capacity_m3 numeric, p_active boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text := upper(btrim(coalesce(p_code, '')));
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-supervisor']) THEN
    RAISE EXCEPTION 'Solo supervisión configura los tipos de unidad' USING ERRCODE = '42501';
  END IF;
  IF v_code !~ '^[A-Z0-9_-]{2,30}$' THEN RAISE EXCEPTION 'Código no válido: use 2 a 30 letras, números, guion o guion bajo'; END IF;
  IF length(btrim(coalesce(p_name, ''))) < 2 THEN RAISE EXCEPTION 'Indique el nombre del tipo de unidad'; END IF;
  IF coalesce(p_capacity_kg, 1) <= 0 OR coalesce(p_capacity_pallets, 1) <= 0 OR coalesce(p_capacity_m3, 1) <= 0 THEN
    RAISE EXCEPTION 'Las capacidades deben ser mayores que cero (o quedar vacías si no se conocen)';
  END IF;
  INSERT INTO public.wh_vehicle_types(code, name, capacity_kg, capacity_pallets, capacity_m3, active, updated_by)
  VALUES (v_code, btrim(p_name), p_capacity_kg, p_capacity_pallets, p_capacity_m3, coalesce(p_active, true), auth.uid())
  ON CONFLICT (code) DO UPDATE SET name = excluded.name, capacity_kg = excluded.capacity_kg, capacity_pallets = excluded.capacity_pallets,
    capacity_m3 = excluded.capacity_m3, active = excluded.active, updated_by = excluded.updated_by, updated_at = now();
  RETURN jsonb_build_object('code', v_code);
END $$;

ALTER TABLE public.wh_load_units ADD COLUMN IF NOT EXISTS vehicle_type_code text REFERENCES public.wh_vehicle_types(code);

-- Tipo de una unidad de carga: mismos permisos y estados que la placa (wh_load_unit_task).
CREATE OR REPLACE FUNCTION public.wh_load_unit_set_type(p_unit_id uuid, p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.wh_load_units%ROWTYPE; v_code text := nullif(upper(btrim(coalesce(p_code, ''))), '');
BEGIN
  SELECT * INTO u FROM public.wh_load_units WHERE id = p_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unidad no encontrada'; END IF;
  PERFORM public.wh_load_unit_task(u.task_id);
  IF v_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_vehicle_types WHERE code = v_code AND active) THEN
    RAISE EXCEPTION 'Tipo de unidad no disponible';
  END IF;
  UPDATE public.wh_load_units SET vehicle_type_code = v_code, updated_at = now() WHERE id = u.id;
  RETURN jsonb_build_object('id', u.id, 'vehicle_type_code', v_code);
END $$;

-- ------------------------------------------------------------
-- 3. Capacidad de la tarea: informa, nunca bloquea
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wh_task_capacity(p_task_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; v_units jsonb; v_task jsonb; v_lpns jsonb;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-packing','almacen-carga','almacen-picking','almacen-auditoria']) THEN
    RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;

  -- Peso y volumen de cada LPN activo de la tarea (se calcula una sola vez)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'lpn_code', l.lpn_code, 'load_unit_id', l.load_unit_id, 'w', public.wh_lpn_weight(l.id)) ORDER BY l.lpn_code), '[]'::jsonb)
    INTO v_lpns FROM public.wh_lpns l WHERE l.task_id = t.id AND l.status <> 'VOID';

  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'seq')::int), '[]'::jsonb) INTO v_units FROM (
    SELECT jsonb_build_object(
      'id', u.id, 'seq', u.seq, 'label', 'UT' || u.seq, 'plate', u.plate,
      'tipo', CASE WHEN vt.code IS NULL THEN NULL ELSE jsonb_build_object('code', vt.code, 'name', vt.name,
        'capacity_kg', vt.capacity_kg, 'capacity_pallets', vt.capacity_pallets, 'capacity_m3', vt.capacity_m3) END,
      'kg', a.kg, 'pallets', a.pallets, 'm3', a.m3, 'sin_peso', a.sin_peso, 'sin_m3', a.sin_m3, 'peso_estado', a.estado,
      'uso_kg', CASE WHEN vt.capacity_kg IS NOT NULL THEN round(100 * a.kg / vt.capacity_kg, 1) END,
      'uso_pallets', CASE WHEN vt.capacity_pallets IS NOT NULL THEN round(100.0 * a.pallets / vt.capacity_pallets, 1) END,
      'uso_m3', CASE WHEN vt.capacity_m3 IS NOT NULL AND a.sin_m3 = 0 THEN round(100 * a.m3 / vt.capacity_m3, 1) END,
      'excede', to_jsonb(array_remove(ARRAY[
        CASE WHEN vt.capacity_kg IS NOT NULL AND a.kg > vt.capacity_kg THEN 'peso' END,
        CASE WHEN vt.capacity_pallets IS NOT NULL AND a.pallets > vt.capacity_pallets THEN 'pallets' END,
        CASE WHEN vt.capacity_m3 IS NOT NULL AND a.m3 > vt.capacity_m3 THEN 'volumen' END], NULL)),
      'no_calculable', to_jsonb(array_remove(ARRAY[
        CASE WHEN vt.code IS NULL THEN 'Sin tipo de unidad: no se conoce su capacidad' END,
        CASE WHEN vt.code IS NOT NULL AND vt.capacity_kg IS NULL THEN 'Peso: el tipo de unidad no tiene capacidad en kg' END,
        CASE WHEN a.sin_peso > 0 THEN 'Peso: ' || a.sin_peso || ' paquete(s) sin peso (se informa, no se cuenta como 0)' END,
        CASE WHEN vt.code IS NOT NULL AND vt.capacity_pallets IS NULL THEN 'Pallets: el tipo de unidad no tiene capacidad en pallets' END,
        CASE WHEN vt.code IS NOT NULL AND vt.capacity_m3 IS NULL THEN 'Volumen: el tipo de unidad no tiene capacidad en m³' END,
        CASE WHEN a.sin_m3 > 0 THEN 'Volumen: ' || a.sin_m3 || ' paquete(s) sin m³ en el maestro' END], NULL))
    ) AS x
    FROM public.wh_load_units u
    LEFT JOIN public.wh_vehicle_types vt ON vt.code = u.vehicle_type_code
    CROSS JOIN LATERAL (
      SELECT round(coalesce(sum((c.w->>'kg')::numeric), 0), 3) AS kg, count(c.id) AS pallets,
             round(coalesce(sum((c.w->>'m3')::numeric), 0), 4) AS m3,
             coalesce(sum((c.w->>'sin_peso')::int), 0) AS sin_peso, coalesce(sum((c.w->>'sin_m3')::int), 0) AS sin_m3,
             CASE WHEN count(c.id) = 0 THEN NULL
                  WHEN bool_or(c.w->>'estado' = 'PROVISIONAL') THEN 'PROVISIONAL'
                  WHEN bool_or(c.w->>'estado' = 'EN_REVISION') THEN 'EN_REVISION'
                  WHEN bool_or(c.w->>'estado' = 'CALCULADO') THEN 'CALCULADO' ELSE 'CONFIRMADO' END AS estado
      FROM jsonb_to_recordset(v_lpns) AS c(id uuid, lpn_code text, load_unit_id uuid, w jsonb) WHERE c.load_unit_id = u.id) a
    WHERE u.task_id = t.id) s;

  SELECT jsonb_build_object(
      'kg', round(coalesce(sum((c.w->>'kg')::numeric), 0), 3), 'pallets', count(c.id), 'm3', round(coalesce(sum((c.w->>'m3')::numeric), 0), 4),
      'sin_peso', coalesce(sum((c.w->>'sin_peso')::int), 0), 'sin_m3', coalesce(sum((c.w->>'sin_m3')::int), 0),
      'sin_unidad_pallets', count(c.id) FILTER (WHERE c.load_unit_id IS NULL),
      'sin_unidad_kg', round(coalesce(sum((c.w->>'kg')::numeric) FILTER (WHERE c.load_unit_id IS NULL), 0), 3))
    INTO v_task FROM jsonb_to_recordset(v_lpns) AS c(id uuid, lpn_code text, load_unit_id uuid, w jsonb);

  -- Capacidad total de las unidades con tipo; una dimensión sin dato en alguna unidad no se suma como si fuera infinita.
  v_task := v_task || (SELECT jsonb_build_object(
      'unidades', count(*), 'unidades_sin_tipo', count(*) FILTER (WHERE u.vehicle_type_code IS NULL),
      'capacidad_kg', CASE WHEN count(*) > 0 AND bool_and(vt.capacity_kg IS NOT NULL) THEN sum(vt.capacity_kg) END,
      'capacidad_pallets', CASE WHEN count(*) > 0 AND bool_and(vt.capacity_pallets IS NOT NULL) THEN sum(vt.capacity_pallets) END,
      'capacidad_m3', CASE WHEN count(*) > 0 AND bool_and(vt.capacity_m3 IS NOT NULL) THEN sum(vt.capacity_m3) END)
    FROM public.wh_load_units u LEFT JOIN public.wh_vehicle_types vt ON vt.code = u.vehicle_type_code WHERE u.task_id = t.id);

  v_task := v_task || jsonb_build_object('excede', to_jsonb(array_remove(ARRAY[
      CASE WHEN (v_task->>'capacidad_kg') IS NOT NULL AND (v_task->>'kg')::numeric > (v_task->>'capacidad_kg')::numeric THEN 'peso' END,
      CASE WHEN (v_task->>'capacidad_pallets') IS NOT NULL AND (v_task->>'pallets')::numeric > (v_task->>'capacidad_pallets')::numeric THEN 'pallets' END,
      CASE WHEN (v_task->>'capacidad_m3') IS NOT NULL AND (v_task->>'m3')::numeric > (v_task->>'capacidad_m3')::numeric THEN 'volumen' END], NULL)));
  v_task := v_task || jsonb_build_object('alerta', CASE
      WHEN jsonb_array_length(v_task->'excede') > 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_units) x WHERE jsonb_array_length(x->'excede') > 0)
        THEN 'Lo preparado supera la capacidad de las unidades (' || coalesce(nullif(array_to_string(ARRAY(SELECT jsonb_array_elements_text(v_task->'excede')), ', '), ''), 'en alguna unidad') || '): solicite una unidad adicional en el TMS.'
      WHEN (v_task->>'unidades')::int = 0 AND (v_task->>'pallets')::int > 0 THEN 'Aún no hay unidades de carga: no se puede comparar con la capacidad.'
      END);

  RETURN jsonb_build_object('tarea', v_task, 'unidades', v_units,
    'lpns', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'lpn_code', c.lpn_code, 'load_unit_id', c.load_unit_id) || c.w ORDER BY c.lpn_code), '[]'::jsonb)
             FROM jsonb_to_recordset(v_lpns) AS c(id uuid, lpn_code text, load_unit_id uuid, w jsonb)));
END $$;

REVOKE ALL ON FUNCTION public.wh_package_weight(public.wh_packages), public.wh_lpn_weight(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wh_vehicle_type_save(text, text, numeric, integer, numeric, boolean), public.wh_load_unit_set_type(uuid, text),
  public.wh_task_capacity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_vehicle_type_save(text, text, numeric, integer, numeric, boolean), public.wh_load_unit_set_type(uuid, text),
  public.wh_task_capacity(uuid) TO authenticated;
