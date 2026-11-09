-- Unidades de carga: el Packing List es la lista completa de lo que se despacha; sus bultos se reparten entre
-- unidades de transporte. Cada unidad se numera UT1, UT2… por tarea y lleva la placa cuando se conoce.
--  · wh_load_unit_add / wh_load_unit_set_plate / wh_load_unit_remove administran las unidades de la tarea.
--  · wh_lpn_assign_unit asigna (o libera) un bulto cerrado a una unidad.
--  · Al cargar, si la tarea tiene unidades, el escaneo debe indicar la unidad (payload.load_unit_id) y el bulto
--    debe estar asignado a ella. La validación envuelve wh_record_scan (también para lecturas offline).
CREATE TABLE IF NOT EXISTS public.wh_load_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.wh_tasks(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id),
  seq integer NOT NULL CHECK (seq > 0),
  plate text CHECK (plate IS NULL OR length(plate) BETWEEN 3 AND 20),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);
ALTER TABLE public.wh_load_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wh_load_units FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wh_load_units TO authenticated;
DROP POLICY IF EXISTS wh_load_units_read ON public.wh_load_units;
CREATE POLICY wh_load_units_read ON public.wh_load_units FOR SELECT TO authenticated
  USING (public.can_access_site(site_id) AND public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-packing','almacen-carga']));

ALTER TABLE public.wh_lpns ADD COLUMN IF NOT EXISTS load_unit_id uuid REFERENCES public.wh_load_units(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS wh_lpns_load_unit_idx ON public.wh_lpns(load_unit_id) WHERE load_unit_id IS NOT NULL;

-- Tarea editable para unidades: permiso de packing/carga, sede autorizada y tarea aún no cargada ni cancelada.
CREATE OR REPLACE FUNCTION public.wh_load_unit_task(p_task_id uuid) RETURNS public.wh_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para gestionar unidades de carga' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  IF t.status NOT IN ('PICKING','PACKING','READY_FOR_LOAD') THEN RAISE EXCEPTION 'La tarea ya no admite cambios en sus unidades de carga'; END IF;
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.wh_load_unit_task(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.wh_load_unit_add(p_task_id uuid, p_plate text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE; u public.wh_load_units%ROWTYPE;
BEGIN
  t := public.wh_load_unit_task(p_task_id);
  INSERT INTO public.wh_load_units(task_id, site_id, seq, plate)
  VALUES (t.id, t.site_id, (SELECT coalesce(max(seq), 0) + 1 FROM public.wh_load_units WHERE task_id = t.id),
          nullif(upper(regexp_replace(btrim(coalesce(p_plate, '')), '\s+', '', 'g')), ''))
  RETURNING * INTO u;
  RETURN jsonb_build_object('id', u.id, 'seq', u.seq, 'label', 'UT' || u.seq, 'plate', u.plate);
END $$;

CREATE OR REPLACE FUNCTION public.wh_load_unit_set_plate(p_unit_id uuid, p_plate text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.wh_load_units%ROWTYPE;
BEGIN
  SELECT * INTO u FROM public.wh_load_units WHERE id = p_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unidad de carga no encontrada'; END IF;
  -- La placa se puede completar o corregir aunque la unidad ya se esté cargando.
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-packing','almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para gestionar unidades de carga' USING ERRCODE = '42501'; END IF;
  IF NOT public.can_access_site(u.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  UPDATE public.wh_load_units SET plate = nullif(upper(regexp_replace(btrim(coalesce(p_plate, '')), '\s+', '', 'g')), ''), updated_at = now() WHERE id = u.id;
END $$;

CREATE OR REPLACE FUNCTION public.wh_load_unit_remove(p_unit_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u public.wh_load_units%ROWTYPE;
BEGIN
  SELECT * INTO u FROM public.wh_load_units WHERE id = p_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unidad de carga no encontrada'; END IF;
  PERFORM public.wh_load_unit_task(u.task_id);
  IF EXISTS (SELECT 1 FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND (l.status = 'LOADED' OR EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'LOADED'))) THEN
    RAISE EXCEPTION 'La unidad UT% ya tiene bultos cargados', u.seq;
  END IF;
  DELETE FROM public.wh_load_units WHERE id = u.id; -- sus bultos quedan sin asignar
END $$;

CREATE OR REPLACE FUNCTION public.wh_lpn_assign_unit(p_lpn_id uuid, p_unit_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE;
BEGIN
  SELECT * INTO l FROM public.wh_lpns WHERE id = p_lpn_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bulto no encontrado'; END IF;
  PERFORM public.wh_load_unit_task(l.task_id);
  IF l.status <> 'CLOSED' OR EXISTS (SELECT 1 FROM public.wh_packages WHERE lpn_id = l.id AND status = 'LOADED') THEN
    RAISE EXCEPTION 'Solo se asignan bultos cerrados y aún no cargados (%)', l.lpn_code;
  END IF;
  IF p_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.wh_load_units WHERE id = p_unit_id AND task_id = l.task_id) THEN
    RAISE EXCEPTION 'La unidad no pertenece a esta tarea';
  END IF;
  UPDATE public.wh_lpns SET load_unit_id = p_unit_id WHERE id = l.id;
END $$;

CREATE OR REPLACE FUNCTION public.wh_task_load_units(p_task_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t public.wh_tasks%ROWTYPE;
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-packing','almacen-carga','almacen-picking','almacen-auditoria']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
  IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', u.id, 'seq', u.seq, 'label', 'UT' || u.seq, 'plate', u.plate,
      'lpn_ids', coalesce((SELECT jsonb_agg(l.id ORDER BY l.lpn_code) FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND l.status <> 'VOID'), '[]'::jsonb),
      'lpn_count', (SELECT count(*) FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND l.status <> 'VOID'),
      'loaded_count', (SELECT count(*) FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND (l.status = 'LOADED' OR EXISTS (SELECT 1 FROM public.wh_packages p WHERE p.lpn_id = l.id AND p.status = 'LOADED'))),
      'package_count', (SELECT coalesce(sum(l.package_count), 0) FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND l.status <> 'VOID'),
      'weight_kg', (SELECT coalesce(sum(l.weight_kg), 0) FROM public.wh_lpns l WHERE l.load_unit_id = u.id AND l.status <> 'VOID')
    ) ORDER BY u.seq) FROM public.wh_load_units u WHERE u.task_id = t.id), '[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION public.wh_load_unit_add(uuid, text), public.wh_load_unit_set_plate(uuid, text), public.wh_load_unit_remove(uuid),
  public.wh_lpn_assign_unit(uuid, uuid), public.wh_task_load_units(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_load_unit_add(uuid, text), public.wh_load_unit_set_plate(uuid, text), public.wh_load_unit_remove(uuid),
  public.wh_lpn_assign_unit(uuid, uuid), public.wh_task_load_units(uuid) TO authenticated;

-- Carga por unidad: se valida antes del registro original, que queda como función interna.
ALTER FUNCTION public.wh_record_scan(uuid, text, text, uuid, jsonb) RENAME TO wh_record_scan_core;
REVOKE ALL ON FUNCTION public.wh_record_scan_core(uuid, text, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.wh_record_scan(p_task_id uuid, p_code text, p_event text, p_client_event_id uuid, p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.wh_lpns%ROWTYPE; t public.wh_tasks%ROWTYPE; v_unit text := nullif(coalesce(p_payload, '{}'::jsonb)->>'load_unit_id', '');
BEGIN
  IF upper(coalesce(p_event, '')) = 'LOAD' THEN
    -- Mismas comprobaciones que el registro original, antes de revelar datos de unidades.
    PERFORM public.security_assert_active_session();
    SELECT * INTO t FROM public.wh_tasks WHERE id = p_task_id;
    IF NOT FOUND OR NOT public.can_access_site(t.site_id) THEN RAISE EXCEPTION 'Tarea no disponible'; END IF;
    IF NOT public.wh_has_permission(ARRAY['almacen-carga','almacen-supervisor']) THEN RAISE EXCEPTION 'Sin permiso para registrar esta lectura' USING ERRCODE = '42501'; END IF;
  END IF;
  IF upper(coalesce(p_event, '')) = 'LOAD' AND EXISTS (SELECT 1 FROM public.wh_load_units WHERE task_id = p_task_id) THEN
    -- Se bloquea el bulto: una reasignación simultánea no puede validar contra una unidad obsoleta.
    SELECT * INTO l FROM public.wh_lpns
     WHERE task_id = p_task_id AND status <> 'VOID'
       AND (lpn_code = trim(p_code) OR id = (SELECT lpn_id FROM public.wh_packages WHERE package_code = trim(p_code) AND task_id = p_task_id))
     LIMIT 1 FOR UPDATE;
    -- Una lectura ya registrada (reintento offline) no se vuelve a validar: el registro original la reconoce.
    IF FOUND AND l.status = 'CLOSED' THEN
      IF l.load_unit_id IS NULL THEN RAISE EXCEPTION 'Asigne el bulto % a una unidad de carga antes de cargarlo', l.lpn_code; END IF;
      IF v_unit IS NULL THEN RAISE EXCEPTION 'Seleccione la unidad que se está cargando'; END IF;
      IF l.load_unit_id::text <> v_unit THEN
        RAISE EXCEPTION 'El bulto % corresponde a %, no a la unidad seleccionada', l.lpn_code,
          (SELECT 'UT' || seq || coalesce(' · ' || plate, '') FROM public.wh_load_units WHERE id = l.load_unit_id);
      END IF;
    END IF;
  END IF;
  RETURN public.wh_record_scan_core(p_task_id, p_code, p_event, p_client_event_id, p_payload);
END $$;
REVOKE ALL ON FUNCTION public.wh_record_scan(uuid, text, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_record_scan(uuid, text, text, uuid, jsonb) TO authenticated;
