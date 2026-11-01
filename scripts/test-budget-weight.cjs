// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Control presupuestal · reparto por peso (D3): guía ERP de la solicitud → peso por componente → peso declarado →
// partes iguales si alguna solicitud queda sin peso.
const assert = require('node:assert/strict')
const { setupBudget, read, id } = require('./fixtures/budget-setup.cjs')
;(async () => {
 const db = await setupBudget()
 try {
  await db.exec(`CREATE TABLE transport_request_components(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid, component_contract_id uuid, requested_weight_kg numeric);
   CREATE TABLE dispatch_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid, transport_request_id uuid, document_number text, doc_type text, voided_at timestamptz);
   CREATE TABLE apt_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), documento text, peso_kg numeric, kind text, active boolean DEFAULT true, valid boolean DEFAULT true);
   CREATE FUNCTION apt_guia_key(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT upper(regexp_replace(COALESCE(t,''), '[^0-9A-Za-z]', '', 'g'))$$;`)
  for (const m of ['20261126090000_control_presupuestal_imputacion.sql']) await db.exec(read('supabase/migrations/' + m))
  const migration = read('supabase/migrations/20261129090000_control_presupuestal_peso.sql')
  await db.exec(migration); await db.exec(migration)
  await db.exec(`INSERT INTO transport_requests VALUES ('${id(40)}','S-1','${id(10)}',1000),('${id(41)}','S-2','${id(20)}',NULL),('${id(42)}','S-3','${id(30)}',NULL);
   INSERT INTO dispatches(id,status,vehicle_plate) VALUES ('${id(60)}','EN RUTA','PRO-1');
   INSERT INTO dispatch_requests VALUES ('${id(60)}','${id(40)}'),('${id(60)}','${id(41)}'),('${id(60)}','${id(42)}');`)
  const shares = async () => (await db.query(`SELECT basis, round(share::numeric, 2)::float s FROM budget_route_shares($1) ORDER BY request_id`, [id(60)])).rows.map(r => [r.basis, r.s])
  assert.deepEqual(await shares(), [['IGUAL', 0.33], ['IGUAL', 0.33], ['IGUAL', 0.33]], 'S-2 and S-3 without weight: equal parts')
  // Peso por componente para S-2; guía ERP para S-3 (prevalece sobre el declarado)
  await db.exec(`INSERT INTO transport_request_components(request_id, component_contract_id, requested_weight_kg) VALUES ('${id(41)}','${id(20)}',600),('${id(41)}','${id(20)}',400);
   UPDATE transport_requests SET estimated_weight = 9999 WHERE id = '${id(42)}';
   INSERT INTO dispatch_documents(dispatch_id, transport_request_id, document_number, doc_type) VALUES ('${id(60)}','${id(42)}','T001-123','GUIA_REMISION'),
    ('${id(60)}','${id(42)}','T001-999','GUIA_REMISION');
   UPDATE dispatch_documents SET voided_at = now() WHERE document_number = 'T001-999';
   INSERT INTO apt_movements(documento, peso_kg, kind) VALUES ('T001 123', 1500, 'SALIDA'), ('T001-123', 500, 'SALIDA'), ('T001-999', 7000, 'SALIDA'), ('T001-123', 800, 'ENTRADA');`)
  assert.deepEqual(await shares(), [['PESO', 0.25], ['PESO', 0.25], ['PESO', 0.5]], 'declared 1 000 · components 1 000 · ERP guide 2 000 (voided guide and entries ignored)')
  // Sin las tablas del ERP sigue funcionando con componentes y declarado
  await db.exec(`DROP FUNCTION apt_guia_key(text)`)
  assert.deepEqual(await shares(), [['PESO', 0.08], ['PESO', 0.08], ['PESO', 0.83]], 'falls back to the declared weight')
  console.log('PASS control presupuestal reparto por peso: guía ERP, componentes, declarado y partes iguales')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
