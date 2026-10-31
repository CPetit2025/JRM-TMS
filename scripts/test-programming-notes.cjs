// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Observaciones operativas de la programación: Despacho las guarda en una ruta activa (se recortan, vacío = sin
// observaciones), no en una ruta cerrada, y un usuario sin permiso de Despacho no las modifica.
const assert = require('node:assert/strict')
const { setupEconomicClosure, read, id } = require('./fixtures/economic-closure-setup.cjs')
;(async () => {
 const db = await setupEconomicClosure()
 try {
  const migration = read('supabase/migrations/20261119090000_observaciones_programacion.sql')
  assert.doesNotMatch(migration, /UPDATE public\.(dispatch_request_freight|transport_requests) /i, 'never updates guarded tables')
  assert.doesNotMatch(migration, /^UPDATE /im, 'no data updates in the migration body')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(92)}','Despacho','["despacho"]'),('${id(94)}','Consulta','["torre-control"]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(93)}','${id(92)}','Despacho'),('${id(95)}','${id(94)}','Consulta');
   INSERT INTO auth.users VALUES('${id(93)}'),('${id(95)}'); INSERT INTO user_site_access(user_id,site_id) SELECT '${id(93)}',primary_site_id();`)
  const as = u => db.exec(`SELECT set_config('request.jwt.claim.sub','${id(u)}',false)`)
  const notes = async d => (await db.query(`SELECT programming_notes AS v FROM dispatches WHERE id=$1`, [d])).rows[0].v
  const save = (d, text) => db.query(`SELECT set_dispatch_programming_notes($1,$2)`, [d, text])
  await db.query(`INSERT INTO dispatches(id,vehicle_plate,status,site_id) VALUES($1,'NOTA-1','PROGRAMADO',primary_site_id()),($2,'NOTA-2','LIQUIDADO',primary_site_id())`, [id(70), id(71)])

  await as(93)
  await save(id(70), '  Acceso por puerta 2; el cliente recibe por la tarde  ')
  assert.equal(await notes(id(70)), 'Acceso por puerta 2; el cliente recibe por la tarde')
  await save(id(70), '   ')
  assert.equal(await notes(id(70)), null, 'blank clears the notes')
  await assert.rejects(save(id(71), 'Tarde'), /ya no está activa/)
  await assert.rejects(save(id(70), 'x'.repeat(1001)), /demasiado extensas/)
  await as(95)
  await assert.rejects(save(id(70), 'Sin permiso'), /Sin permiso/)

  await assert.rejects(db.exec(read('supabase/tests/caja_c188_observaciones_programacion.test.sql')), /CAJA C188 PASS/)
  await db.exec('ROLLBACK').catch(() => {})
  console.log('PASS observaciones de programación: Despacho guarda en ruta activa, vacío limpia, ruta cerrada y sin permiso rechazados')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
