// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico parcial por ítem (C): cada servicio y el flete se envían, aprueban (solo su diferencia en la partida),
// observan y reabren por separado; CIERRE_PARCIAL / CERRADO; bloqueo del costo final de ítems aprobados; monto de Caja
// aparte; rutas cerradas antes de la migración sin doble conteo; rutas mixtas con dos OT; reapertura de un solo ítem.
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
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),('${id(12)}','Estiba prueba','20222222222','ESTIBA');
   INSERT INTO transport_requests(id,contract_id,request_number,delivery_address,delivery_district,site_id) VALUES
    ('${id(33)}','${id(20)}','S-4','Entrega D','Callao',primary_site_id()),('${id(34)}','${id(21)}','H-2','Entrega E','Callao',primary_site_id());`)
  const budget = c => db.query(`SELECT reserved_pen::float AS reserved,consumed_pen::float AS consumed FROM contract_budgets WHERE contract_id=$1`,[c]).then(r => r.rows[0])
  const validate = (line, p) => rpc('validate_service_final($1,$2::jsonb)',[line,JSON.stringify(p)])
  const routeAction = (route, a, reason=null) => rpc('economic_closure_action($1,$2,$3)',[route,a,reason])
  const itemAction = (route, key, a, reason=null) => rpc('economic_item_action($1,$2,$3,$4)',[route,key,a,reason])
  const items = async route => (await rpc('economic_closure_detail($1)',[route])).items
  const status = route => scalar(`SELECT status AS value FROM economic_closures WHERE dispatch_id=$1`,[route])

  // Ruta de una OT con grúa (hora) y estiba (jornada, Caja); el flete consumido al cerrar la ruta en Torre.
  async function singleRoute(request, plate, grua_rate=100) {
   await rpc('save_request_unloading_costs($1,$2::jsonb)',[request,JSON.stringify([{concept:'GRUA',estimated_pen:0}])])
   await rpc('apply_request_tariff($1)',[request])
   const grua = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='GRUA'`,[request])
   const route = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',freight_reason:'Flete acordado aparte',p_driver_id:null,p_vehicle_plate:plate,
    p_departure:'2026-10-30T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:request}],forklift:null,
    special_services:{items:[{id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:grua_rate,agreed_qty:2,min_billable_qty:3,fraction_minutes:30,reason:'Tarifa del proveedor por hora'},
     {transport_request_id:request,concept:'ESTIBA',supplier_id:id(12),billing_unit:'JORNADA',agreed_rate:90,agreed_qty:1,workers:4,reason:'Cuadrilla por volumen'}]} })])
   const estiba = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND concept='ESTIBA'`,[route])
   await db.query(`UPDATE dispatches SET freight_cost=500 WHERE id=$1`,[route])
   await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[route])
   await db.query(`SELECT unloading_consume($1,380,NULL,'Estiba prueba')`,[estiba])  // Caja aprobó la estiba por 380
   const expense = id(500 + Number(plate.slice(-1)))
   await db.query(`INSERT INTO dispatch_expenses(id,dispatch_id,expense_type,amount,status) VALUES($1,$2,'ESTIBA',380,'APROBADO')`,[expense,route])
   await db.query(`UPDATE transport_unloading_costs SET expense_id=$2 WHERE id=$1`,[estiba,expense])
   await db.query(`INSERT INTO contract_services(contract_id,service_type,dispatch_id,amount_pen) VALUES($1,'FLETE',$2,500)`,[id(20),route])
   await db.query(`UPDATE contract_budgets SET consumed_pen=consumed_pen+500 WHERE contract_id=$1`,[id(20)])
   await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[route])
   return { route, grua, estiba }
  }

  // --- 1. Ruta cerrada con el flujo anterior (por ruta), antes de la migración C ---
  const old = await singleRoute(id(30), 'PC-1')
  assert.equal((await validate(old.grua,{executed_qty:3.2,reason:'La descarga tomó más tiempo'})).success,true)
  assert.equal((await validate(old.estiba,{executed_qty:1,workers:4,extras_pen:40,reason:'Movilidad de la cuadrilla'})).success,true)
  assert.equal((await rpc('register_dispatch_freight_final($1,$2::jsonb)',[old.route,JSON.stringify({executed_as_planned:true,extras_pen:50,reason:'Peaje adicional'})])).success,true)
  assert.equal((await routeAction(old.route,'ENVIAR')).status,'EN_REVISION')
  assert.equal((await routeAction(old.route,'APROBAR')).status,'CERRADO')
  const beforeC = await budget(id(20))

  // --- Migración C (reaplicable): sin movimiento de partida; la ruta cerrada queda con todos sus ítems aprobados ---
  const migration = read('supabase/migrations/20261111120000_cierre_economico_parcial.sql')
  assert.doesNotMatch(migration, /replace\(\s*(def|source)/i, 'functions are rewritten in full')
  assert.doesNotMatch(migration, /FUNCTION public\.(validate_service_final|economic_billable_qty)\(/, 'owned by another stage')
  await db.exec(migration)
  await db.exec(migration)
  assert.deepEqual(await budget(id(20)),beforeC,'migration moves no budget')
  assert.deepEqual((await items(old.route)).map(i => i.status),['APROBADO','APROBADO','APROBADO'])
  assert.equal(await status(old.route),'CERRADO')
  assert.equal(await scalar(`SELECT caja_pen::float AS value FROM transport_unloading_costs WHERE id=$1`,[old.estiba]),380,'Caja amount kept apart (actual_pen became 400)')

  // Ítem aprobado bloqueado; reabrir uno solo con motivo; al reaprobar se mueve solo su diferencia (sin doble conteo)
  assert.match((await validate(old.grua,{executed_qty:3})).error,/en revisión o cerrado|aprobado/)
  assert.match((await itemAction(old.route,`S:${old.grua}`,'REABRIR')).error,/motivo/)
  let r = await itemAction(old.route,`S:${old.grua}`,'REABRIR','Factura de la grúa por 3 h')
  assert.equal(r.status,'CIERRE_PARCIAL',r.error)
  assert.equal((await validate(old.grua,{executed_qty:3})).success,true,'reopened item can be corrected while others stay approved')
  assert.match((await validate(old.estiba,{executed_qty:1,workers:4})).error,/aprobado/,'other approved items stay locked')
  r = await itemAction(old.route,`S:${old.grua}`,'APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  let after = await budget(id(20))
  assert.deepEqual([after.consumed - beforeC.consumed, after.reserved - beforeC.reserved],[-50,0],'only the grúa difference (350 → 300)')
  assert.deepEqual(r.detail.budget_delta_by_contract,{[id(20)]:-50})
  // Reabrir la ruta completa y volver a aprobarla no vuelve a imputar nada
  assert.equal((await routeAction(old.route,'REABRIR','Revisión de auditoría')).status,'PENDIENTE')
  assert.equal((await routeAction(old.route,'ENVIAR')).status,'EN_REVISION')
  r = await routeAction(old.route,'APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  assert.deepEqual(r.detail.budget_delta_by_contract,{},'no double counting after route-level re-close')
  assert.deepEqual(await budget(id(20)),after)

  // --- 2. Cierre parcial: transporte y grúa aprobados, estiba pendiente ---
  const b = await singleRoute(id(32), 'PC-2')
  const b0 = await budget(id(20))
  const freightKey = `F:${b.route}`
  assert.equal((await validate(b.grua,{executed_qty:3.2,reason:'La descarga tomó más tiempo'})).success,true)
  assert.match((await itemAction(b.route,freightKey,'APROBAR')).error,/Valide/,'no approval without final')
  assert.equal((await rpc('register_dispatch_freight_final($1,$2::jsonb)',[b.route,JSON.stringify({executed_as_planned:false,base_pen:540,reason:'Desvío por obra'})])).success,true)
  // Programación (despacho) envía pero no aprueba
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho');
   INSERT INTO auth.users VALUES('${id(93)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();
   SELECT set_config('request.jwt.claim.sub','${id(93)}',false);`)
  assert.equal((await itemAction(b.route,freightKey,'ENVIAR')).success,true)
  assert.match((await itemAction(b.route,freightKey,'APROBAR')).error,/permiso de Cierre económico/)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)
  assert.match((await rpc('register_dispatch_freight_final($1,$2::jsonb)',[b.route,JSON.stringify({executed_as_planned:true})])).error,/revisión o aprobado/,'sent freight is locked')
  assert.equal((await itemAction(b.route,freightKey,'APROBAR')).status,'CIERRE_PARCIAL')
  assert.equal((await itemAction(b.route,`S:${b.grua}`,'APROBAR')).status,'CIERRE_PARCIAL')
  const b1 = await budget(id(20))
  assert.deepEqual([b1.consumed - b0.consumed, b0.reserved - b1.reserved],[40 + 350, 300],'freight +40, grúa consumes 350 and releases its 300')
  assert.deepEqual((await items(b.route)).map(i => [i.concept,i.status]),[['FLETE','APROBADO'],['ESTIBA','POR_VALIDAR'],['GRUA','APROBADO']])
  assert.match((await routeAction(b.route,'APROBAR')).error,/Faltan costos|estiba/,'no full close while anything is pending')
  let q = (await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)).routes.find(x => x.dispatch_id === b.route)
  assert.deepEqual([q.state.status,q.state.items_total,q.state.items_approved],['CIERRE_PARCIAL',3,2])
  // Servicio agregado en el cierre con cierre parcial y validación de lo pendiente
  r = await rpc('economic_add_service($1,$2::jsonb)',[b.route,JSON.stringify({transport_request_id:id(32),concept:'OTROS',final_pen:70,reason:'Resguardo nocturno'})])
  assert.equal(r.success,true,r.error)
  assert.equal((await validate(b.estiba,{executed_qty:1,workers:4,extras_pen:40,reason:'Movilidad de la cuadrilla'})).success,true,'pending item validated while route is partial')
  // Observar y corregir un ítem: vuelve a Validado
  assert.equal((await itemAction(b.route,`S:${b.estiba}`,'ENVIAR')).success,true)
  assert.equal((await itemAction(b.route,`S:${b.estiba}`,'OBSERVAR','Adjuntar sustento de la movilidad')).success,true)
  assert.equal((await items(b.route)).find(i => i.id === b.estiba).status,'OBSERVADO')
  assert.equal((await validate(b.estiba,{executed_qty:1,workers:4,extras_pen:30,reason:'Movilidad sustentada'})).success,true)
  assert.equal((await items(b.route)).find(i => i.id === b.estiba).status,'VALIDADO')
  // Cierre completo de lo que falta: solo se imputan la estiba (+10 sobre Caja) y el servicio agregado (70)
  assert.equal((await routeAction(b.route,'APROBAR')).status,'CERRADO')
  const b2 = await budget(id(20))
  assert.deepEqual([b2.consumed - b1.consumed, b1.reserved - b2.reserved],[10 + 70, 0])
  assert.deepEqual(await db.query(`SELECT caja_pen::float AS c, actual_pen::float AS a FROM transport_unloading_costs WHERE id=$1`,[b.estiba]).then(x => [x.rows[0].c,x.rows[0].a]),[380,390])

  // --- 3. Ruta mixta con dos OT: el flete de cada OT es un ítem ---
  await db.exec(`CREATE FUNCTION sync_mixed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    UPDATE dispatch_request_freight SET amount_pen=NEW.amount_pen WHERE service_id=NEW.id AND status<>'LIBERADO'; RETURN NEW; END$$;
   CREATE TRIGGER sync_mixed AFTER UPDATE OF amount_pen ON contract_services FOR EACH ROW EXECUTE FUNCTION sync_mixed();
   CREATE FUNCTION ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.contract_id IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'El flete y la descarga superan el importe aprobado para esta referencia'; END$$;
   CREATE TRIGGER ref_guard BEFORE UPDATE ON dispatch_request_freight FOR EACH ROW EXECUTE FUNCTION ref_guard();`)
  const mixed = id(86)
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost,scheduled_departure) VALUES($1,'PC-M','PROGRAMADO',primary_site_id(),500,'2026-10-30T12:00:00Z')`,[mixed])
  await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2),($1,$3)`,[mixed,id(33),id(34)])
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,300),($4,$5,'FLETE',$3,200)`,[id(87),id(20),mixed,id(88),id(21)])
  await db.query(`INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id,status) VALUES($1,$2,$3,300,$4,'CONSUMIDO'),($1,$5,$6,200,$7,'CONSUMIDO')`,
   [mixed,id(33),id(20),id(87),id(34),id(21),id(88)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[mixed])
  const register = alloc => rpc('register_dispatch_freight_final($1,$2::jsonb)',[mixed,JSON.stringify({executed_as_planned:false,base_pen:alloc[0]+alloc[1],reason:'Estadía en ambas obras',
   allocation:[{request_id:id(33),final_pen:alloc[0]},{request_id:id(34),final_pen:alloc[1]}]})])
  assert.equal((await register([340,220])).success,true)
  const [m20, m21] = [await budget(id(20)), await budget(id(21))]
  assert.deepEqual((await items(mixed)).map(i => [i.key,i.contract_code,i.status]),[[`F:${id(34)}`,'OT-H','VALIDADO'],[`F:${id(33)}`,'OT-A','VALIDADO']],'one freight item per OT')
  assert.equal((await itemAction(mixed,`F:${id(33)}`,'APROBAR')).status,'CIERRE_PARCIAL')
  assert.deepEqual([(await budget(id(20))).consumed - m20.consumed,(await budget(id(21))).consumed - m21.consumed],[40,0],'only OT A absorbs its difference')
  assert.match((await register([350,210])).error,/revisión o aprobado/,'approved OT freight is locked')
  assert.equal((await register([340,230])).success,true,'the other OT can still be corrected')
  assert.equal((await itemAction(mixed,`F:${id(34)}`,'APROBAR')).status,'CERRADO')
  assert.deepEqual([(await budget(id(20))).consumed - m20.consumed,(await budget(id(21))).consumed - m21.consumed],[40,30])
  assert.deepEqual((await db.query(`SELECT amount_pen::float AS a FROM dispatch_request_freight WHERE dispatch_id=$1 ORDER BY request_id`,[mixed])).rows.map(x => x.a),[340,230])
  // Reabrir solo la OT B y reaprobar sin cambios: no mueve nada
  assert.equal((await itemAction(mixed,`F:${id(34)}`,'REABRIR','Revisión de la factura')).status,'CIERRE_PARCIAL')
  r = await itemAction(mixed,`F:${id(34)}`,'APROBAR')
  assert.deepEqual([r.status,r.detail.budget_delta_by_contract],['CERRADO',{}])

  // Historial: cada acción por ítem queda con el ítem
  const ev = await db.query(`SELECT action, detail->'item'->>'label' AS label FROM economic_closure_events WHERE dispatch_id=$1 ORDER BY created_at`,[mixed])
  assert.deepEqual(ev.rows.map(x => x.action),['APROBAR','APROBAR','REABRIR','APROBAR'])
  assert.ok(ev.rows.every(x => /Transporte/.test(x.label)))

  await assert.rejects(db.exec(read('supabase/tests/caja_c177_cierre_economico_parcial.test.sql')),/CAJA C177 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(db.exec(read('supabase/tests/caja_c176_cierre_economico_bandeja.test.sql')),/CAJA C176 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await assert.rejects(db.exec(read('supabase/tests/caja_c173_cierre_economico.test.sql')),/CAJA C173 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cierre económico parcial (C): aprobación por ítem con su diferencia, CIERRE_PARCIAL/CERRADO, bloqueo de aprobados, Caja aparte, migración sin doble conteo, ruta mixta con dos OT y reapertura de un ítem')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
