-- App del conductor: cada parada muestra su OT (u OC/OS/RQ si no tiene OT) y el cliente o proveedor.
-- En rutas con varias OT el viaje no tiene una OT única, por eso el dato va por parada. Se envuelve la función
-- vigente sin cambiar su lógica.
CREATE OR REPLACE FUNCTION public.trip_stop_info(p_request uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'ot_code',(SELECT c.code FROM public.contracts c WHERE c.id=t.contract_id),
  'reference',NULLIF(trim(COALESCE(to_jsonb(t)->>'reference_type','')||' '||COALESCE(to_jsonb(t)->>'reference_number','')),''),
  'party_label',CASE WHEN COALESCE(to_jsonb(t)->>'attention_mode','')<>'RECOJO_CLIENTE' AND t.request_type IN ('RECOJO','TRASLADO') THEN 'Proveedor' ELSE 'Cliente' END,
  'party_name',CASE WHEN COALESCE(to_jsonb(t)->>'attention_mode','')<>'RECOJO_CLIENTE' AND t.request_type IN ('RECOJO','TRASLADO')
   THEN COALESCE((SELECT s.business_name FROM public.suppliers s WHERE s.id=NULLIF(to_jsonb(t)->>'supplier_id','')::uuid),
                 (SELECT cl.business_name FROM public.clients cl WHERE cl.id=t.client_id))
   ELSE COALESCE((SELECT cl.business_name FROM public.clients cl WHERE cl.id=t.client_id),
                 (SELECT s.business_name FROM public.suppliers s WHERE s.id=NULLIF(to_jsonb(t)->>'supplier_id','')::uuid)) END)
 FROM public.transport_requests t WHERE t.id=p_request;
$$;
REVOKE ALL ON FUNCTION public.trip_stop_info(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trip_stop_info(uuid) TO service_role;

DO $wrap$ BEGIN
 IF to_regprocedure('public.get_active_trip_context_before_stop_info()') IS NULL THEN
  ALTER FUNCTION public.get_active_trip_context() RENAME TO get_active_trip_context_before_stop_info;
 END IF;
END $wrap$;
REVOKE ALL ON FUNCTION public.get_active_trip_context_before_stop_info() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_active_trip_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb:=public.get_active_trip_context_before_stop_info();
BEGIN
 IF jsonb_typeof(r#>'{trip,stops}')='array' THEN
  r:=jsonb_set(r,'{trip,stops}',COALESCE((SELECT jsonb_agg(s||COALESCE(public.trip_stop_info(NULLIF(s->>'transport_request_id','')::uuid),'{}'::jsonb) ORDER BY o)
   FROM jsonb_array_elements(r#>'{trip,stops}') WITH ORDINALITY e(s,o)),'[]'::jsonb));
 END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.get_active_trip_context() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_active_trip_context() TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
