// Reproduce the real begin-stage timeout with a locked abandoned upload.
// Uses the installed function bodies in disposable PostgreSQL, never production.
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {spawnSync} = require('node:child_process')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const name = `jrm-apt-begin-${process.pid}`
function run(args, input) {
  const result = spawnSync('docker', args, {input, encoding: 'utf8'})
  if (result.status !== 0) throw Error(result.stderr || result.stdout)
  return result.stdout
}
function query(input) {
  return spawnSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], {input, encoding: 'utf8'})
}
function sql(input) {
  const result = query(input)
  if (result.status !== 0) throw Error(result.stderr || result.stdout)
  return result.stdout
}
const owner = '11111111-1111-1111-1111-111111111111'
const oldUpload = '22222222-2222-2222-2222-222222222222'
const asLoader = `SET ROLE authenticated; SET request.jwt.claim.sub='${owner}';`
try {
  run(['run', '-d', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  let ready = false
  for (let i = 0; i < 30; i++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) {ready = true; break}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  if (!ready) throw Error('Scratch PostgreSQL did not become ready')
  const base = readFileSync(path.join(root, 'supabase/migrations/20261002100000_apt_estadia_inventario.sql'), 'utf8')
  sql(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${owner}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    CREATE TABLE roles(id uuid PRIMARY KEY, name text, permissions jsonb);
    CREATE TABLE profiles(id uuid PRIMARY KEY, role_id uuid, is_active boolean);
    INSERT INTO roles VALUES ('${owner}', 'APT loader', '["apt-carga:write"]');
    INSERT INTO profiles VALUES ('${owner}', '${owner}', true);
  ` + base.slice(base.indexOf('CREATE OR REPLACE FUNCTION public.apt_can_load()'), base.indexOf('-- ------------------------------------------------------------\n-- Tablas'))
    + base.slice(base.indexOf('CREATE TABLE IF NOT EXISTS public.apt_uploads'), base.indexOf('CREATE TABLE IF NOT EXISTS public.apt_settings'))
    + base.slice(base.indexOf('CREATE OR REPLACE FUNCTION public.apt_upload_begin('), base.indexOf('CREATE OR REPLACE FUNCTION public.apt_upload_rows(')) + `
    ALTER TABLE apt_uploads ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON FUNCTION apt_upload_begin(text) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION apt_upload_begin(text) TO authenticated, service_role;
    CREATE TABLE expected_function AS SELECT proacl,proowner,proconfig,prosecdef FROM pg_proc WHERE oid='apt_upload_begin(text)'::regprocedure;
    INSERT INTO apt_uploads(id,file_name,created_at) VALUES('${oldUpload}','abandoned',now()-interval '2 days');
    INSERT INTO apt_movements(upload_id,kind,row_no,raw,valid)
      SELECT '${oldUpload}','ENTRADA',i,'{}',true FROM generate_series(1,64000)i;
  `)
  // Another request holds this old row. Starting a different upload must not wait for it.
  run(['exec', '-d', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
    `BEGIN; SELECT id FROM apt_uploads WHERE id='${oldUpload}' FOR UPDATE; SELECT pg_advisory_lock(743110); SELECT pg_sleep(30); ROLLBACK;`])
  let locked = false
  for (let i = 0; i < 30; i++) {
    if (sql("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=743110 AND granted);").trim() === 't') {locked = true; break}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  if (!locked) throw Error('Could not reproduce the historical upload lock')
  const before = query(`${asLoader} SET statement_timeout='500ms'; SELECT apt_upload_begin('new.xlsx');`)
  assert.notEqual(before.status, 0)
  assert.match(before.stderr, /canceling statement due to statement timeout/)
  console.log('PASS: original apt_upload_begin reproduces the statement timeout on a locked abandoned upload.')

  const migration = readFileSync(path.join(root, 'supabase/migrations/20261007110000_apt_inicio_sin_limpieza.sql'), 'utf8')
  sql(migration)
  sql(migration)
  const after = sql(`${asLoader} SET statement_timeout='500ms'; SELECT apt_upload_begin('  new.xlsx  ');`).trim().split('\n').at(-1)
  const result = JSON.parse(after)
  assert.equal(result.success, true)
  assert.ok(result.id)
  sql(`DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=743110 AND granted) THEN RAISE EXCEPTION 'The old upload must still be locked'; END IF;
    IF (SELECT count(*) FROM apt_movements WHERE upload_id='${oldUpload}') <> 64000 THEN RAISE EXCEPTION 'Old movements changed'; END IF;
    IF NOT EXISTS(SELECT 1 FROM apt_uploads WHERE id='${oldUpload}' AND status='CARGANDO') THEN RAISE EXCEPTION 'Old upload changed'; END IF;
    IF NOT EXISTS(SELECT 1 FROM apt_uploads WHERE id='${result.id}' AND file_name='new.xlsx' AND created_by='${owner}' AND status='CARGANDO') THEN RAISE EXCEPTION 'New upload ownership or metadata'; END IF;
    IF EXISTS(SELECT 1 FROM pg_proc p,expected_function e WHERE p.oid='apt_upload_begin(text)'::regprocedure AND (p.proacl,p.proowner,p.proconfig,p.prosecdef) IS DISTINCT FROM (e.proacl,e.proowner,e.proconfig,e.prosecdef)) THEN RAISE EXCEPTION 'Security configuration changed'; END IF;
  END $$;`)
  // Filename defaults/limits and the permission gate still run in the real function.
  for (const [input, expected] of [["NULL", 'archivo.xlsx'], ["'   '", 'archivo.xlsx'], ["repeat('x',250)", 'x'.repeat(200)]]) {
    const created = JSON.parse(sql(`${asLoader} SELECT apt_upload_begin(${input});`).trim().split('\n').at(-1))
    assert.equal(created.success, true)
    assert.equal(sql(`SELECT file_name FROM apt_uploads WHERE id='${created.id}';`).trim(), expected)
  }
  for (const permissions of ['["apt"]', '[]']) {
    sql(`UPDATE roles SET permissions='${permissions}';`)
    const denied = JSON.parse(sql(`${asLoader} SELECT apt_upload_begin('forbidden');`).trim().split('\n').at(-1))
    assert.equal(denied.success, false)
  }
  sql(`UPDATE roles SET permissions='["apt-carga:write"]'; UPDATE profiles SET is_active=false;`)
  assert.equal(JSON.parse(sql(`${asLoader} SELECT apt_upload_begin('inactive');`).trim().split('\n').at(-1)).success, false)
  assert.equal(sql("SELECT count(*) FROM apt_uploads WHERE file_name IN ('forbidden','inactive');").trim(), '0')
  const anonymous = query("SET ROLE anon; SELECT apt_upload_begin('anonymous');")
  assert.notEqual(anonymous.status, 0)
  assert.match(anonymous.stderr, /permission denied/)
  sql('UPDATE profiles SET is_active=true;')
  const caja = query(readFileSync(path.join(root, 'supabase/tests/caja_c43_apt_inicio_carga.test.sql'), 'utf8'))
  assert.notEqual(caja.status, 0)
  assert.match(caja.stderr, /CAJA C43 PASS \(3\/3\)/)
  console.log('PASS: begin under 500ms while old upload remains locked; 64,000 old movements unchanged; repeatable migration; ownership, filenames, ACL and authorization preserved; C43 passes.')
} catch (error) {
  const message = String(error.stack || error).slice(0, 6000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.error(`::error title=APT begin regression::${message}`)
  throw error
} finally {
  spawnSync('docker', ['rm', '-f', name], {stdio: 'ignore'})
}
