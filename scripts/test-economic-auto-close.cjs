// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico automático (B + C): al cerrar la ruta, el flete de flota propia se confirma con el vigente (sin mover la
// partida) y queda aprobado; una ruta sin costos queda «No aplica»; lo tercerizado sigue pendiente de cierre manual.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyPriorStages, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyPriorStages(db)
  await db.exec(read('supabase/migrations/20261111110000_cierre_economico_bandeja.sql'))
  await db.exec(read('supabase/migrations/20261111120000_cierre_economico_parcial.sql'))
  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id,service_cost) VALUES
    ('${id(40)}','${id(20)}','A-1',primary_site_id(),450),('${id(41)}','${id(20)}','A-2',primary_site_id(),1408),('${id(42)}','${id(20)}','A-3',primary_site_id(),400),
    ('${id(43)}','${id(20)}','A-4',primary_site_id(),300),('${id(44)}','${id(20)}','A-5',primary_site_id(),200);`)
  const route = async (n, plate, req, freight, extra = '') => {
   await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure${extra ? ',carrier_id' : ''}) VALUES($1,$2,'ENTREGADO',primary_site_id(),$3,$4,'2026-10-30T12:00:00Z'${extra ? `,'${extra}'` : ''})`,[id(n),plate,id(20),freight])
   await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(n),req])
   return id(n)
  }
  // Ruta cerrada antes de la migración (carga inicial): flota propia con flete 200
  const old = await route(70, 'OLD-1', id(44), 200)
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[old])
  const consumed = () => scalar(`SELECT consumed_pen::float AS value FROM contract_budgets WHERE contract_id=$1`,[id(20)])

  const migration = read('supabase/migrations/20261113090000_cierre_economico_automatico.sql')
  assert.doesNotMatch(migration, /UPDATE public\.dispatches|UPDATE public\.dispatch_request_freight /i, 'never updates dispatches nor dispatch_request_freight')
  await db.exec(migration); await db.exec(migration)
  const status = r => scalar(`SELECT status AS value FROM economic_closures WHERE dispatch_id=$1`,[r])
  const freight = r => db.query(`SELECT final_pen::float AS final,final_applied_pen::float AS applied,econ_status,final_reason FROM dispatch_freight_stages WHERE dispatch_id=$1`,[r]).then(x => x.rows[0])
  assert.equal(await status(old),'CERRADO','backfill: closed own-fleet route with only freight is closed')

  // C · flota propia con flete y grúa: el flete se confirma solo; la grúa sigue pendiente → cierre parcial
  const own = await route(71, 'OWN-1', id(40), 450)
  await db.query(`INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,planned_pen,status,origin) VALUES($1,$2,$3,$4,'GRUA',300,'PLANIFICADO','SOLICITUD')`,[id(80),id(40),own,id(20)])
  const before = await consumed()
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[own])
  const f = await freight(own)
  assert.deepEqual([f.final,f.applied,f.econ_status],[450,450,'APROBADO'],'own freight confirmed with the current freight and approved')
  assert.match(f.final_reason,/automáticamente/)
  assert.equal(await consumed(),before,'no budget movement: the current freight was already consumed')
  assert.equal(await status(own),'CIERRE_PARCIAL','freight approved, crane still pending')
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM economic_closure_events WHERE dispatch_id=$1 AND action='AUTOMATICO'`,[own]),1)
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM service_cost_events WHERE dispatch_id=$1 AND stage='FINAL' AND (detail->>'automatico')::boolean`,[own]),1)

  // B · ruta sin costos (flete 0, sin servicios) → No aplica
  const free = await route(72, 'FREE-1', id(41), 0)
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[free])
  assert.equal(await status(free),'NO_APLICA')
  assert.equal((await rpc('economic_route_state($1)',[free])).status,'NO_APLICA')

  // Tercerizado: queda pendiente para el cierre manual
  const third = await route(73, 'TER-1', id(42), 400, id(90))
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[third])
  assert.equal((await freight(third))?.final ?? null,null,'third-party freight is not auto-confirmed')
  assert.equal(await status(third),'PENDIENTE')

  // Solo flete propio → cerrado; se puede reabrir el ítem para ajustar una excepción
  const only = await route(74, 'OWN-2', id(43), 300)
  await db.query(`UPDATE dispatches SET status='CERRADO' WHERE id=$1`,[only])
  assert.equal(await status(only),'CERRADO')
  const reopened = await rpc('economic_item_action($1,$2,$3,$4)',[only,`F:${only}`,'REABRIR','Peaje no considerado en el flete propio'])
  assert.equal(reopened.success,true,reopened.error)
  assert.notEqual(await status(only),'CERRADO','reopening the own freight item reopens the route')

  // Reaplicar la función no duplica eventos ni cambia cierres trabajados
  await db.query(`SELECT economic_auto_close($1)`,[own])
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM economic_closure_events WHERE dispatch_id=$1 AND action='AUTOMATICO'`,[own]),1)

  await assert.rejects(db.exec(read('supabase/tests/caja_c182_cierre_economico_automatico.test.sql')),/CAJA C182 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cierre económico automático: flete propio confirmado y aprobado sin mover la partida, rutas sin costo «No aplica», tercerizado pendiente, carga inicial y reapertura')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
