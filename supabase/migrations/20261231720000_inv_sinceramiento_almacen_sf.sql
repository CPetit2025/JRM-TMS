-- ============================================================
-- Sinceramiento del stock APT: transferencia al almacén virtual SF (fases 1–3)
-- ============================================================
-- Contratos antiguos con stock en el sistema que físicamente ya no está. El Analista de Inventario propone, por
-- contrato/OT o ID por ID (bodega · producto · lote), con un motivo; la Jefatura de Distribución autoriza (nadie
-- autoriza lo propio). El sustento es el acta que genera el sistema (sin foto). Autorizado, el stock sale del APT
-- (647 · 540 · ST) hacia la bodega virtual SF-SINCERAMIENTO, que no es del APT.
--
-- Efecto en el modelo: no se tocan los datos del ERP. En cada recálculo (inv_rebuild) las líneas autorizadas se
-- vuelven a escribir como un traspaso (salida de la bodega real, ingreso a SF) en inv_movements con una carga propia
-- (DESCARTADA, para que no salga en el historial de cargas). Así sobreviven a las cargas del ERP, que borran los
-- movimientos de su rango, y revertir es solo cambiar el estado. Cantidad con tope en el saldo actual del modelo.
BEGIN;
SET LOCAL lock_timeout = '3min';
-- Esperar a que termine un recálculo en curso: se reemplaza inv_rebuild
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));

CREATE TABLE IF NOT EXISTS public.inv_sinc (
  id bigserial PRIMARY KEY,
  numero text GENERATED ALWAYS AS ('SF-' || lpad(id::text, 6, '0')) STORED,
  ot text NOT NULL CHECK (ot = upper(btrim(ot)) AND ot <> ''),
  cliente text,
  motivo text NOT NULL CHECK (motivo IN ('DESPACHADO_SIN_GUIA', 'SALDO_INICIAL_INFERIDO', 'ERROR_DIGITACION', 'MERMA_NO_UBICADO')),
  observacion text NOT NULL CHECK (length(btrim(observacion)) >= 10),
  estado text NOT NULL DEFAULT 'PROPUESTA' CHECK (estado IN ('PROPUESTA', 'AUTORIZADA', 'RECHAZADA', 'ANULADA', 'REVERTIDA', 'REGULARIZADA')),
  propuesto_por uuid NOT NULL DEFAULT auth.uid(),
  propuesto_at timestamptz NOT NULL DEFAULT now(),
  decidido_por uuid,
  decidido_at timestamptz,
  decision_motivo text,
  autorizado_por uuid,
  autorizado_at timestamptz,
  revertido_por uuid,
  revertido_at timestamptz,
  revertido_motivo text,
  regularizado_at timestamptz,
  CHECK (estado NOT IN ('AUTORIZADA', 'REVERTIDA', 'REGULARIZADA') OR (autorizado_por IS NOT NULL AND autorizado_at IS NOT NULL)),
  CHECK (autorizado_por IS NULL OR autorizado_por <> propuesto_por)
);
CREATE INDEX IF NOT EXISTS inv_sinc_estado_idx ON public.inv_sinc (estado, propuesto_at DESC);
CREATE INDEX IF NOT EXISTS inv_sinc_ot_idx ON public.inv_sinc (ot);

CREATE TABLE IF NOT EXISTS public.inv_sinc_lineas (
  id bigserial PRIMARY KEY,
  sinc_id bigint NOT NULL REFERENCES public.inv_sinc(id) ON DELETE CASCADE,
  bodega text NOT NULL,
  producto text NOT NULL,
  glosa text,
  lote text NOT NULL,
  unidad text,
  cantidad numeric NOT NULL CHECK (cantidad > 0),
  peso_unit numeric CHECK (peso_unit IS NULL OR peso_unit >= 0)
);
CREATE INDEX IF NOT EXISTS inv_sinc_lineas_sinc_idx ON public.inv_sinc_lineas (sinc_id);
CREATE INDEX IF NOT EXISTS inv_sinc_lineas_key_idx ON public.inv_sinc_lineas (bodega, producto, lote);

ALTER TABLE public.inv_sinc ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inv_sinc_lineas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS security_active_account ON public.inv_sinc;
CREATE POLICY security_active_account ON public.inv_sinc AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
DROP POLICY IF EXISTS security_active_account ON public.inv_sinc_lineas;
CREATE POLICY security_active_account ON public.inv_sinc_lineas AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.is_active_tms_user())) WITH CHECK ((SELECT public.is_active_tms_user()));
REVOKE ALL ON public.inv_sinc FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.inv_sinc_lineas FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inv_sinc, public.inv_sinc_lineas TO service_role;
COMMENT ON TABLE public.inv_sinc IS 'Sinceramiento APT: transferencias del stock que físicamente no existe al almacén virtual SF. Solo por inv_sinc_*.';
COMMENT ON TABLE public.inv_sinc_lineas IS 'Líneas (bodega · producto · lote · cantidad) de cada sinceramiento APT.';

-- Permisos: proponer = carga del APT o «apt-sincerar»; autorizar = Jefe de Distribución, Administrador o «apt-sincerar-autorizar»
CREATE OR REPLACE FUNCTION public.inv_sinc_puede_proponer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.apt_can_load() OR public.menu_has_permission('apt-sincerar');
$$;
CREATE OR REPLACE FUNCTION public.inv_sinc_puede_autorizar()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.menu_has_permission('apt-sincerar-autorizar') OR EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = auth.uid() AND p.is_active AND r.name = 'Jefe de Distribución');
$$;

-- Saldo del modelo de una clave, sin lo comprometido por otros sinceramientos aún no reflejados:
-- propuestas pendientes y autorizaciones posteriores al último recálculo
CREATE OR REPLACE FUNCTION public.inv_sinc_disponible(p_bodega text, p_producto text, p_lote text, p_excluir bigint)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT sum(l.qty - l.consumed) FROM public.inv_layers l
                   WHERE l.bodega = p_bodega AND l.producto = p_producto AND l.lk = COALESCE(p_lote, '')), 0)
       - COALESCE((SELECT sum(x.cantidad) FROM public.inv_sinc_lineas x JOIN public.inv_sinc s ON s.id = x.sinc_id
                   WHERE x.bodega = p_bodega AND x.producto = p_producto AND x.lote = p_lote AND s.id IS DISTINCT FROM p_excluir
                     AND (s.estado = 'PROPUESTA' OR (s.estado = 'AUTORIZADA'
                          AND s.autorizado_at > COALESCE((SELECT rebuilt_at FROM public.inv_state WHERE id = 1), '-infinity')))), 0);
$$;

-- Traspasos al almacén virtual: se reescriben en cada recálculo (lo llama inv_rebuild)
CREATE OR REPLACE FUNCTION public.inv_sinc_materializar(p_from date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_up constant uuid := '5f000000-0000-4000-8000-00000000005f'; n integer;
BEGIN
  INSERT INTO public.inv_uploads (id, side, file_name, status)
  VALUES (v_up, 'E', 'Sinceramiento APT (almacén virtual SF)', 'DESCARTADA') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.inv_movements WHERE upload_id = v_up;
  INSERT INTO public.inv_movements (upload_id, side, active, linea, tipodocto, clase, bodega, numero, fecha, producto, glosa,
    cantidad, unidad, lote_raw, lote, ot, comentario, peso_unit, peso_kg)
  SELECT v_up, x.side, true, (l.id * 2 + x.k)::integer, 'SINCERAMIENTO SF', 'TRASPASO', x.bodega, s.numero,
    -- la fecha de autorización; si la foto de stock del modelo es posterior, el día en que arranca el modelo
    greatest((s.autorizado_at AT TIME ZONE 'America/Lima')::date, COALESCE(p_from, (s.autorizado_at AT TIME ZONE 'America/Lima')::date)),
    l.producto, l.glosa, x.sg * l.cantidad, l.unidad, l.lote, l.lote, s.ot, 'Sinceramiento ' || s.numero, l.peso_unit,
    round(l.cantidad * l.peso_unit, 3)
  FROM public.inv_sinc s JOIN public.inv_sinc_lineas l ON l.sinc_id = s.id
  CROSS JOIN LATERAL (VALUES (0, 'S', l.bodega, -1), (1, 'E', 'SF-SINCERAMIENTO', 1)) x(k, side, bodega, sg)
  -- regularizada: el ERP ya trae el saldo en cero, deja de restar
  WHERE s.estado = 'AUTORIZADA';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

DO $migration$
DECLARE src text := pg_get_functiondef('public.inv_rebuild()'::regprocedure);
  pat text := 'TRUNCATE public.inv_allocations, public.inv_transfer_links, public.inv_layers;';
BEGIN
  IF (length(src) - length(replace(src, pat, ''))) / length(pat) <> 1 THEN
    RAISE EXCEPTION 'inv_rebuild no vacía las tablas derivadas como se esperaba: revisar antes de migrar';
  END IF;
  IF position('inv_sinc_materializar' IN src) = 0 THEN
    EXECUTE replace(src, pat, pat || chr(10) || '  -- Sinceramiento: traspasos autorizados al almacén virtual SF'
      || chr(10) || '  PERFORM public.inv_sinc_materializar(v_from);');
  END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.inv_sinc_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso al inventario'); END IF;
  RETURN jsonb_build_object('success', true, 'uid', auth.uid(),
    'puede_proponer', public.inv_sinc_puede_proponer(), 'puede_autorizar', public.inv_sinc_puede_autorizar(),
    'rebuilt_at', (SELECT rebuilt_at FROM public.inv_state WHERE id = 1),
    'filas', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'numero', s.numero, 'ot', s.ot, 'cliente', s.cliente, 'motivo', s.motivo,
        'observacion', s.observacion, 'estado', s.estado, 'propuesto_por', s.propuesto_por, 'propuesto_at', s.propuesto_at,
        'proponente', public.inv_sinc_nombre(s.propuesto_por), 'decidido_at', s.decidido_at, 'decisor', public.inv_sinc_nombre(s.decidido_por),
        'decision_motivo', s.decision_motivo, 'autorizado_at', s.autorizado_at, 'autorizador', public.inv_sinc_nombre(s.autorizado_por),
        'revertido_at', s.revertido_at, 'revertidor', public.inv_sinc_nombre(s.revertido_por), 'revertido_motivo', s.revertido_motivo,
        'regularizado_at', s.regularizado_at,
        'lineas', (SELECT jsonb_agg(jsonb_build_object('bodega', l.bodega, 'producto', l.producto, 'glosa', l.glosa, 'lote', l.lote,
            'unidad', l.unidad, 'cantidad', l.cantidad, 'peso_unit', l.peso_unit, 'kg', round(l.cantidad * COALESCE(l.peso_unit, 0), 1))
            ORDER BY l.bodega, l.producto, l.lote) FROM public.inv_sinc_lineas l WHERE l.sinc_id = s.id))
        ORDER BY s.propuesto_at DESC)
      FROM public.inv_sinc s), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.inv_sinc_nombre(p uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(concat_ws(' ', first_name, last_name)), '') FROM public.profiles WHERE id = p;
$$;

-- p: { ot, cliente, motivo, observacion, lineas: [{ bodega, producto, glosa, lote, unidad, cantidad, peso_unit }] }
CREATE OR REPLACE FUNCTION public.inv_sinc_proponer(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_ot text := upper(btrim(COALESCE(p->>'ot', ''))); v_obs text := btrim(COALESCE(p->>'observacion', ''));
  v_id bigint; v_num text; bad text;
BEGIN
  IF NOT public.inv_sinc_puede_proponer() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para proponer sinceramientos'); END IF;
  IF v_ot = '' THEN RETURN jsonb_build_object('success', false, 'error', 'Indique el contrato u OT'); END IF;
  IF COALESCE(p->>'motivo', '') NOT IN ('DESPACHADO_SIN_GUIA', 'SALDO_INICIAL_INFERIDO', 'ERROR_DIGITACION', 'MERMA_NO_UBICADO') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Elija el motivo');
  END IF;
  IF length(v_obs) < 10 THEN RETURN jsonb_build_object('success', false, 'error', 'Describa lo verificado (mínimo 10 caracteres)'); END IF;
  IF jsonb_typeof(p->'lineas') <> 'array' OR jsonb_array_length(p->'lineas') = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Seleccione al menos un lote');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inv_layers LIMIT 1) THEN
    RETURN jsonb_build_object('success', false, 'error', 'El inventario se está preparando: intente en unos minutos');
  END IF;

  DROP TABLE IF EXISTS pg_temp.inv_sinc_in;
  CREATE TEMP TABLE inv_sinc_in ON COMMIT DROP AS
  SELECT btrim(x->>'bodega') AS bodega, btrim(x->>'producto') AS producto, NULLIF(btrim(x->>'glosa'), '') AS glosa,
    upper(btrim(COALESCE(x->>'lote', ''))) AS lote, NULLIF(btrim(x->>'unidad'), '') AS unidad,
    -- a la precisión de inv_movements.cantidad (numeric(20,6)): una cantidad que redondea a 0 haría fallar el recálculo
    round((x->>'cantidad')::numeric, 6) AS cantidad, NULLIF(x->>'peso_unit', '')::numeric AS peso_unit
  FROM jsonb_array_elements(p->'lineas') x;

  SELECT format('%s · %s · %s', bodega, producto, lote) INTO bad FROM inv_sinc_in
  WHERE public.apt_almacen(bodega) IS NULL OR producto = '' OR lote = '' OR cantidad IS NULL OR cantidad <= 0
     OR left(lote, length(v_ot)) <> v_ot OR substr(lote, length(v_ot) + 1, 1) ~ '\d' LIMIT 1;
  IF bad IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', format('Línea no válida (bodega del APT, lote del contrato %s y cantidad > 0): %s', v_ot, bad));
  END IF;
  -- Reserva serializada: dos propuestas simultáneas no pueden tomar el mismo saldo
  PERFORM pg_advisory_xact_lock(hashtext('inv_sinc'));
  SELECT format('%s · %s · %s: propone %s y hay %s disponibles', bodega, producto, lote, q, round(d, 3)) INTO bad
  FROM (SELECT bodega, producto, lote, sum(cantidad) q, public.inv_sinc_disponible(bodega, producto, lote, NULL) d
        FROM inv_sinc_in GROUP BY 1, 2, 3) t WHERE q > d + 0.0005 LIMIT 1;
  IF bad IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'Supera el saldo del sistema: ' || bad); END IF;

  INSERT INTO public.inv_sinc (ot, cliente, motivo, observacion) VALUES (v_ot, NULLIF(btrim(p->>'cliente'), ''), p->>'motivo', v_obs)
  RETURNING id, numero INTO v_id, v_num;
  INSERT INTO public.inv_sinc_lineas (sinc_id, bodega, producto, glosa, lote, unidad, cantidad, peso_unit)
  SELECT v_id, bodega, producto, glosa, lote, unidad, cantidad, peso_unit FROM inv_sinc_in;
  RETURN jsonb_build_object('success', true, 'id', v_id, 'numero', v_num);
END $$;

-- p: { id, accion: autorizar | rechazar | anular | revertir, motivo }
CREATE OR REPLACE FUNCTION public.inv_sinc_decidir(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.inv_sinc; v_acc text := COALESCE(p->>'accion', ''); v_mot text := NULLIF(btrim(COALESCE(p->>'motivo', '')), ''); bad text;
BEGIN
  SELECT * INTO s FROM public.inv_sinc WHERE id = (p->>'id')::bigint FOR UPDATE;
  IF s.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El sinceramiento no existe'); END IF;

  IF v_acc = 'anular' THEN
    IF s.estado <> 'PROPUESTA' OR s.propuesto_por IS DISTINCT FROM auth.uid() THEN
      RETURN jsonb_build_object('success', false, 'error', 'Solo quien propuso puede anular una propuesta pendiente');
    END IF;
    UPDATE public.inv_sinc SET estado = 'ANULADA', decidido_por = auth.uid(), decidido_at = now(), decision_motivo = v_mot WHERE id = s.id;
    RETURN jsonb_build_object('success', true, 'numero', s.numero, 'estado', 'ANULADA');
  END IF;

  IF NOT public.inv_sinc_puede_autorizar() THEN RETURN jsonb_build_object('success', false, 'error', 'Solo la Jefatura de Distribución autoriza sinceramientos'); END IF;
  IF v_acc IN ('rechazar', 'revertir') AND (v_mot IS NULL OR length(v_mot) < 5) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Indique el motivo');
  END IF;

  IF v_acc = 'rechazar' THEN
    IF s.estado <> 'PROPUESTA' THEN RETURN jsonb_build_object('success', false, 'error', format('%s ya está %s', s.numero, lower(s.estado))); END IF;
    UPDATE public.inv_sinc SET estado = 'RECHAZADA', decidido_por = auth.uid(), decidido_at = now(), decision_motivo = v_mot WHERE id = s.id;
    RETURN jsonb_build_object('success', true, 'numero', s.numero, 'estado', 'RECHAZADA');
  END IF;

  IF v_acc NOT IN ('autorizar', 'revertir') THEN RETURN jsonb_build_object('success', false, 'error', 'Acción no válida'); END IF;
  -- Cambia el stock: con un recálculo en curso su marca de «pendiente» se perdería, se pide reintentar
  IF NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay un recálculo del inventario en curso: intente de nuevo en un minuto');
  END IF;

  IF v_acc = 'autorizar' THEN
    IF s.estado <> 'PROPUESTA' THEN RETURN jsonb_build_object('success', false, 'error', format('%s ya está %s', s.numero, lower(s.estado))); END IF;
    IF s.propuesto_por = auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'No puede autorizar un sinceramiento que usted propuso'); END IF;
    PERFORM pg_advisory_xact_lock(hashtext('inv_sinc'));
    SELECT format('%s · %s · %s: %s propuestos y hay %s', bodega, producto, lote, q, round(d, 3)) INTO bad
    FROM (SELECT bodega, producto, lote, sum(cantidad) q, public.inv_sinc_disponible(bodega, producto, lote, s.id) d
          FROM public.inv_sinc_lineas WHERE sinc_id = s.id GROUP BY 1, 2, 3) t WHERE q > d + 0.0005 LIMIT 1;
    IF bad IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'El saldo del sistema cambió: ' || bad || '. Rechace y vuelva a proponer.'); END IF;
    UPDATE public.inv_sinc SET estado = 'AUTORIZADA', decidido_por = auth.uid(), decidido_at = now(), decision_motivo = v_mot,
      autorizado_por = auth.uid(), autorizado_at = now() WHERE id = s.id;
  ELSE
    IF s.estado <> 'AUTORIZADA' THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se revierte un sinceramiento autorizado'); END IF;
    UPDATE public.inv_sinc SET estado = 'REVERTIDA', revertido_por = auth.uid(), revertido_at = now(), revertido_motivo = v_mot WHERE id = s.id;
  END IF;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN jsonb_build_object('success', true, 'numero', s.numero, 'estado', CASE v_acc WHEN 'autorizar' THEN 'AUTORIZADA' ELSE 'REVERTIDA' END);
END $$;

REVOKE ALL ON FUNCTION public.inv_sinc_puede_proponer(), public.inv_sinc_puede_autorizar(), public.inv_sinc_nombre(uuid),
  public.inv_sinc_disponible(text, text, text, bigint), public.inv_sinc_materializar(date),
  public.inv_sinc_list(), public.inv_sinc_proponer(jsonb), public.inv_sinc_decidir(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_sinc_puede_proponer(), public.inv_sinc_puede_autorizar(), public.inv_sinc_nombre(uuid),
  public.inv_sinc_disponible(text, text, text, bigint), public.inv_sinc_materializar(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_sinc_list(), public.inv_sinc_proponer(jsonb), public.inv_sinc_decidir(jsonb) TO authenticated, service_role;
COMMIT;
