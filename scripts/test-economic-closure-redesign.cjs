// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Rediseño del cierre económico (A + B): bandeja con ítems por ruta (servicios y flete), estado documentario, responsable
// y última actualización; referencial original del flete; umbral de desviación; notas internas sin cambio de estado;
// servicio agregado en el cierre (origen CIERRE, acordado 0, sin reserva hasta aprobar) e historial unificado.
const assert = require('node:assert/strict')
const { setupEconomicClosure, applyReferentialStage, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  await applyReferentialStage(db)
  const migration = read('supabase/migrations/20261111110000_cierre_economico_bandeja.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full')
  await db.exec(migration)
  await db.exec(migration) // reaplicable

  // --- Ruta de una OT: grúa acordada por hora, estiba agregada en programación, flete 500 ---
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),('${id(12)}','Estiba prueba','20222222222','ESTIBA');
`)
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([{concept:'GRUA',estimated_pen:0}])])
  await rpc('apply_request_tariff($1)',[id(30)])
  const grua = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='GRUA'`,[id(30)])
  const route = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'RB-1',
   p_departure:'2026-10-30T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(30)}],forklift:null,
   special_services:{items:[{id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:100,agreed_qty:2,min_billable_qty:3,fraction_minutes:30},
    {transport_request_id:id(30),concept:'ESTIBA',supplier_id:id(12),billing_unit:'JORNADA',agreed_rate:90,agreed_qty:1,workers:4,reason:'Cuadrilla por volumen'}]} })])
  const estiba = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND concept='ESTIBA'`,[route])
  await db.query(`UPDATE dispatches SET freight_cost=500 WHERE id=$1`,[route])
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[route])
  const validate = (line, p) => rpc('validate_service_final($1,$2::jsonb)',[line,JSON.stringify(p)])
  const action = (a, reason=null) => rpc('economic_closure_action($1,$2,$3)',[route,a,reason])
  const queueRow = async () => (await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)).routes.find(x => x.dispatch_id === route)
  const budget = () => db.query(`SELECT reserved_pen::float AS reserved,consumed_pen::float AS consumed FROM contract_budgets WHERE contract_id=$1`,[id(20)]).then(r => r.rows[0])

  // Bandeja: un ítem por servicio y el flete, todos por validar; documentación sin registro = pendiente
  let q = await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)
  assert.equal(q.success,true,q.error)
  assert.deepEqual(q.settings,{deviation_pct:10,deviation_pen:100},'threshold exposed read-only')
  let row = q.routes.find(x => x.dispatch_id === route)
  assert.deepEqual(row.items.map(i => [i.kind,i.concept,i.status]),[['FLETE','FLETE','POR_VALIDAR'],['SERVICIO','ESTIBA','POR_VALIDAR'],['SERVICIO','GRUA','POR_VALIDAR']])
  const freight = row.items[0]
  assert.deepEqual([Number(freight.referential_pen),Number(freight.agreed_pen),freight.supplier],[300,500,'JRM (flota propia)'],'referential from the request tariff')
  assert.equal(row.items.find(i => i.concept === 'GRUA').supplier,'Grúas prueba')
  assert.equal(row.doc_status,'PENDIENTE')

  // Referencial original del flete (Etapa E): request_referential_freight prevalece sobre service_cost
  await db.exec(`UPDATE transport_requests SET service_cost=400 WHERE id='${id(30)}'; UPDATE transport_requests SET approved_at=now() WHERE id='${id(30)}';
   UPDATE transport_requests SET service_cost=520 WHERE id='${id(30)}';`)
  row = await queueRow()
  assert.equal(Number(row.items[0].referential_pen),400,'original referential freight before a pickup authorization')
  assert.equal(Number(row.state.referential_pen),400 + 80,'route state uses the original referential too (freight 400 + grúa 80)')

  // Estado documentario: observado si algún servicio lo está; completo cuando todos lo están
  await db.query(`INSERT INTO documentary_closures VALUES($1,$2,'OBSERVADO')`,[route,id(30)])
  assert.equal((await queueRow()).doc_status,'OBSERVADO')
  await db.query(`UPDATE documentary_closures SET status='COMPLETO' WHERE dispatch_id=$1`,[route])
  assert.equal((await queueRow()).doc_status,'COMPLETO')

  // Validación: responsable y última actualización
  assert.equal((await validate(grua,{executed_qty:3.2,reason:'La descarga tomó más tiempo'})).success,true)
  row = await queueRow()
  const g = row.items.find(i => i.concept === 'GRUA')
  assert.deepEqual([g.status,Number(g.final_pen),g.validated_by],['VALIDADO',350,'Prueba Admin'])
  assert.equal(row.last.by,'Prueba Admin'); assert.ok(row.last.at)

  // Nota interna: no cambia el estado, va a notas (no a las acciones) y al historial
  assert.equal((await rpc('economic_closure_note($1,$2)',[route,'x'])).success,false,'note needs text')
  assert.equal((await rpc('economic_closure_note($1,$2)',[route,'Esperando factura del proveedor de grúa'])).success,true)
  let detail = await rpc('economic_closure_detail($1)',[route])
  assert.equal(detail.state.status,'PENDIENTE','a note does not change status')
  assert.deepEqual([detail.notes.length,detail.notes[0].note,detail.events.length],[1,'Esperando factura del proveedor de grúa',0])
  assert.ok(detail.history.some(h => h.source === 'CIERRE' && h.action === 'NOTA'))
  assert.ok(detail.history.some(h => h.source === 'COSTO' && h.stage === 'FINAL' && h.concept === 'GRUA'))
  assert.deepEqual(detail.requests.map(r => [r.request_number,r.doc_status]),[['S-1','COMPLETO']])

  // Servicio agregado en el cierre: motivo obligatorio, acordado 0, sin reserva hasta aprobar
  const b0 = await budget()
  const add = p => rpc('economic_add_service($1,$2::jsonb)',[route,JSON.stringify(p)])
  assert.match((await add({transport_request_id:id(30),concept:'OTROS',final_pen:120})).error,/por qué/)
  assert.match((await add({transport_request_id:id(31),concept:'OTROS',final_pen:120,reason:'Resguardo nocturno'})).error,/solicitud de la ruta/)
  assert.match((await add({transport_request_id:id(30),concept:'OTROS',final_pen:0,reason:'Resguardo nocturno'})).error,/costo final/)
  let r = await add({transport_request_id:id(30),concept:'OTROS',description:'Resguardo',final_pen:120,reason:'Resguardo nocturno no programado'})
  assert.equal(r.success,true,r.error)
  const extra = r.id
  assert.deepEqual(await budget(),b0,'no reservation when added at closing')
  row = await queueRow()
  const o = row.items.find(i => i.id === extra)
  assert.deepEqual([o.origin,Number(o.agreed_pen),Number(o.final_pen),o.status],['CIERRE',0,120,'VALIDADO'],'full amount is deviation')
  detail = await rpc('economic_closure_detail($1)',[route])
  assert.deepEqual(detail.events.map(e => e.action),['AGREGAR'])

  // Cierre completo: la partida consume el servicio agregado solo al aprobar
  assert.equal((await validate(estiba,{executed_qty:1,workers:4})).success,true)
  await db.query(`INSERT INTO contract_services(contract_id,service_type,dispatch_id,amount_pen) VALUES($1,'FLETE',$2,500)`,[id(20),route])
  await db.query(`UPDATE contract_budgets SET consumed_pen=consumed_pen+500 WHERE contract_id=$1`,[id(20)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[route])
  assert.equal((await rpc('register_dispatch_freight_final($1,$2::jsonb)',[route,JSON.stringify({executed_as_planned:true})])).success,true)
  const b1 = await budget()
  assert.equal((await action('ENVIAR')).status,'EN_REVISION')
  assert.match((await add({transport_request_id:id(30),concept:'OTROS',final_pen:10,reason:'Otro servicio'})).error,/en revisión o cerrado/)
  assert.equal((await action('APROBAR')).status,'CERRADO')
  const b2 = await budget()
  assert.deepEqual([b2.consumed - b1.consumed, b1.reserved - b2.reserved],[350 + 360 + 120, 300 + 360],'grúa 350, estiba 360 and the closing service 120; releases only grúa and estiba')
  assert.equal(await scalar(`SELECT status AS value FROM transport_unloading_costs WHERE id=$1`,[extra]),'CONSUMIDO')

  await assert.rejects(db.exec(read('supabase/tests/caja_c176_cierre_economico_bandeja.test.sql')),/CAJA C176 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)

  // Sin permiso de escritura no se agregan servicios ni notas
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await rpc('economic_closure_note($1,$2)',[route,'Sin permiso'])).success,false)
  assert.equal((await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)).success,false)
  console.log('PASS rediseño del cierre económico (A + B): ítems por ruta, referencial original del flete, estado documentario, responsable, umbral, notas internas y servicio agregado en el cierre')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
