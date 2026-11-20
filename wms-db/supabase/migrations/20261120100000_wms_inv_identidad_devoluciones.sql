-- Inventario y Logística Inversa · Fase 2: identidad estable de las líneas del ERP y carga versionada (decisiones del
-- 20-11-2026: clave por firma; un solo libro de movimientos en el WMS; alcance 540-04 APT LB).
--  · mkey = firma estable de cada línea: lado + bodega + tipo de documento + número + producto + lote + cantidad + ocurrencia
--    (el campo «linea» es la fila del archivo y no sirve como clave). Sobrevive a las recargas diarias del mismo rango.
--  · La carga sigue reemplazando el rango de fechas (los reportes no cambian), pero antes registra en inv_movement_changes
--    qué líneas son nuevas (ALTA) y cuáles desaparecieron del ERP (BAJA), y archiva las bajas en inv_movement_removals:
--    una anulación en el ERP ya no se pierde sin rastro.
--  · Fuente de devoluciones: wh_return_lines lista las guías de recojo de las bodegas en alcance con unidad normalizada,
--    OT raíz del lote y peso con su origen (ERP, maestro o sin dato; nunca 0).

ALTER TABLE public.inv_movements ADD COLUMN IF NOT EXISTS mkey text;
CREATE INDEX IF NOT EXISTS inv_movements_mkey_idx ON public.inv_movements(mkey) WHERE active;

-- Firma de una línea (la ocurrencia distingue líneas idénticas del mismo documento)
CREATE OR REPLACE FUNCTION wms_private.inv_mkey(p_side text, p_bodega text, p_tipodocto text, p_numero text, p_producto text, p_lote text, p_cantidad numeric, p_occ bigint)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(concat_ws('|', p_side, upper(btrim(coalesce(p_bodega, ''))), upper(btrim(coalesce(p_tipodocto, ''))), upper(btrim(coalesce(p_numero, ''))),
    upper(btrim(coalesce(p_producto, ''))), upper(btrim(coalesce(p_lote, ''))), coalesce(p_cantidad, 0)::numeric(20,6)::text, p_occ::text))
$$;
REVOKE ALL ON FUNCTION wms_private.inv_mkey(text, text, text, text, text, text, numeric, bigint) FROM PUBLIC, anon, authenticated;

-- Asigna la firma a las filas de una carga (o a todas las activas si p_upload es NULL)
CREATE OR REPLACE FUNCTION wms_private.inv_assign_mkey(p_upload uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.inv_movements m SET mkey = k.mkey FROM (
    SELECT id, wms_private.inv_mkey(side, bodega, tipodocto, numero, producto, lote, cantidad,
      row_number() OVER (PARTITION BY side, upper(btrim(coalesce(bodega, ''))), upper(btrim(coalesce(tipodocto, ''))), upper(btrim(coalesce(numero, ''))),
        upper(btrim(coalesce(producto, ''))), upper(btrim(coalesce(lote, ''))), cantidad ORDER BY linea, id)) mkey
    FROM public.inv_movements WHERE (p_upload IS NULL AND active) OR upload_id = p_upload) k
  WHERE m.id = k.id AND m.mkey IS DISTINCT FROM k.mkey;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION wms_private.inv_assign_mkey(uuid) FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.inv_movement_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_id uuid NOT NULL REFERENCES public.inv_uploads(id),
  mkey text NOT NULL,
  change text NOT NULL CHECK (change IN ('ALTA','BAJA')),
  side text NOT NULL, bodega text, tipodocto text, numero text, producto text, fecha date, cantidad numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inv_movement_changes_mkey_idx ON public.inv_movement_changes(mkey, created_at DESC);
CREATE INDEX IF NOT EXISTS inv_movement_changes_upload_idx ON public.inv_movement_changes(upload_id);
CREATE TABLE IF NOT EXISTS public.inv_movement_removals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mkey text NOT NULL,
  removed_by_upload uuid NOT NULL REFERENCES public.inv_uploads(id),
  removed_at timestamptz NOT NULL DEFAULT now(),
  movement jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS inv_movement_removals_mkey_idx ON public.inv_movement_removals(mkey);
CREATE INDEX IF NOT EXISTS inv_movement_removals_upload_idx ON public.inv_movement_removals(removed_by_upload);

-- Equivalencias de unidades (solo las inequívocas; las demás quedan como vienen)
CREATE TABLE IF NOT EXISTS public.inv_unit_aliases (alias text PRIMARY KEY, unit text NOT NULL);
INSERT INTO public.inv_unit_aliases(alias, unit) VALUES ('UNID','UND'),('UNIDAD','UND'),('UNUD','UND'),('GALON','GAL'),('GL','GAL'),('MTS','MT'),('RLLO','RLL'),('ROLL','RLL')
ON CONFLICT (alias) DO NOTHING;
CREATE OR REPLACE FUNCTION public.inv_unit_norm(p_unit text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT a.unit FROM public.inv_unit_aliases a WHERE a.alias = upper(btrim(p_unit))), upper(btrim(p_unit)))
$$;

-- Bodegas y tipos de documento en alcance de Logística Inversa (decisión 1: solo 540-04 APT LB)
CREATE TABLE IF NOT EXISTS public.wh_return_scope (bodega text NOT NULL, tipodocto text NOT NULL, PRIMARY KEY (bodega, tipodocto));
INSERT INTO public.wh_return_scope(bodega, tipodocto) VALUES ('540-04 APT LB', 'GUIA DE RECOJO') ON CONFLICT DO NOTHING;

DO $p$
DECLARE tb text;
BEGIN
  FOREACH tb IN ARRAY ARRAY['inv_movement_changes','inv_movement_removals','inv_unit_aliases','wh_return_scope'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tb);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tb);
    EXECUTE format('DROP POLICY IF EXISTS security_active_account ON public.%I', tb);
    EXECUTE format('CREATE POLICY security_active_account ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()))', tb);
  END LOOP;
END $p$;
REVOKE ALL ON FUNCTION public.inv_unit_norm(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inv_unit_norm(text) TO authenticated;

-- Firma de lo ya cargado
SELECT wms_private.inv_assign_mkey(NULL);

-- La carga registra altas y bajas antes de reemplazar el rango
DO $m$
DECLARE def text; a text := '    DELETE FROM public.inv_movements m WHERE m.side = u.side AND m.active AND m.fecha BETWEEN v_from AND v_to;';
BEGIN
  def := pg_get_functiondef('public.inv_upload_apply_core(uuid, boolean)'::regprocedure);
  IF position(a IN def) = 0 THEN RAISE EXCEPTION 'inv_upload_apply_core cambió: revisar esta migración'; END IF;
  EXECUTE replace(def, a, '    PERFORM wms_private.inv_assign_mkey(u.id);
    INSERT INTO public.inv_movement_changes(upload_id, mkey, change, side, bodega, tipodocto, numero, producto, fecha, cantidad)
    SELECT u.id, o.mkey, ''BAJA'', o.side, o.bodega, o.tipodocto, o.numero, o.producto, o.fecha, o.cantidad FROM public.inv_movements o
    WHERE o.side = u.side AND o.active AND o.fecha BETWEEN v_from AND v_to AND o.mkey IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.inv_movements n WHERE n.upload_id = u.id AND n.mkey = o.mkey);
    INSERT INTO public.inv_movement_removals(mkey, removed_by_upload, movement)
    SELECT o.mkey, u.id, to_jsonb(o) - ''id'' - ''active'' FROM public.inv_movements o
    WHERE o.side = u.side AND o.active AND o.fecha BETWEEN v_from AND v_to AND o.mkey IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.inv_movements n WHERE n.upload_id = u.id AND n.mkey = o.mkey);
    INSERT INTO public.inv_movement_changes(upload_id, mkey, change, side, bodega, tipodocto, numero, producto, fecha, cantidad)
    SELECT u.id, n.mkey, ''ALTA'', n.side, n.bodega, n.tipodocto, n.numero, n.producto, n.fecha, n.cantidad FROM public.inv_movements n
    WHERE n.upload_id = u.id AND NOT EXISTS (SELECT 1 FROM public.inv_movements o WHERE o.side = u.side AND o.active AND o.mkey = n.mkey);
' || a);
END $m$;

-- Líneas de devolución en alcance, con su firma, unidad normalizada, OT raíz y peso con origen; incluye las dadas de baja
-- por el ERP en el período para conciliar (estado BAJA_ERP).
CREATE OR REPLACE FUNCTION public.wh_return_lines(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.security_assert_active_session();
  IF NOT public.wh_has_permission(ARRAY['almacen-lectura','almacen-supervisor','almacen-inventario']) THEN RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 800 THEN RAISE EXCEPTION 'Período no válido'; END IF;
  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'lines', coalesce((SELECT jsonb_agg(x ORDER BY x->>'fecha' DESC, x->>'numero', x->>'producto') FROM (
    SELECT jsonb_build_object('mkey', m.mkey, 'estado_erp', 'VIGENTE', 'fecha', m.fecha, 'bodega', m.bodega, 'tipodocto', m.tipodocto, 'numero', m.numero,
      'producto', m.producto, 'glosa', m.glosa, 'cantidad', m.cantidad, 'unidad', public.inv_unit_norm(m.unidad), 'unidad_original', m.unidad,
      -- La carga deriva la OT del lote (inv_ot): el ERP no envía una OT propia en este reporte
      'lote', m.lote, 'ot', coalesce(nullif(m.ot, ''), substring(coalesce(m.lote, '') FROM '^([0-9]{5,6})')),
      'ot_origen', CASE WHEN coalesce(nullif(m.ot, ''), substring(coalesce(m.lote, '') FROM '^([0-9]{5,6})')) IS NOT NULL THEN 'LOTE' END,
      'ruc', m.cod_legal, 'cliente', m.razon_social,
      'kg', CASE WHEN m.peso_kg > 0 THEN m.peso_kg ELSE w.kg END,
      'peso_origen', CASE WHEN m.peso_kg > 0 THEN 'ERP' WHEN w.kg IS NOT NULL THEN 'MAESTRO' ELSE 'SIN_DATO' END,
      -- Lo cargado antes de esta versión no tiene ALTA registrada: se usa la aplicación de su carga
      'alta', coalesce((SELECT min(c.created_at) FROM public.inv_movement_changes c WHERE c.mkey = m.mkey AND c.change = 'ALTA'),
                       (SELECT coalesce(up.applied_at, up.created_at) FROM public.inv_uploads up WHERE up.id = m.upload_id))) x
    FROM public.inv_movements m JOIN public.wh_return_scope sc ON sc.bodega = m.bodega AND sc.tipodocto = upper(btrim(m.tipodocto))
    LEFT JOIN public.erp_sku_medidas s ON s.cod_producto = m.producto
    -- Peso del maestro con la cantidad absoluta; un resultado que redondea a 0 no es un peso conocido
    LEFT JOIN LATERAL (SELECT nullif(round(s.peso_unit * abs(m.cantidad), 3), 0) AS kg WHERE s.peso_unit > 0) w ON true
    WHERE m.active AND m.side = 'E' AND m.fecha BETWEEN p_from AND p_to
    UNION ALL
    SELECT (r.movement - 'upload_id') || jsonb_build_object('mkey', r.mkey, 'estado_erp', 'BAJA_ERP', 'baja_en', r.removed_at,
      'unidad', public.inv_unit_norm(r.movement->>'unidad'), 'unidad_original', r.movement->>'unidad')
    FROM public.inv_movement_removals r JOIN public.wh_return_scope sc ON sc.bodega = r.movement->>'bodega' AND sc.tipodocto = upper(btrim(r.movement->>'tipodocto'))
    WHERE r.movement->>'side' = 'E' AND (r.movement->>'fecha')::date BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM public.inv_movements m WHERE m.active AND m.mkey = r.mkey)
  ) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.wh_return_lines(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wh_return_lines(date, date) TO authenticated;
