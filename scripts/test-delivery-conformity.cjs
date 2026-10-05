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
  CREATE FUNCTION has_tms_permission(code text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT has_tms_read_permission(code) $$;
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
  sql(installed('supabase/migrations/20260929180000_despacho_f1_estados_partida.sql', 'close_dispatch_route') + installed('supabase/migrations/20260922181500_ai_trip_actions.sql', 'get_active_trip_context') + installed(third, 'tercero_avance') + installed(third, 'tercero_enlace_despacho') + installed('supabase/migrations/20260922181500_ai_trip_actions.sql', 'execute_driver_offline_action') + installed('supabase/migrations/000163_dispatch_transactions.sql', 'request_dispatch_return'))
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
} catch(error) {
  console.error(error.message)
  console.error('::error title=Delivery conformity validation::' + error.message.replaceAll('%','%25').replaceAll('\n','%0A'))
  process.exitCode=1
} finally { spawnSync('docker',['rm','-f',name],{encoding:'utf8'}) }
