BEGIN;
CREATE FUNCTION pg_temp.ins(p_table text,p_cols jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
 EXECUTE (SELECT format('INSERT INTO public.%I (%s) VALUES (%s) RETURNING id',p_table,
 string_agg(quote_ident(k.key),', '),string_agg(quote_nullable(k.value #>> '{}'),', ')) FROM jsonb_each(p_cols) k
 WHERE EXISTS(SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema='public' AND ic.table_name=p_table AND ic.column_name=k.key)) INTO v_id;
 RETURN v_id;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
-- A temporary historical row exercises migration-era null policy without modifying live requests.
CREATE TEMP TABLE c56_legacy_probe AS SELECT * FROM public.transport_requests WITH NO DATA;
INSERT INTO c56_legacy_probe(request_number,request_type,attention_mode,required_date,created_at)
 VALUES('ZZ-C56-LEGACY-PROBE','RECOJO','TRANSPORTE_JRM',current_date+1,clock_timestamp());
CREATE TRIGGER c56_legacy_probe_guard BEFORE INSERT OR UPDATE ON c56_legacy_probe
 FOR EACH ROW EXECUTE FUNCTION public.transport_request_lead_time_guard();

DO $test$
DECLARE actor uuid; outsider uuid; test_role uuid; site uuid; req uuid; fresh uuid; r jsonb; policy jsonb;
 before_registration timestamptz; original timestamptz; requested timestamptz; blocked boolean; suffix text:=substr(replace(gen_random_uuid()::text,'-',''),1,8);
BEGIN
 SELECT id INTO actor FROM public.profiles WHERE id IN(SELECT id FROM auth.users) ORDER BY id LIMIT 1;
 SELECT id INTO outsider FROM public.profiles WHERE id IN(SELECT id FROM auth.users) AND id<>actor ORDER BY id LIMIT 1;
 SELECT id INTO site FROM public.sites LIMIT 1;
 IF actor IS NULL OR outsider IS NULL OR site IS NULL THEN RAISE EXCEPTION 'CAJA C56 FAIL: faltan perfiles o sede'; END IF;
 INSERT INTO public.roles(name,permissions) VALUES('ZZ C56 configuración '||suffix,'["configuracion","solicitudes","despacho","despacho-aprobacion"]') RETURNING id INTO test_role;
 UPDATE public.profiles SET role_id=test_role,is_active=true WHERE id=actor;
 UPDATE public.profiles SET role_id=NULL,is_active=true WHERE id=outsider;
 INSERT INTO public.user_site_access(user_id,site_id) VALUES(actor,site) ON CONFLICT DO NOTHING;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('request.jwt.claims',json_build_object('sub',actor,'role','authenticated')::text,true);
 policy:='{"enabled":true,"zones":{"LIMA":{"enabled":true,"hours":24},"PROVINCIA":{"enabled":true,"hours":48},"EXTERIOR":{"enabled":true,"hours":72}}}'::jsonb;
 PERFORM public.set_transport_lead_time_settings(policy);
 blocked:=false;
 BEGIN UPDATE c56_legacy_probe SET request_type='DESPACHO'; EXCEPTION WHEN raise_exception THEN blocked:=SQLERRM LIKE '%zona, fecha y hora%'; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: cambio de servicio histórico evita anticipación'; END IF;
 -- The exact owner example and equality boundary, independent of when this test runs.
 IF public.evaluate_transport_lead_time('2026-10-07 17:45-05','2026-10-08 08:00-05','LIMA',policy)->>'status'<>'INSUFFICIENT'
 OR public.evaluate_transport_lead_time('2026-10-07 17:45-05','2026-10-08 17:45-05','LIMA',policy)->>'status'<>'COMPLIANT'
 OR public.evaluate_transport_lead_time('2026-10-07 17:45-05','2026-10-09 17:44-05','PROVINCIA',policy)->>'status'<>'INSUFFICIENT'
 OR public.evaluate_transport_lead_time('2026-10-07 17:45-05','2026-10-10 17:45-05','EXTERIOR',policy)->>'status'<>'COMPLIANT' THEN
  RAISE EXCEPTION 'CAJA C56 FAIL: límites exactos 24/48/72 horas';
 END IF;
 blocked:=false;
 BEGIN
  PERFORM pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C56-BAD-'||suffix,'request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','PENDIENTE DE APROBACIÓN','site_id',site,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',((clock_timestamp()+interval '14 hours') AT TIME ZONE 'America/Lima')::date,'required_at',clock_timestamp()+interval '14 hours','delivery_zone','LIMA'));
 EXCEPTION WHEN raise_exception THEN blocked:=SQLERRM LIKE '%24 horas de anticipación%'; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: inserción insuficiente no bloqueada'; END IF;
 requested:=clock_timestamp()+interval '24 hours 1 minute';
 before_registration:=clock_timestamp();
 req:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C56-OK-'||suffix,'request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','PENDIENTE DE APROBACIÓN','site_id',site,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',(requested AT TIME ZONE 'America/Lima')::date,'required_at',requested,'delivery_zone','LIMA','created_at','2000-01-01T00:00:00Z'));
 SELECT created_at INTO original FROM public.transport_requests WHERE id=req;
 IF original<'2026-01-01'::timestamptz OR (SELECT lead_time_policy->'zones'->'LIMA'->>'hours' FROM public.transport_requests WHERE id=req)<>'24' THEN RAISE EXCEPTION 'CAJA C56 FAIL: registro/snapshot no controlados por servidor'; END IF;
 blocked:=false; BEGIN UPDATE public.transport_requests SET created_at=created_at-interval '1 day' WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: reloj original modificable'; END IF;
 blocked:=false; BEGIN UPDATE public.transport_requests SET required_at=original+interval '23 hours',required_date=((original+interval '23 hours') AT TIME ZONE 'America/Lima')::date WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: edición insuficiente no bloqueada'; END IF;
 blocked:=false; BEGIN UPDATE public.transport_requests SET lead_time_policy='{"enabled":false}' WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: snapshot modificable'; END IF;
 blocked:=false; BEGIN UPDATE public.transport_requests SET required_date=required_date+interval '1 day' WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 -- A date-only change is intentionally valid and preserves the registered clock time.
 IF blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: reprogramación heredada pierde hora'; END IF;
 UPDATE public.transport_requests SET required_date=(requested AT TIME ZONE 'America/Lima')::date,required_at=requested WHERE id=req;
 blocked:=false; BEGIN UPDATE public.transport_requests SET required_date=required_date+interval '1 day',required_at=required_at+interval '2 days' WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: fecha/hora discrepantes aceptadas'; END IF;
 blocked:=false; BEGIN UPDATE public.transport_requests SET delivery_zone=NULL WHERE id=req; EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'CAJA C56 FAIL: zona obligatoria eliminable'; END IF;
 -- Reprogramming must update exact time atomically and keep the original clock.
 r:=public.reprogramar_solicitud_at(req,original+interval '24 hours','LIMA','CLIENTE','Hora confirmada');
 IF r->>'success' IS DISTINCT FROM 'true' OR (SELECT created_at FROM public.transport_requests WHERE id=req)<>original THEN RAISE EXCEPTION 'CAJA C56 FAIL: reprogramación válida: %',r; END IF;
 r:=public.reprogramar_solicitud_at(req,original+interval '14 hours','LIMA','CLIENTE','Insuficiente');
 IF r->>'success' IS DISTINCT FROM 'false' OR (SELECT required_at FROM public.transport_requests WHERE id=req)<>original+interval '24 hours' THEN RAISE EXCEPTION 'CAJA C56 FAIL: reprogramación inválida no atómica'; END IF;
 -- New configuration cannot silently replace the rule already attached to a request.
 PERFORM public.set_transport_lead_time_settings(jsonb_set(policy,'{zones,LIMA,hours}','48'));
 UPDATE public.transport_requests SET required_at=original+interval '25 hours',required_date=((original+interval '25 hours') AT TIME ZONE 'America/Lima')::date WHERE id=req;
 IF (SELECT lead_time_policy->'zones'->'LIMA'->>'hours' FROM public.transport_requests WHERE id=req)<>'24' THEN RAISE EXCEPTION 'CAJA C56 FAIL: configuración aplicada retroactivamente'; END IF;
 -- Per-zone disabling is captured, while the other zones remain enabled.
 PERFORM public.set_transport_lead_time_settings(jsonb_set(policy,'{zones,LIMA,enabled}','false'));
 requested:=clock_timestamp()+interval '1 hour';
 fresh:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C56-OFF-'||suffix,'request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','PENDIENTE DE APROBACIÓN','site_id',site,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',(requested AT TIME ZONE 'America/Lima')::date,'required_at',requested,'delivery_zone','LIMA'));
 IF public.evaluate_transport_lead_time(original,requested,'LIMA',(SELECT lead_time_policy FROM public.transport_requests WHERE id=fresh))->>'status'<>'DISABLED' THEN RAISE EXCEPTION 'CAJA C56 FAIL: desactivación por zona'; END IF;
 PERFORM public.set_transport_lead_time_settings(jsonb_set(policy,'{enabled}','false'));
 fresh:=pg_temp.ins('transport_requests',jsonb_build_object('request_number','ZZ-C56-LEGACY-'||suffix,'request_type','DESPACHO','attention_mode','TRANSPORTE_JRM','status','PENDIENTE DE APROBACIÓN','site_id',site,'requester_name','ZZ','department','Logística','cargo_description','Prueba','pickup_address','Planta','delivery_address','Obra','required_date',current_date+1));
 PERFORM public.set_transport_lead_time_settings(policy);
 UPDATE public.transport_requests SET status='APROBADA' WHERE id=fresh;
 IF (SELECT required_at FROM public.transport_requests WHERE id=fresh) IS NOT NULL THEN RAISE EXCEPTION 'CAJA C56 FAIL: hora histórica inventada'; END IF;
 PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
 r:=public.reprogramar_solicitud_at(req,original+interval '72 hours','LIMA','CLIENTE',NULL);
 IF r->>'success' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'CAJA C56 FAIL: reprogramación sin permiso'; END IF;
 blocked:=false; BEGIN PERFORM public.set_transport_lead_time_settings(policy); EXCEPTION WHEN raise_exception THEN blocked:=true; END;
 IF NOT blocked OR has_function_privilege('anon','public.get_transport_lead_time_settings()','EXECUTE') OR has_function_privilege('anon','public.reprogramar_solicitud_at(uuid,timestamptz,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'CAJA C56 FAIL: permisos de configuración/reprogramación'; END IF;
 RAISE EXCEPTION 'CAJA C56 PASS: anticipación 24/48/72, bloqueo servidor, reloj original, snapshots, configuración y reprogramación atómica';
END $test$;
ROLLBACK;
