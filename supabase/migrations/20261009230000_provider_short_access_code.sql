-- Four-character provider codes; preserve issued credentials until expiry/explicit renewal.
BEGIN;
CREATE OR REPLACE FUNCTION public.delivery_issue_access_core(p_dispatch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; v_token text; v_code text; v_expires timestamptz;
 v_byte integer; v_attempt integer; v_inserted boolean:=false;
BEGIN
 SELECT to_jsonb(x) INTO d FROM public.dispatches x WHERE x.id=p_dispatch FOR UPDATE;
 IF d IS NULL OR d->>'modalidad' IS DISTINCT FROM 'TERCERO' OR d->>'status' NOT IN ('PROGRAMADO','EN_CURSO','EN RUTA') THEN
   RAISE EXCEPTION 'El servicio no admite acceso del tercero'; END IF;
 UPDATE public.dispatch_tercero_enlaces SET revoked_at=now() WHERE dispatch_id=p_dispatch AND revoked_at IS NULL;
 v_expires:=GREATEST(now(),COALESCE(NULLIF(d->>'scheduled_departure','')::timestamptz,now()))+interval '3 days';
 FOR v_attempt IN 1..64 LOOP
   v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
   v_code:='';
   WHILE length(v_code)<4 LOOP
     -- First UUID byte is random. Rejection sampling avoids bias across 36 symbols.
     v_byte:=get_byte(decode(substr(replace(gen_random_uuid()::text,'-',''),1,2),'hex'),0);
     IF v_byte<252 THEN v_code:=v_code||substr('0123456789abcdefghijklmnopqrstuvwxyz',1+v_byte%36,1); END IF;
   END LOOP;
   INSERT INTO public.dispatch_tercero_enlaces(token,dispatch_id,created_by,expires_at,access_code)
   VALUES(v_token,p_dispatch,auth.uid(),v_expires,v_code) ON CONFLICT DO NOTHING;
   IF FOUND THEN v_inserted:=true; EXIT; END IF;
 END LOOP;
 IF NOT v_inserted THEN RAISE EXCEPTION 'No se pudo generar un código disponible. Intente nuevamente.'; END IF;
 INSERT INTO public.dispatch_events(dispatch_id,event_type,description,created_by)
 VALUES(p_dispatch,'ENLACE_TERCERO','Acceso del proveedor generado; compartir portal, placa y código',auth.uid()::text);
 RETURN jsonb_build_object('success',true,'token',v_token,'codigo',v_code,'placa',d->>'vehicle_plate','expires_at',v_expires);
END $$;
REVOKE ALL ON FUNCTION public.delivery_issue_access_core(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
