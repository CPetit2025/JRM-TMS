// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico: en una ruta de flota propia con reparto por servicio (entrega de OT con flete + recojos en S/ 0), los
// servicios en S/ 0 quedan aprobados automáticamente (no se valorizan) aunque la ruta siga sin cerrar en Torre; el flete
// con costo sigue por validar y, al registrar el flete final, queda validado. En un tercero el S/ 0 sí pide confirmación.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyPriorStages, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyPriorStages(db)
  await db.exec(read('supabase/migrations/20261111110000_cierre_economico_bandeja.sql'))
  await db.exec(read('supabase/migrations/20261111120000_cierre_economico_parcial.sql'))
  await db.exec(read('supabase/migrations/20261113090000_cierre_economico_automatico.sql'))
  const migration = read('supabase/migrations/20261116090000_flete_propio_cero_automatico.sql')
  assert.doesNotMatch(migration, /^\s*(UPDATE|INSERT|DELETE)\b/im, 'only rewrites the read function')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)

  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id,request_type) VALUES
    ('${id(40)}','${id(20)}','RT-002147',primary_site_id(),'DESPACHO'),('${id(41)}',NULL,'RT-002148',primary_site_id(),'RECOJO'),
    ('${id(42)}',NULL,'RT-002299',primary_site_id(),'RECOJO'),('${id(43)}','${id(20)}','RT-003000',primary_site_id(),'DESPACHO'),
    ('${id(44)}',NULL,'RT-003001',primary_site_id(),'RECOJO');
   INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure) VALUES
    ('${id(70)}','BDJ943','CIERRE_OPERATIVO',primary_site_id(),'${id(20)}',1240,'2026-10-30T12:00:00Z');
   INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure,carrier_id) VALUES
    ('${id(71)}','TER-1','CIERRE_OPERATIVO',primary_site_id(),'${id(20)}',800,'2026-10-30T12:00:00Z','${id(90)}');
   INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES('${id(70)}','${id(40)}'),('${id(70)}','${id(41)}'),('${id(70)}','${id(42)}'),
    ('${id(71)}','${id(43)}'),('${id(71)}','${id(44)}');
   INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,status) VALUES
    ('${id(70)}','${id(40)}','${id(20)}',1240,'CONSUMIDO'),('${id(70)}','${id(41)}',NULL,0,'CONSUMIDO'),('${id(70)}','${id(42)}',NULL,0,'CONSUMIDO'),
    ('${id(71)}','${id(43)}','${id(20)}',800,'CONSUMIDO'),('${id(71)}','${id(44)}',NULL,0,'CONSUMIDO');`)
  const items = async r => Object.fromEntries((await rpc('economic_route_items($1)',[r])).map(i => [i.request_number, i]))

  // Flota propia: los recojos en S/ 0 quedan aprobados solos, la entrega con flete sigue por validar
  let own = await items(id(70))
  assert.deepEqual([own['RT-002148'].status, own['RT-002148'].final_pen, own['RT-002148'].auto], ['APROBADO', 0, true])
  assert.equal(own['RT-002299'].status, 'APROBADO')
  assert.equal(own['RT-002147'].status, 'POR_VALIDAR')
  assert.equal(own['RT-002147'].auto, undefined)

  // Registrar el flete final conforme a lo programado: la entrega queda validada y los recojos siguen automáticos
  const saved = await rpc('register_dispatch_freight_final($1,$2)',[id(70), JSON.stringify({ executed_as_planned: true, extras_pen: 0 })])
  assert.equal(saved.success, true, saved.error)
  own = await items(id(70))
  assert.deepEqual([own['RT-002147'].status, own['RT-002147'].final_pen], ['VALIDADO', 1240])
  assert.deepEqual([own['RT-002148'].status, own['RT-002299'].status], ['APROBADO', 'APROBADO'])

  // Tercero: el S/ 0 no se aprueba solo
  const third = await items(id(71))
  assert.equal(third['RT-003001'].status, 'POR_VALIDAR')
  assert.equal(third['RT-003001'].auto, undefined)
  console.log('PASS flete propio en S/ 0 aprobado automáticamente (ruta sin cerrar en Torre); flete con costo por validar; tercero en S/ 0 pide confirmación')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
