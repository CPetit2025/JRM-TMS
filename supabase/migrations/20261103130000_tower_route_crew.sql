-- Datos operativos de auxiliares asignados: no exponer la ficha laboral completa.
BEGIN;
CREATE OR REPLACE FUNCTION public.get_tower_route_crew(p_dispatch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_active_tms_user() OR NOT (
   public.has_tms_read_permission('torre-control') OR public.has_tms_read_permission('despacho')
   OR public.has_tms_read_permission('monitoreo')) THEN
  RAISE EXCEPTION 'Sin permiso para consultar la tripulación' USING ERRCODE='42501';
 END IF;
 IF p_dispatch_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatches WHERE id=p_dispatch_id)
   OR NOT public.delivery_can_read(p_dispatch_id) THEN
  RAISE EXCEPTION 'Despacho no disponible' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('success',true,'people',COALESCE((
  WITH people AS (
   SELECT hp.id::text AS id,hp.name,hp.code,hp.document_number,hp.position,a.name AS area,
     COALESCE(NULLIF(to_jsonb(hp)->>'phone',''),NULLIF(to_jsonb(d)->>'phone',''),NULLIF(to_jsonb(p)->>'phone','')) AS phone,
     'AUXILIAR'::text AS role,hp.active
   FROM public.route_auxiliaries ra JOIN public.hhee_people hp ON hp.id=ra.person_id
   LEFT JOIN public.hhee_areas a ON a.id=hp.area_id
   LEFT JOIN public.drivers d ON d.id=hp.driver_id LEFT JOIN public.profiles p ON p.id=hp.profile_id
   WHERE ra.dispatch_id=p_dispatch_id
   UNION ALL
   SELECT c.id::text,COALESCE(NULLIF(hp.name,''),NULLIF(btrim(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name')),''),'Sin nombre'),
     hp.code,COALESCE(NULLIF(hp.document_number,''),NULLIF(to_jsonb(p)->>'document_number',''),NULLIF(to_jsonb(p)->>'document_id','')),
     hp.position,COALESCE(a.name,NULLIF(to_jsonb(p)->>'area','')),
     COALESCE(NULLIF(to_jsonb(hp)->>'phone',''),NULLIF(to_jsonb(d)->>'phone',''),NULLIF(to_jsonb(p)->>'phone','')),
     c.crew_role,COALESCE(hp.active,p.is_active)
   FROM public.dispatch_crew c JOIN public.profiles p ON p.id=c.profile_id
   LEFT JOIN LATERAL (SELECT h.* FROM public.hhee_people h WHERE h.profile_id=c.profile_id ORDER BY h.active DESC,h.id LIMIT 1) hp ON true
   LEFT JOIN public.hhee_areas a ON a.id=hp.area_id LEFT JOIN public.drivers d ON d.id=hp.driver_id
   WHERE c.dispatch_id=p_dispatch_id AND c.removed_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.route_auxiliaries ra JOIN public.hhee_people h ON h.id=ra.person_id
      WHERE ra.dispatch_id=p_dispatch_id AND h.profile_id=c.profile_id)
  ) SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'code',code,'document_number',document_number,
    'position',position,'area',area,'phone',phone,'role',role,'active',active) ORDER BY name,id) FROM people
 ),'[]'::jsonb),'manual_closure',(
  SELECT jsonb_build_object('reason',COALESCE(NULLIF(e.payload->>'reason',''),e.description),
    'closed_at',COALESCE(e.payload->>'closed_at',e.created_at::text),'previous_status',e.payload->>'previous_status',
    'actor_name',COALESCE(NULLIF(btrim(concat_ws(' ',to_jsonb(p)->>'first_name',to_jsonb(p)->>'last_name')),''),'Usuario no disponible'))
  FROM public.dispatch_events e LEFT JOIN public.profiles p ON p.id=e.created_by_user
  WHERE e.dispatch_id=p_dispatch_id AND e.event_type='CIERRE_OPERATIVO_MANUAL'
  ORDER BY e.created_at DESC NULLS LAST,e.id DESC LIMIT 1
 ));
END $$;
REVOKE ALL ON FUNCTION public.get_tower_route_crew(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_tower_route_crew(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
