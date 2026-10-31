// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Flete pactado obligatorio con tercero: una ruta con transportista tercero no se programa sin flete, tenga o no OT.
// Flota propia conserva su regla (servicio sin OT o recojo propio sin flete); recojo por el cliente no lleva flete JRM.
const assert = require('node:assert/strict')
const { setupEconomicClosure, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id,request_type,attention_mode) VALUES
    ('${id(40)}','${id(20)}','E-1',primary_site_id(),'DESPACHO','TRANSPORTE_JRM'),('${id(43)}','${id(20)}','C-1',primary_site_id(),'DESPACHO','RECOJO_CLIENTE'),
    ('${id(44)}',NULL,'S-OC',primary_site_id(),'RECOJO','TRANSPORTE_JRM'),('${id(45)}',NULL,'S-OS',primary_site_id(),'DESPACHO','TRANSPORTE_JRM');`)
  await db.exec(read('supabase/migrations/20261114090000_flete_obligatorio_ot.sql'))
  const migration = read('supabase/migrations/20261118090000_flete_tercero_obligatorio.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatches|dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  await db.exec(migration); await db.exec(migration)
  let n = 100
  const program = (req, freight, carrier = null) => {
   const d = id(n++)
   return db.exec(`BEGIN;
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost${carrier ? ',carrier_id' : ''}) VALUES('${d}','P-${n}','PROGRAMADO',primary_site_id(),${freight}${carrier ? `,'${carrier}'` : ''});
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${d}','${req}');
    COMMIT;`).then(() => d)
  }
  const third = /flete pactado con el proveedor/

  await assert.rejects(program(id(44), 0, id(90)), third, 'third-party pickup without OT needs agreed freight')
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(program(id(45), 0, id(90)), third, 'third-party delivery without OT needs agreed freight')
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(program(id(40), 0, id(90)), third, 'third-party OT delivery needs agreed freight')
  await db.exec('ROLLBACK').catch(() => {})
  const ok = await program(id(45), 396, id(90))
  assert.ok(ok, 'third party with agreed freight is programmed')
  await assert.rejects(db.exec(`UPDATE dispatches SET freight_cost=0 WHERE id='${ok}'`), third, 'cannot drop agreed freight to 0')
  assert.ok(await program(id(43), 0, id(90)), 'customer pickup has no JRM freight')
  assert.ok(await program(id(44), 0), 'own-fleet pickup without OT keeps the no-valuation rule')
  assert.ok(await program(id(45), 0), 'own fleet without OT is not affected')
  await assert.rejects(program(id(40), 0), /no puede programarse sin costo/, 'own fleet OT delivery still needs freight')
  await db.exec('ROLLBACK').catch(() => {})

  await assert.rejects(db.exec(read('supabase/tests/caja_c187_flete_tercero_obligatorio.test.sql')), /CAJA C187 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(db.exec(read('supabase/tests/caja_c183_flete_obligatorio_ot.test.sql')), /CAJA C183 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS flete tercero obligatorio: tercero sin flete rechazado con o sin OT, flota propia y recojo del cliente sin cambios')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
