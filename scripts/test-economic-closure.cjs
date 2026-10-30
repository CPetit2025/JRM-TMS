// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Etapa 4: cierre económico por ruta — costo final por servicio con reglas de cobro, envío, observación, aprobación con
// permiso propio, impacto en la partida solo por diferencia, reapertura con motivo e historial solo de inserción.
const assert = require('node:assert/strict')
const { setupEconomicClosure, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const scalar = async (sql, params=[]) => (await db.query(sql,params)).rows[0]?.value
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  // Reglas de cobro: fracción hacia arriba, mínimo, hora completa, jornada y sin ejecución.
  const billable = (u,q,f,m) => scalar('SELECT economic_billable_qty($1,$2,$3,$4)::float AS value',[u,q,f,m])
  assert.equal(await billable('HORA',2.25,30,3),3,'2 h 15 min → 2.5 h por fracción de 30, mínimo 3')
  assert.equal(await billable('HORA',3.2,30,3),3.5)
  assert.equal(await billable('HORA',3.1,15,null),3.25)
  assert.equal(await billable('HORA',1.1,null,null),2,'sin fracción: hora completa')
  assert.equal(await billable('JORNADA',0.5,null,1),1)
  assert.equal(await billable('SERVICIO',1,null,null),1)
  assert.equal(await billable('HORA',0,30,3),0,'no ejecutado: no se cobra mínimo')

  // --- Ruta de una OT con grúa (acordada por hora) y estiba agregada en programación ---
  await db.exec(`INSERT INTO suppliers(id,business_name,tax_id,category) VALUES('${id(11)}','Grúas prueba','20111111111','GRUA'),('${id(12)}','Estiba prueba','20222222222','ESTIBA');`)
  await rpc('save_request_unloading_costs($1,$2::jsonb)',[id(30),JSON.stringify([{concept:'GRUA',estimated_pen:0}])])
  await rpc('apply_request_tariff($1)',[id(30)])
  const grua = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE transport_request_id=$1 AND concept='GRUA'`,[id(30)])
  const budget = () => db.query(`SELECT reserved_pen::float AS reserved,consumed_pen::float AS consumed FROM contract_budgets WHERE contract_id=$1`,[id(20)]).then(r => r.rows[0])
  const route = await scalar('SELECT schedule_route_resources($1::jsonb) AS value',[JSON.stringify({ mode:'PROPIA',p_driver_id:null,p_vehicle_plate:'E4-1',
   p_departure:'2026-10-30T12:00:00Z',p_estimated_km:10,p_freight_cost:0,p_contract_id:id(20),p_document_type:'GR',auxiliaries:[],p_requests:[{id:id(30)}],forklift:null,
   special_services:{items:[{id:grua,supplier_id:id(11),billing_unit:'HORA',agreed_rate:100,agreed_qty:2,min_billable_qty:3,fraction_minutes:30},
    {transport_request_id:id(30),concept:'ESTIBA',supplier_id:id(12),billing_unit:'JORNADA',agreed_rate:90,agreed_qty:1,workers:4,reason:'Cuadrilla por volumen'}]} })])
  const estiba = await scalar(`SELECT id AS value FROM transport_unloading_costs WHERE dispatch_id=$1 AND concept='ESTIBA'`,[route])
  await db.query(`UPDATE dispatches SET freight_cost=500 WHERE id=$1`,[route])  // flete acordado al programar
  const b0 = await budget()
  const validate = (line, p) => rpc('validate_service_final($1,$2::jsonb)',[line,JSON.stringify(p)])
  const action = (a, reason=null) => rpc('economic_closure_action($1,$2,$3)',[route,a,reason])

  await db.query(`UPDATE dispatches SET status='EN RUTA' WHERE id=$1`,[route])
  assert.match((await validate(grua,{executed_qty:2})).error,/después de la ejecución/)
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[route])
  // Caja aprobó la estiba por 380 (consumo real); el cierre la ajusta a lo validado.
  await db.query(`SELECT unloading_consume($1,380,NULL,'Estiba prueba')`,[estiba])
  let r = await validate(grua,{executed_qty:2.25})
  assert.equal(r.success,true,r.error); assert.equal(Number(r.final_pen),300,'2.25 h → mínimo 3 h × 100, igual a lo acordado: sin motivo')
  r = await validate(grua,{executed_qty:3.2})
  assert.match(r.error,/Justifique/,'final above the agreed cost needs a reason')
  r = await validate(grua,{executed_qty:3.2,reason:'La descarga tomó más tiempo'})
  assert.equal(Number(r.final_pen),350); assert.equal(Number(r.billable_qty),3.5)
  r = await validate(estiba,{executed_qty:1,workers:4,extras_pen:40,reason:'Movilidad de la cuadrilla'})
  assert.equal(Number(r.final_pen),400,'4 trabajadores × 1 jornada × 90 + 40 adicionales')

  // No se envía con pendientes: la ruta no está cerrada y falta el flete final.
  r = await action('ENVIAR')
  assert.equal(r.success,false); assert.match(r.error,/Cierre la ruta/); assert.match(r.error,/flete final/)
  // Cierre de la ruta en Torre de Control: consume el flete vigente (como close_dispatch_route).
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,500)`,[id(85),id(20),route])
  await db.query(`UPDATE contract_budgets SET consumed_pen=consumed_pen+500 WHERE contract_id=$1`,[id(20)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[route])
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[route,JSON.stringify({executed_as_planned:true,extras_pen:50,reason:'Peaje adicional'})])
  assert.equal(r.success,true,r.error)
  const queue = await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)
  const row = queue.routes.find(x => x.dispatch_id === route)
  assert.deepEqual([row.state.status,row.state.pending.length,Number(row.state.agreed_pen),Number(row.state.final_pen),Number(row.state.extras_pen)],
   ['PENDIENTE',0,1160,1300,90],'agreed 500 + 300 + 360; final 550 + 350 + 400; extras 50 + 40')

  // Envío, observación, reenvío y aprobación (permiso de Cierre económico)
  assert.equal((await action('ENVIAR')).status,'EN_REVISION')
  assert.match((await validate(grua,{executed_qty:3})).error,/en revisión o cerrado/,'locked while under review')
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[route,JSON.stringify({executed_as_planned:true})])
  assert.match(r.error,/en revisión o cerrado/,'freight final locked while under review')
  assert.match((await action('OBSERVAR')).error,/observación/,'observation needs a reason')
  assert.equal((await action('OBSERVAR','Adjuntar el sustento del peaje')).status,'OBSERVADO')
  assert.equal((await action('ENVIAR')).status,'EN_REVISION')
  // Programación (sin permiso de Cierre económico) no aprueba.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho');
   INSERT INTO auth.users VALUES('${id(93)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();
   SELECT set_config('request.jwt.claim.sub','${id(93)}',false);`)
  assert.match((await action('APROBAR')).error,/permiso de Cierre económico/)
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)
  r = await action('APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  const b1 = await budget()
  assert.deepEqual([b1.reserved,b1.consumed],[b0.reserved-360-300,b0.consumed+380+500+350+20+50],
   'estiba de Caja: libera 360 y consume 380 (+20 al cierre); grúa: libera 300 y consume 350; flete 500 → +50')
  assert.deepEqual(r.detail.budget_delta_by_contract,{[id(20)]:120})
  assert.equal(await scalar(`SELECT amount_pen::float AS value FROM contract_services WHERE id=$1`,[id(85)]),550,'the OT freight service shows the final freight')
  assert.equal(await scalar(`SELECT actual_pen::float AS value FROM transport_unloading_costs WHERE id=$1`,[estiba]),400)

  // Reapertura con motivo; al volver a cerrar solo se mueve la diferencia.
  assert.equal((await action('REABRIR')).success,false)
  assert.equal((await action('REABRIR','Factura de la grúa por 3 h')).status,'PENDIENTE')
  assert.equal((await validate(grua,{executed_qty:3})).success,true)
  await action('ENVIAR'); r = await action('APROBAR')
  assert.equal(r.status,'CERRADO',r.error)
  const b2 = await budget()
  assert.deepEqual([b2.reserved,b2.consumed],[b1.reserved,b1.consumed-50],'re-close moves only the difference (350 → 300)')
  assert.deepEqual((await db.query(`SELECT action FROM economic_closure_events WHERE dispatch_id=$1 ORDER BY created_at`,[route])).rows.map(x => x.action),
   ['ENVIAR','OBSERVAR','ENVIAR','APROBAR','REABRIR','ENVIAR','APROBAR'])
  await assert.rejects(db.exec(`DELETE FROM economic_closure_events`),/no se modifica/,'closure history is append-only')
  const detail = await rpc('economic_closure_detail($1)',[route])
  assert.equal(detail.success,true); assert.equal(detail.services.length,2); assert.equal(detail.events.length,7); assert.equal(detail.can_approve,true)

  // --- Ruta mixta: el flete final se aplica por OT. Como en producción, editar el servicio FLETE sincroniza el reparto
  //     y la guarda de referencias solo deja pasar filas con OT. ---
  await db.exec(`CREATE FUNCTION sync_mixed() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
    UPDATE dispatch_request_freight SET amount_pen=NEW.amount_pen WHERE service_id=NEW.id AND status<>'LIBERADO'; RETURN NEW; END$$;
   CREATE TRIGGER sync_mixed AFTER UPDATE OF amount_pen ON contract_services FOR EACH ROW EXECUTE FUNCTION sync_mixed();
   CREATE FUNCTION ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.contract_id IS NOT NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'El flete y la descarga superan el importe aprobado para esta referencia'; END$$;
   CREATE TRIGGER ref_guard BEFORE UPDATE ON dispatch_request_freight FOR EACH ROW EXECUTE FUNCTION ref_guard();`)
  const mixed = id(86)
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,freight_cost,scheduled_departure) VALUES($1,'E4-M','PROGRAMADO',primary_site_id(),500,'2026-10-30T12:00:00Z')`,[mixed])
  await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2),($1,$3)`,[mixed,id(31),id(39)])
  await db.query(`INSERT INTO contract_services(id,contract_id,service_type,dispatch_id,amount_pen) VALUES($1,$2,'FLETE',$3,300),($4,$5,'FLETE',$3,200)`,[id(87),id(20),mixed,id(88),id(21)])
  await db.query(`INSERT INTO dispatch_request_freight(dispatch_id,request_id,contract_id,amount_pen,service_id,status) VALUES($1,$2,$3,300,$4,'CONSUMIDO'),($1,$5,$6,200,$7,'CONSUMIDO')`,
   [mixed,id(31),id(20),id(87),id(39),id(21),id(88)])
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[mixed])
  r = await rpc('register_dispatch_freight_final($1,$2::jsonb)',[mixed,JSON.stringify({executed_as_planned:true,extras_pen:60,reason:'Estadía en ambas obras',
   allocation:[{request_id:id(31),final_pen:340},{request_id:id(39),final_pen:220}]})])
  assert.equal(r.success,true,r.error)
  const consumed = c => scalar(`SELECT consumed_pen::float AS value FROM contract_budgets WHERE contract_id=$1`,[c])
  const [c20, c21] = [await consumed(id(20)), await consumed(id(21))]
  assert.equal((await rpc('economic_closure_action($1,$2,$3)',[mixed,'ENVIAR',null])).status,'EN_REVISION')
  r = await rpc('economic_closure_action($1,$2,$3)',[mixed,'APROBAR',null])
  assert.equal(r.status,'CERRADO',r.error)
  assert.deepEqual([await consumed(id(20)) - c20, await consumed(id(21)) - c21],[40,20],'each OT absorbs only its own difference')
  assert.deepEqual((await db.query(`SELECT amount_pen::float AS a FROM dispatch_request_freight WHERE dispatch_id=$1 ORDER BY request_id`,[mixed])).rows.map(x => x.a),[340,220])

  // --- Etapa 6: indicadores (cada costo una vez; rutas mixtas por OT) ---
  await db.exec(`CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);
   INSERT INTO documentary_closures VALUES('${route}','${id(30)}','PENDIENTE'),('${mixed}','${id(31)}','COMPLETO'),('${mixed}','${id(39)}','COMPLETO');`)
  await db.exec(read('supabase/migrations/20261110090000_indicadores_costos_servicios.sql'))
  const ind = await rpc(`service_cost_indicators('2026-10-01','2026-10-31')`)
  assert.equal(ind.success,true,ind.error); assert.equal(ind.routes,2)
  const t = ind.totals
  assert.deepEqual([t.items,t.with_final,Number(t.referential_pen),Number(t.agreed_pen),Number(t.final_pen),Number(t.extras_pen)],[5,5,380,1660,1810,150],
   'freight 300/500/550 + grúa 80/300/300 + estiba 0/360/400 + mixed OT A 0/300/340 + OT B 0/200/220')
  const flete = ind.by_type.find(x => x.concept === 'FLETE')
  assert.deepEqual([flete.items,Number(flete.agreed_pen),Number(flete.final_pen)],[3,1000,1110])
  const ot20 = ind.by_contract.find(x => x.contract_id === id(20)), ot21 = ind.by_contract.find(x => x.contract_id === id(21))
  assert.deepEqual([Number(ot20.agreed_pen),Number(ot20.final_pen),Number(ot21.agreed_pen),Number(ot21.final_pen)],[1460,1590,200,220])
  assert.ok(ot20.budget && Number(ot20.budget.allocated_pen) === 5000,'OT budget beside its costs')
  assert.deepEqual(ind.by_supplier.find(x => x.supplier === 'Grúas prueba').final_pen*1,300)
  assert.deepEqual(ind.pending,{routes_open:0,economic_pending:0,economic_review:0,economic_closed:2,documentary_pending_services:1,documentary_complete_economic_pending:0})
  assert.equal((await rpc(`service_cost_indicators('2026-01-01','2027-12-31')`)).success,false,'period up to 366 days')

  await assert.rejects(db.exec(read('supabase/tests/caja_c174_indicadores_costos.test.sql')),/CAJA C174 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${id(1)}',false)`)

  // Verificación de producción C173 sobre este esquema
  await assert.rejects(db.exec(read('supabase/tests/caja_c173_cierre_economico.test.sql')),/CAJA C173 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  // Sin permisos de lectura no se ve la bandeja.
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await rpc(`economic_closure_queue('2026-10-01','2026-10-31')`)).success,false)
  assert.equal((await action('ENVIAR')).success,false)
  console.log('PASS cierre económico: reglas de cobro (fracción, mínimo, jornada), validación con motivo, bloqueo en revisión, envío, observación, aprobación con permiso, impacto en la partida solo por diferencia, reapertura (Etapa 4) e indicadores (Etapa 6)')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
