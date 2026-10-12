const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const name = `jrm-readiness-${process.pid}`
function docker(args, input) { const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 2e6 }); if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout }
function sql(input) { return docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-qtA', '-v', 'ON_ERROR_STOP=1'], input) }
function result(input) { return JSON.parse(sql(input).trim()) }
try {
 docker(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
 let ready = false
 for (let i = 0; i < 50; i++) { if (spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) { ready = true; break } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) }
 assert.ok(ready)
 sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '11111111-1111-1111-1111-111111111111'::uuid$$;
 CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.active',true),'true')='true'$$;
 CREATE FUNCTION apt_can_view() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.view',true),'true')='true'$$;
 CREATE FUNCTION apt_can_load() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.load',true),'true')='true'$$;`)
 const migration = fs.readFileSync('supabase/migrations/20261011210000_apt_operational_readiness.sql', 'utf8')
 sql(migration); sql(migration)
 assert.equal(result(`SELECT apt_readiness_list('[{"almacen":"ST","lote":"16339"}]')`).rows.length, 0, 'missing record must stay unevaluated')
 const save = data => result(`SELECT apt_readiness_save('${JSON.stringify(data).replaceAll("'", "''")}')`)
 const base = { almacen: 'ST', lote: '16339', status: 'DISPONIBLE', reason: 'Revisión documentada', responsible_name: 'Supervisor APT', next_action: 'Coordinar programación' }
 assert.equal(save({ ...base, reason: '' }).success, false, 'availability requires evidence')
 const first = save(base); assert.equal(first.success, true)
 assert.equal(sql('SELECT count(*) FROM apt_operational_readiness_history').trim(), '1')
 assert.equal(save({ ...base, status: 'BLOQUEADO' }).success, false, 'reject stale concurrent updates')
 const second = save({ ...base, status: 'BLOQUEADO', expected_updated_at: first.row.updated_at }); assert.equal(second.success, true)
 assert.equal(sql('SELECT count(*) FROM apt_operational_readiness_history').trim(), '2')
 assert.equal(result(`SET test.load='false'; SELECT apt_readiness_save('${JSON.stringify(base)}')`).success, false)
 assert.equal(result(`SET test.view='false'; SELECT apt_readiness_list('[]')`).success, false)
 assert.equal(result(`SET test.active='false'; SELECT apt_readiness_list('[]')`).success, false)
 assert.equal(result(`SET test.active='false'; SELECT apt_readiness_save('${JSON.stringify(base)}')`).success, false)
 assert.equal(sql(`SELECT has_function_privilege('anon','apt_readiness_save(jsonb)','EXECUTE')`).trim(), 'f')
 assert.equal(sql(`SELECT has_table_privilege('authenticated','apt_operational_readiness','UPDATE')`).trim(), 'f')
 assert.equal(sql(`SET ROLE authenticated; SET test.view='false'; SELECT count(*) FROM apt_operational_readiness`).trim(), '0', 'RLS hides records outside APT')
 sql(`CREATE TABLE roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,permissions jsonb);
 CREATE TABLE profiles(id uuid PRIMARY KEY,role_id uuid,is_active boolean);
 CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE TABLE drivers(profile_id uuid);
 INSERT INTO auth.users VALUES('11111111-1111-1111-1111-111111111111');
 INSERT INTO profiles(id,is_active) VALUES('11111111-1111-1111-1111-111111111111',true);
 CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE OR REPLACE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND is_active)$$;
 GRANT USAGE ON SCHEMA auth TO authenticated;`)
 const initial = fs.readFileSync('supabase/migrations/20261002100000_apt_estadia_inventario.sql','utf8')
 for (const name of ['apt_can_view','apt_can_load']) {
  const start = initial.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`)
  sql(initial.slice(start, initial.indexOf('$$;',start)+3))
 }
 const caja = spawnSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: fs.readFileSync('supabase/tests/caja_c89_apt_readiness.test.sql','utf8'), encoding: 'utf8' })
 assert.notEqual(caja.status, 0, 'Caja must terminate with the rollback exception')
 assert.match(caja.stderr, /CAJA C89 PASS:/)
 assert.doesNotMatch(caja.stderr, /CAJA C89 FAIL:/)
 console.log('APT readiness SQL: permissions, RLS, explicit evidence, audit trail, optimistic concurrency passed.')
} finally { spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }) }
