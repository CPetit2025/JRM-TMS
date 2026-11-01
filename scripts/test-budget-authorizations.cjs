// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control presupuestal · etapa 3: un compromiso sobre el tope (80 %) solo pasa con una autorización vigente de Gerencia
// y nunca más allá del 100 %; flujo Supervisor → Jefe de Distribución → Gerencia con historial; emergencia provisional que
// se ratifica o rechaza; la autorización no cambia la partida; vista previa al programar.
const assert = require('node:assert/strict')
const { setupBudget, read, id, fn } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  await db.exec(`ALTER TABLE contracts ADD COLUMN site_id uuid;
   CREATE TABLE transport_margin_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope text, contract_id uuid, client_id uuid, operating_pct numeric,
    reason text, active boolean DEFAULT true, valid_until date);
   ALTER TABLE contracts ADD COLUMN client_id uuid;
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION economic_user_name(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Usuario'$$;
   CREATE FUNCTION service_cost_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'El historial de costos no se modifica ni se borra'; END$$;
   CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(99)}'::uuid$$;`)
  const margin = 'supabase/migrations/20261015100000_transport_margin_override.sql'
  for (const name of ['transport_margin_override_for','transport_operating_pct','transport_operating_limit']) await db.exec(fn(margin, name, '$$;'))
  for (const m of ['20261125090000_control_presupuestal_posicion.sql','20261126090000_control_presupuestal_imputacion.sql']) await db.exec(read('supabase/migrations/' + m))
  const migration = read('supabase/migrations/20261127090000_control_presupuestal_autorizaciones.sql')
  await db.exec(migration); await db.exec(migration)
  const as = perms => db.exec(`SELECT set_config('test.perms', '${perms}', false)`)
  const reserve = n => db.exec(`UPDATE contract_budgets SET reserved_pen = ${n} WHERE contract_id='${id(10)}'`)
  const request = (amount, emergency = false, reason = 'Pedido urgente del cliente sin holgura') => rpc('budget_authorization_request($1,$2,$3,$4,$5)', [id(10), amount, reason, 'Correo del cliente', emergency])
  const act = (aid, action, note = null) => rpc('budget_authorization_action($1,$2,$3)', [aid, action, note])

  // OT-A: asignado 1 000, tope 800. Con 700 comprometido, llegar a 900 se bloquea
  await reserve(700)
  await assert.rejects(reserve(900), /Saldo insuficiente/)
  // Supervisor (despacho) solicita; no puede recomendar ni autorizar
  await as('despacho')
  assert.match((await request(150, false, 'corto')).error, /mínimo 10/)
  let r = await request(150); assert.equal(r.status, 'SOLICITADA', r.error); const a1 = r.id
  assert.match((await act(a1, 'AUTORIZAR')).error, /Solo Gerencia/)
  await assert.rejects(reserve(900), /Saldo insuficiente/, 'a request alone does not allow')
  // Jefe de Distribución recomienda (no autoriza)
  await as('control-presupuestal-recomendar')
  assert.equal((await act(a1, 'RECOMENDAR', 'Cliente estratégico')).status, 'RECOMENDADA')
  assert.match((await act(a1, 'AUTORIZAR')).error, /Solo Gerencia/)
  // Gerencia autoriza: hasta 800 + 150 = 950
  await as('control-presupuestal-autorizar')
  assert.equal((await act(a1, 'AUTORIZAR', 'Aprobado por excepción')).status, 'AUTORIZADA')
  await reserve(900)
  await assert.rejects(reserve(960), /Saldo insuficiente/, 'over the authorized amount')
  const b = (await db.query(`SELECT allocated_pen::float a FROM contract_budgets WHERE contract_id=$1`, [id(10)])).rows[0]
  assert.equal(b.a, 1000, 'authorization does not change the budget')
  // Nunca más allá del 100 %: quedan 1 000 − 800 − 150 = 50 autorizables
  await as('despacho')
  assert.match((await request(60)).error, /Supera el 100 % de la partida \(máximo autorizable S\/ 50\.00\): requiere ampliación/)
  // Emergencia: autorizada de inmediato (provisional), Gerencia la ratifica
  r = await request(50, true, 'Emergencia: unidad varada con carga')
  assert.equal(r.status, 'AUTORIZADA', r.error); const a2 = r.id
  await reserve(1000)
  await as('control-presupuestal-autorizar')
  assert.equal((await act(a2, 'RATIFICAR')).status, 'AUTORIZADA')
  assert.match((await act(a2, 'RATIFICAR')).error, /emergencia pendiente/)
  // Anular la primera: lo comprometido se conserva, pero ya no se puede comprometer más sobre el tope
  assert.match((await act(a1, 'ANULAR')).error, /motivo/)
  assert.equal((await act(a1, 'ANULAR', 'Cliente canceló el pedido')).status, 'ANULADA')
  await reserve(990)  // liberar está permitido
  await assert.rejects(reserve(995), /Saldo insuficiente/, 'only 50 still authorized: 850 max')
  // Una emergencia sin ratificar se puede rechazar
  await as('despacho'); r = await request(10, true, 'Emergencia: retén policial en ruta')
  await as('control-presupuestal-autorizar')
  assert.equal((await act(r.id, 'RECHAZAR', 'No justificada')).status, 'RECHAZADA')

  // Vista previa al programar (dos servicios de OT-A y uno de OT-B)
  await reserve(700)
  const pv = await rpc('budget_preview($1::jsonb)', [JSON.stringify([{ contract_id: id(10), amount: 100 }, { contract_id: id(10), amount: 100 }, { contract_id: id(20), amount: 750 }])])
  const byCode = Object.fromEntries(pv.rows.map(x => [x.code, x]))
  assert.deepEqual([Number(byCode['OT-A'].after_pct), byCode['OT-A'].level, byCode['OT-A'].allowed, Number(byCode['OT-A'].needs_pen)], [90, 'BLOQUEO', false, 50],
   'two services on OT-A: 700 + 200 = 900; cap 800 + 50 authorized → needs 50 more')
  assert.deepEqual([Number(byCode['OT-B'].after_pct), byCode['OT-B'].level, byCode['OT-B'].allowed], [75, 'ALERTA', true])

  // Historial solo de inserción y listado
  await assert.rejects(db.exec(`DELETE FROM budget_authorization_events`), /no se modifica/)
  await db.exec(`SELECT set_config('test.perms', 'control-presupuestal-recomendar', false)`)
  const list = await rpc('budget_authorizations_list()')
  assert.equal(list.success, true, list.error); assert.equal(list.can_recommend, true); assert.equal(list.can_authorize, false)
  assert.deepEqual(list.rows.map(x => x.status).sort(), ['ANULADA','AUTORIZADA','RECHAZADA'])

  await assert.rejects(db.exec(read('supabase/tests/caja_c200_control_presupuestal_autorizaciones.test.sql')), /CAJA C200 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS control presupuestal etapa 3: sobre el tope solo con autorización de Gerencia (hasta el 100 %), flujo Supervisor → Jefe → Gerencia, emergencia provisional, la partida no cambia y vista previa al programar')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
