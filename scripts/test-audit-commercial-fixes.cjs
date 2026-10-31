// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Correcciones de la auditoría de Comercial y Operaciones:
// F01 · Registro de Servicios no edita el importe de un servicio con el cierre económico en revisión, parcial o cerrado.
// F02 · Un cierre operativo manual desde PROGRAMADO (la ruta no salió) no confirma el flete propio, ni al cerrarse ni después.
// F03 · Un usuario solo de Cierre económico lee el flete de la ruta.
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
  for (const m of ['20261111110000_cierre_economico_bandeja.sql','20261111120000_cierre_economico_parcial.sql','20261113090000_cierre_economico_automatico.sql',
   '20261116090000_flete_propio_cero_automatico.sql','20261117090000_cierre_economico_simplificado.sql']) await db.exec(read('supabase/migrations/'+m))
  // Tipo producción: eventos con payload, servicios con partida dueña y asignación de OT
  await db.exec(`ALTER TABLE dispatch_events ADD COLUMN IF NOT EXISTS payload jsonb, ADD COLUMN IF NOT EXISTS created_by_user uuid;
   ALTER TABLE contract_services ADD COLUMN IF NOT EXISTS budget_contract_id uuid;
   CREATE OR REPLACE FUNCTION has_assigned_contract(uuid, boolean) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;`)
  const migration = read('supabase/migrations/20261120090000_correcciones_auditoria_comercial.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  await db.exec(migration); await db.exec(migration)

  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Cierre','["cierre-economico"]'),('${id(96)}','Registro','["contratos-servicios"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Cierre'),('${id(97)}','${id(96)}','Registro');
   INSERT INTO auth.users VALUES('${id(93)}'),('${id(97)}');
   INSERT INTO user_site_access(user_id,site_id) SELECT u,primary_site_id() FROM (VALUES('${id(93)}'::uuid),('${id(97)}'::uuid)) v(u);`)
  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub','${id(u)}',false)`)
  const closure = r => scalar(`SELECT status AS value FROM economic_closures WHERE dispatch_id=$1`,[r])
  const finalOf = r => scalar(`SELECT final_pen AS value FROM dispatch_freight_stages WHERE dispatch_id=$1`,[r])
  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES('${id(40)}','${id(20)}','A-1',primary_site_id()),('${id(41)}','${id(20)}','A-2',primary_site_id());`)
  const route = async (n, req, plate) => {
   await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure) VALUES($1,$2,'PROGRAMADO',primary_site_id(),$3,350,'2026-10-30T12:00:00Z')`,[id(n),plate,id(20)])
   await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(n),req])
   return id(n)
  }
  await as(1)

  // F02 · Cierre manual desde PROGRAMADO (como manual_close_dispatch_operations: estado y luego el evento)
  const notRun = await route(70, id(40), 'NR-1')
  await db.query(`UPDATE dispatches SET status='CIERRE_OPERATIVO' WHERE id=$1`,[notRun])
  await db.query(`INSERT INTO dispatch_events(dispatch_id,event_type,description,payload) VALUES($1,'CIERRE_OPERATIVO_MANUAL','Cierre manual',jsonb_build_object('previous_status','PROGRAMADO'))`,[notRun])
  assert.equal((await finalOf(notRun)) ?? null, null, 'no final freight for a route that did not leave')
  assert.notEqual(await closure(notRun), 'CERRADO')
  await db.query(`UPDATE dispatches SET status='LIQUIDADO' WHERE id=$1`,[notRun])
  assert.equal((await finalOf(notRun)) ?? null, null, 'a later status change does not confirm it either')
  assert.notEqual(await closure(notRun), 'CERRADO', 'stays pending for a decision in Cierre económico')
  // Una ruta propia que sí se ejecutó se sigue confirmando sola al liberar la unidad
  const ran = await route(71, id(41), 'RUN-1')
  await db.query(`UPDATE dispatches SET status='ENTREGADO' WHERE id=$1`,[ran])
  await db.query(`UPDATE dispatches SET status='RETORNO_COMPLETADO' WHERE id=$1`,[ran])
  assert.equal(Number(await finalOf(ran)), 350)
  assert.equal(await closure(ran), 'CERRADO')

  // F03 · Solo Cierre económico: lee el flete
  await as(93)
  const summary = await rpc('dispatch_freight_summary($1)',[ran])
  assert.equal(summary.success, true, summary.error)
  assert.equal(summary.can_register_final, true)

  // F01 · Registro de Servicios no edita el cargo de una ruta con cierre económico aprobado; sí uno sin ruta
  await db.exec(`INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES('${id(20)}','PARTIDA_TRANSPORTE',10000)
    ON CONFLICT DO NOTHING;
   INSERT INTO contract_services(id,contract_id,status,service_type,dispatch_id,amount_pen) VALUES
    ('${id(80)}','${id(20)}','REALIZADO','FLETE','${ran}',350),('${id(81)}','${id(20)}','REALIZADO','OTROS',NULL,100);`)
  await as(97)
  await assert.rejects(db.query(`SELECT update_contract_service_amount_with_reason($1,130,'Ajuste de tarifa')`,[id(80)]), /Cierre económico/)
  assert.equal(Number(await scalar(`SELECT amount_pen AS value FROM contract_services WHERE id=$1`,[id(80)])), 350)
  await db.query(`SELECT update_contract_service_amount_with_reason($1,130,'Ajuste de tarifa')`,[id(81)])
  assert.equal(Number(await scalar(`SELECT amount_pen AS value FROM contract_services WHERE id=$1`,[id(81)])), 130, 'charges without a route keep working')

  await assert.rejects(db.exec(read('supabase/tests/caja_c189_correcciones_auditoria_comercial.test.sql')), /CAJA C189 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS auditoría comercial: ruta no ejecutada sin flete confirmado, ruta ejecutada se confirma, Cierre económico lee el flete, Registro no edita lo aprobado')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
