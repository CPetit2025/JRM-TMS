const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..'), name = `jrm-security-${process.pid}`
const read = file => readFileSync(path.join(root, file), 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function cmd(args, input) {
 const r = spawnSync('docker', args, { input, encoding: 'utf8' })
 if (r.status) throw Error(r.stderr || r.stdout)
 return r.stdout
}
const raw = input => spawnSync('docker', ['exec','-i',name,'psql','-U','postgres','-At','-v','ON_ERROR_STOP=1'], { input, encoding:'utf8' })
function sql(input) { const r = raw(input); if(r.status)throw Error(r.stderr||r.stdout);return r.stdout.trim().split('\n').at(-1) }
const user = n => `SET ROLE authenticated; SET request.jwt.claim.sub='${id(n)}';`
function denied(input,pattern) { const r=raw(input);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,pattern) }
try {
 cmd(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'])
 for(let n=0;n<40;n++){if(!spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)}
 sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE SCHEMA storage;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth,storage TO authenticated,anon,service_role;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 SET check_function_bodies=off;`+read('scripts/security/production-shape.sql')+`
 CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(bucket_id text,name text,owner_id text,PRIMARY KEY(bucket_id,name));
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT ALL ON ALL TABLES IN SCHEMA public,storage TO anon,authenticated,service_role;
 CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND r.name='Administrador')$$;
 CREATE FUNCTION has_tms_read_permission(m text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT is_tms_admin() OR EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND (r.permissions ? m OR r.permissions ? (m||':read') OR r.permissions ? (m||':write')))$$;
 CREATE FUNCTION has_tms_permission(m text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$SELECT is_tms_admin() OR EXISTS(SELECT 1 FROM profiles p JOIN roles r ON r.id=p.role_id WHERE p.id=auth.uid() AND p.is_active AND (r.permissions ? m OR r.permissions ? (m||':write')))$$;
 CREATE FUNCTION has_cmms_permission(m text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_permission('mantenimiento-'||m)$$;
 CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
 CREATE FUNCTION has_caja_read_access() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_read_permission('caja')$$;
 CREATE FUNCTION can_access_site(s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT is_tms_admin() OR EXISTS(SELECT 1 FROM user_site_access WHERE user_id=auth.uid() AND site_id=s)$$;
 CREATE FUNCTION can_manage_fleet_status() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid() IS NULL OR has_tms_permission('mantenimiento-flota') OR has_tms_permission('mantenimiento-ot') OR has_tms_permission('despacho')$$;
 CREATE FUNCTION can_operate_dispatch(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT has_tms_permission('despacho') AND can_access_site(s)$$;
 CREATE FUNCTION transition_dispatch_status(uuid,text,text DEFAULT NULL,uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT '{"success":false,"error":"Transición rechazada"}'::jsonb$$;
 `+read('scripts/security/legacy-boundaries.sql')+`
 DO $$DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 EXECUTE format('CREATE POLICY legacy_open ON public.%I FOR ALL TO authenticated USING(true) WITH CHECK(true)',t.tablename);
 EXECUTE format('CREATE POLICY tms_admin_full_access ON public.%I FOR ALL TO authenticated USING(is_tms_admin()) WITH CHECK(is_tms_admin())',t.tablename);
 END LOOP;END$$;
 CREATE POLICY "Public Access" ON storage.objects FOR SELECT TO public USING(bucket_id='signatures');
 CREATE POLICY "Permitir ver a public en evidence" ON storage.objects FOR SELECT TO public USING(bucket_id='evidence');
 DROP POLICY legacy_open ON public.profiles; DROP POLICY legacy_open ON public.roles;
 CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated USING(id=auth.uid() OR is_tms_admin());
 CREATE POLICY roles_read ON public.roles FOR SELECT TO authenticated USING(true);
 CREATE VIEW vehicle_fuel_efficiency AS SELECT * FROM carriers;
 GRANT ALL ON vehicle_fuel_efficiency TO anon,authenticated;
 INSERT INTO roles(id,name,permissions) VALUES('${id(1)}','Administrador','[]'),('${id(2)}','Conductor','[]'),('${id(3)}','Lectura APT','["apt:read"]'),('${id(4)}','Sin módulos','[]'),('${id(5)}','Supervisor','["despacho","operaciones-revision"]');
 INSERT INTO profiles(id,role_id,is_active) VALUES('${id(11)}','${id(2)}',true),('${id(12)}','${id(4)}',true),('${id(13)}','${id(3)}',true),('${id(14)}','${id(1)}',false),('${id(15)}','${id(5)}',true);
 INSERT INTO auth.users(id) VALUES('${id(11)}'),('${id(12)}'),('${id(13)}'),('${id(14)}'),('${id(15)}');
 INSERT INTO sites(id,code,name) VALUES('${id(20)}','TEST','Sede'); INSERT INTO user_site_access VALUES('${id(15)}','${id(20)}');
 INSERT INTO drivers(id,profile_id,document_number,license_number,is_active) VALUES('${id(21)}','${id(11)}','SEC-1','SEC-1',true),('${id(22)}',NULL,'SEC-2','SEC-2',true);
 INSERT INTO vehicles(id,plate,assigned_driver_id,site_id,current_odometer,current_mileage,status) VALUES('${id(31)}','OWN-001','${id(21)}','${id(20)}',1000,1000,'DISPONIBLE'),('${id(32)}','OTHER-2','${id(22)}','${id(20)}',1000,1000,'DISPONIBLE');
 INSERT INTO dispatches(id,driver_id,vehicle_plate,status,site_id) VALUES('${id(41)}','${id(21)}','OWN-001','EN_CURSO','${id(20)}'),('${id(42)}','${id(22)}','OTHER-2','EN_CURSO','${id(20)}');
 INSERT INTO carriers(id,business_name,is_active,tax_id) VALUES('${id(51)}','Visible carrier',true,'private-ruc');
 INSERT INTO products(id,sku,description) VALUES('${id(61)}','TEST','Product');
 INSERT INTO operaciones_turnos(id,profile_id,supervisor_status) VALUES('${id(71)}','${id(11)}','PENDIENTE'),('${id(72)}','${id(12)}','PENDIENTE');
 INSERT INTO storage.buckets VALUES('evidence',true,NULL,NULL),('signatures',true,NULL,NULL);
 INSERT INTO storage.objects VALUES('signatures','inspecciones/OWN-001/sign.png','${id(15)}');
 GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated,service_role;
 `)
 assert.equal(sql(`SET ROLE anon; SELECT count(*) FROM vehicle_fuel_efficiency;`),'1','owner view leak reproduced')
 sql(user(12)+`INSERT INTO carriers(id,business_name) VALUES('${id(52)}','Unauthorized write');`)
 // Original post-route RPC trusts the supplied driver ID and persists changes even when transition fails.
 sql(`SET ROLE anon; SELECT submit_post_route_checklist('${id(42)}','OTHER-2','${id(22)}',1200,'{}');`)
 assert.equal(sql(`SELECT end_odometer FROM dispatches WHERE id='${id(42)}';`),'1200')
 sql(`UPDATE dispatches SET end_odometer=NULL WHERE id='${id(42)}';UPDATE vehicles SET current_odometer=1000 WHERE id='${id(32)}';`)
 console.log('PASS: production-era owner-view leak, unrestricted write and anonymous post-route mutation reproduced.')
 sql(read('supabase/migrations/20261008020000_production_security_boundaries.sql'))
 // Revoking PUBLIC defaults also protects new temporary functions. SQL regression helpers
 // grant their own session-local execution explicitly, without reopening production RPCs.
 denied(`CREATE FUNCTION pg_temp.security_probe() RETURNS uuid LANGUAGE sql AS $$SELECT auth.uid()$$;`+user(12)+`SELECT pg_temp.security_probe();`,/permission denied/)
 assert.equal(sql(`CREATE FUNCTION pg_temp.security_probe() RETURNS uuid LANGUAGE sql AS $$SELECT auth.uid()$$; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;`+user(12)+`SELECT pg_temp.security_probe();`),id(12))
 denied(`SET ROLE anon; SELECT * FROM vehicle_fuel_efficiency;`,/permission denied/)
 denied(`SET ROLE anon; SELECT submit_post_route_checklist(NULL,NULL,NULL,NULL,NULL);`,/permission denied/)
 denied(`SET ROLE anon; SELECT tax_id FROM carriers;`,/permission denied/)
 assert.equal(sql(`SET ROLE anon; SELECT count(id) FROM carriers;`),'2')
 assert.equal(sql(user(12)+`SELECT count(*) FROM carriers;`),'0')
 denied(user(12)+`INSERT INTO carriers(id,business_name) VALUES('${id(53)}','Denied');`,/row-level security/)
 assert.equal(sql(user(13)+`SELECT count(*) FROM products;`),'1')
 denied(user(13)+`INSERT INTO products(id,sku) VALUES('${id(62)}','Denied');`,/row-level security/)
 assert.equal(sql(user(14)+`SELECT count(*) FROM products;`),'0')
 assert.equal(sql(`SELECT has_table_privilege('anon','products','TRUNCATE') OR has_table_privilege('authenticated','products','TRUNCATE');`),'f')
 assert.equal(sql(user(11)+`SELECT count(*) FROM operaciones_turnos;`),'1')
 denied(user(11)+`UPDATE operaciones_turnos SET supervisor_status='APROBADO' WHERE id='${id(71)}';`,/Solo el supervisor/)
 sql(user(15)+`UPDATE operaciones_turnos SET supervisor_status='APROBADO' WHERE id='${id(71)}';`)
 denied(user(11)+`SELECT record_odometer_reading('OTHER-2',1100,NULL,'WEB',NULL);`,/Sin acceso/)
 sql(user(11)+`SELECT record_odometer_reading('OWN-001',1100,NULL,'WEB',NULL);`)
 assert.equal(sql(`SELECT current_odometer FROM vehicles WHERE id='${id(31)}';`),'1100')
 denied(user(11)+`SELECT submit_post_route_checklist('${id(42)}','OTHER-2','${id(22)}',1400,'{}');`,/conductor asignado/)
 assert.equal(sql(`SELECT end_odometer IS NULL FROM dispatches WHERE id='${id(42)}';`),'t')
 // Rejected transition now raises and rolls back mileage, checklist and liquidation changes atomically.
 denied(user(11)+`SELECT submit_post_route_checklist('${id(41)}','OWN-001','${id(21)}',1500,'{}');`,/Transición no permitida/)
 assert.equal(sql(`SELECT end_odometer IS NULL FROM dispatches WHERE id='${id(41)}';`),'t')
 assert.equal(sql(`SELECT current_odometer FROM vehicles WHERE id='${id(31)}';`),'1100')
 assert.equal(sql(`SELECT bool_and(NOT public) FROM storage.buckets;`),'t')
 assert.equal(sql(user(12)+`SELECT count(*) FROM storage.objects;`),'0')
 denied(user(12)+`SELECT reserve_registration_attempt('staff','${'a'.repeat(64)}');`,/permission denied/)
 for(let n=1;n<=6;n++)assert.equal(sql(`SET ROLE service_role; SELECT reserve_registration_attempt('staff','${'a'.repeat(64)}');`),n<=5?'t':'f')
 console.log('PASS: anonymous, inactive, read-only, foreign-driver and self-review attempts denied; permitted reads and own odometer preserved; rejected post-route fully rolls back.')
 sql(read('supabase/migrations/20261008021000_production_relation_indexes.sql'))
 denied(`INSERT INTO driver_documents(id,driver_id) VALUES('${id(81)}','${id(82)}');`,/foreign key/)
 const indexes=sql(`SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'security_fk_%';`)
 assert.ok(Number(indexes)>=20,indexes)
 sql(read('supabase/migrations/20261008021000_production_relation_indexes.sql'))
 assert.equal(sql(`SELECT count(*) FROM pg_indexes WHERE indexname LIKE 'security_fk_%';`),indexes)
 const regression=raw(read('supabase/tests/caja_c55_seguridad_produccion.test.sql'));assert.match(regression.stderr,/CAJA C55 PASS/);
 console.log('PASS: missing relations reject new orphans; FK indexes reuse coverage on a repeat run; live C55 rolls back all probes.')
}finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'})}
