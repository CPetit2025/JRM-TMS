// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Liquidación documentaria con la ruta cerrada: un viaje LIQUIDADO admite cargar documentos, validar la guía y dar
// por liquidado (pasa la verificación de estado); con cierre final vigente se rechaza con su aviso; CERRADO sigue fuera.
const assert = require('node:assert/strict')
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const read = p => readFileSync(p, 'utf8')
const fn = (file, name) => { const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`) >= 0 ? s.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`) : s.indexOf(`CREATE FUNCTION public.${name}(`)
 assert(a >= 0, name); return s.slice(a, s.indexOf('END $$;', a) + 7) }
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT '${id(9)}'::uuid$$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION has_tms_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION can_settle_manually() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE FUNCTION delivery_can_review(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
   CREATE TABLE dispatches(id uuid PRIMARY KEY, status text, site_id uuid);
   CREATE TABLE dispatch_requests(dispatch_id uuid, transport_request_id uuid);
   CREATE TABLE dispatch_final_closures(dispatch_id uuid PRIMARY KEY);
   CREATE TABLE delivery_conformities(dispatch_id uuid, request_id uuid, current_submission_id uuid, state text);
   CREATE TABLE settlement_manual_closures(dispatch_id uuid, request_id uuid);
   ${fn('supabase/migrations/20261013150000_settlement_rules_by_service.sql', 'settlement_upload_document')}
   ${fn('supabase/migrations/20261007130000_delivery_conformity.sql', 'delivery_review')}
   ${fn('supabase/migrations/20261106090000_documentary_closure.sql', 'settlement_mark_settled')}`)
  // Estado vigente de la carga de documentos: el parche de 20261013190000
  const p190 = read('supabase/migrations/20261013190000_settlement_after_departure.sql')
  await db.exec(p190.slice(p190.indexOf('DO $patch$'), p190.indexOf('END $patch$;') + 12))
  const migration = read('supabase/migrations/20261209090000_documentos_ruta_cerrada.sql')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`INSERT INTO dispatches VALUES ('${id(1)}','LIQUIDADO',NULL),('${id(2)}','LIQUIDADO',NULL),('${id(3)}','CERRADO',NULL);
   INSERT INTO dispatch_final_closures VALUES ('${id(2)}')`)
  const err = async sql => { try { await db.query(sql); return 'OK' } catch (e) { return e.message } }
  const calls = {
   carga: d => `SELECT settlement_upload_document('${d}','${id(50)}','GUIA','T001-1',ARRAY['a.pdf'])`,
   guia: d => `SELECT delivery_review('${d}','${id(50)}','${id(60)}','VALIDADA')`,
   liquidar: d => `SELECT settlement_mark_settled('${d}','${id(50)}','Documentos revisados en oficina')`,
  }
  for (const [name, call] of Object.entries(calls)) {
   // LIQUIDADO sin cierre final: pasa el estado y se detiene en la verificación siguiente (servicio / sustento)
   assert.match(await err(call(id(1))), /La solicitud no pertenece|El sustento cambió/, `${name}: LIQUIDADO pasa la verificación de estado`)
   assert.match(await err(call(id(2))), /cierre final: reábralo en Torre de Control/, `${name}: con cierre final se rechaza`)
   // Dar por liquidado ya admitía CERRADO (estado que hoy ningún flujo asigna); carga y guía lo siguen rechazando
   if (name !== 'liquidar') assert.doesNotMatch(await err(call(id(3))), /La solicitud no pertenece|El sustento cambió/, `${name}: CERRADO sigue fuera`)
  }
  const def = (await db.query(`SELECT pg_get_functiondef('settlement_upload_document(uuid,uuid,text,text,text[],text[],uuid)'::regprocedure) d`)).rows[0].d
  assert.equal(def.split('dispatch_final_closures').length, 2, 'parche idempotente')
  await assert.rejects(db.exec(read('supabase/tests/caja_c208_documentos_ruta_cerrada.test.sql')), /CAJA C208 PASS/)
  console.log('PASS documentos con la ruta cerrada: LIQUIDADO admite carga, guía y liquidación; cierre final las bloquea; CERRADO sigue fuera')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
