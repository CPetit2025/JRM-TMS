// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Cierre económico simplificado: «Conforme» cierra lo acordado en un paso; dentro del umbral se aprueba al validar (motivo
// opcional); sobre el umbral pasa a «Por aprobar» y lo aprueba Cierre económico, que además aprueba directo lo que corrige;
// el cierre empieza al liberar la unidad (sin esperar Torre) y una ruta sin liberar no se cierra.
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
   '20261116090000_flete_propio_cero_automatico.sql']) await db.exec(read('supabase/migrations/'+m))
  const migration = read('supabase/migrations/20261117090000_cierre_economico_simplificado.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatches|dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  await db.exec(migration); await db.exec(migration)

  // Usuarios: Despacho (valida) y el administrador (tiene Cierre económico)
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho');
   INSERT INTO auth.users VALUES('${id(93)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();`)
  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub','${id(u)}',false)`)
  const status = r => scalar(`SELECT status AS value FROM economic_closures WHERE dispatch_id=$1`,[r])
  const items = async r => Object.fromEntries((await rpc('economic_route_items($1)',[r])).map(i => [i.concept, i]))
  const confirm = (r, conforme=true) => rpc('economic_confirm($1,$2)',[r,conforme])
  const freightFinal = (r, p) => rpc('register_dispatch_freight_final($1,$2::jsonb)',[r,JSON.stringify(p)])

  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES
    ('${id(40)}','${id(20)}','A-1',primary_site_id()),('${id(41)}','${id(20)}','A-2',primary_site_id()),('${id(42)}','${id(20)}','A-3',primary_site_id()),
    ('${id(43)}','${id(20)}','A-4',primary_site_id()),('${id(44)}','${id(20)}','A-5',primary_site_id());`)
  const route = async (n, req, freight, status, third=true) => {
   await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id,contract_id,freight_cost,scheduled_departure${third ? ',carrier_id' : ''}) VALUES($1,$2,'ENTREGADO',primary_site_id(),$3,$4,'2026-10-30T12:00:00Z'${third ? `,'${id(90)}'` : ''})`,[id(n),'P-'+n,id(20),freight])
   await db.query(`INSERT INTO dispatch_requests(dispatch_id,transport_request_id) VALUES($1,$2)`,[id(n),req])
   if (status !== 'ENTREGADO') await db.query(`UPDATE dispatches SET status=$2 WHERE id=$1`,[id(n),status])
   return id(n)
  }
  await as(93)

  // 1 · «Conforme» en un paso: tercero liberado (sin liquidar en Torre) con flete y grúa → cerrado
  const a = await route(70, id(40), 400, 'RETORNO_COMPLETADO')
  await db.query(`INSERT INTO transport_unloading_costs(id,transport_request_id,dispatch_id,contract_id,concept,planned_pen,status,origin) VALUES($1,$2,$3,$4,'GRUA',300,'PLANIFICADO','SOLICITUD')`,[id(80),id(40),a,id(20)])
  let r = await confirm(a)
  assert.equal(r.success, true, r.error)
  assert.equal(r.status, 'CERRADO')
  let it = await items(a)
  assert.deepEqual([it.FLETE.final_pen, it.FLETE.status, it.GRUA.final_pen, it.GRUA.status], [400, 'APROBADO', 300, 'APROBADO'])
  assert.equal(await scalar(`SELECT count(*)::int AS value FROM economic_closure_events WHERE dispatch_id=$1 AND action='CONFORME'`,[a]), 1)
  assert.equal((await confirm(a)).status, 'CERRADO', 'idempotent')

  // 2 · Dentro del umbral (S/ 420 sobre 400): sin motivo y se aprueba al cerrar lo validado
  const b = await route(71, id(41), 400, 'CIERRE_OPERATIVO')
  assert.equal((await freightFinal(b, { executed_as_planned: false, base_pen: 420 })).success, true, 'no reason within threshold')
  assert.equal((await confirm(b, false)).status, 'CERRADO')

  // 3 · Sobre el umbral (S/ 600): motivo obligatorio y pasa a «Por aprobar»; Despacho no lo aprueba
  const c = await route(72, id(42), 400, 'RETORNO_COMPLETADO')
  assert.match((await freightFinal(c, { executed_as_planned: false, base_pen: 600 })).error, /Justifique/)
  assert.equal((await freightFinal(c, { executed_as_planned: false, base_pen: 600, reason: 'Desvío por obra en la vía' })).success, true)
  r = await confirm(c, false)
  assert.deepEqual([r.status, r.review.length], ['EN_REVISION', 1])
  assert.equal((await items(c)).FLETE.status, 'EN_REVISION')
  assert.match((await rpc('economic_item_action($1,$2,$3,$4)',[c,'F:'+c,'APROBAR',null])).error, /permiso de Cierre económico/)
  await as(1)
  assert.equal((await rpc('economic_item_action($1,$2,$3,$4)',[c,'F:'+c,'APROBAR',null])).status, 'CERRADO', 'approved without waiting for Torre')

  // 4 · Cierre económico corrige y aprueba directamente lo que supera el umbral
  const d = await route(73, id(43), 400, 'CIERRE_OPERATIVO')
  assert.equal((await freightFinal(d, { executed_as_planned: false, base_pen: 700, reason: 'Ajuste aprobado por gerencia' })).success, true)
  assert.equal((await confirm(d, false)).status, 'CERRADO')

  // 5 · Unidad no liberada: no se cierra
  const e = await route(74, id(44), 400, 'ENTREGADO')
  assert.match((await confirm(e)).error, /no está liberada/)
  assert.ok((await rpc('economic_route_state($1)',[e])).pending.includes('La unidad aún no está liberada'))

  // 6 · Flota propia: se cierra sola al liberar la unidad
  await db.exec(`INSERT INTO transport_requests(id,contract_id,request_number,site_id) VALUES('${id(45)}','${id(20)}','A-6',primary_site_id())`)
  const own = await route(75, id(45), 350, 'ENTREGADO', false)
  await db.query(`UPDATE dispatches SET status='RETORNO_COMPLETADO' WHERE id=$1`,[own])
  assert.equal(await status(own), 'CERRADO', 'own freight closes on release')
  assert.deepEqual([(await items(own)).FLETE.final_pen, (await items(own)).FLETE.status], [350, 'APROBADO'])

  await assert.rejects(db.exec(read('supabase/tests/caja_c186_cierre_economico_simplificado.test.sql')), /CAJA C186 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS cierre económico simplificado: Conforme en un paso, dentro del umbral sin motivo ni revisión, sobre el umbral por aprobar, aprobador directo, sin esperar Torre, unidad no liberada bloqueada, flota propia al liberar')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
