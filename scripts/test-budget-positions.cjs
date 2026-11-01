// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control presupuestal · etapa 1: posición por OT (familia raíz + subcontratos), consumo = comprometido + ejecutado sobre
// lo asignado, niveles 70/80/100 configurables y margen pactado visible; sin acceso no se ve.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION is_contract_administrator() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_assigned_contract(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.perm',true) = $1$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE TABLE sites(id uuid PRIMARY KEY);
   CREATE TABLE clients(id uuid PRIMARY KEY, business_name text);
   CREATE TABLE contracts(id uuid PRIMARY KEY, code text, client_id uuid, type text, parent_contract_id uuid, site_id uuid, created_at timestamptz DEFAULT now());
   CREATE FUNCTION contract_root_id(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
    WITH RECURSIVE up(id, parent) AS (SELECT id, parent_contract_id FROM contracts WHERE id = p UNION SELECT c.id, c.parent_contract_id FROM contracts c JOIN up ON c.id = up.parent)
    SELECT id FROM up WHERE parent IS NULL$$;
   CREATE TABLE contract_budgets(contract_id uuid, concept text, allocated_pen numeric DEFAULT 0, reserved_pen numeric DEFAULT 0, consumed_pen numeric DEFAULT 0);
   CREATE TABLE transport_margin_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text, contract_id uuid, client_id uuid, operating_pct numeric,
    reason text, active boolean DEFAULT true, valid_until date);
   CREATE TABLE economic_settings(id boolean PRIMARY KEY DEFAULT true CHECK (id), deviation_pct numeric DEFAULT 10, deviation_pen numeric DEFAULT 100, max_pending_days int DEFAULT 7);
   INSERT INTO economic_settings DEFAULT VALUES;`)
  // Margen vigente (misma definición que 20261015100000_transport_margin_override)
  const margin = readFileSync('supabase/migrations/20261015100000_transport_margin_override.sql','utf8')
  for (const name of ['transport_margin_override_for','transport_operating_pct']) {
   const a = margin.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert(a >= 0, name)
   await db.exec(margin.slice(a, margin.indexOf('$$;', margin.indexOf('AS $$', a) + 5) + 3))
  }
  await db.exec(`INSERT INTO sites VALUES('${id(1)}'); INSERT INTO clients VALUES('${id(2)}','Minera Sur'),('${id(3)}','Agro Norte');
   INSERT INTO contracts(id,code,client_id,type,parent_contract_id,site_id) VALUES
    ('${id(10)}','OT-100','${id(2)}','CONTRATO',NULL,'${id(1)}'),('${id(11)}','OT-100-S1','${id(2)}','SUBCONTRATO','${id(10)}','${id(1)}'),
    ('${id(20)}','OT-200','${id(3)}','OT_INDEPENDIENTE',NULL,'${id(1)}'),('${id(30)}','OT-300','${id(3)}','CONTRATO',NULL,'${id(1)}'),
    ('${id(40)}','OT-400','${id(3)}','CONTRATO',NULL,'${id(1)}'),('${id(50)}','OT-500','${id(3)}','CONTRATO',NULL,'${id(1)}');
   -- OT-100: familia 10 000 asignado (raíz); 4 000 comprometido + 3 600 ejecutado entre raíz y subcontrato = 76 % → ALERTA
   INSERT INTO contract_budgets VALUES ('${id(10)}','PARTIDA_TRANSPORTE',10000,4000,1000), ('${id(11)}','PARTIDA_TRANSPORTE',0,0,2600),
    ('${id(20)}','PARTIDA_TRANSPORTE',5000,1000,1500), ('${id(30)}','PARTIDA_TRANSPORTE',2000,500,1200), ('${id(40)}','PARTIDA_TRANSPORTE',1000,300,900),
    ('${id(50)}','PARTIDA_TRANSPORTE',0,0,0);
   INSERT INTO transport_margin_overrides(scope,contract_id,operating_pct,reason) VALUES('OT','${id(30)}',90,'Tarifa pactada');`)
  const migration = readFileSync('supabase/migrations/20261125090000_control_presupuestal_posicion.sql','utf8')
  assert.doesNotMatch(migration, /^\s*(UPDATE|DELETE) /im, 'read-only stage: no data changes')
  await db.exec(migration); await db.exec(migration)
  const positions = async () => (await db.query(`SELECT budget_positions() AS v`)).rows[0].v

  assert.equal((await positions()).success, false, 'no access without permission')
  await db.exec(`SELECT set_config('test.uid','${id(9)}',false), set_config('test.perm','caja',false)`)  // Finanzas (lectura de Caja)
  const out = await positions()
  assert.equal(out.success, true, out.error)
  assert.deepEqual([out.settings.budget_alert_pct, out.settings.budget_cap_pct], [70, 80])
  const by = Object.fromEntries(out.rows.map(r => [r.code, r]))
  assert.deepEqual(Object.keys(by), ['OT-400','OT-300','OT-100','OT-200'], 'ordered by consumption; no budget and no spend hidden; subcontract inside its root')
  assert.deepEqual([Number(by['OT-100'].used_pen), Number(by['OT-100'].used_pct), by['OT-100'].level], [7600, 76, 'ALERTA'], 'family totals')
  assert.equal(Number(by['OT-100'].available_to_cap_pen), 400, 'cap 8 000 − 7 600')
  assert.deepEqual([Number(by['OT-200'].used_pct), by['OT-200'].level], [50, 'NORMAL'])
  assert.deepEqual([Number(by['OT-300'].used_pct), by['OT-300'].level, Number(by['OT-300'].operating_pct), by['OT-300'].override.reason], [85, 'BLOQUEO', 90, 'Tarifa pactada'],
   'agreed margin is shown but the level still uses the 80 % cap')
  assert.deepEqual([Number(by['OT-400'].used_pct), by['OT-400'].level, Number(by['OT-400'].available_to_cap_pen)], [120, 'EXCEDIDO', -400])
  // Cortes configurables por la jefatura
  await db.exec(`UPDATE economic_settings SET budget_alert_pct = 75`)
  assert.equal((await positions()).rows.find(r => r.code === 'OT-100').level, 'ALERTA')
  await db.exec(`UPDATE economic_settings SET budget_alert_pct = 77`)
  assert.equal((await positions()).rows.find(r => r.code === 'OT-100').level, 'NORMAL')
  await assert.rejects(db.exec(`UPDATE economic_settings SET budget_alert_pct = 85`), /budget_pct_check/, 'alert below the cap')

  await assert.rejects(db.exec(readFileSync('supabase/tests/caja_c198_control_presupuestal_posicion.test.sql','utf8')), /CAJA C198 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS control presupuestal etapa 1: posición por OT (familia), niveles 70/80/100 configurables, margen pactado visible y acceso restringido')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
