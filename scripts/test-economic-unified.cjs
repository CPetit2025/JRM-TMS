// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico como único lugar del costo final: con costo final validado, Torre ya no anula ni registra otro costo
// real manual (Caja y la aplicación del propio cierre sí); los indicadores cuentan con los mismos estados que la bandeja.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyPriorStages, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyPriorStages(db)
  for (const m of ['20261111110000_cierre_economico_bandeja.sql','20261111120000_cierre_economico_parcial.sql','20261113090000_cierre_economico_automatico.sql',
   '20261116090000_flete_propio_cero_automatico.sql','20261117090000_cierre_economico_simplificado.sql']) await db.exec(read('supabase/migrations/'+m))
  const migration = read('supabase/migrations/20261122110000_cierre_economico_unificado.sql')
  assert.doesNotMatch(migration, /^\s*(UPDATE|INSERT|DELETE) /im, 'no data changes')
  assert.doesNotMatch(migration, /FUNCTION public\.(register_unloading_actual|void_unloading_cost)\(/, 'patched production functions are not rewritten')
  await db.exec(migration); await db.exec(migration)

  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES('${id(40)}','${id(20)}','U-1',primary_site_id()),('${id(41)}','${id(20)}','U-2',primary_site_id()),
    ('${id(42)}','${id(20)}','U-3',primary_site_id())`)
  const route = async (n, req, status) => {
   await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure,carrier_id) VALUES($1,$2,'ENTREGADO',primary_site_id(),$3,400,'2026-10-30T12:00:00Z',$4)`,[id(n),`U-${n}`,id(20),id(90)])
   await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(n),req])
   if (status !== 'ENTREGADO') await db.query(`UPDATE dispatches SET status=$2 WHERE id=$1`,[id(n),status])
   return id(n)
  }
  const a = await route(70, id(40), 'RETORNO_COMPLETADO')
  await db.query(`INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,planned_pen,status,origin) VALUES
    ($1,$2,$3,$4,'GRUA',300,'PLANIFICADO','SOLICITUD'),($5,$2,$3,$4,'ESTIBA',100,'PLANIFICADO','SOLICITUD')`,[id(80),id(40),a,id(20),id(81)])

  // Sin costo final: Torre todavía puede anular o registrar el costo real
  await db.query(`UPDATE transport_unloading_costs SET status='ANULADO', void_reason='No se ejecutó' WHERE id=$1`,[id(81)])
  // Con costo final validado en el cierre: ni anular ni costo real manual
  assert.equal((await rpc(`validate_service_final($1,'{"final_pen":310,"reason":"Grúa con media hora extra"}'::jsonb)`,[id(80)])).success, true)
  await assert.rejects(db.query(`UPDATE transport_unloading_costs SET status='ANULADO' WHERE id=$1`,[id(80)]), /costo final en el Cierre económico/)
  await assert.rejects(db.query(`UPDATE transport_unloading_costs SET actual_pen=320 WHERE id=$1`,[id(80)]), /se registra en el Cierre económico/)
  // Caja (gasto con expense_id) sigue funcionando
  await db.query(`UPDATE transport_unloading_costs SET actual_pen=305, expense_id=$2 WHERE id=$1`,[id(80),id(85)])
  // El propio cierre aplica el costo final a la partida
  const r = await rpc('economic_confirm($1,$2)',[a,true])
  assert.equal(r.success, true, r.error)
  assert.equal(Number((await db.query(`SELECT actual_pen FROM transport_unloading_costs WHERE id=$1`,[id(80)])).rows[0].actual_pen), 310, 'economic closure applies the final cost')

  // Estado de la bandeja e indicadores con los mismos estados (Por cerrar, Por aprobar, Cerrada, No aplica) y alcance
  const b = await route(71, id(41), 'CIERRE_OPERATIVO'), c = await route(72, id(42), 'ENTREGADO')
  assert.equal(await rpc('economic_queue_key($1)',[a]), 'CERRADO')
  assert.equal(await rpc('economic_queue_key($1)',[b]), 'POR_CERRAR', 'released, not yet closed in Torre: counted as to close')
  assert.equal(await rpc('economic_queue_key($1)',[c]), 'POR_CERRAR')
  const p = (await rpc(`service_cost_indicators('2026-10-01','2026-10-31')`)).pending
  assert.deepEqual([p.cerradas, p.por_cerrar, p.por_aprobar, p.routes_unreleased], [1, 2, 0, 1])
  assert.equal('economic_pending' in p, false, 'old vocabulary removed')
  await assert.rejects(db.exec(read('supabase/tests/caja_c195_cierre_economico_unificado.test.sql')), /CAJA C195 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cierre económico unificado: costo final solo en el cierre (Torre no anula ni registra real tras validar), Caja y la aplicación del cierre siguen, indicadores con los estados de la bandeja')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
