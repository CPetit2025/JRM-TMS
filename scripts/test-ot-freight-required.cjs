// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Flete obligatorio: un servicio de transporte de una OT no se programa sin costo (flota propia o tercero). Excepciones:
// recojo por el cliente y recojo con flota propia (no se valoriza); servicios sin OT. Validación diferida al final de la transacción.
const assert = require('node:assert/strict')
const { setupEconomicClosure, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id,request_type,attention_mode) VALUES
    ('${id(40)}','${id(20)}','E-1',primary_site_id(),'DESPACHO','TRANSPORTE_JRM'),('${id(41)}','${id(21)}','E-2',primary_site_id(),'DESPACHO','TRANSPORTE_JRM'),
    ('${id(42)}','${id(20)}','R-1',primary_site_id(),'RECOJO','TRANSPORTE_JRM'),('${id(43)}','${id(20)}','C-1',primary_site_id(),'DESPACHO','RECOJO_CLIENTE'),
    ('${id(44)}',NULL,'S-OC',primary_site_id(),'RECOJO','TRANSPORTE_JRM');`)
  const migration = read('supabase/migrations/20261114090000_flete_obligatorio_ot.sql')
  await db.exec(migration); await db.exec(migration)
  let n = 100
  const program = (req, freight, { carrier = null, status = 'PROGRAMADO' } = {}) => {
   const d = id(n++)
   return db.exec(`BEGIN;
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost${carrier ? ',carrier_id' : ''}) VALUES('${d}','P-${n}','${status}',primary_site_id(),${freight}${carrier ? `,'${carrier}'` : ''});
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${d}','${req}');
    COMMIT;`).then(() => d)
  }
  const blocked = /no puede programarse sin costo/

  await assert.rejects(program(id(40), 0), blocked, 'own fleet OT delivery without freight is rejected')
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(program(id(40), 0, { carrier: id(90) }), blocked, 'third-party OT delivery without freight is rejected')
  await db.exec('ROLLBACK').catch(() => {})
  const ok = await program(id(40), 500)
  assert.ok(ok, 'OT delivery with freight is programmed')
  assert.ok(await program(id(42), 0), 'own-fleet pickup keeps the no-valuation rule')
  await assert.rejects(program(id(42), 0, { carrier: id(90) }), blocked, 'third-party pickup of an OT needs freight')
  await db.exec('ROLLBACK').catch(() => {})
  assert.ok(await program(id(43), 0), 'customer pickup (Nota de Salida) has no JRM freight')
  assert.ok(await program(id(44), 0), 'services without OT are not affected')

  // Bajar a 0 el flete de una ruta de OT programada se rechaza; una ruta ya cerrada no se revalida
  await assert.rejects(db.exec(`UPDATE dispatches SET freight_cost=0 WHERE id='${ok}'`), blocked)
  await db.exec(`UPDATE dispatches SET status='LIQUIDADO' WHERE id='${ok}'`)
  await db.exec(`UPDATE dispatches SET freight_cost=0 WHERE id='${ok}'`)

  // Flete repartido por OT: ninguna OT con 0
  const mixed = id(200)
  await assert.rejects(db.exec(`BEGIN;
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost) VALUES('${mixed}','MIX-1','PROGRAMADO',primary_site_id(),500);
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${mixed}','${id(40)}'),('${mixed}','${id(41)}');
    INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen) VALUES('${mixed}','${id(40)}','${id(20)}',500),('${mixed}','${id(41)}','${id(21)}',0);
    COMMIT;`), /Cada servicio de OT debe llevar su flete: E-2/)
  await db.exec('ROLLBACK').catch(() => {})
  await db.exec(`BEGIN;
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost) VALUES('${mixed}','MIX-1','PROGRAMADO',primary_site_id(),500);
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${mixed}','${id(40)}'),('${mixed}','${id(41)}');
    INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen) VALUES('${mixed}','${id(40)}','${id(20)}',300),('${mixed}','${id(41)}','${id(21)}',200);
    COMMIT;`)

  await assert.rejects(db.exec(read('supabase/tests/caja_c183_flete_obligatorio_ot.test.sql')),/CAJA C183 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS flete obligatorio: servicio de OT sin costo rechazado (propio o tercero), excepciones de recojo propio, recojo del cliente y sin OT, rutas repartidas por OT')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
