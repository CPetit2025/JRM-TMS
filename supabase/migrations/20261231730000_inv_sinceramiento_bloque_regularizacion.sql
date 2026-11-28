-- ============================================================
-- Sinceramiento APT: bloque de contratos, transferencia directa de la Jefatura y regularización con el ERP (fase 4)
-- ============================================================
-- 1. Bloque: varias OT a la vez, cada una con todo su stock del APT (647 · 540 · ST). Cada OT tiene su acta (se revierte
--    sola) y las actas del bloque comparten «bloque» (BQ-…) para el acta consolidada.
-- 2. Directo: la Jefatura de Distribución (quien puede autorizar) propone y autoriza en un paso; queda marcado en el acta.
--    El Analista sigue con proponer → autorizar (nadie autoriza lo propio, salvo la transferencia directa).
-- 3. Regularización: al autorizar se guarda el saldo de la clave en el modelo (saldo_previo). En cada recálculo, si los
--    movimientos del ERP posteriores dejan la clave por debajo de lo que realmente había (saldo_previo − cantidad), esa
--    diferencia ya la quitó el ERP: deja de restarse en SF. Todo regularizado → estado REGULARIZADA.
--    Así un despacho real de la parte que sí existía no «devuelve» el stock fantasma al APT.
BEGIN;
SET LOCAL lock_timeout = '3min';
SELECT pg_advisory_xact_lock(hashtext('inv_rebuild'));

ALTER TABLE public.inv_sinc ADD COLUMN IF NOT EXISTS bloque text;
ALTER TABLE public.inv_sinc ADD COLUMN IF NOT EXISTS directo boolean NOT NULL DEFAULT false;
ALTER TABLE public.inv_sinc_lineas ADD COLUMN IF NOT EXISTS saldo_previo numeric;
CREATE INDEX IF NOT EXISTS inv_sinc_bloque_idx ON public.inv_sinc (bloque) WHERE bloque IS NOT NULL;

-- «Nadie autoriza lo propio», salvo la transferencia directa de la Jefatura
DO $migration$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.inv_sinc'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ~ 'autorizado_por <> propuesto_por' AND conname <> 'inv_sinc_autoriza_otro' LOOP
    EXECUTE format('ALTER TABLE public.inv_sinc DROP CONSTRAINT %I', c);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.inv_sinc'::regclass AND conname = 'inv_sinc_autoriza_otro') THEN
    ALTER TABLE public.inv_sinc ADD CONSTRAINT inv_sinc_autoriza_otro CHECK (autorizado_por IS NULL OR autorizado_por <> propuesto_por OR directo);
  END IF;
END $migration$;

-- Autoriza (pasos comunes de decidir y de la transferencia directa): reserva serializada, saldo y saldo_previo por clave.
-- Devuelve el error o NULL. Lo llaman funciones que ya validaron permiso y estado.
CREATE OR REPLACE FUNCTION public.inv_sinc_autorizar_interno(p_id bigint, p_directo boolean, p_motivo text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bad text; v_rebuilt timestamptz := COALESCE((SELECT rebuilt_at FROM public.inv_state WHERE id = 1), '-infinity');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('inv_sinc'));
  SELECT format('%s · %s · %s: %s propuestos y hay %s', bodega, producto, lote, q, round(d, 3)) INTO bad
  FROM (SELECT bodega, producto, lote, sum(cantidad) q, public.inv_sinc_disponible(bodega, producto, lote, p_id) d
        FROM public.inv_sinc_lineas WHERE sinc_id = p_id GROUP BY 1, 2, 3) t WHERE q > d + 0.0005 LIMIT 1;
  IF bad IS NOT NULL THEN RETURN 'El saldo del sistema cambió: ' || bad || '. Rechace y vuelva a proponer.'; END IF;
  -- Saldo de la clave en el modelo sin este sinceramiento (descontando otros autorizados aún no reflejados)
  UPDATE public.inv_sinc_lineas l SET saldo_previo =
      COALESCE((SELECT sum(y.qty - y.consumed) FROM public.inv_layers y
                WHERE y.bodega = l.bodega AND y.producto = l.producto AND y.lk = l.lote), 0)
    - COALESCE((SELECT sum(x.cantidad) FROM public.inv_sinc_lineas x JOIN public.inv_sinc s ON s.id = x.sinc_id
                WHERE x.bodega = l.bodega AND x.producto = l.producto AND x.lote = l.lote AND s.id <> p_id
                  AND s.estado = 'AUTORIZADA' AND s.autorizado_at > v_rebuilt), 0)
  WHERE l.sinc_id = p_id;
  UPDATE public.inv_sinc SET estado = 'AUTORIZADA', decidido_por = auth.uid(), decidido_at = now(), decision_motivo = p_motivo,
    autorizado_por = auth.uid(), autorizado_at = now(), directo = p_directo WHERE id = p_id;
  UPDATE public.inv_state SET dirty = true WHERE id = 1;
  RETURN NULL;
END $$;

-- p: { id, accion: autorizar | rechazar | anular | revertir, motivo }  (igual que antes; autorizar usa el paso común)
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
    bad := public.inv_sinc_autorizar_interno(s.id, false, v_mot);
    IF bad IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', bad); END IF;
  ELSE
    IF s.estado <> 'AUTORIZADA' THEN RETURN jsonb_build_object('success', false, 'error', 'Solo se revierte un sinceramiento autorizado'); END IF;
    UPDATE public.inv_sinc SET estado = 'REVERTIDA', revertido_por = auth.uid(), revertido_at = now(), revertido_motivo = v_mot WHERE id = s.id;
    UPDATE public.inv_state SET dirty = true WHERE id = 1;
  END IF;
  RETURN jsonb_build_object('success', true, 'numero', s.numero, 'estado', CASE v_acc WHEN 'autorizar' THEN 'AUTORIZADA' ELSE 'REVERTIDA' END);
END $$;

-- p: { motivo, observacion, directo, ot, cliente, lineas: [...] }        → una OT con los lotes elegidos (modal)
--  o { motivo, observacion, directo, ots: [{ ot, cliente }] }             → bloque: cada OT con todo su stock del APT
-- directo = la Jefatura propone y autoriza en un paso. Todo o nada: si una OT falla, no se registra ninguna.
CREATE OR REPLACE FUNCTION public.inv_sinc_transferir(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_dir boolean := COALESCE((p->>'directo')::boolean, false); v_bloque boolean := jsonb_typeof(p->'ots') = 'array';
  o jsonb; v_ot text; v_lin jsonb; r jsonb; bad text; v_ids bigint[] := '{}'; v_sin text[] := '{}'; v_bq text;
BEGIN
  IF NOT public.inv_sinc_puede_proponer() THEN RETURN jsonb_build_object('success', false, 'error', 'No tiene permiso para proponer sinceramientos'); END IF;
  IF v_dir AND NOT public.inv_sinc_puede_autorizar() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Solo la Jefatura de Distribución transfiere directamente');
  END IF;
  IF v_dir AND NOT pg_try_advisory_xact_lock(hashtext('inv_rebuild')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hay un recálculo del inventario en curso: intente de nuevo en un minuto');
  END IF;
  IF v_bloque AND jsonb_array_length(p->'ots') = 0 THEN RETURN jsonb_build_object('success', false, 'error', 'Seleccione al menos un contrato'); END IF;
  IF v_bloque AND jsonb_array_length(p->'ots') > 300 THEN RETURN jsonb_build_object('success', false, 'error', 'Máximo 300 contratos por bloque'); END IF;

  BEGIN
    FOR o IN SELECT x FROM jsonb_array_elements(CASE WHEN v_bloque THEN p->'ots' ELSE jsonb_build_array(p) END) x LOOP
      v_ot := upper(btrim(COALESCE(o->>'ot', '')));
      IF v_bloque THEN
        -- Todo el stock del APT de la OT (lote madre y subcontratos), menos lo ya comprometido en otros sinceramientos
        SELECT jsonb_agg(jsonb_build_object('bodega', k.bodega, 'producto', k.producto, 'lote', k.lk, 'cantidad', k.disp,
                 'peso_unit', k.pu, 'glosa', g.glosa, 'unidad', g.unidad) ORDER BY k.bodega, k.producto, k.lk)
          INTO v_lin
        FROM (SELECT y.bodega, y.producto, y.lk,
                     round(sum((y.qty - y.consumed) * COALESCE(y.peso_unit, 0)) / NULLIF(sum(y.qty - y.consumed) FILTER (WHERE y.peso_unit IS NOT NULL), 0), 6) AS pu,
                     round(public.inv_sinc_disponible(y.bodega, y.producto, y.lk, NULL), 6) AS disp
              FROM public.inv_layers y
              WHERE v_ot <> '' AND left(y.lk, length(v_ot)) = v_ot AND substr(y.lk, length(v_ot) + 1, 1) !~ '\d'
                AND public.apt_almacen(y.bodega) IS NOT NULL AND y.qty > y.consumed
              GROUP BY 1, 2, 3) k
        LEFT JOIN LATERAL (SELECT m.glosa, m.unidad FROM public.inv_movements m
                           WHERE m.active AND m.lote = k.lk AND m.producto = k.producto ORDER BY m.fecha DESC LIMIT 1) g ON true
        WHERE k.disp > 0.0000005;
        IF v_lin IS NULL THEN v_sin := v_sin || v_ot; CONTINUE; END IF;
        r := public.inv_sinc_proponer(jsonb_build_object('ot', v_ot, 'cliente', o->>'cliente', 'motivo', p->>'motivo',
               'observacion', p->>'observacion', 'lineas', v_lin));
      ELSE
        r := public.inv_sinc_proponer(p);
      END IF;
      IF NOT COALESCE((r->>'success')::boolean, false) THEN RAISE EXCEPTION USING MESSAGE = format('OT %s: %s', v_ot, r->>'error'), ERRCODE = 'SF001'; END IF;
      v_ids := v_ids || (r->>'id')::bigint;
      IF v_dir THEN
        bad := public.inv_sinc_autorizar_interno((r->>'id')::bigint, true, 'Transferencia directa de la Jefatura de Distribución');
        IF bad IS NOT NULL THEN RAISE EXCEPTION USING MESSAGE = format('OT %s: %s', v_ot, bad), ERRCODE = 'SF001'; END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN SQLSTATE 'SF001' THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Las OT elegidas no tienen stock disponible para sincerar', 'sin_stock', to_jsonb(v_sin));
  END IF;
  IF v_bloque THEN
    v_bq := 'BQ-' || lpad(v_ids[1]::text, 6, '0');
    UPDATE public.inv_sinc SET bloque = v_bq WHERE id = ANY (v_ids);
  END IF;
  RETURN jsonb_build_object('success', true, 'bloque', v_bq, 'directo', v_dir, 'sin_stock', to_jsonb(v_sin),
    'actas', (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'numero', s.numero, 'ot', s.ot, 'estado', s.estado,
                'lotes', (SELECT count(*) FROM public.inv_sinc_lineas l WHERE l.sinc_id = s.id),
                'kg', (SELECT round(sum(l.cantidad * COALESCE(l.peso_unit, 0)), 1) FROM public.inv_sinc_lineas l WHERE l.sinc_id = s.id))
                ORDER BY s.id) FROM public.inv_sinc s WHERE s.id = ANY (v_ids)));
END $$;

-- Traspasos al almacén virtual, menos lo ya regularizado por el ERP (se reescriben en cada recálculo; lo llama inv_rebuild)
CREATE OR REPLACE FUNCTION public.inv_sinc_materializar(p_from date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_up constant uuid := '5f000000-0000-4000-8000-00000000005f'; n integer;
BEGIN
  INSERT INTO public.inv_uploads (id, side, file_name, status)
  VALUES (v_up, 'E', 'Sinceramiento APT (almacén virtual SF)', 'DESCARTADA') ON CONFLICT (id) DO NOTHING;
  DELETE FROM public.inv_movements WHERE upload_id = v_up;

  DROP TABLE IF EXISTS pg_temp.inv_sinc_vigente;
  -- reg: lo que el ERP ya quitó. Saldo de la clave sin sinceramiento = saldo_previo + neto de movimientos del ERP posteriores
  -- a la autorización; si queda por debajo de saldo_previo − cantidad, la diferencia la regularizó el ERP.
  -- shortcut: cuenta los movimientos con fecha posterior al día de la autorización; un ajuste del ERP fechado el mismo día
  -- no se ve (los del ERP suelen registrarse después). Índice inv_movements_key_idx: solo lee las claves sinceradas.
  CREATE TEMP TABLE inv_sinc_vigente ON COMMIT DROP AS
  SELECT s.id AS sinc_id, s.numero, s.ot, s.autorizado_at, l.id, l.bodega, l.producto, l.glosa, l.lote, l.unidad, l.peso_unit, l.cantidad,
    CASE WHEN l.saldo_previo IS NULL THEN 0 ELSE least(l.cantidad, greatest(0, l.cantidad - l.saldo_previo - COALESCE((
      SELECT sum(m.cantidad) FROM public.inv_movements m
      WHERE m.active AND m.bodega = l.bodega AND m.producto = l.producto AND m.lote = l.lote
        AND m.fecha > (s.autorizado_at AT TIME ZONE 'America/Lima')::date), 0))) END AS reg
  FROM public.inv_sinc s JOIN public.inv_sinc_lineas l ON l.sinc_id = s.id
  WHERE s.estado = 'AUTORIZADA';

  UPDATE public.inv_sinc s SET estado = 'REGULARIZADA', regularizado_at = now()
  WHERE s.estado = 'AUTORIZADA' AND NOT EXISTS (SELECT 1 FROM inv_sinc_vigente v WHERE v.sinc_id = s.id AND v.cantidad - v.reg > 0.0000005);

  INSERT INTO public.inv_movements (upload_id, side, active, linea, tipodocto, clase, bodega, numero, fecha, producto, glosa,
    cantidad, unidad, lote_raw, lote, ot, comentario, peso_unit, peso_kg)
  SELECT v_up, x.side, true, (v.id * 2 + x.k)::integer, 'SINCERAMIENTO SF', 'TRASPASO', x.bodega, v.numero,
    -- la fecha de autorización; si la foto de stock del modelo es posterior, el día en que arranca el modelo
    greatest((v.autorizado_at AT TIME ZONE 'America/Lima')::date, COALESCE(p_from, (v.autorizado_at AT TIME ZONE 'America/Lima')::date)),
    v.producto, v.glosa, x.sg * round(v.cantidad - v.reg, 6), v.unidad, v.lote, v.lote, v.ot, 'Sinceramiento ' || v.numero, v.peso_unit,
    round((v.cantidad - v.reg) * v.peso_unit, 3)
  FROM inv_sinc_vigente v
  CROSS JOIN LATERAL (VALUES (0, 'S', v.bodega, -1), (1, 'E', 'SF-SINCERAMIENTO', 1)) x(k, side, bodega, sg)
  WHERE round(v.cantidad - v.reg, 6) > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Lista: agrega bloque, directo y lo regularizado por línea (pendiente = cantidad − regularizado)
CREATE OR REPLACE FUNCTION public.inv_sinc_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_up constant uuid := '5f000000-0000-4000-8000-00000000005f';
  v_rb timestamptz := COALESCE((SELECT rebuilt_at FROM public.inv_state WHERE id = 1), '-infinity');
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
        'regularizado_at', s.regularizado_at, 'bloque', s.bloque, 'directo', s.directo,
        'lineas', (SELECT jsonb_agg(jsonb_build_object('bodega', l.bodega, 'producto', l.producto, 'glosa', l.glosa, 'lote', l.lote,
            'unidad', l.unidad, 'cantidad', l.cantidad, 'peso_unit', l.peso_unit, 'kg', round(l.cantidad * COALESCE(l.peso_unit, 0), 1),
            -- en SF ahora: aún sin recalcular, todo; después, el traspaso vigente (0 si ya lo regularizó el ERP)
            'en_sf', CASE WHEN s.estado <> 'AUTORIZADA' THEN 0 WHEN s.autorizado_at > v_rb THEN l.cantidad
                       ELSE COALESCE((SELECT m.cantidad FROM public.inv_movements m WHERE m.upload_id = v_up AND m.numero = s.numero
                                      AND m.bodega = 'SF-SINCERAMIENTO' AND m.linea = l.id * 2 + 1), 0) END)
            ORDER BY l.bodega, l.producto, l.lote) FROM public.inv_sinc_lineas l WHERE l.sinc_id = s.id))
        ORDER BY s.propuesto_at DESC)
      FROM public.inv_sinc s), '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION public.inv_sinc_autorizar_interno(bigint, boolean, text), public.inv_sinc_transferir(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_sinc_autorizar_interno(bigint, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_sinc_transferir(jsonb) TO authenticated, service_role;
COMMIT;
