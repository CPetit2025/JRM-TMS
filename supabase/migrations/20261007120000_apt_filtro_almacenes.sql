-- Estadía APT: filtrar por el almacén del ingreso original de producción.
-- Las capas y su FIFO no se modifican. Detalle, agregaciones, totales y Excel
-- pasan por apt_filtered; el filtro se aplica antes de ordenar/paginar.
-- Se adapta la definición instalada para conservar ajustes de producción y ACL.
BEGIN;
DO $migration$
DECLARE
  definition text;
  anchor text := E'SELECT l.* FROM public.apt_layers l\n  WHERE';
  replacement text := $filter$SELECT l.* FROM public.apt_layers l
  WHERE -- apt_filter_almacenes_ingreso
    (public.apt_arr(q, 'almacenes') IS NULL OR EXISTS (
      SELECT 1 FROM public.apt_movements m
      WHERE m.id = l.movement_id
        AND COALESCE(NULLIF(to_jsonb(m) ->> 'almacen', ''),
                     public.apt_almacen(to_jsonb(m) ->> 'bodega'), '647')
            = ANY (public.apt_arr(q, 'almacenes'))
    )) AND$filter$;
BEGIN
  SELECT pg_get_functiondef('public.apt_filtered(jsonb)'::regprocedure) INTO definition;
  IF position('apt_filter_almacenes_ingreso' IN definition) > 0 THEN RETURN; END IF;
  IF position(anchor IN definition) = 0
     OR (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
     OR to_regprocedure('public.apt_almacen(text)') IS NULL THEN
    RAISE EXCEPTION 'apt_filtered o apt_almacen no coincide con la definición esperada; revisar antes de aplicar el filtro';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $migration$;
COMMIT;
NOTIFY pgrst, 'reload schema';
