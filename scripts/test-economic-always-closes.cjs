// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico que siempre puede cerrarse (Operaciones, fase 1): un gasto de Caja o un servicio que aparece después
// del cierre devuelve la ruta a la bandeja (No aplica / Cerrada → Por cerrar / Cierre parcial) sin tocar lo aprobado ni la
// partida; las rutas trabadas antes de la migración se corrigen; «Agregar servicio» no duplica montacarga, grúa o estiba.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyPriorStages, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyPriorStages(db)
  for (const m of ['20261111110000_cierre_economico_bandeja.sql','20261111120000_cierre_economico_parcial.sql','20261113090000_cierre_economico_automatico.sql',
   '20261116090000_flete_propio_cero_automatico.sql','20261117090000_cierre_economico_simplificado.sql','20261122110000_cierre_economico_unificado.sql'])
   await db.exec(read('supabase/migrations/'+m))

  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA');
   INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES('${id(40)}','${id(20)}','K-1',primary_site_id()),
    ('${id(41)}','${id(20)}','K-2',primary_site_id()),('${id(42)}','${id(20)}','K-3',primary_site_id())`)
  // Ruta de un tercero entregada; al liberar la unidad corre el cierre automático
  const route = async (n, req, freight) => {
   await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure,carrier_id) VALUES($1,$2,'ENTREGADO',primary_site_id(),$3,$4,'2026-10-30T12:00:00Z',$5)`,
    [id(n),`K-${n}`,id(20),freight,id(90)])
   await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(n),req])
   return id(n)
  }
  const release = r => db.query(`UPDATE dispatches SET status='RETORNO_COMPLETADO' WHERE id=$1`,[r])
  const cajaLine = (n, r, req, concept, amount) => db.query(`INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,description,status,actual_pen,expense_id,origin)
    VALUES($1,$2,$3,$4,$5,'No planificado · gasto de Caja','CONSUMIDO',$6,$7,'CAJA')`,[id(n),req,r,id(20),concept,amount,id(n + 500)])
  const closure = r => scalar(`SELECT status AS value FROM economic_closures WHERE dispatch_id=$1`,[r])
  const queueKey = r => rpc('economic_queue_key($1)',[r])
  const budget = () => db.query(`SELECT reserved_pen::float AS r, consumed_pen::float AS c FROM contract_budgets WHERE contract_id=$1`,[id(20)]).then(x => x.rows[0])

  // --- Antes de la migración: dos rutas trabadas, como en producción ---
  const stuckNa = await route(760, id(40), 0)
  await release(stuckNa)
  assert.equal(await closure(stuckNa), 'NO_APLICA', 'route without costs')
  await cajaLine(761, stuckNa, id(40), 'ESTIBA', 150)
  assert.equal(await queueKey(stuckNa), 'NO_APLICA', 'BUG before: the Caja expense stays hidden as «No aplica»')

  const stuckClosed = await route(762, id(41), 400)
  await release(stuckClosed)
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')
  await cajaLine(763, stuckClosed, id(41), 'GRUA', 90)
  assert.equal(await queueKey(stuckClosed), 'POR_CERRAR')
  assert.deepEqual((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).approved, [], 'BUG before: «Conforme» does nothing on a closed route')
  assert.match((await rpc(`validate_service_final($1,'{"final_pen":90}'::jsonb)`,[id(763)])).error, /cerrado/)

  // --- Migración (reaplicable): corrige las rutas trabadas sin mover la partida ---
  const migration = read('supabase/migrations/20261123090000_cierre_economico_siempre_cierra.sql')
  assert.doesNotMatch(migration, /FUNCTION public\.(validate_service_final|register_unloading_actual|void_unloading_cost|caja_unloading_expense_sync)\(/,
   'functions owned elsewhere or patched in production are not rewritten')
  const b0 = await budget()
  await db.exec(migration); await db.exec(migration)
  assert.deepEqual(await budget(), b0, 'no budget movement')
  assert.deepEqual([await closure(stuckNa), await queueKey(stuckNa)], ['PENDIENTE','POR_CERRAR'])
  assert.deepEqual([await closure(stuckClosed), await queueKey(stuckClosed)], ['CIERRE_PARCIAL','POR_CERRAR'])
  const ev = await db.query(`SELECT action, reason FROM economic_closure_events WHERE dispatch_id=$1 AND action='AUTOMATICO' ORDER BY created_at DESC LIMIT 1`,[stuckClosed])
  assert.match(ev.rows[0].reason, /Costo nuevo después del cierre: Grúa · K-2/)
  // Ahora sí se cierran
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckNa,true])).status, 'CERRADO')
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')
  const fl = await db.query(`SELECT econ_status, final_applied_pen::float AS a FROM dispatch_freight_stages WHERE dispatch_id=$1`,[stuckClosed])
  assert.deepEqual([fl.rows[0].econ_status, fl.rows[0].a], ['APROBADO', 400], 'approved freight untouched')

  // --- Después de la migración: un gasto de Caja sobre una ruta cerrada la reabre sola (al confirmar la transacción) ---
  await cajaLine(764, stuckClosed, id(41), 'OTROS', 35)
  assert.deepEqual([await closure(stuckClosed), await queueKey(stuckClosed)], ['CIERRE_PARCIAL','POR_CERRAR'])
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')
  // Dentro de una transacción la reapertura espera al final (no interfiere con las acciones del cierre)
  await db.exec('BEGIN')
  await cajaLine(765, stuckClosed, id(41), 'OTROS', 10)
  assert.equal(await closure(stuckClosed), 'CERRADO', 'deferred until commit')
  await db.exec('COMMIT')
  assert.equal(await closure(stuckClosed), 'CIERRE_PARCIAL')
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')
  // Reabrir a mano no genera además un evento automático
  const before = Number(await scalar(`SELECT count(*) AS value FROM economic_closure_events WHERE dispatch_id=$1 AND action='AUTOMATICO'`,[stuckClosed]))
  assert.equal((await rpc('economic_closure_action($1,$2,$3)',[stuckClosed,'REABRIR','Revisión de factura'])).success, true)
  assert.equal(Number(await scalar(`SELECT count(*) AS value FROM economic_closure_events WHERE dispatch_id=$1 AND action='AUTOMATICO'`,[stuckClosed])), before)
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')
  // Una ruta sin liberar no se toca
  const open = await route(766, id(42), 0)
  await cajaLine(767, open, id(42), 'ESTIBA', 50)
  assert.equal(await closure(open), undefined)

  // --- Agregar servicio: sin duplicar montacarga, grúa o estiba; permitido sobre una ruta cerrada ---
  const add = (r, req, concept) => rpc('economic_add_service($1,$2::jsonb)',[r,JSON.stringify({transport_request_id:req,concept,final_pen:80,reason:'Ejecutado sin programar'})])
  assert.match((await add(stuckClosed, id(41), 'GRUA')).error, /ya tiene grúa en esta ruta: corrija su costo final/)
  let r = await add(stuckClosed, id(41), 'MONTACARGAS')
  assert.equal(r.success, true, r.error)
  assert.equal(r.status, 'CIERRE_PARCIAL', 'closed route goes back to partial')
  assert.match((await add(stuckClosed, id(41), 'MONTACARGAS')).error, /ya tiene montacargas/)
  assert.equal((await add(stuckClosed, id(41), 'OTROS')).success, true, 'OTROS may repeat')
  assert.equal((await rpc('economic_confirm($1,$2)',[stuckClosed,true])).status, 'CERRADO')

  // Umbral de días expuesto a la bandeja
  assert.equal((await rpc('economic_settings_get()')).max_pending_days, 7)

  await assert.rejects(db.exec(read('supabase/tests/caja_c196_cierre_economico_siempre_cierra.test.sql')), /CAJA C196 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(db.exec(read('supabase/tests/caja_c195_cierre_economico_unificado.test.sql')), /CAJA C195 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cierre económico siempre cierra: gasto de Caja después del cierre vuelve a la bandeja (No aplica y Cerrada), rutas trabadas corregidas sin mover la partida, reapertura diferida y sin duplicar servicios')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
