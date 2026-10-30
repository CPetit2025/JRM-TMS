// SQL real en PostgreSQL aislado (PGlite); nunca conecta a producción.
// Modal de Documentos: categoría de archivo (solo «Otro documento», sin tocar doc_type) y contexto del modal
// (retorno, quién subió, tamaño, anulados) con permisos de lectura.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = path => readFileSync(path, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
;(async () => {
 const db = new PGlite()
 try {
  await db.exec(read('scripts/fixtures/hhee-schema.sql'))
  await db.exec(read('scripts/fixtures/route-operations-schema.sql'))
  await db.exec(`ALTER TABLE dispatches ADD COLUMN returned_at timestamptz;
   CREATE TABLE dispatch_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dispatch_id uuid NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    transport_request_id uuid,doc_type text NOT NULL CHECK (doc_type IN ('GUIA_REMISION','PACKING_LIST','NOTA_DESPACHO','OTRO')),document_number text,
    file_path text NOT NULL,file_name text,mime_type text,size_bytes bigint,uploaded_by uuid,uploaded_at timestamptz NOT NULL DEFAULT now(),voided_at timestamptz);
   SELECT set_config('request.jwt.claim.sub','${id(1)}',false);
   INSERT INTO dispatches(id,vehicle_plate,status,site_id,returned_at) VALUES('${id(60)}','DOC-1','LIQUIDADO',primary_site_id(),'2026-10-07T15:00:00Z');
   INSERT INTO dispatch_documents(id,dispatch_id,doc_type,file_path,file_name,size_bytes,uploaded_by) VALUES
    ('${id(70)}','${id(60)}','OTRO','a/1.pdf','Comprobante_Grua.pdf',1200000,'${id(1)}'),
    ('${id(71)}','${id(60)}','GUIA_REMISION','a/2.pdf','T001-1.pdf',800000,'${id(2)}');
   INSERT INTO dispatch_documents(dispatch_id,doc_type,file_path,voided_at) VALUES('${id(60)}','OTRO','a/3.pdf',now());`)
  const migration = read('supabase/migrations/20261112090000_documentos_modal_contexto.sql')
  await db.exec(migration); await db.exec(migration)
  const rpc = async (sql, params=[]) => (await db.query(`SELECT ${sql} AS value`,params)).rows[0].value

  assert.equal((await rpc('set_dispatch_document_category($1,$2)',[id(70),'comprobante'])).success,true)
  assert.equal((await db.query(`SELECT category FROM dispatch_documents WHERE id=$1`,[id(70)])).rows[0].category,'COMPROBANTE')
  assert.match((await rpc('set_dispatch_document_category($1,$2)',[id(71),'COMPROBANTE'])).error,/Otro documento/,'guides keep their own type')
  assert.match((await rpc('set_dispatch_document_category($1,$2)',[id(70),'FACTURA'])).error,/inválida/)
  await assert.rejects(db.exec(`UPDATE dispatch_documents SET category='X' WHERE id='${id(70)}'`),/dispatch_documents_category_check/)
  const ctx = await rpc('dispatch_documents_modal_context($1)',[id(60)])
  assert.equal(ctx.success,true); assert.equal(ctx.voided,1); assert.equal(ctx.documents.length,2,'only current documents')
  assert.ok(ctx.returned_at,'return date')
  const doc = ctx.documents.find(d => d.id === id(70))
  assert.deepEqual([doc.category,Number(doc.size_bytes),doc.uploaded_by_name],['COMPROBANTE',1200000,'Prueba Admin'])
  await assert.rejects(db.exec(read('supabase/tests/caja_c181_documentos_modal.test.sql')),/CAJA C181 PASS/)
  await db.exec('ROLLBACK').catch(() => {})

  await db.exec(`INSERT INTO roles(id,name,permissions) VALUES('${id(90)}','Lector','[]');
   INSERT INTO profiles(id,role_id,first_name) VALUES('${id(91)}','${id(90)}','Lector');
   SELECT set_config('request.jwt.claim.sub','${id(91)}',false);`)
  assert.equal((await rpc('dispatch_documents_modal_context($1)',[id(60)])).success,false)
  assert.equal((await rpc('set_dispatch_document_category($1,$2)',[id(70),'OTROS'])).success,false)
  console.log('PASS modal de documentos: categoría solo para «Otro documento», contexto con retorno, autor, tamaño y anulados, y permisos')
 } finally { await db.close() }
})().catch(e => { console.error(e); process.exit(1) })
