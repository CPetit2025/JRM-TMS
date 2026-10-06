-- Flota es la fuente de la unidad del app, aun cuando no haya ruta.
BEGIN;
CREATE FUNCTION public.fleet_sync_driver_unit(p_driver uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_plate text; route_plate text;
BEGIN
 IF p_driver IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||p_driver::text,0));
 SELECT v.plate INTO v_plate FROM public.vehicles v JOIN public.drivers d ON d.id=v.assigned_driver_id
 WHERE d.id=p_driver AND d.is_active AND COALESCE(to_jsonb(v)->>'is_active','true')<>'false'
 AND COALESCE(v.type,'') NOT IN ('MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR');
 SELECT vehicle_plate INTO route_plate FROM public.dispatches WHERE driver_id=p_driver
 AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO')
 ORDER BY scheduled_departure DESC NULLS LAST LIMIT 1;
 -- No sustituye una unidad que está prestando un servicio activo.
 IF v_plate IS NOT NULL AND (route_plate IS NULL OR route_plate=v_plate) THEN
   PERFORM public.driver_preuse_select_core(p_driver,v_plate);
 ELSE
   DELETE FROM public.driver_preuse_units u WHERE u.driver_id=p_driver AND route_plate IS NULL
     AND EXISTS(SELECT 1 FROM public.vehicles v WHERE v.plate=u.vehicle_plate AND v.assigned_driver_id IS NOT NULL AND v.assigned_driver_id<>p_driver);
 END IF;
END $$;

CREATE FUNCTION public.fleet_assignment_app_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.assigned_driver_id IS NOT NULL AND
    (OLD.assigned_driver_id IS DISTINCT FROM NEW.assigned_driver_id OR OLD.plate IS DISTINCT FROM NEW.plate) THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||OLD.assigned_driver_id::text,0));
   DELETE FROM public.driver_preuse_units u WHERE u.driver_id=OLD.assigned_driver_id AND u.vehicle_plate=OLD.plate
     AND NOT EXISTS(SELECT 1 FROM public.dispatches d WHERE d.driver_id=OLD.assigned_driver_id AND d.vehicle_plate=OLD.plate
       AND d.status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO'));
 END IF;
 PERFORM public.fleet_sync_driver_unit(NEW.assigned_driver_id);
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_assignment_app_sync AFTER INSERT OR UPDATE OF assigned_driver_id,plate ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.fleet_assignment_app_sync();

-- También sincroniza asignaciones existentes. No relaciona personas por nombre ni altera rutas.
SELECT public.fleet_sync_driver_unit(assigned_driver_id) FROM public.vehicles WHERE assigned_driver_id IS NOT NULL;

ALTER FUNCTION public.get_driver_preuse_context() RENAME TO get_driver_preuse_context_before_fleet;
CREATE FUNCTION public.get_driver_preuse_context() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr uuid; r jsonb; assigned jsonb;
BEGIN
 SELECT d.id INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id
 WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr IS NULL THEN RAISE EXCEPTION 'No existe un conductor activo asociado a la sesión'; END IF;
 PERFORM public.fleet_sync_driver_unit(dr);
 r:=public.get_driver_preuse_context_before_fleet();
 SELECT jsonb_build_object('plate',v.plate,'soat_expiration',to_jsonb(v)->>'soat_expiration',
 'technical_review_expiration',to_jsonb(v)->>'technical_review_expiration') INTO assigned
 FROM public.vehicles v WHERE v.assigned_driver_id=dr AND COALESCE(to_jsonb(v)->>'is_active','true')<>'false'
 AND COALESCE(v.type,'') NOT IN ('MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR');
 -- Solo la unidad asignada (o la de una ruta activa) puede seleccionarse. Sin asignación
 -- se conserva el mecanismo manual, pero se excluyen las unidades de otros conductores.
 r:=jsonb_set(r,'{vehicles}',COALESCE((SELECT jsonb_agg(x ORDER BY x->>'plate') FROM
   (SELECT value AS x FROM jsonb_array_elements(r->'vehicles') WHERE EXISTS(
     SELECT 1 FROM public.vehicles v WHERE v.plate=value->>'plate'
       AND (v.assigned_driver_id IS NULL OR v.assigned_driver_id=dr)
       AND (assigned IS NULL OR v.plate=assigned->>'plate' OR v.plate=r->>'route_plate'))
    UNION SELECT assigned WHERE assigned IS NOT NULL) choices),'[]'::jsonb));
 RETURN r||jsonb_build_object('assigned_unit',assigned);
END $$;

ALTER FUNCTION public.select_driver_preuse_unit(text) RENAME TO select_driver_preuse_unit_before_fleet;
CREATE FUNCTION public.select_driver_preuse_unit(p_plate text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dr uuid; assigned text; route_plate text; v public.vehicles; v_plate text:=upper(trim(p_plate));
BEGIN
 SELECT d.id INTO dr FROM public.drivers d JOIN public.profiles p ON p.id=d.profile_id
 WHERE d.profile_id=auth.uid() AND d.is_active AND p.is_active ORDER BY d.id LIMIT 1;
 IF dr IS NULL THEN RAISE EXCEPTION 'No existe un conductor activo asociado a la sesión'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('driver-preuse:'||dr::text,0));
 SELECT * INTO v FROM public.vehicles WHERE vehicles.plate=v_plate;
 SELECT vehicle_plate INTO route_plate FROM public.dispatches WHERE driver_id=dr
 AND status IN ('PROGRAMADO','EN_CURSO','EN RUTA','ESPERANDO_AUTORIZACION','RETORNO') LIMIT 1;
 SELECT vehicles.plate INTO assigned FROM public.vehicles WHERE assigned_driver_id=dr;
 IF v.assigned_driver_id IS NOT NULL AND v.assigned_driver_id<>dr THEN RAISE EXCEPTION 'La unidad está asignada a otro conductor'; END IF;
 IF route_plate IS NOT NULL AND route_plate<>v_plate THEN RAISE EXCEPTION 'La unidad debe coincidir con tu ruta activa'; END IF;
 IF assigned IS NOT NULL AND assigned<>v_plate AND route_plate IS NULL THEN RAISE EXCEPTION 'Solicita a Transporte cambiar tu unidad asignada en Flota'; END IF;
 IF v.assigned_driver_id=dr AND COALESCE(to_jsonb(v)->>'is_active','true')<>'false'
 AND COALESCE(v.type,'') NOT IN ('MONTACARGAS','APILADOR','TRANSPALETA','ELEVADOR') THEN
   RETURN public.driver_preuse_select_core(dr,v_plate);
 END IF;
 RETURN public.select_driver_preuse_unit_before_fleet(v_plate);
END $$;

CREATE OR REPLACE FUNCTION public.get_active_trip_context() RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; c jsonb;
BEGIN
 r:=public.get_active_trip_context_before_preuse();
 IF r->'driver'->>'id' IS NOT NULL THEN
   c:=public.get_driver_preuse_context();
   r:=jsonb_set(r,'{pending}',COALESCE(r->'pending','{}'::jsonb)||jsonb_build_object('checklist',c->'pending'));
   r:=r||jsonb_build_object('assigned_unit',c->'assigned_unit');
 END IF; RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.fleet_sync_driver_unit(uuid),public.fleet_assignment_app_sync(),
 public.get_driver_preuse_context_before_fleet(),public.select_driver_preuse_unit_before_fleet(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_driver_preuse_context(),public.select_driver_preuse_unit(text),public.get_active_trip_context() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_driver_preuse_context(),public.select_driver_preuse_unit(text),public.get_active_trip_context() TO authenticated,service_role;
COMMIT;
