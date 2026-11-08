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
