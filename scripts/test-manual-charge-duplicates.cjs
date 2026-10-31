// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Auditoría F08: un cargo manual no duplica en silencio un cargo vigente de la misma partida, tipo y fecha (±3 días) que
// venga de una ruta, tenga el mismo importe o el mismo proveedor; con motivo se registra y el motivo queda en la descripción.
const assert = require('node:assert/strict')
const { setupEconomicClosure, read, id, fn } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  await db.exec(`ALTER TABLE contract_services ADD COLUMN IF NOT EXISTS hours numeric, ADD COLUMN IF NOT EXISTS provider_ruc text,
    ADD COLUMN IF NOT EXISTS referral_guide text, ADD COLUMN IF NOT EXISTS budget_contract_id uuid;
   CREATE OR REPLACE FUNCTION has_assigned_contract(uuid, boolean) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE OR REPLACE FUNCTION contract_budget_owner(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $$SELECT p$$;`)
  await db.exec(fn('supabase/migrations/20260930130000_gastos_ot_regularizacion.sql', 'register_contract_service'))
  const migration = read('supabase/migrations/20261121090000_cargo_manual_sin_duplicar.sql')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(96)}','Registro','["contratos-servicios"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(97)}','${id(96)}','Registro'); INSERT INTO auth.users VALUES('${id(97)}');
   INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES('${id(20)}','PARTIDA_TRANSPORTE',10000);
   INSERT INTO dispatches(id,vehicle_plate,status,site_id,dispatch_number) VALUES('${id(70)}','R-1','LIQUIDADO',primary_site_id(),'10103');
   INSERT INTO contract_services(contract_id,status,service_type,dispatch_id,amount_pen,service_date,description) VALUES
    ('${id(20)}','REALIZADO','MONTACARGA','${id(70)}',48,'2026-10-30','Montacarga de la ruta');
   SELECT set_config('request.jwt.claim.sub','${id(97)}',false);`)
  const register = async (type, amount, date, extra = {}) => (await db.query(
   `SELECT register_contract_service_checked($1,$2,$3,$4,$5::date,NULL,NULL,NULL,$6,$7,'Contrato',NULL,$8) AS v`,
   [id(20), type, extra.description ?? 'Cargo manual', amount, date, extra.ruc ?? null, extra.provider ?? null, extra.reason ?? null])).rows[0].v
  const count = async type => Number((await db.query(`SELECT count(*) AS n FROM contract_services WHERE service_type=$1`, [type])).rows[0].n)
  const consumed = async () => Number((await db.query(`SELECT consumed_pen AS v FROM contract_budgets WHERE contract_id=$1`, [id(20)])).rows[0].v)

  // Mismo tipo y fecha cercana que un cargo de ruta: no se registra sin motivo y se muestran los posibles duplicados
  let r = await register('MONTACARGA', 60, '2026-10-31')
  assert.deepEqual([r.success, r.duplicate], [false, true])
  assert.equal(r.matches[0].origin, 'Ruta 10103')
  assert.equal(await count('MONTACARGA'), 1)
  assert.equal(await consumed(), 0, 'nothing consumed while unconfirmed')
  r = await register('MONTACARGA', 60, '2026-10-31', { reason: 'corto' })
  assert.equal(r.duplicate, true, 'reason needs 10 characters')
  r = await register('MONTACARGA', 60, '2026-10-31', { reason: 'Segundo turno de descarga en planta' })
  assert.equal(r.success, true, r.error)
  assert.equal(await count('MONTACARGA'), 2)
  assert.match((await db.query(`SELECT description AS d FROM contract_services WHERE amount_pen=60`)).rows[0].d, /Confirmado no duplicado: Segundo turno/)
  // Mismo importe y tipo, sin ruta: también se detecta; otro tipo o fuera de ±3 días no
  assert.equal((await register('GRUA', 300, '2026-10-20')).success, true)
  assert.equal((await register('GRUA', 300, '2026-10-21')).duplicate, true)
  assert.equal((await register('GRUA', 250, '2026-10-21')).success, true, 'different amount, provider and no route')
  assert.equal((await register('ESTIBA', 300, '2026-10-21')).success, true, 'different type')
  assert.equal((await register('GRUA', 300, '2026-11-05')).success, true, 'outside ±3 days')
  // Errores del registro (saldo) vuelven como mensaje, no como excepción
  r = await register('OTROS', 999999, '2026-10-21')
  assert.deepEqual([r.success, /Saldo insuficiente/.test(r.error)], [false, true])

  await assert.rejects(db.exec(read('supabase/tests/caja_c190_cargo_manual_sin_duplicar.test.sql')), /CAJA C190 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cargo manual sin duplicar: posible duplicado de ruta, importe o proveedor exige motivo; otros tipos y fechas se registran')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
