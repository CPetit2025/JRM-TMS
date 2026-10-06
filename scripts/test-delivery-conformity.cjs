// Executes the complete migration and installed offline/third-party functions in isolated PostgreSQL.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const name = `jrm-delivery-${process.pid}`
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const read = file => readFileSync(path.join(root, file), 'utf8')
function installed(file, fn) {
  const source = read(file), start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`)
  assert.ok(start >= 0, fn)
  return source.slice(start, source.indexOf('END $$;', start) + 7)
}
function run(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' })
  if (result.status) throw Error(result.stderr || result.stdout)
  return result.stdout
}
const query = input => spawnSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8' })
function sql(input) { const r = query(input); if (r.status) throw Error(r.stderr || r.stdout); return r.stdout.trim().split('\n').at(-1) }
const user = n => `SET ROLE authenticated; SET request.jwt.claim.sub='${id(n)}';`
const service = 'SET ROLE service_role; SET request.jwt.claim.sub=\'\';'
const rpc = (n, input) => JSON.parse(sql(user(n) + 'SELECT ' + input + ';'))
const pub = input => JSON.parse(sql(service + 'SELECT ' + input + ';'))
function denied(input, message) { const r = query(input); assert.notEqual(r.status, 0); if (message) assert.match(r.stderr, message); }
try {
  run(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  let ready = false
  for (let n = 0; n < 40; n++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  assert.ok(ready, 'PostgreSQL ready')
  sql(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
  CREATE SCHEMA auth; CREATE SCHEMA storage;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
  CREATE TABLE roles(id uuid PRIMARY KEY,name text,permissions jsonb);
  CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
  CREATE TABLE user_site_access(user_id uuid,site_id uuid);
  CREATE TABLE drivers(id uuid PRIMARY KEY,profile_id uuid,is_active boolean);
  CREATE TABLE clients(id uuid PRIMARY KEY,business_name text);
  CREATE TABLE contracts(id uuid PRIMARY KEY,code text,client_id uuid);
  CREATE TABLE carriers(id uuid PRIMARY KEY,business_name text);
  CREATE TABLE dispatches(id uuid PRIMARY KEY,dispatch_number text,status text,site_id uuid,driver_id uuid,driver_name text,
    vehicle_plate text,scheduled_departure timestamptz,modalidad text,carrier_id uuid,tercero_conductor text,tercero_telefono text,tercero_salida_at timestamptz,tercero_entrega_at timestamptz,last_gps_at timestamptz,last_lat numeric,last_lon numeric,contract_id uuid,freight_cost numeric DEFAULT 0,actual_distance_km numeric DEFAULT 0,return_gps_complete boolean,gps_coverage_complete boolean);
  CREATE UNIQUE INDEX dispatch_one_active_driver ON dispatches(driver_id) WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','RETORNO');
  CREATE UNIQUE INDEX dispatch_one_active_vehicle ON dispatches(vehicle_plate) WHERE status IN ('PROGRAMADO','EN_CURSO','EN RUTA','RETORNO');
  CREATE TABLE transport_requests(id uuid PRIMARY KEY,request_number text,status text,pickup_address text,delivery_address text,contract_id uuid);
  CREATE TABLE dispatch_requests(dispatch_id uuid,transport_request_id uuid,status text,sequence_order int,document_number text,document_type text,
    leg_actual_km numeric,leg_gps_complete boolean,arrival_lat numeric,arrival_lon numeric,PRIMARY KEY(dispatch_id,transport_request_id));
  CREATE TABLE dispatch_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,event_type text,description text,created_by text,created_at timestamptz DEFAULT now());
  CREATE TABLE route_stops_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,transport_request_id uuid,driver_id uuid,stop_type text,arrival_time timestamptz,odometer_km numeric,photo_url text,notes text);
  CREATE TABLE route_track_points(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,leg_order int,recorded_at timestamptz,latitude numeric,longitude numeric,distance_m numeric,cumulative_m numeric,gap_detected boolean);
  CREATE TABLE vehicles(id uuid,plate text,status text,current_mileage numeric);
  CREATE TABLE contract_budgets(contract_id uuid,concept text,reserved_pen numeric,consumed_pen numeric,updated_at timestamptz);
  CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name));
  CREATE TABLE dispatch_tercero_enlaces(token text PRIMARY KEY,dispatch_id uuid,created_by uuid,created_at timestamptz DEFAULT now(),expires_at timestamptz,revoked_at timestamptz,last_used_at timestamptz);
  CREATE TABLE dispatch_tercero_entregas(id uuid DEFAULT gen_random_uuid(),dispatch_id uuid,transport_request_id uuid,entregado_at timestamptz,recibido_por text,foto_path text,nota text,fuente text,registrado_por uuid,UNIQUE(dispatch_id,transport_request_id));
  CREATE TABLE daily_tracking_links(tracking_token uuid,tracking_pin text,planning_date date,expires_at timestamptz);
  CREATE TABLE driver_operation_receipts(operation_id uuid PRIMARY KEY,user_id uuid,action_type text,result jsonb);
  CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND r.name='Administrador') $$;
  CREATE FUNCTION has_tms_read_permission(code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND r.permissions ? code) $$;
  CREATE FUNCTION can_access_site(site uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT site IS NULL OR EXISTS(SELECT 1 FROM user_site_access WHERE user_id=auth.uid() AND site_id=site) $$;
  CREATE FUNCTION has_tms_permission(code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT is_tms_admin() OR has_tms_read_permission(code) $$;
  CREATE FUNCTION tercero_puede_operar(d uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT has_tms_read_permission('despacho') AND EXISTS(SELECT 1 FROM dispatches WHERE id=d AND can_access_site(site_id)) $$;
  INSERT INTO roles VALUES('${id(1)}','Supervisor de Transporte','["torre-control","despacho"]'),('${id(2)}','Despacho','["despacho"]'),('${id(3)}','Conductor','[]'),('${id(4)}','Administrador','["despacho"]');
  INSERT INTO profiles VALUES('${id(11)}','${id(1)}',true),('${id(12)}','${id(2)}',true),('${id(13)}','${id(3)}',true),('${id(14)}','${id(4)}',true),('${id(15)}','${id(1)}',false);
  INSERT INTO user_site_access VALUES('${id(11)}','${id(21)}'),('${id(12)}','${id(21)}'),('${id(14)}','${id(21)}');
  INSERT INTO drivers VALUES('${id(31)}','${id(13)}',true);
  INSERT INTO clients VALUES('${id(41)}','Cliente SCM'); INSERT INTO contracts VALUES('${id(42)}','OT-001','${id(41)}'); INSERT INTO carriers VALUES('${id(43)}','Transportista SCM');
  INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad,carrier_id,tercero_salida_at) VALUES
    ('${id(51)}','D1','EN_CURSO','${id(21)}','ABC-123',now(),'TERCERO','${id(43)}',now()-interval '1 hour'),
    ('${id(52)}','D2','LIQUIDADO','${id(21)}','ZZZ-123',now()-interval '1 week','TERCERO','${id(43)}',now()-interval '1 week'),
    ('${id(53)}','D3','EN RUTA','${id(21)}','APP-123',now(),'PROPIA',NULL,NULL),
    ('${id(54)}','D4','EN_CURSO','${id(22)}','XYZ-123',now(),'TERCERO','${id(43)}',now()-interval '1 hour');
  UPDATE dispatches SET driver_id='${id(31)}' WHERE id='${id(53)}';
  ` +
  [61,62,63,64,65,66,67,68].map(n => `INSERT INTO transport_requests VALUES('${id(n)}','RT-${n}','ASIGNADA','Planta','Destino ${n}','${id(42)}');`).join('\n') + `
  INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_number,leg_actual_km,leg_gps_complete,arrival_lat,arrival_lon) VALUES('${id(51)}','${id(61)}','PROGRAMADO',1,'G1',NULL,NULL,NULL,NULL),('${id(51)}','${id(62)}','PROGRAMADO',2,'G2',NULL,NULL,NULL,NULL),('${id(51)}','${id(63)}','ENTREGADO',3,'G3',NULL,NULL,NULL,NULL),('${id(52)}','${id(64)}','ENTREGADO',1,'G4',NULL,NULL,NULL,NULL),('${id(53)}','${id(65)}','PROGRAMADO',1,'G5',NULL,NULL,NULL,NULL),('${id(54)}','${id(66)}','PROGRAMADO',1,'G6',NULL,NULL,NULL,NULL);
  INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad,contract_id,freight_cost) VALUES('${id(57)}','D7','RETORNO_COMPLETADO','${id(21)}','FIN-123',now(),'PROPIA','${id(42)}',30);
  INSERT INTO contract_budgets VALUES('${id(42)}','PARTIDA_TRANSPORTE',30,0,now());
  INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) VALUES('${id(57)}','${id(68)}','ENTREGADO',1);
  UPDATE transport_requests SET status='ENTREGADA' WHERE id='${id(68)}';
  INSERT INTO storage.objects VALUES('driver_evidence','legacy/open.jpg','{}'),('driver_evidence','legacy/finance.jpg','{}');
  INSERT INTO route_stops_log(dispatch_id,transport_request_id,stop_type,photo_url,arrival_time) VALUES('${id(51)}','${id(63)}','ENTREGA','legacy/open.jpg',now()),('${id(52)}','${id(64)}','ENTREGA','legacy/closed.jpg',now()),('${id(57)}','${id(68)}','ENTREGA','legacy/finance.jpg',now());
  `)
  const third = 'supabase/migrations/20261006160000_despacho_tercerizado.sql'
  sql(installed('supabase/migrations/20260929180000_despacho_f1_estados_partida.sql', 'close_dispatch_route') + installed('supabase/migrations/20260922181500_ai_trip_actions.sql', 'get_active_trip_context') + installed(third, 'tercero_avance') + installed(third, 'tercero_enlace_despacho') + installed(third, 'tercero_enlace_entregar') + installed('supabase/migrations/20260922181500_ai_trip_actions.sql', 'execute_driver_offline_action') + installed('supabase/migrations/000163_dispatch_transactions.sql', 'request_dispatch_return'))
  sql(`CREATE FUNCTION complete_dispatch_stop(p_dispatch_id uuid,p_request_id uuid,p_photo_url text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION tercero_entrega_core(p_dispatch_id uuid,p_request_id uuid,p_at timestamptz,p_recibido_por text,p_foto text,p_nota text,p_fuente text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION tercero_generar_enlace(p_dispatch_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION tercero_enlace_info(p_token text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION get_public_daily_tracking_locations(p_token uuid,p_pin text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '[]'::jsonb $$;
    CREATE FUNCTION get_public_daily_tracking_info(p_token uuid,p_pin text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    REVOKE ALL ON FUNCTION complete_dispatch_stop(uuid,uuid,text),tercero_generar_enlace(uuid),tercero_entrega_core(uuid,uuid,timestamptz,text,text,text,text),tercero_enlace_info(text),get_public_daily_tracking_info(uuid,text),tercero_enlace_despacho(text) FROM PUBLIC,anon,authenticated;
    GRANT EXECUTE ON FUNCTION complete_dispatch_stop(uuid,uuid,text),tercero_generar_enlace(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION get_public_daily_tracking_info(uuid,text),get_public_daily_tracking_locations(uuid,text) TO anon,authenticated;
    GRANT EXECUTE ON FUNCTION tercero_enlace_info(text),tercero_enlace_despacho(text) TO service_role;`)
  sql(read('supabase/migrations/20261007130000_delivery_conformity.sql'))
  sql(`ALTER TABLE dispatches ADD COLUMN docs_required boolean DEFAULT false, ADD COLUMN docs_ready_at timestamptz, ADD COLUMN docs_ready_by uuid, ADD COLUMN docs_reissue boolean DEFAULT false, ADD COLUMN docs_reissue_reason text, ADD COLUMN docs_reissue_at timestamptz;
    CREATE TABLE dispatch_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid,transport_request_id uuid,doc_type text,cargo_type text,document_number text,file_path text,file_name text,mime_type text,size_bytes bigint,notes text,uploaded_by uuid,uploaded_at timestamptz DEFAULT now(),voided_at timestamptz,voided_by uuid,void_reason text);
    CREATE TABLE dispatch_cargos(dispatch_id uuid PRIMARY KEY,recibido_at timestamptz,recibido_by uuid,file_path text,notas text);
    CREATE FUNCTION dispatch_document_folder(n text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$ BEGIN RETURN split_part(n,'/',1)::uuid; EXCEPTION WHEN others THEN RETURN NULL; END $$;
    CREATE FUNCTION can_view_driver_evidence() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT has_tms_read_permission('despacho') $$;
    INSERT INTO roles VALUES('${id(5)}','Asistente Documentario','["documentario"]'); INSERT INTO profiles VALUES('${id(16)}','${id(5)}',true);
    INSERT INTO user_site_access VALUES('${id(16)}','${id(21)}');`)
  sql(`INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad) VALUES('${id(95)}','D-REVOKED','PROGRAMADO','${id(21)}','REV-123',now(),'TERCERO'); INSERT INTO dispatch_tercero_enlaces(token,dispatch_id,expires_at,revoked_at,access_code) VALUES('${'9'.repeat(64)}','${id(95)}',now()+interval '1 day',now(),'revoked-code');`)
  sql(read('supabase/migrations/20261007160000_provider_access_document_roles.sql'))
  assert.equal(sql(`SELECT count(*) FROM dispatch_tercero_enlaces WHERE dispatch_id='${id(95)}' AND revoked_at IS NULL`),'0')
  sql(`CREATE TRIGGER dispatch_docs_detect_changes BEFORE UPDATE ON dispatches FOR EACH ROW EXECUTE FUNCTION dispatch_docs_detect_changes();`)
  denied(user(12)+`SELECT delivery_issue_access_core('${id(51)}');`,/permission denied/)

  denied(`SET ROLE anon; SELECT complete_dispatch_stop(NULL,NULL,NULL);`,/permission denied/)
  denied(`SET ROLE authenticated; SELECT tercero_entrega_core(NULL,NULL,NULL,NULL,NULL,NULL,NULL);`,/permission denied/)
  const deployedGuards=query(read('supabase/tests/caja_c44_conformidad_entrega.test.sql'))
  assert.match(deployedGuards.stderr,/CAJA C44 PASS/)

  assert.equal(sql(`SELECT state FROM delivery_conformities WHERE request_id='${id(63)}';`), 'RECIBIDA')
  assert.equal(sql(`SELECT count(*) FROM delivery_conformities WHERE dispatch_id='${id(52)}';`), '0')
  denied(user(12)+`SELECT close_dispatch_route('${id(57)}');`,/Faltan guías aprobadas/)
  assert.equal(sql(`SELECT reserved_pen||':'||consumed_pen FROM contract_budgets WHERE contract_id='${id(42)}';`),'30:0')
  const oldFinance=rpc(11,`delivery_get('${id(57)}','${id(68)}')`)
  rpc(11,`delivery_review('${id(57)}','${id(68)}','${oldFinance.submissions[0].id}','VALIDADA')`)
  sql(user(12)+`SELECT close_dispatch_route('${id(57)}');`)
  assert.equal(sql(`SELECT reserved_pen||':'||consumed_pen FROM contract_budgets WHERE contract_id='${id(42)}';`),'0:30')
  console.log('PASS: actual financial closure rolls back consumption without conformity and consumes it once after approval.')
  console.log('PASS: complete migration installs; open historical evidence awaits review; closed trips stay unchanged.')
  for (const role of ['anon','authenticated']) {
    denied(`SET ROLE ${role}; SELECT delivery_public_authorize('',NULL,NULL);`, /permission denied/)
    denied(`SET ROLE ${role}; SELECT delivery_submit_core(NULL,NULL,NULL,NULL,NULL,NULL);`, /permission denied/)
    denied(`SET ROLE ${role}; SELECT * FROM delivery_submissions;`, /permission denied/)
    denied(`SET ROLE ${role}; UPDATE delivery_conformities SET state='VALIDADA';`, /permission denied/)
  }
  denied(user(12)+`SELECT delivery_review('${id(51)}','${id(61)}','${id(70)}','VALIDADA');`, /Solo el Supervisor/)
  denied(user(14)+`SELECT delivery_review('${id(51)}','${id(61)}','${id(70)}','VALIDADA');`, /Solo el Supervisor/)
  denied(user(15)+`SELECT delivery_review('${id(51)}','${id(61)}','${id(70)}','VALIDADA');`, /Solo el Supervisor/)
  denied(user(11)+`SELECT delivery_get('${id(54)}','${id(66)}');`, /Sin acceso/)
  denied(user(13)+`SELECT delivery_get('${id(51)}','${id(61)}');`, /Sin acceso/)
  console.log('PASS: only active Supervisor of the site reviews; private helpers, evidence and other drivers stay inaccessible.')
  const access = rpc(12,`tercero_generar_enlace('${id(51)}')`), token=access.token, code=access.codigo
  assert.equal(pub(`delivery_portal_login('abc 123','${code}','${'a'.repeat(64)}')`).token,token)
  assert.equal(pub(`delivery_portal_login('XYZ-123','${code}','${'b'.repeat(64)}')`).success,false)
  for(let n=0;n<11;n++) { const r=pub(`delivery_portal_login('ABC-123','invalid','${'b'.repeat(64)}')`); if(n===10)assert.equal(r.limited,true) }
  const path1=`tercero/${id(51)}/g1.jpg`, path2=`tercero/${id(51)}/g2.jpg`
  const submit=(q,op,photo=path1)=>`delivery_public_submit('${token}','${id(q)}','${id(op)}',ARRAY['${photo}'],'Receptor','Nota','Guía')`
  denied(service+`SELECT ${submit(66,71)};`, /Entrega no autorizada/)
  denied(service+`SELECT ${submit(61,71)};`, /Foto no válida/)
  sql(`INSERT INTO storage.objects VALUES('driver_evidence','${path1}','{}'),('driver_evidence','${path2}','{}');`)
  denied(service+`SELECT ${submit(61,71,`tercero/${id(54)}/fake.jpg`)};`, /Foto no válida/)
  assert.equal(pub(`delivery_public_arrive('${token}','${id(61)}')`).success,true)
  const first=pub(submit(61,71))
  assert.equal(first.pending_review,true)
  assert.equal(sql(`SELECT status FROM dispatch_requests WHERE transport_request_id='${id(61)}';`),'PROGRAMADO')
  assert.equal(pub(submit(61,71)).duplicate,true)
  assert.equal(sql(`SELECT count(*) FROM delivery_submissions WHERE request_id='${id(61)}';`),'1')
  assert.equal(sql(`SELECT count(*) FROM route_stops_log WHERE transport_request_id='${id(61)}';`),'1')
  assert.equal(pub(`tercero_enlace_info('${token}')`).paradas.some(p=>p.request_id===id(61)),false)
  denied(service+`SELECT ${submit(61,72)};`, /Acceso bloqueado/)
  denied(`UPDATE dispatch_requests SET status='ENTREGADO' WHERE transport_request_id='${id(61)}';`, /guía debe ser aprobada/)
  denied(`UPDATE transport_requests SET status='ENTREGADA' WHERE id='${id(61)}';`, /guía debe ser aprobada/)
  denied(`UPDATE dispatches SET status='LIQUIDADO' WHERE id='${id(51)}';`, /Faltan guías aprobadas/)
  sql(`ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT,UPDATE,DELETE ON storage.objects TO authenticated; CREATE POLICY fixture_owner ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);`)
  assert.equal(sql(user(12)+`DELETE FROM storage.objects WHERE name='${path1}'; SELECT count(*) FROM storage.objects WHERE name='${path1}';`),'1')
  assert.equal(sql(user(12)+`UPDATE storage.objects SET metadata='{"changed":true}' WHERE name='${path1}'; SELECT metadata::text FROM storage.objects WHERE name='${path1}';`),'{}')
  console.log('PASS: plate/code scope, throttling, real-object requirement, arrival, idempotency and pending-stage closure guards.')
  denied(user(11)+`SELECT delivery_review('${id(51)}','${id(61)}','${first.submission_id}','OBSERVADA','');`, /Indique el motivo/)
  rpc(11,`delivery_review('${id(51)}','${id(61)}','${first.submission_id}','OBSERVADA','Foto ilegible')`)
  assert.equal(pub(`tercero_enlace_info('${token}')`).paradas.find(p=>p.request_id===id(61)).motivo,'Foto ilegible')
  const second=pub(submit(61,72,path2))
  denied(user(11)+`SELECT delivery_review('${id(51)}','${id(61)}','${first.submission_id}','VALIDADA');`, /sustento cambió/)
  rpc(11,`delivery_review('${id(51)}','${id(61)}','${second.submission_id}','RECHAZADA','Falta firma')`)
  const thirdSubmission=pub(submit(61,73,path2))
  rpc(11,`delivery_review('${id(51)}','${id(61)}','${thirdSubmission.submission_id}','VALIDADA')`)
  const history=rpc(12,`delivery_get('${id(51)}','${id(61)}')`)
  assert.equal(history.submissions.length,3)
  assert.equal(history.submissions.filter(s=>s.review).length,3)
  assert.equal(history.state,'VALIDADA')
  assert.equal(sql(`SELECT status FROM dispatches WHERE id='${id(51)}';`),'EN_CURSO')
  const remaining=pub(submit(62,74,path2))
  assert.equal(pub(`delivery_portal_login('ABC-123','${code}','${'c'.repeat(64)}')`).success,false)
  assert.equal(pub(`tercero_enlace_info('${token}')`).success,false)
  rpc(11,`delivery_review('${id(51)}','${id(62)}','${remaining.submission_id}','VALIDADA')`)
  const historical=rpc(11,`delivery_get('${id(51)}','${id(63)}')`)
  rpc(11,`delivery_review('${id(51)}','${id(63)}','${historical.submissions[0].id}','VALIDADA')`)
  assert.equal(sql(`SELECT status FROM dispatches WHERE id='${id(51)}';`),'ENTREGADO')
  assert.equal(sql(`UPDATE dispatches SET status='LIQUIDADO' WHERE id='${id(51)}'; SELECT status FROM dispatches WHERE id='${id(51)}';`),'LIQUIDADO')
  console.log('PASS: required reasons, observe/reject reopening, stale-review prevention, immutable versions and all-stop approval gate.')
  sql(`INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad) VALUES('${id(55)}','D5','EN_CURSO','${id(21)}','ABC-123',now(),'TERCERO'); INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_number,leg_actual_km,leg_gps_complete,arrival_lat,arrival_lon) VALUES('${id(55)}','${id(67)}','PROGRAMADO',1,'G-new',NULL,NULL,NULL,NULL);`)
  const newAccess=rpc(12,`tercero_generar_enlace('${id(55)}')`)
  assert.equal(pub(`delivery_portal_login('ABC-123','${newAccess.codigo}','${'c'.repeat(64)}')`).success,true)
  assert.equal(pub(`delivery_portal_login('ABC-123','${code}','${'c'.repeat(64)}')`).success,false)
  sql(`UPDATE dispatch_tercero_enlaces SET expires_at=now()-interval '1 second' WHERE token='${newAccess.token}';`)
  assert.equal(pub(`delivery_portal_login('ABC-123','${newAccess.codigo}','${'c'.repeat(64)}')`).success,false)
sql(`INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad) VALUES('${id(56)}','D6','EN_CURSO','${id(21)}','EXTERNO',now(),'PROPIA'); INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_type) VALUES('${id(56)}','${id(64)}','PROGRAMADO',1,'NOTA_SALIDA'); UPDATE dispatch_requests SET status='ENTREGADO' WHERE dispatch_id='${id(56)}'; UPDATE dispatches SET status='ENTREGADO' WHERE id='${id(56)}';`)
  assert.equal(rpc(12,`delivery_get('${id(56)}','${id(64)}')`).state,'NO_APLICA')
  console.log('PASS: customer pickup keeps its existing note-of-release flow without driver/provider gates.')
  const renewed=rpc(12,`tercero_generar_enlace('${id(55)}')`)
  const racePath=`tercero/${id(55)}/race.jpg`
  sql(`INSERT INTO storage.objects VALUES('driver_evidence','${racePath}','{}');`)
  const raceSQL=`SET ROLE service_role; SELECT delivery_public_submit('${renewed.token}','${id(67)}','${id(85)}',ARRAY['${racePath}'],'Receptor',NULL,'G-race');`
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'"
  const command=`psql -U postgres -At -v ON_ERROR_STOP=1 -c ${quote(raceSQL)} > /tmp/race1 2>&1 & psql -U postgres -At -v ON_ERROR_STOP=1 -c ${quote(raceSQL)} > /tmp/race2 2>&1 & wait; cat /tmp/race1 /tmp/race2`
  const raced=run(['exec',name,'sh','-c',command])
  assert.equal(raced.split('\n').filter(line=>line.startsWith('{')).length,2)
  assert.equal(sql(`SELECT count(*) FROM delivery_submissions WHERE operation_id='${id(85)}';`),'1')
  console.log('PASS: simultaneous retry produces one submission and two confirmations.')
  console.log('PASS: a new service for the same plate is enabled; expired/previous service codes do not reopen it.')
  const appPhoto=`${id(13)}/${id(53)}/${id(65)}/g.jpg`
  sql(`INSERT INTO storage.objects VALUES('driver_evidence','${appPhoto}','{}');`)
  const appSubmit=`delivery_submit_driver('${id(53)}','${id(65)}',ARRAY['${appPhoto}'],'Receptor','Nota','G5','${id(80)}',now())`
  denied(user(12)+`SELECT ${appSubmit};`,/Ruta no autorizada/)
  denied(user(13)+`SELECT ${appSubmit};`,/Se requiere GPS/)
  sql(`INSERT INTO route_track_points(dispatch_id,leg_order,recorded_at,latitude,longitude,distance_m,cumulative_m,gap_detected) VALUES('${id(53)}',1,now()-interval '10 seconds',-12,-77,500,500,false),('${id(53)}',1,now(),-12,-77,1000,1500,false);`)
  const offline=`execute_driver_offline_action('${id(80)}','delivery_submit_driver',jsonb_build_object('dispatch_id','${id(53)}','request_id','${id(65)}','photos',jsonb_build_array('${appPhoto}'),'received_by','Recibió','captured_at',now()))`
  const app=rpc(13,offline)
  assert.equal(app.success,true); assert.equal(app.pending_review,true); assert.equal(app.leg_actual_km,1.5)
  assert.deepEqual(rpc(13,offline),app)
  denied(user(13)+`SELECT request_dispatch_return('${id(53)}');`,/paradas pendientes/)
  rpc(11,`delivery_review('${id(53)}','${id(65)}','${app.submission_id}','VALIDADA')`)
  assert.equal(sql(`SELECT status FROM dispatches WHERE id='${id(53)}';`),'EN RUTA')
  sql(user(13)+`SELECT request_dispatch_return('${id(53)}');`)
  assert.equal(sql(`SELECT status FROM dispatches WHERE id='${id(53)}';`),'ESPERANDO_AUTORIZACION')
  console.log('PASS: driver identity, GPS freshness, offline receipt replay, actual kilometers and existing supervised return flow.')
  sql(`INSERT INTO daily_tracking_links VALUES('${id(90)}','12345678',(now() AT TIME ZONE 'America/Lima')::date,now()+interval '1 hour'); GRANT EXECUTE ON FUNCTION get_public_daily_tracking_info(uuid,text) TO anon;`)
  sql(`UPDATE dispatches SET last_gps_at=now(),last_lat=-12,last_lon=-77,scheduled_departure=(((now() AT TIME ZONE 'America/Lima')::date+1)::timestamp AT TIME ZONE 'UTC')+interval '30 minutes' WHERE id='${id(53)}';`)
  const publicRows=JSON.parse(sql(`SET ROLE anon; SELECT get_public_daily_tracking_info('${id(90)}','12345678');`))
  assert.ok(publicRows.rows.some(r=>r.ot_code==='OT-001'&&r.request_number==='RT-61'))
  const gps=JSON.parse(sql(`SET ROLE anon; SELECT get_public_daily_tracking_locations('${id(90)}','12345678');`))
  assert.equal(gps.length,1);assert.equal(gps[0].dispatch_id,id(53));assert.equal(gps[0].speed,undefined)
  denied(`SET ROLE anon; SELECT get_public_daily_tracking_locations('${id(90)}','bad');`,/PIN incorrecto/)
  assert.ok(publicRows.rows.every(r=>!r.photos&&!r.access_code&&!r.tercero_telefono&&r.events.every(e=>e.description===null)))
  denied(`SET ROLE anon; SELECT get_public_daily_tracking_info('${id(90)}','bad');`,/PIN incorrecto/)
  sql(`UPDATE daily_tracking_links SET expires_at=now()-interval '1 second';`)
  denied(`SET ROLE anon; SELECT get_public_daily_tracking_info('${id(90)}','12345678');`,/enlace vencido/)
  console.log('PASS: public table uses genuine OT/RT data; PIN checked on every refresh; secret/file/cost data omitted.')
  sql(`INSERT INTO dispatches(id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,modalidad,docs_required) VALUES('${id(96)}','D-AUTO','PROGRAMADO','${id(21)}','AUTO-123',now(),'TERCERO',true);
    INSERT INTO transport_requests VALUES('${id(97)}','RT-97','ASIGNADA','Planta','Destino','${id(42)}'),('${id(98)}','RT-98','ASIGNADA','Planta','Destino','${id(42)}');
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order,document_number) VALUES('${id(96)}','${id(97)}','PROGRAMADO',1,'G97'),('${id(96)}','${id(98)}','PROGRAMADO',2,'G98');`)
  const issued=JSON.parse(sql(`SELECT jsonb_build_object('token',token,'code',access_code) FROM dispatch_tercero_enlaces WHERE dispatch_id='${id(96)}' AND revoked_at IS NULL;`))
  assert.match(issued.code,/^[a-f0-9]{12}$/)
  assert.equal(pub(`delivery_portal_login('AUTO-123','${issued.code}','${'d'.repeat(64)}')`).token,issued.token)
  sql(`UPDATE dispatches SET vehicle_plate='AUTO-456' WHERE id='${id(96)}';`)
  assert.equal(pub(`delivery_portal_login('AUTO-456','${issued.code}','${'d'.repeat(64)}')`).success,false)
  assert.equal(sql(`SELECT count(*) FROM dispatch_tercero_enlaces WHERE dispatch_id='${id(96)}' AND revoked_at IS NULL`),'1')
  const docPath=`${id(96)}/packing.pdf`
  const packing=(extra={})=>`register_signed_packing_list('${id(96)}',${extra.request?"'"+extra.request+"'":'NULL'},'${extra.path||docPath}','packing.pdf','${extra.mime||'application/pdf'}',1000,'${extra.auditor===undefined?'Auditor de despacho':extra.auditor}',current_date,${extra.signature===undefined?true:extra.signature})`
  assert.equal(rpc(12,packing()).success,false)
  assert.equal(rpc(16,packing({signature:false})).success,false)
  assert.equal(rpc(16,packing({auditor:''})).success,false)
  assert.equal(rpc(16,packing({mime:'application/vnd.ms-excel'})).success,false)
  assert.equal(rpc(16,packing()).success,false)
  assert.equal(rpc(16,`register_signed_packing_list('${id(54)}',NULL,'x','x','application/pdf',1,'Auditor',current_date,true)`).success,false)
  assert.equal(rpc(16,`register_dispatch_document('${id(96)}','${id(97)}','GUIA_REMISION','PT','G97','${docPath}','guia.pdf','application/pdf',1000,NULL)`).success,false)
  assert.equal(rpc(16,`register_dispatch_document('${id(96)}',NULL,'PACKING_LIST',NULL,NULL,'${docPath}','packing.pdf','application/pdf',1000,NULL)`).success,false)
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(96)}')`).success,false)
  denied(`UPDATE dispatches SET docs_ready_at=now(),status='EN_CURSO' WHERE id='${id(96)}';`,/Documentos pendientes/)
  sql(`INSERT INTO storage.objects VALUES('dispatch_documents','${docPath}','{}')`)
  const partial=rpc(16,packing({request:id(97)}));assert.equal(partial.success,true)
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(96)}')`).success,false)
  const consolidated=rpc(16,packing());assert.equal(consolidated.success,true)
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(96)}')`).success,true)
  const queue=rpc(16,`get_documentary_queue(false)`)
  assert.equal(queue.find(d=>d.id===id(96)).documents.some(d=>d.signed&&d.auditor_name==='Auditor de despacho'),true)
  sql(`UPDATE dispatch_documents SET voided_at=now() WHERE id='${consolidated.id}'`)
  assert.equal(sql(`SELECT docs_ready_at IS NULL AND docs_reissue FROM dispatches WHERE id='${id(96)}'`),'t')
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(96)}')`).success,false)
  assert.equal(rpc(16,packing()).success,true)
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(96)}')`).success,true)
  sql(`UPDATE dispatches SET status='EN_CURSO' WHERE id='${id(96)}';`)
  assert.equal(rpc(16,packing()).success,false)
  assert.equal(rpc(16,`registrar_cargo('${id(96)}','fake.pdf','solo nota')`).success,false)
  assert.equal(rpc(12,`tercero_registrar_entrega('${id(96)}','${id(97)}',now(),'Receptor','foto.jpg',NULL)`).success,false)
  denied(user(16)+`SELECT delivery_review('${id(51)}','${id(61)}','${id(70)}','VALIDADA');`,/Solo el Supervisor/)
  const autoToken=sql(`SELECT token FROM dispatch_tercero_enlaces WHERE dispatch_id='${id(96)}' AND revoked_at IS NULL`)
  const autoPhoto=`tercero/${id(96)}/signed.jpg`
  sql(`INSERT INTO storage.objects VALUES('driver_evidence','${autoPhoto}','{}')`)
  sql(`UPDATE dispatch_requests SET document_number=NULL WHERE transport_request_id='${id(97)}'`)
  denied(service+`SELECT delivery_public_submit('${autoToken}','${id(97)}','${id(99)}',ARRAY['${autoPhoto}'],'Receptor',NULL,NULL)`,/número de la guía/)
  denied(service+`SELECT delivery_public_submit('${autoToken}','${id(97)}','${id(99)}',ARRAY['${autoPhoto}'],'',NULL,'GR-97')`,/quién recibió/)
  assert.equal(pub(`delivery_public_submit('${autoToken}','${id(97)}','${id(99)}',ARRAY['${autoPhoto}'],'Receptor',NULL,'GR-97')`).success,true)
  assert.equal(sql(`SELECT count(*) FROM dispatch_cargos WHERE dispatch_id='${id(96)}'`),'0')
  assert.equal(pub(`delivery_public_submit('${autoToken}','${id(98)}','${id(100)}',ARRAY['${autoPhoto}'],'Receptor',NULL,'GR-98')`).success,true)
  assert.equal(sql(`SELECT count(*) FROM dispatch_cargos WHERE dispatch_id='${id(96)}' AND recibido_by IS NULL AND file_path LIKE 'driver_evidence/%'`),'1')
  assert.equal(rpc(16,`delivery_get('${id(96)}','${id(97)}')`).can_review,false)
  assert.equal(sql(user(16)+`SELECT delivery_can_read_photo('${autoPhoto}')`),'t')
  assert.equal(sql(user(13)+`SELECT delivery_can_read_photo('${autoPhoto}')`),'f')
  assert.equal(sql(user(16)+`SELECT delivery_can_read('${id(54)}')`),'f')
  assert.equal(pub(`delivery_portal_login('AUTO-456','${issued.code}','${'d'.repeat(64)}')`).success,false)
  console.log('PASS: scheduling auto-issues scoped access; plate changes rotate credentials; signed packing requires documentary role, auditor/file/signature and covers all stops before departure.')
  console.log('PASS: assistant cannot upload a guide or note-only cargo; drivers/providers must submit guide number, receiver and real photos; only the supervisor approves; all-stop receipt is recorded once.')
  // Run the exact production documentary regression with real scheduling/budget functions and active fleet indices.
  sql(`CREATE TABLE auth.users(id uuid PRIMARY KEY); INSERT INTO auth.users SELECT id FROM profiles;
    ALTER TABLE roles ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE profiles ADD COLUMN first_name text, ADD COLUMN last_name text;
    ALTER TABLE drivers ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE drivers ADD COLUMN carrier_id uuid, ADD COLUMN first_name text, ADD COLUMN last_name text, ADD COLUMN document_number text UNIQUE, ADD COLUMN license_number text;
    ALTER TABLE vehicles ADD COLUMN carrier_id uuid, ADD COLUMN site_id uuid, ADD COLUMN type text, ADD COLUMN current_odometer numeric;
    INSERT INTO vehicles(id,plate,carrier_id,site_id,status) VALUES('${id(101)}','C9-SEED','${id(43)}','${id(21)}','DISPONIBLE');
    ALTER TABLE contracts ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE contracts ADD COLUMN type text, ADD COLUMN status text, ADD COLUMN site_id uuid;
    ALTER TABLE contract_budgets ADD COLUMN id uuid DEFAULT gen_random_uuid(), ADD COLUMN allocated_pen numeric DEFAULT 0, ADD COLUMN balance_pen numeric GENERATED ALWAYS AS (allocated_pen-COALESCE(reserved_pen,0)-COALESCE(consumed_pen,0)) STORED;
    ALTER TABLE contract_budgets ALTER COLUMN reserved_pen SET DEFAULT 0, ALTER COLUMN consumed_pen SET DEFAULT 0;
    ALTER TABLE transport_requests ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE transport_requests ADD COLUMN site_id uuid, ADD COLUMN requester_name text, ADD COLUMN department text, ADD COLUMN request_type text, ADD COLUMN cargo_description text, ADD COLUMN pickup_district text, ADD COLUMN delivery_district text, ADD COLUMN required_date date, ADD COLUMN service_cost numeric DEFAULT 0, ADD COLUMN reserved_pen numeric DEFAULT 0, ADD COLUMN approved_at timestamptz, ADD COLUMN approved_by uuid, ADD COLUMN budget_shortfall numeric DEFAULT 0, ADD COLUMN budget_observation text, ADD COLUMN updated_at timestamptz;
    ALTER TABLE dispatch_requests ADD COLUMN leg_planned_km numeric;
    ALTER TABLE dispatches ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE dispatches ADD COLUMN estimated_distance_km numeric;
    CREATE TABLE contract_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid,service_type text,description text,amount_pen numeric,service_date date,plate text,driver_name text,category text,created_by uuid,dispatch_id uuid);
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    ALTER TABLE dispatch_documents ENABLE ROW LEVEL SECURITY;`)
  const f3='supabase/migrations/20260929200000_documentario_f3.sql'
  const defs=read(f3), start=defs.indexOf('CREATE OR REPLACE FUNCTION public.can_view_dispatch_documents(')
  sql(defs.slice(start,defs.indexOf('$$;',defs.indexOf('AS $$',start))+3))
  sql(`CREATE POLICY dispatch_documents_read ON dispatch_documents FOR SELECT TO authenticated USING(can_view_dispatch_documents(dispatch_id));`)
  sql(installed(f3,'void_dispatch_document') + installed(f3,'dispatch_docs_stops_changed') + installed(f3,'schedule_dispatch') + installed('supabase/migrations/20260929190000_solicitud_f2_partida_observada.sql','transport_request_budget_sync'))
  sql(`CREATE TRIGGER dispatch_docs_stops_changed AFTER INSERT OR DELETE ON dispatch_requests FOR EACH ROW EXECUTE FUNCTION dispatch_docs_stops_changed(); CREATE TRIGGER request_budget_sync BEFORE UPDATE OF status ON transport_requests FOR EACH ROW EXECUTE FUNCTION transport_request_budget_sync();`)
  const c9=query(read('supabase/tests/caja_c9_documentario.test.sql'))
  assert.match(c9.stderr,/CAJA C9 PASS \(7\/7\)/,c9.stderr)
  console.log('PASS: exact production C9 verifies signed packing, release note, role/scope, reissue, voiding, driver visibility and real OT budget scheduling (7/7), rolled back.')
  const c46=query(read('supabase/tests/caja_c46_responsabilidad_documentaria.test.sql'))
  assert.match(c46.stderr,/CAJA C46 PASS/,c46.stderr)
  console.log('PASS: exact production C46 confirms private access controls, signed packing traceability and evidence responsibilities, rolled back.')
  sql(`ALTER TABLE carriers ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE carriers ADD COLUMN type text, ADD COLUMN ruc text, ADD COLUMN is_active boolean DEFAULT true;
    ALTER TABLE contract_services ADD COLUMN provider_ruc text, ADD COLUMN provider_name text;
    CREATE TABLE kpi_dispatch_log(dispatch_id uuid,estado_anterior text,estado_nuevo text,at timestamptz DEFAULT now(),by uuid);
    GRANT ALL ON kpi_dispatch_log TO authenticated;`)
  const f1='supabase/migrations/20260929180000_despacho_f1_estados_partida.sql'
  sql(installed(f1,'can_operate_dispatch')+installed(f1,'transition_dispatch_status')+
    installed('supabase/migrations/20261005180000_desempeno_por_rol.sql','kpi_trg_dispatch_log')+
    ['schedule_dispatch_tercero','tercero_ajustar_hora','tercero_salida_core','tercero_registrar_salida','tercero_desempeno'].map(f=>installed(third,f)).join('\n'))
  sql(`CREATE TRIGGER trg_kpi_dispatch_log AFTER INSERT OR UPDATE ON dispatches FOR EACH ROW EXECUTE FUNCTION kpi_trg_dispatch_log();`)
  const c41=query(read('supabase/tests/caja_c41_despacho_tercerizado.test.sql'))
  assert.match(c41.stderr,/CAJA C41 PASS \(8\/8\)/,c41.stderr)
  console.log('PASS: exact production C41 schedules a provider, creates access, confirms signed packing, accepts provider guide, reviews and closes with real budget consumption (8/8), rolled back.')
  sql(`ALTER TABLE route_track_points ADD COLUMN driver_id uuid, ADD COLUMN accuracy_m numeric DEFAULT 10, ADD COLUMN speed_mps numeric, ADD COLUMN created_at timestamptz DEFAULT now();`)
  sql(installed('supabase/migrations/000165_late_gps_samples.sql','record_route_track_point'))
  sql(`CREATE TRIGGER route_track_before_insert BEFORE INSERT ON route_track_points FOR EACH ROW EXECUTE FUNCTION record_route_track_point();`)
  sql(read('supabase/migrations/20261007170000_driver_app_presence_monitor.sql'))
  sql(`INSERT INTO drivers(id,profile_id,is_active,first_name,last_name) VALUES('${id(102)}','${id(12)}',true,'Conductor','Sin ruta');`)
  assert.equal(rpc(12,`driver_app_heartbeat('checking')`).success,true)
  let monitor=rpc(14,'get_driver_gps_monitor()')
  let idle=monitor.drivers.find(d=>d.driver_id===id(102))
  assert.equal(idle.connected,true);assert.equal(idle.operational_status,'SIN_RUTA');assert.equal(idle.lat,null)
  assert.equal(rpc(12,`driver_app_heartbeat('active',-12,-77,20,NULL,now())`).success,true)
  monitor=rpc(14,'get_driver_gps_monitor()');idle=monitor.drivers.find(d=>d.driver_id===id(102))
  assert.equal(idle.gps_fresh,true);assert.equal(idle.speed,null)
  denied(user(12)+`SELECT driver_app_heartbeat('active',91,0,20,NULL,now())`,/Señal GPS no válida/)
  denied(user(12)+`SELECT driver_app_heartbeat('active',-12,-77,20,NULL,now()+interval '1 hour')`,/Señal GPS no válida/)
  denied(user(12)+`SELECT get_driver_gps_monitor()`,/Sin permiso/)
  denied(`SET ROLE anon; SELECT get_driver_gps_monitor()`,/permission denied/)
  denied(user(12)+`UPDATE driver_app_presence SET driver_id='${id(31)}'`,/permission denied/)
  rpc(12,`driver_app_heartbeat('denied')`)
  monitor=rpc(14,'get_driver_gps_monitor()');idle=monitor.drivers.find(d=>d.driver_id===id(102))
  assert.equal(idle.connected,true);assert.equal(idle.gps_fresh,false);assert.equal(idle.gps_state,'denied')
  sql(`UPDATE driver_app_presence SET last_seen_at=now()-interval '3 minutes' WHERE driver_id='${id(102)}'`)
  assert.equal(rpc(14,'get_driver_gps_monitor()').drivers.find(d=>d.driver_id===id(102)).connected,false)
  rpc(12,`driver_app_heartbeat('checking')`);sql(user(12)+`SELECT driver_app_disconnect()`)
  assert.equal(rpc(14,'get_driver_gps_monitor()').drivers.find(d=>d.driver_id===id(102)).connected,false)
  sql(`INSERT INTO dispatches(id,driver_id,dispatch_number,status,site_id,vehicle_plate,scheduled_departure,docs_required) VALUES('${id(103)}','${id(102)}','D-GPS','PROGRAMADO','${id(21)}','GPS-103',now(),true);
    INSERT INTO transport_requests(id,request_number,status,pickup_address,delivery_address,contract_id) VALUES('${id(104)}','RT-GPS','ASIGNADA','Planta','Cliente','${id(42)}');
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id,status,sequence_order) VALUES('${id(103)}','${id(104)}','PROGRAMADO',1);`)
  const own=()=>rpc(14,'get_driver_gps_monitor()').drivers.find(d=>d.driver_id===id(102))
  assert.equal(own().operational_status,'ESPERANDO_DOCUMENTOS')
  const gpsPacking=`${id(103)}/packing.pdf`
  sql(`INSERT INTO storage.objects VALUES('dispatch_documents','${gpsPacking}','{}')`)
  assert.equal(rpc(16,`register_signed_packing_list('${id(103)}',NULL,'${gpsPacking}','packing.pdf','application/pdf',1000,'Auditor',current_date,true)`).success,true)
  assert.equal(rpc(16,`confirm_dispatch_documents('${id(103)}')`).success,true)
  assert.equal(own().operational_status,'RUTA_ASIGNADA')
  sql(`UPDATE dispatches SET status='EN_CURSO' WHERE id='${id(103)}'`)
  assert.equal(own().operational_status,'EN_RUTA')
  sql(user(12)+`INSERT INTO route_track_points(id,dispatch_id,driver_id,recorded_at,latitude,longitude,accuracy_m,speed_mps) VALUES('${id(105)}','${id(103)}','${id(102)}',now(),-12,-77,10,1);`)
  assert.equal(own().connected,true);assert.equal(own().gps_fresh,true);assert.equal(own().speed,3.6)
  assert.equal(sql(`SELECT actual_distance_km FROM dispatches WHERE id='${id(103)}'`),'0.000')
  sql(`INSERT INTO delivery_conformities(dispatch_id,request_id,state,arrived_at) VALUES('${id(103)}','${id(104)}','PENDIENTE',now())`)
  assert.equal(own().operational_status,'ESPERANDO_GUIA')
  const gpsPhoto=`${id(12)}/${id(103)}/${id(104)}/signed.jpg`
  sql(`INSERT INTO storage.objects VALUES('driver_evidence','${gpsPhoto}','{}')`)
  const guideGps=rpc(12,`delivery_submit_driver('${id(103)}','${id(104)}',ARRAY['${gpsPhoto}'],'Receptor',NULL,'GR-GPS','${id(106)}',now())`)
  assert.equal(guideGps.success,true);assert.equal(own().operational_status,'GUIA_EN_VALIDACION')
  rpc(11,`delivery_review('${id(103)}','${id(104)}','${guideGps.submission_id}','OBSERVADA','Foto incompleta')`)
  assert.equal(own().operational_status,'GUIA_OBSERVADA')
  denied(`UPDATE dispatches SET status='RETORNO' WHERE id='${id(103)}'`,/Faltan guías aprobadas/)
  sql(`UPDATE delivery_conformities SET state='VALIDADA' WHERE dispatch_id='${id(103)}'; UPDATE dispatches SET status='RETORNO' WHERE id='${id(103)}'`)
  assert.equal(own().operational_status,'RETORNO')
  sql(`UPDATE dispatches SET site_id='${id(22)}' WHERE id='${id(103)}'; UPDATE roles SET permissions='["monitoreo"]' WHERE id='${id(1)}'`)
  assert.equal(rpc(11,'get_driver_gps_monitor()').drivers.some(d=>d.driver_id===id(102)),false)
  sql(`UPDATE profiles SET is_active=false WHERE id='${id(12)}'`)
  assert.equal(rpc(12,`driver_app_heartbeat('checking')`).success,false)
  assert.equal(rpc(14,'get_driver_gps_monitor()').drivers.some(d=>d.driver_id===id(102)),false)
  sql(`UPDATE profiles SET is_active=true WHERE id='${id(12)}'`)
  const c47=query(read('supabase/tests/caja_c47_presencia_conductor_gps.test.sql'))
  assert.match(c47.stderr,/CAJA C47 PASS/,c47.stderr)
  console.log('PASS: complete GPS presence migration and real C47: idle/denied GPS, own identity, role/site, expiry/logout, late samples, assigned/guide/return states, no route kilometers changed.')




} catch(error) {
  console.error(error.message)
  console.error('::error title=Delivery conformity validation::' + error.message.replaceAll('%','%25').replaceAll('\n','%0A'))
  process.exitCode=1
} finally { spawnSync('docker',['rm','-f',name],{encoding:'utf8'}) }
