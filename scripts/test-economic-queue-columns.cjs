// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Bandeja del cierre económico: por ruta trae cliente, unidad (propia o tercero con su transportista), servicios, orden de
// referencia y desde cuándo está lista para el cierre; sigue incluyendo las rutas sin cerrar en Torre.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyPriorStages, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);
    CREATE TABLE clients(id uuid PRIMARY KEY, business_name text);
    ALTER TABLE transport_requests ADD COLUMN client_id uuid REFERENCES clients(id), ADD COLUMN reference_type text, ADD COLUMN reference_number text;
    ALTER TABLE dispatches ADD COLUMN operational_closed_at timestamptz, ADD COLUMN returned_at timestamptz;`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyPriorStages(db)
  await db.exec(read('supabase/migrations/20261111110000_cierre_economico_bandeja.sql'))
  await db.exec(read('supabase/migrations/20261111120000_cierre_economico_parcial.sql'))
  await db.exec(read('supabase/migrations/20261113090000_cierre_economico_automatico.sql'))
  const migration = read('supabase/migrations/20261115090000_bandeja_economica_columnas.sql')
  assert.doesNotMatch(migration, /^\s*(UPDATE|INSERT|DELETE)\b/im, 'only rewrites the read function')
  await db.exec(migration); await db.exec(migration)

  await db.exec(`INSERT INTO clients VALUES('${id(30)}','Metalpren S.A.'),('${id(31)}','Aceros Lima SAC');
    INSERT INTO carriers(id,business_name,ruc) VALUES('${id(90)}','Transportes Sur SAC','20123456789');
    INSERT INTO transport_requests(id,contract_id,request_number,site_id,client_id,request_type,attention_mode,reference_type,reference_number) VALUES
     ('${id(40)}','${id(20)}','RT-002314',primary_site_id(),'${id(30)}','RECOJO','TRANSPORTE_JRM','OC','57724'),
     ('${id(41)}','${id(20)}','RT-002315',primary_site_id(),'${id(31)}','DESPACHO','TRANSPORTE_JRM',NULL,NULL),
     ('${id(42)}','${id(20)}','RT-002316',primary_site_id(),'${id(31)}','DESPACHO','RECOJO_CLIENTE','OS','88');
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure,returned_at) VALUES
     ('${id(70)}','BDK791','RETORNO_COMPLETADO',primary_site_id(),'${id(20)}',0,'2026-10-30T12:00:00Z','2026-10-30T20:00:00Z');
    INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure,carrier_id,operational_closed_at) VALUES
     ('${id(71)}','TER-100','CIERRE_OPERATIVO',primary_site_id(),'${id(20)}',600,'2026-10-20T12:00:00Z','${id(90)}','2026-10-22T15:00:00Z');
    INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${id(70)}','${id(40)}'),('${id(71)}','${id(41)}'),('${id(71)}','${id(42)}');`)

  const q = await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)
  assert.equal(q.success, true, q.error)
  const own = q.routes.find(r => r.dispatch_id === id(70)), third = q.routes.find(r => r.dispatch_id === id(71))
  assert.ok(own && third, 'open routes (liberated, operational close) stay in the queue')
  assert.equal(own.clients, 'Metalpren S.A.')
  assert.equal(own.references, 'OC 57724')
  assert.equal(own.requests, 'RT-002314')
  assert.equal(own.modalidad, 'PROPIA')
  assert.equal(own.carrier, null)
  assert.deepEqual(own.services, [{ request_type: 'RECOJO', attention_mode: 'TRANSPORTE_JRM' }])
  assert.equal(new Date(own.ready_at).toISOString(), '2026-10-30T20:00:00.000Z', 'ready since the unit returned')
  assert.equal(third.modalidad, 'TERCERO')
  assert.equal(third.carrier, 'Transportes Sur SAC')
  assert.equal(third.clients, 'Aceros Lima SAC', 'clients without duplicates')
  assert.equal(third.references, 'OS 88')
  assert.equal(third.services.length, 2)
  assert.equal(new Date(third.ready_at).toISOString(), '2026-10-22T15:00:00.000Z', 'ready since the operational close')
  assert.ok(own.state && Array.isArray(own.items) && own.doc_status && own.last, 'keeps the previous fields')
  console.log('PASS bandeja del cierre económico: cliente, unidad propia/tercero, servicios, orden de referencia y días desde que la ruta está lista')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
