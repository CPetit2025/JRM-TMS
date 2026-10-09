// Real PostgreSQL/RLS/RPC checks in a disposable production-shaped fixture.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process')
const root = path.resolve(__dirname,'..'), name = 'jrm-notifications-'+process.pid
const read = file => fs.readFileSync(path.join(root,file),'utf8')
const query = input => spawnSync('docker',['exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-At','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'})
const sql = input => {const r=query(input);if(r.status)throw Error(r.stderr||r.stdout);return r.stdout}
try {
 const started=spawnSync('docker',['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16-alpine'],{encoding:'utf8'})
 if(started.status)throw Error(started.stderr)
 for(let i=0;i<40;i++){
  if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status===0)break
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200)
 }
 sql(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
 SET check_function_bodies=off;`+read('scripts/security/production-shape.sql')+`
 CREATE SEQUENCE notification_fixture_ids START 1000000;
 ALTER TABLE public.notifications ALTER COLUMN id SET DEFAULT nextval('notification_fixture_ids');
 ALTER TABLE public.notif_reglas ADD PRIMARY KEY(evento);
 ALTER TABLE public.notification_reads ADD PRIMARY KEY(user_id,notification_id);
 ALTER TABLE public.notif_prefs ADD PRIMARY KEY(user_id,categoria);
 INSERT INTO public.roles(id,name,permissions) VALUES('00000000-0000-4000-8000-000000000100','Administrador','[]');
 INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003');
 INSERT INTO public.profiles(id,role_id,is_active) SELECT id,'00000000-0000-4000-8000-000000000100',true FROM auth.users;
 GRANT SELECT ON public.profiles,public.roles TO authenticated;`)
 sql(read('supabase/migrations/20261004120000_notificaciones_por_rol.sql'))
 sql(read('supabase/migrations/20261009140000_responsible_notifications.sql'))
 sql(read('supabase/migrations/20261010030000_despacho_atrasado_responsable.sql'))
 for(const file of ['caja_c29_notificaciones_por_rol.test.sql','caja_c64_responsible_notifications.test.sql','caja_c73_despacho_atrasado_responsable.test.sql']){
  const r=query(read('supabase/tests/'+file)), number=file.match(/caja_c(\d+)/)[1]
  assert.match(r.stderr,new RegExp('CAJA C'+number+' PASS'),r.stderr||r.stdout)
  console.log('PASS: '+file)
 }
} finally {spawnSync('docker',['rm','-f',name],{encoding:'utf8'})}
