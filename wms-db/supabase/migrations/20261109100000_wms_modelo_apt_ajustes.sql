-- Ajustes de la réplica del modelo de almacén (revisión de #513).
-- 1. apt_flow_tms: varias funciones de flujo lo llaman. En el WMS no hay documentos de despacho del TMS, así que
--    devuelve un objeto vacío (misma definición que el TMS, que ya lo resuelve así cuando falta la tabla).
-- 2. erp_ot_cliente_erp: lo usa inv_contratos_refresh (refresco de la caché del inventario); solo lee el ERP.
-- 3. Vistas del modelo: Supabase da acceso por defecto a authenticated en vistas nuevas y una vista lee como su dueño
--    (sin RLS). Se cierran: los datos se leen por las funciones, que validan cuenta activa y permisos.

CREATE OR REPLACE FUNCTION public.apt_flow_tms(p_docs text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE v jsonb := '{}'::jsonb;
BEGIN
  IF p_docs IS NULL OR cardinality(p_docs) = 0 OR to_regclass('public.dispatch_documents') IS NULL THEN RETURN v; END IF;
  EXECUTE $q$
    SELECT COALESCE(jsonb_object_agg(doc, info), '{}'::jsonb) FROM (
      SELECT DISTINCT ON (upper(dd.document_number)) upper(dd.document_number) AS doc, jsonb_build_object(
        'dispatch_id', d.id, 'numero', to_jsonb(d) ->> 'dispatch_number', 'estado', to_jsonb(d) ->> 'status',
        'programado', to_jsonb(d) ->> 'scheduled_date', 'salida', to_jsonb(d) ->> 'departure_time',
        'llegada', to_jsonb(d) ->> 'arrival_time', 'placa', to_jsonb(d) ->> 'vehicle_plate',
        'conductor', to_jsonb(d) ->> 'driver_name') AS info
      FROM public.dispatch_documents dd JOIN public.dispatches d ON d.id = dd.dispatch_id
      WHERE dd.voided_at IS NULL AND upper(dd.document_number) = ANY ($1)
      ORDER BY upper(dd.document_number), dd.uploaded_at DESC NULLS LAST) z $q$
  INTO v USING (SELECT array_agg(upper(btrim(x))) FROM unnest(p_docs) x);
  RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN '{}'::jsonb;
END $function$;

CREATE OR REPLACE FUNCTION public.erp_ot_cliente_erp()
RETURNS TABLE(ot text, cliente text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT DISTINCT ON (x.raiz) x.raiz, x.cliente FROM (
    SELECT public.apt_ot_raiz(l.ot) AS raiz, btrim(l.cliente) AS cliente, count(*) AS n
    FROM public.erp_contract_lines l
    WHERE l.import_id = public.erp_active_import('CONTRATOS') AND NULLIF(btrim(l.cliente), '') IS NOT NULL
    GROUP BY 1, 2) x
  WHERE x.raiz IS NOT NULL ORDER BY x.raiz, x.n DESC, x.cliente;
$function$;

REVOKE ALL ON FUNCTION public.apt_flow_tms(text[]), public.erp_ot_cliente_erp() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.apa_v_movimientos_vigentes, public.apa_v_clientes, public.apa_v_documentos, public.apa_v_lotes,
  public.apa_v_ordenes, public.apa_v_productos, public.apa_v_traspasos, public.inv_movements_v FROM PUBLIC, anon, authenticated;

-- 4. Filas únicas de estado y configuración: las funciones solo las actualizan. En producción llegan con la copia de la
--    historia; en una base nueva se crean con sus valores por defecto (no pisan filas existentes).
INSERT INTO public.inv_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.apt_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.apt_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.apt_flow_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.apt_gantt_meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 5. erp_estado con el formato del TMS (la pestaña ERP lee «activas» e «historial»); conserva can_load, que verifican
--    las rutas que aplican cargas en el servidor.
CREATE OR REPLACE FUNCTION public.erp_estado()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  IF NOT public.apt_can_view() THEN RETURN jsonb_build_object('success', false, 'error', 'Sin acceso a los datos del ERP'); END IF;
  RETURN jsonb_build_object('success', true, 'can_load', public.apt_can_load(),
    'activas', COALESCE((SELECT jsonb_object_agg(kind, jsonb_build_object('id', id, 'file_name', file_name, 'cut_at', cut_at, 'applied_at', applied_at,
       'rows', rows_loaded, 'summary', summary)) FROM public.erp_imports WHERE status = 'ACTIVA'), '{}'::jsonb),
    'historial', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'status', status, 'file_name', file_name, 'cut_at', cut_at,
       'applied_at', applied_at, 'created_at', created_at, 'rows', rows_loaded) ORDER BY created_at DESC)
       FROM (SELECT * FROM public.erp_imports ORDER BY created_at DESC LIMIT 20) h), '[]'::jsonb));
END $function$;

-- 6. erp_tms_guias cruza las guías con las rutas del TMS; en el WMS no hay despachos del TMS: devuelve vacío.
CREATE OR REPLACE FUNCTION public.erp_tms_guias(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE(guia_key text, guia text, fecha date, rutas text, placas text, ot text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $function$
  SELECT NULL::text, NULL::text, NULL::date, NULL::text, NULL::text, NULL::text WHERE false;
$function$;
REVOKE ALL ON FUNCTION public.erp_tms_guias(date, date) FROM PUBLIC, anon, authenticated;
