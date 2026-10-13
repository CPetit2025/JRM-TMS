const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const name = `jrm-driver-transaction-${process.pid}`
const profile = '00000000-0000-4000-8000-000000000001'
const driver = '00000000-0000-4000-8000-000000000002'
const route = '00000000-0000-4000-8000-000000000003'
function command(args, input) {
  return spawnSync('docker', args, { input, encoding: 'utf8' })
}
function query(input) { return command(['exec', '-i', name, 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], input) }
function sql(input) { const r = query(input); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
function native(file, signature) {
  const source = fs.readFileSync(file, 'utf8'), at = source.indexOf(signature)
  assert.ok(at >= 0, signature)
  return source.slice(at, source.indexOf('END $$;', at) + 7)
}
try {
  const start = command(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  assert.equal(start.status, 0, start.stderr)
  let ready = false
  for (let i = 0; i < 60; i++) {
    if (command(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  assert.ok(ready, 'PostgreSQL starts')
  sql(`CREATE SCHEMA auth; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  CREATE TABLE profiles(id uuid PRIMARY KEY,is_active boolean);
  CREATE TABLE drivers(id uuid PRIMARY KEY,profile_id uuid,is_active boolean);
  CREATE TABLE vehicles(plate text,assigned_driver_id uuid,type text,soat_expiration date,technical_review_expiration date);
  CREATE TABLE dispatches(id uuid PRIMARY KEY,driver_id uuid,vehicle_plate text,status text,scheduled_departure timestamptz,dispatch_number text);
  CREATE TABLE driver_preuse_units(driver_id uuid,vehicle_plate text);
  INSERT INTO profiles VALUES('${profile}',true); INSERT INTO drivers VALUES('${driver}','${profile}',true);
  INSERT INTO dispatches VALUES('${route}','${driver}','ZZ-10026','EN_CURSO',now(),'10026');
  INSERT INTO driver_preuse_units VALUES('${driver}','ZZ-10026');
  CREATE FUNCTION driver_preuse_select_core(uuid,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
  CREATE FUNCTION get_driver_preuse_context_before_fleet() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"vehicles":[],"pending":false,"route_plate":"ZZ-10026"}'::jsonb $$;
  CREATE FUNCTION get_active_trip_context_before_preuse() RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('user',jsonb_build_object('id',auth.uid()),'driver',jsonb_build_object('id',dr.id),
      'trip',jsonb_build_object('id',d.id,'dispatch_number',d.dispatch_number,'stops','[]'::jsonb),'pending','{}'::jsonb)
    FROM drivers dr JOIN profiles p ON p.id=dr.profile_id JOIN dispatches d ON d.driver_id=dr.id
    WHERE p.id=auth.uid() AND p.is_active AND dr.is_active $$;
  CREATE FUNCTION trip_stop_info(uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`)
  const fleet = 'supabase/migrations/20261007210000_fleet_assignment_app_link.sql'
  sql(native(fleet, 'CREATE FUNCTION public.fleet_sync_driver_unit('))
  sql(native(fleet, 'CREATE FUNCTION public.get_driver_preuse_context('))
  sql(native(fleet, 'CREATE OR REPLACE FUNCTION public.get_active_trip_context('))
  sql('ALTER FUNCTION get_active_trip_context() RENAME TO get_active_trip_context_before_stop_info;')
  sql(native('supabase/migrations/20261013170000_driver_stop_ot_client.sql', 'CREATE OR REPLACE FUNCTION public.get_active_trip_context('))
  const session = `SET request.jwt.claim.sub='${profile}'; `
  assert.equal(sql("SELECT provolatile FROM pg_proc WHERE oid='get_active_trip_context()'::regprocedure"), 's')
  const failed = query(session + 'BEGIN READ ONLY; SELECT get_active_trip_context();')
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /cannot execute DELETE in a read-only transaction/)
  sql(fs.readFileSync('supabase/migrations/20261013200000_driver_trip_rpc_transaction.sql', 'utf8'))
  assert.equal(sql("SELECT provolatile FROM pg_proc WHERE oid='get_active_trip_context()'::regprocedure"), 'v')
  assert.equal(sql(session + "BEGIN READ WRITE; SELECT get_active_trip_context()#>>'{trip,dispatch_number}'; ROLLBACK;").split('\n').at(-2), '10026')
  assert.equal(sql('SELECT count(*) FROM driver_preuse_units'), '1', 'existing inspection selection remains intact')
  console.log('PASS: original STABLE route RPC fails in PostgREST READ ONLY mode; corrected VOLATILE RPC returns dispatch 10026 with existing fleet synchronization and stop wrapper.')
} finally { command(['rm', '-f', name]) }
