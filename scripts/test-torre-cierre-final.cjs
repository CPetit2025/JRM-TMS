// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Torre de Control · cierre final del servicio: estados independientes (operativo, documentario, económico, Caja);
// documentario completo con económico pendiente no cierra (esc. 13); desvío de costo pendiente no cierra (esc. 20);
// excepción solo del Jefe con motivo; reabrir con motivo y historial que no se borra (esc. 14 y 19); permisos y sede.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
const fn = (file, name) => { const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert(a >= 0, name)
 const body = s.indexOf('$$', s.indexOf(' AS $$', a) + 4) ; return s.slice(a, s.indexOf('$$;', body) + 3) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION is_tms_admin() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION has_tms_read_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT p = ANY(string_to_array(current_setting('test.perms', true), ','))$$;
   CREATE FUNCTION budget_can_read() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT false$$;
   CREATE FUNCTION can_access_site(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT s = '${id(1)}'::uuid$$;
   CREATE FUNCTION economic_user_name(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Usuario'$$;
   CREATE TABLE dispatches(id uuid PRIMARY KEY, dispatch_number text, status text, site_id uuid);
   CREATE TABLE documentary_closures(dispatch_id uuid, request_id uuid, status text);
   CREATE TABLE economic_closures(dispatch_id uuid PRIMARY KEY, status text);
   CREATE TABLE dispatch_expenses(id serial PRIMARY KEY, dispatch_id uuid, status text, amount numeric);`)
  await db.exec(fn('supabase/migrations/20261111110000_cierre_economico_bandeja.sql', 'economic_documentary_status'))
  await db.exec(fn('supabase/migrations/20261109090000_cierre_economico.sql', 'economic_closure_status'))
  const migration = read('supabase/migrations/20261205090000_torre_cierre_final.sql')
  await db.exec(migration); await db.exec(migration)
  const as = perms => db.exec(`SELECT set_config('test.perms', '${perms}', false)`)
  const rpc = async (sql, params = []) => (await db.query(`SELECT ${sql} AS v`, params)).rows[0].v
  const close = (d, note = null, exc = false) => rpc('dispatch_final_close($1,$2,$3)', [d, note, exc])
  const status = async d => (await rpc('dispatch_closure_status($1)', [[d]])).rows[d]

  // R-1: ruta cerrada, documentación completa, económico en revisión (desvío de costo pendiente), un gasto de Caja observado
  await db.exec(`INSERT INTO dispatches VALUES ('${id(10)}','R-1','LIQUIDADO','${id(1)}'),('${id(11)}','R-2','EN RUTA','${id(1)}'),('${id(12)}','R-3','LIQUIDADO','${id(2)}');
   INSERT INTO documentary_closures VALUES ('${id(10)}','${id(40)}','COMPLETO'),('${id(10)}','${id(41)}','COMPLETO'),('${id(11)}','${id(42)}','PENDIENTE');
   INSERT INTO economic_closures VALUES ('${id(10)}','EN_REVISION');
   INSERT INTO dispatch_expenses(dispatch_id,status,amount) VALUES ('${id(10)}','OBSERVADO',35),('${id(10)}','APROBADO',100)`)
  await as('torre-control,despacho')
  let s = await status(id(10))
  assert.deepEqual([s.operativo.ok, s.documentario.ok, s.economico.ok, s.caja.ok, s.caja.pending, s.ready], [true, true, false, false, 1, false], 'esc. 13: documentary done, economic and Caja pending')
  let r = await close(id(10))
  assert.equal(r.success, false); assert.match(r.error, /liquidación económica \(EN_REVISION\).*1 gasto\(s\) de Caja/, 'esc. 20: pending cost deviation and Caja block the normal close')
  // Excepción: solo el Jefe y con motivo
  assert.match((await close(id(10), 'Cliente pidió cierre', true)).error, /Solo el Jefe/)
  await as('torre-control,control-presupuestal-recomendar')
  assert.match((await close(id(10), 'corto', true)).error, /mínimo 10/)
  r = await close(id(10), 'Gasto observado se regulariza en la próxima liquidación', true)
  assert.equal(r.success, true, r.error)
  s = await status(id(10)); assert.deepEqual([s.final.exception, s.final.closed_by, s.ready], [true, 'Usuario', false])
  assert.match((await close(id(10), 'otra vez con motivo', true)).error, /ya tiene cierre final/)
  // Reabrir con motivo (esc. 19); el historial no se borra ni se modifica (esc. 14)
  assert.match((await rpc('dispatch_final_reopen($1,$2)', [id(10), 'x'])).error, /mínimo 10/)
  assert.equal((await rpc('dispatch_final_reopen($1,$2)', [id(10), 'Se corrigió el gasto observado'])).success, true)
  assert.equal((await status(id(10))).final, null)
  await db.exec(`UPDATE economic_closures SET status='CERRADO'; UPDATE dispatch_expenses SET status='APROBADO'`)
  await as('torre-control,despacho')
  assert.match((await rpc('dispatch_final_reopen($1,$2)', [id(10), 'Supervisor no reabre'])).error, /Solo el Jefe/)
  r = await close(id(10)); assert.equal(r.success, true, r.error); assert.equal(r.checks.final.exception, false)
  const hist = await rpc('dispatch_final_close_history($1)', [id(10)])
  assert.deepEqual(hist.map(h => h.action).sort(), ['CERRAR', 'CERRAR_CON_EXCEPCION', 'REABRIR'])
  await assert.rejects(db.exec(`DELETE FROM dispatch_final_close_events`), /no se modifica ni se borra/)
  await assert.rejects(db.exec(`UPDATE dispatch_final_close_events SET note = 'x'`), /no se modifica ni se borra/)
  // Ruta en curso: ni con excepción
  await as('control-presupuestal-recomendar,torre-control')
  assert.match((await close(id(11), 'Excepción sobre ruta en curso', true)).error, /Primero cierre la ruta \(estado actual: EN RUTA\)/)
  // Sede sin acceso y usuario sin permiso
  assert.match((await close(id(12), 'Otra sede con motivo', true)).error, /Despacho inexistente/)
  assert.deepEqual(Object.keys((await rpc('dispatch_closure_status($1)', [[id(10), id(12)]])).rows), [id(10)], 'other site not listed')
  await as('')
  assert.match((await rpc('dispatch_closure_status($1)', [[id(10)]])).error, /Sin acceso/)
  assert.match((await close(id(10))).error, /Sin permiso/)
  assert.deepEqual(await rpc('dispatch_final_close_history($1)', [id(10)]), [])
  await as('torre-control')
  assert.match((await rpc('dispatch_closure_status($1)', [Array.from({ length: 501 }, () => id(10))])).error, /Demasiados/)
  console.log('PASS cierre final del servicio: estados independientes, excepción del Jefe con motivo, reapertura con historial inalterable, ruta en curso, sede y permisos')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
