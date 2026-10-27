const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const shape = readFileSync('scripts/security/production-shape.sql', 'utf8')
const table = name => {
  const start = shape.indexOf(`CREATE TABLE public."${name}" (`)
  assert.ok(start >= 0)
  return shape.slice(start, shape.indexOf(';', start) + 1)
}
const migration = readFileSync('supabase/migrations/20261103110000_request_ot_catalog.sql', 'utf8')
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
;(async () => {
  const db = new PGlite()
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.user',true),'')::uuid$$;
      CREATE SEQUENCE permission_calls; CREATE SEQUENCE site_calls;
      CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.active',true) = 'true'$$;
      CREATE FUNCTION has_tms_read_permission(p text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN
        PERFORM nextval('permission_calls'); RETURN current_setting('test.allowed',true)='true'
          AND (p='solicitudes' OR current_setting('test.budgets',true)='true'); END$$;
      CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.portfolio',true)='true'$$;
      CREATE FUNCTION can_access_site(p uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$BEGIN
        PERFORM nextval('site_calls'); RETURN p='${id(1)}' AND current_setting('test.site',true)='true'; END$$;
      CREATE TABLE sites(id uuid PRIMARY KEY);
      CREATE TABLE contract_user_assignments(contract_id uuid,user_id uuid,active boolean,role text);
      ${['clients','contracts','contract_budgets'].map(table).join('\n')}
      CREATE INDEX ON contracts(parent_contract_id); CREATE INDEX ON contract_budgets(contract_id,concept);
      INSERT INTO sites VALUES('${id(1)}'),('${id(2)}');
      INSERT INTO clients(id,business_name) VALUES('${id(100)}','Cliente visible'),('${id(101)}','Cliente privado');
      INSERT INTO contracts(id,code,type,status,site_id,client_id,destination_address,destination_district)
      SELECT ('00000001-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'OT-'||i,'CONTRATO','ACTIVO','${id(1)}','${id(100)}','Av. Venezuela','San Miguel'
      FROM generate_series(1,10000) i;
      INSERT INTO contracts(id,code,type,status,site_id,client_id,parent_contract_id) VALUES
        ('${id(200)}','SUB-1','SUBCONTRATO','ACTIVO','${id(1)}','${id(100)}','00000001-0000-0000-0000-000000000001'),
        ('${id(201)}','ERR-1','ERROR','ACTIVO','${id(1)}','${id(100)}','00000001-0000-0000-0000-000000000001'),
        ('${id(202)}','GAR-1','GARANTIA','ACTIVO','${id(1)}','${id(100)}','00000001-0000-0000-0000-000000000001'),
        ('${id(203)}','OTHER-SITE','CONTRATO','ACTIVO','${id(2)}','${id(101)}',null),
        ('${id(204)}','CLOSED','CONTRATO','CERRADO','${id(1)}','${id(100)}',null),
        ('${id(205)}','ORPHAN','SUBCONTRATO','ACTIVO','${id(1)}','${id(100)}','${id(204)}'),
        ('${id(206)}','CROSS-SITE','ERROR','ACTIVO','${id(2)}','${id(101)}','00000001-0000-0000-0000-000000000001'),
        ('${id(207)}','INDEPENDENT','OT_INDEPENDIENTE','ACTIVO','${id(1)}',null,null);
      INSERT INTO contract_budgets(contract_id,concept,allocated_pen,balance_pen) VALUES
        ('00000001-0000-0000-0000-000000000001','PARTIDA_TRANSPORTE',100,-570),
        ('00000001-0000-0000-0000-000000000001','OTRO',9999,9999);
      INSERT INTO contract_user_assignments VALUES
        ('00000001-0000-0000-0000-000000000001','${id(50)}',true,'ADMIN_CONTRATO'),
        ('00000001-0000-0000-0000-000000000002','${id(50)}',false,'ADMIN_CONTRATO'),
        ('00000001-0000-0000-0000-000000000003','${id(51)}',true,'ADMIN_CONTRATO');
      SELECT set_config('test.user','${id(50)}',false),set_config('test.active','true',false),
        set_config('test.allowed','true',false),set_config('test.budgets','true',false),
        set_config('test.site','true',false),set_config('test.portfolio','false',false);`)
    await db.exec(migration)
    const scalar = async sql => (await db.query(sql)).rows[0].v
    const catalog = () => scalar('SELECT get_transport_request_ot_catalog() AS v')
    await db.exec('ALTER SEQUENCE permission_calls RESTART; ALTER SEQUENCE site_calls RESTART;')
    const started = performance.now()
    const all = await catalog()
    console.log(`Catalog of ${all.rows.length} rows: ${Math.round(performance.now() - started)} ms`)
    assert.equal(all.rows.length, 10003, 'complete catalog beyond the PostgREST 1,000-row cap')
    assert.equal(all.rows.find(r => r.code === 'OT-1').balance_pen, -570)
    assert.equal(all.rows.find(r => r.code === 'OT-1').clients.business_name, 'Cliente visible')
    assert.equal(all.rows.find(r => r.code === 'OT-1').destination_district, 'San Miguel')
    assert.ok(all.rows.some(r => r.code === 'INDEPENDENT'))
    for (const code of ['GAR-1','OTHER-SITE','CLOSED','ORPHAN','CROSS-SITE']) assert.ok(!all.rows.some(r => r.code === code), code)
    assert.ok(Number(await scalar('SELECT last_value AS v FROM permission_calls')) <= 7, 'module permissions checked once, not per OT')
    assert.equal(Number(await scalar('SELECT last_value AS v FROM site_calls')), 2, 'access checked once per site')
    await db.exec("SELECT set_config('test.portfolio','true',false)")
    assert.deepEqual((await catalog()).rows.map(r => r.code).sort(), ['ERR-1','OT-1','SUB-1'])
    await db.exec("UPDATE contract_user_assignments SET role='CONSULTOR'")
    assert.ok((await catalog()).rows.every(r => r.balance_pen === null), 'read-only portfolio assignments do not expose restricted budgets')
    await db.exec("SELECT set_config('test.budgets','false',false)")
    assert.ok((await catalog()).rows.every(r => r.allocated_pen === null && r.balance_pen === null), 'request permission alone does not expose budgets')
    await db.exec("SELECT set_config('test.site','false',false)")
    assert.deepEqual((await catalog()).rows, [])
    for (const setting of ['active','allowed','user']) {
      await db.exec(`SELECT set_config('test.site','true',false),set_config('test.${setting}','${setting === 'user' ? '' : 'false'}',false)`)
      await assert.rejects(catalog, /Sin permiso/)
      await db.exec(`SELECT set_config('test.${setting}','${setting === 'user' ? id(50) : 'true'}',false)`)
    }
    assert.equal(await scalar("SELECT has_function_privilege('anon','get_transport_request_ot_catalog()','EXECUTE') AS v"), false)
    assert.equal(await scalar("SELECT has_function_privilege('authenticated','get_transport_request_ot_catalog()','EXECUTE') AS v"), true)
    await db.exec(`CREATE TABLE auth.users(id uuid); CREATE TABLE roles(id uuid,name text);
      CREATE TABLE profiles(id uuid,role_id uuid,is_active boolean);
      INSERT INTO roles VALUES('${id(80)}','Administrador');
      INSERT INTO profiles VALUES('${id(50)}','${id(80)}',true); INSERT INTO auth.users VALUES('${id(50)}');`)
    const audit = await db.exec(readFileSync('scripts/security/request-ot-performance.sql','utf8'))
    const measured = audit.flatMap(part => part.rows).find(row => row.section === 'OT_CATALOG_PERFORMANCE')
    assert.equal(measured.finding.success, true, 'production performance check executes against the catalog')
    assert.equal(measured.finding.rows, 3)
    console.log('PASS: full OT catalog, constant authorization work, active/site/portfolio scope, budget permissions and no anonymous access')
  } finally { await db.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
