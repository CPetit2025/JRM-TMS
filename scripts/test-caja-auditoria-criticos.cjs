// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Auditoría (Caja): un gasto con viaje y anticipo a la vez se rechaza (pago doble) y la solicitud de anticipo desde la
// app se serializa por conductor (doble toque). La espera entre dos sesiones no se puede simular en PGlite: se verifica
// que el bloqueo quede antes de la verificación de solicitud pendiente.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
;(async () => {
 const db = new PGlite()
 try {
  const c5 = read('supabase/migrations/20260929160000_caja_c5_anticipos_por_motivo.sql')
  const a = c5.indexOf('CREATE OR REPLACE FUNCTION public.request_advance_from_app(')
  assert(a >= 0)
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
   CREATE TABLE dispatch_expenses(id serial PRIMARY KEY, dispatch_id uuid, advance_id uuid, amount numeric);
   CREATE TABLE advance_reasons(code text);  -- tipo de fila declarado por la función
   ${c5.slice(a, c5.indexOf('END $$;', a) + 7)}`)
  const migration = read('supabase/migrations/20261202090000_caja_auditoria_criticos.sql')
  await db.exec(migration); await db.exec(migration)
  const t = '00000000-0000-4000-8000-000000000001'
  await db.exec(`INSERT INTO dispatch_expenses(dispatch_id, amount) VALUES ('${t}', 10); INSERT INTO dispatch_expenses(advance_id, amount) VALUES ('${t}', 10)`)
  await assert.rejects(db.exec(`INSERT INTO dispatch_expenses(dispatch_id, advance_id, amount) VALUES ('${t}','${t}', 200)`), /dispatch_expenses_single_target/)
  await assert.rejects(db.exec(`UPDATE dispatch_expenses SET advance_id = '${t}' WHERE dispatch_id IS NOT NULL`), /dispatch_expenses_single_target/)
  const def = (await db.query(`SELECT pg_get_functiondef('request_advance_from_app'::regproc) d`)).rows[0].d
  assert.equal(def.split('trip_advance_request:').length, 2, 'lock added once (migration is idempotent)')
  assert(def.indexOf('pg_advisory_xact_lock') < def.indexOf('Ya tiene una solicitud pendiente'), 'lock taken before the pending-request check')
  await assert.rejects(db.exec(read('supabase/tests/caja_c204_auditoria_criticos.test.sql')), /CAJA C204 PASS.*\(0 gastos/)
  console.log('PASS auditoría Caja: gasto con un solo destino y solicitud de anticipo serializada por conductor')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
